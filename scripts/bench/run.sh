#!/usr/bin/env bash
# run.sh — the one committed three-layer harness entry point (sprint 018
# ticket 003): build prerequisites, then Layer 1 -> Layer 2 -> Layer 3 ->
# the Markdown report, in that order.
#
# Usage:
#   scripts/bench/run.sh [--skip-held] [--audit-db <path>] --report <file.md>
#
# --skip-held        forwarded to Layer 1 and Layer 2's own exclusivity
#                     checks (README.md's "Requires exclusive access to
#                     the bench" section) -- every resource already held
#                     by another process (e.g. a stakeholder's own
#                     `npm run dev`) is marked "skipped" on its own row
#                     rather than refusing the whole run. Without this
#                     flag, Layer 1/2 each refuse outright (exit
#                     non-zero) the moment either finds a held resource
#                     it needs -- this script does not second-guess that
#                     refusal, it simply stops (`set -e`).
# --audit-db <path>   forwarded to Layer 2: audits a read-only COPY of
#                     the real `console.sqlite` at <path> (never opened
#                     in place -- see `layer2/auditDb.ts`'s own doc
#                     comment) alongside the live-snapshot truthfulness
#                     assertions.
# --report <file.md>  required. Where the final Markdown report is
#                     written.
#
# This script never kills or signals any process it did not itself
# start (same discipline as every layer it calls); the only processes
# it starts are the two short-lived host instances Layer 2 and Layer 3
# each spawn and clean up on their own.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

SKIP_HELD=""
AUDIT_DB=""
REPORT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-held)
      SKIP_HELD="--skip-held"
      shift
      ;;
    --audit-db)
      AUDIT_DB="$2"
      shift 2
      ;;
    --report)
      REPORT_PATH="$2"
      shift 2
      ;;
    *)
      echo "bench/run.sh: unrecognized argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REPORT_PATH" ]]; then
  echo "bench/run.sh: --report <file.md> is required" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bench-run.XXXXXX")"
echo "[bench:run] work dir: $WORK_DIR"

LAYER1_JSON="$WORK_DIR/layer1.json"
LAYER2_JSON="$WORK_DIR/layer2.json"
LAYER3_JSON="$WORK_DIR/layer3.json"
SCREENSHOT_DIR="$WORK_DIR/screenshots"

echo "[bench:run] building protocol/host (typecheck) and the UI's production bundle..."
npm run build
npm run vite:build -w @robot-console/ui

echo "[bench:run] Layer 1: raw device probes..."
# shellcheck disable=SC2086
npx tsx scripts/bench/layer1/index.ts $SKIP_HELD --out "$LAYER1_JSON"

echo "[bench:run] Layer 2: host-over-WebSocket checks + truthfulness assertions..."
AUDIT_ARGS=()
if [[ -n "$AUDIT_DB" ]]; then
  AUDIT_ARGS=(--audit-db "$AUDIT_DB")
fi
# shellcheck disable=SC2086
npx tsx scripts/bench/layer2/index.ts $SKIP_HELD --layer1 "$LAYER1_JSON" --out "$LAYER2_JSON" "${AUDIT_ARGS[@]}"

echo "[bench:run] Layer 3: headless Chrome pass..."
npx tsx scripts/bench/layer3/index.ts --layer2 "$LAYER2_JSON" --out "$LAYER3_JSON" --screenshot-dir "$SCREENSHOT_DIR"

echo "[bench:run] generating report..."
npx tsx scripts/bench/report/generate.ts --layer1 "$LAYER1_JSON" --layer2 "$LAYER2_JSON" --layer3 "$LAYER3_JSON" --out "$REPORT_PATH"

echo "[bench:run] done. Report: $REPORT_PATH"
echo "[bench:run] intermediate JSON + screenshots kept at: $WORK_DIR"
