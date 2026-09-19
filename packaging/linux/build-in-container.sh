#!/usr/bin/env bash
# Builds the robot-console .deb inside ubuntu:24.04 (linux/amd64).
# Invoked by scripts/package-linux.sh; do not run on a workstation.
#
# Mounts:
#   /in/src.tar  `git archive HEAD` of the repo (read-only)
#   /cache       verified Node + nfpm tarballs, npm cache
#   /packaging   packaging/linux (read-only)
#   /out         output directory for the .deb
set -euo pipefail

: "${NODE_VERSION:?}" "${NODE_TARBALL:?}" "${NODE_SHA256:?}"
: "${NFPM_TARBALL:?}" "${NFPM_SHA256:?}" "${NFPM_VERSION:?}"
: "${ROBOT_CONSOLE_VERSION:?}" "${ROBOT_CONSOLE_DEB_RELEASE:?}" "${ROBOT_CONSOLE_MAINTAINER:?}"
: "${GIT_SHA:?}" "${SOURCE_DATE_EPOCH:?}" "${BASE_IMAGE:?}"
PACKAGING_DIRTY="${PACKAGING_DIRTY:-unknown}"

export DEBIAN_FRONTEND=noninteractive
export npm_config_cache=/cache/npm npm_config_update_notifier=false \
  npm_config_fund=false npm_config_audit=false npm_config_loglevel=warn

step() { printf '\n== [%4ss] %s\n' "$SECONDS" "$*"; }

step "apt prerequisites"
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates xz-utils >/dev/null

step "toolchain: Node $NODE_VERSION, nfpm $NFPM_VERSION (re-verifying checksums)"
echo "$NODE_SHA256  /cache/$NODE_TARBALL" | sha256sum -c -
echo "$NFPM_SHA256  /cache/$NFPM_TARBALL" | sha256sum -c -
mkdir -p /toolchain/node
tar -xJf "/cache/$NODE_TARBALL" -C /toolchain/node --strip-components=1
tar -xzf "/cache/$NFPM_TARBALL" -C /toolchain nfpm
export PATH="/toolchain/node/bin:/toolchain:$PATH"
node --version
nfpm --version | head -3

step "source: git archive $GIT_SHA"
mkdir -p /work
tar -xf /in/src.tar -C /work
cd /work

step "npm ci"
npm ci

step "npm run build (protocol + host tsc, ui typecheck)"
npm run build

step "vite build (packages/ui/dist)"
npm run vite:build -w @robot-console/ui

step "stage /opt/robot-console/app"
STAGE=/stage/opt/robot-console
APP="$STAGE/app"
mkdir -p "$APP/packages"
cp -a bin package.json package-lock.json "$APP/"
for f in LICENSE LICENSE.md LICENSE.txt; do [ -f "$f" ] && cp "$f" "$APP/"; done
for p in protocol host ui; do
  mkdir -p "$APP/packages/$p"
  cp "packages/$p/package.json" "$APP/packages/$p/"
  cp -a "packages/$p/dist" "$APP/packages/$p/"
done

step "production node_modules (npm ci --omit=dev in the staged app)"
(cd "$APP" && npm ci --omit=dev)

step "drop native prebuilds for other platforms"
find "$APP/node_modules" -type d -name prebuilds -prune -print | while read -r dir; do
  for entry in "$dir"/*; do
    name=$(basename "$entry")
    case "$name" in
      *linux-x64*) ;;
      *) rm -rf "$entry" ;;
    esac
  done
done
# musl builds are useless on Ubuntu (glibc).
find "$APP/node_modules" -path '*prebuilds*' \( -name '*musl*' \) -prune -exec rm -rf {} +
echo "native modules kept:"
find "$APP/node_modules" -name '*.node' | sed "s#^$APP/##" | sort

step "stage /opt/robot-console/node"
mkdir -p "$STAGE/node/bin"
cp /toolchain/node/bin/node "$STAGE/node/bin/node"
cp /toolchain/node/LICENSE "$STAGE/node/LICENSE"

step "BUILD_INFO"
cat >"$STAGE/BUILD_INFO" <<EOF
name=robot-console
version=$ROBOT_CONSOLE_VERSION
deb_release=$ROBOT_CONSOLE_DEB_RELEASE
deb_version=$ROBOT_CONSOLE_VERSION-$ROBOT_CONSOLE_DEB_RELEASE
git_sha=$GIT_SHA
git_commit_time=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
packaging_dirty=$PACKAGING_DIRTY
node=v$NODE_VERSION
nfpm=v$NFPM_VERSION
base_image=$BASE_IMAGE
entry=bin/robot-console-supervisor.js
EOF
cat "$STAGE/BUILD_INFO"

step "normalize permissions and mtimes"
find /stage -type d -exec chmod 0755 {} +
find /stage -type f -perm /111 -exec chmod 0755 {} +
find /stage -type f ! -perm /111 -exec chmod 0644 {} +
find /stage -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
du -sh "$STAGE/node" "$APP/node_modules" "$APP/packages" "$STAGE"

step "nfpm pkg"
DEB="/out/robot-console_${ROBOT_CONSOLE_VERSION}-${ROBOT_CONSOLE_DEB_RELEASE}_amd64.deb"
rm -f "$DEB"
nfpm pkg --config /packaging/nfpm.yaml --packager deb --target "$DEB"
ls -l "$DEB"
sha256sum "$DEB"
step "done"
