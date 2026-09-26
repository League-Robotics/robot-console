#!/usr/bin/env bash
# Install-test a robot-console .deb in a fresh ubuntu:24.04 linux/amd64
# container. Runs on the workstation; the checks themselves live in
# test-in-container.sh.
#
# Usage: packaging/linux/test-install.sh [path/to/robot-console_<v>_amd64.deb]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=pins.env
set -a
. "$HERE/pins.env"
set +a

DEB="${1:-$(ls -t "$ROOT"/dist/robot-console_*_amd64.deb 2>/dev/null | head -1)}"
if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  echo "no package found; run scripts/package-linux.sh first" >&2
  exit 2
fi
DEB="$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")"
echo "testing $DEB in $BASE_IMAGE (linux/amd64)"

start=$(date +%s)
status=0
docker run --rm --platform linux/amd64 \
  -v "$DEB:/deb/$(basename "$DEB"):ro" \
  -v "$HERE:/packaging:ro" \
  -e NODE_VERSION \
  -e MBTOOLS_VERSION \
  "$BASE_IMAGE" bash /packaging/test-in-container.sh "/deb/$(basename "$DEB")" || status=$?
echo "test run: $(($(date +%s) - start)) s"
exit "$status"
