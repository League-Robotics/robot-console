#!/usr/bin/env bash
# Build dist/robot-console_<version>_amd64.deb for Ubuntu 24.04 x86_64.
#
# Runs on a workstation with Docker (macOS or Linux, any CPU: the build
# container is linux/amd64, emulated if needed). The app is built from
# committed HEAD (`git archive HEAD`), never the working tree. Build inputs
# (Node tarball, nfpm, base image) are pinned in packaging/linux/pins.env and
# checksum-verified.
#
# Usage: scripts/package-linux.sh [--test] [--test-only] [--help]
#   --test       build, then run packaging/linux/test-install.sh on the result
#   --test-only  skip the build; test the existing dist/ package
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGING="$ROOT/packaging/linux"
CACHE="$ROOT/build/linux/cache"
OUT="$ROOT/dist"
# shellcheck source=../packaging/linux/pins.env
set -a
. "$PACKAGING/pins.env"
set +a

run_build=1 run_test=0
for arg in "$@"; do
  case "$arg" in
    --test) run_test=1 ;;
    --test-only) run_build=0 run_test=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# fetch URL DEST SHA256 -- download once into the cache, always verify.
fetch() {
  local url=$1 dest=$2 want=$3
  if [ ! -f "$dest" ] || [ "$(sha256 "$dest")" != "$want" ]; then
    echo "downloading $url"
    curl -fsSL --retry 3 -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  local got
  got=$(sha256 "$dest")
  if [ "$got" != "$want" ]; then
    echo "checksum mismatch for $dest: got $got, pinned $want" >&2
    rm -f "$dest"
    exit 1
  fi
  echo "verified $(basename "$dest") sha256=$got"
}

# upstream_lists FILE SUMS_URL SHA256 -- the pinned checksum must also be the
# one the upstream checksum list publishes for that file name.
upstream_lists() {
  local file=$1 sums_url=$2 want=$3
  if ! curl -fsSL --retry 3 "$sums_url" | grep -qE "^$want  $file\$"; then
    echo "pinned sha256 for $file is not in $sums_url" >&2
    exit 1
  fi
  echo "verified $file against $sums_url"
}

VERSION=$(git -C "$ROOT" show HEAD:package.json | sed -n 's/^  "version": "\([^"]*\)",*$/\1/p' | head -1)
DEB="$OUT/robot-console_${VERSION}_amd64.deb"

if [ "$run_build" = 1 ]; then
  start=$(date +%s)
  mkdir -p "$CACHE/npm" "$OUT"

  fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL" "$CACHE/$NODE_TARBALL" "$NODE_SHA256"
  upstream_lists "$NODE_TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$NODE_SHA256"
  fetch "https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION/$NFPM_TARBALL" \
    "$CACHE/$NFPM_TARBALL" "$NFPM_SHA256"
  upstream_lists "$NFPM_TARBALL" \
    "https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION/checksums.txt" "$NFPM_SHA256"

  GIT_SHA=$(git -C "$ROOT" rev-parse HEAD)
  SOURCE_DATE_EPOCH=$(git -C "$ROOT" log -1 --format=%ct HEAD)
  MAINTAINER="${ROBOT_CONSOLE_MAINTAINER:-$(git -C "$ROOT" log -1 --format='%an <%ae>' HEAD)}"
  if [ -n "$(git -C "$ROOT" status --porcelain -- packaging/linux scripts/package-linux.sh)" ]; then
    PACKAGING_DIRTY=1
    echo "note: packaging/linux has uncommitted changes (packaging files come from the working tree; the app comes from HEAD)"
  else
    PACKAGING_DIRTY=0
  fi

  echo "building robot-console $VERSION from $GIT_SHA"
  git -C "$ROOT" archive --format=tar -o "$ROOT/build/linux/src.tar" HEAD

  docker run --rm --platform linux/amd64 \
    -v "$ROOT/build/linux/src.tar:/in/src.tar:ro" \
    -v "$CACHE:/cache" \
    -v "$PACKAGING:/packaging:ro" \
    -v "$OUT:/out" \
    -e NODE_VERSION -e NODE_TARBALL -e NODE_SHA256 \
    -e NFPM_VERSION -e NFPM_TARBALL -e NFPM_SHA256 -e BASE_IMAGE \
    -e ROBOT_CONSOLE_VERSION="$VERSION" -e ROBOT_CONSOLE_MAINTAINER="$MAINTAINER" \
    -e GIT_SHA="$GIT_SHA" -e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
    -e PACKAGING_DIRTY="$PACKAGING_DIRTY" \
    "$BASE_IMAGE" bash /packaging/build-in-container.sh

  size=$(wc -c <"$DEB" | tr -d ' ')
  echo
  echo "package: $DEB"
  echo "version: $VERSION  git: $GIT_SHA"
  echo "size:    $size bytes ($((size / 1024 / 1024)) MiB)"
  echo "sha256:  $(sha256 "$DEB")"
  echo "build:   $(($(date +%s) - start)) s"
fi

if [ "$run_test" = 1 ]; then
  "$PACKAGING/test-install.sh" "$DEB"
fi
