#!/usr/bin/env bash
# Install test for the robot-console .deb. Runs as root inside a fresh
# ubuntu:24.04 linux/amd64 container (see test-install.sh).
#
# Phase A: minimal container (only the package's own dependencies; nothing
#          running): install, files and permissions, native modules, the
#          service's ExecStart serves the UI and a WebSocket snapshot, remove.
# Phase B: systemd + udev + desktop-file-utils installed (not running):
#          global unit enable, rule/unit/desktop validation, the launcher's
#          no-user-systemd fallback with a fake Chrome, apt-get purge.
set -uo pipefail

DEB="$1"
PORT=4795
ROOT=/opt/robot-console
NODE="$ROOT/node/bin/node"
APP="$ROOT/app"
UNIT=/usr/lib/systemd/user/robot-console.service
RULES=/usr/lib/udev/rules.d/70-robot-console-microbit.rules
DESKTOP=/usr/share/applications/robot-console.desktop
ICON=/usr/share/icons/hicolor/scalable/apps/robot-console.svg
LAUNCHER=/usr/bin/robot-console
WANTS=/etc/systemd/user/default.target.wants/robot-console.service
RESULTS=/tmp/results
export DEBIAN_FRONTEND=noninteractive
: >"$RESULTS"

log() { printf '\n--- %s\n' "$*"; }
check() {
  local name=$1
  shift
  if "$@"; then echo "PASS  $name" | tee -a "$RESULTS"; else echo "FAIL  $name" | tee -a "$RESULTS"; fi
}
student_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
as_student() {
  runuser -u student -- env -i HOME=/home/student USER=student LOGNAME=student \
    PATH="$student_path" "$@"
}
app_pids() { # PIDs of the bundled node running one of the app's bin/*.js
  # Parses argv as separate NUL-delimited arguments: argv[0] must be the
  # bundled node and some later argument exactly $APP/bin/*.js. Not
  # /proc/<pid>/exe and not a plain substring: under amd64 emulation (Docker
  # Desktop on arm64) exe is unreadable and extra emulator arguments are
  # injected ("node node --no-opt -r /proc/.p <script>"), while wrapper
  # processes (runuser, sh -c) carry the path inside one longer argument.
  local d first arg hit
  for d in /proc/[0-9]*; do
    first="" hit=""
    while IFS= read -r -d '' arg; do
      if [ -z "$first" ]; then first=$arg; continue; fi
      case "$arg" in "$APP"/bin/*.js) hit=1 ;; esac
    done 2>/dev/null <"$d/cmdline"
    [ "$first" = "$NODE" ] && [ -n "$hit" ] && echo "${d#/proc/}"
  done
  return 0
}
show_procs() {
  local p
  for p in $(app_pids); do printf '    pid %s: %s\n' "$p" "$(tr '\0' ' ' <"/proc/$p/cmdline")"; done
}
stop_app() {
  local pids i
  pids=$(app_pids)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  for i in $(seq 50); do [ -z "$(app_pids)" ] && return 0; sleep 0.2; done
  pids=$(app_pids)
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  return 0
}
wait_http() { # seconds
  as_student "$NODE" -e '
    const deadline = Date.now() + Number(process.argv[2]) * 1000;
    (async () => { for (;;) {
      try { await fetch(`http://127.0.0.1:${process.argv[1]}/`, { signal: AbortSignal.timeout(2000) }); process.exit(0); } catch {}
      if (Date.now() >= deadline) process.exit(1);
      await new Promise((r) => setTimeout(r, 250));
    } })();' "$PORT" "$1"
}
installed() { [ "$(dpkg-query -W -f='${db:Status-Status}' robot-console 2>/dev/null)" = installed ]; }
not_installed() { ! installed; }
mode_is() { [ "$(stat -c %a "$2")" = "$1" ]; }

########################################################################
log "Phase A: install into a bare container (no systemd, no udev)"
apt-get update -qq >/dev/null
check "A: apt-get install ./deb in a bare container" apt-get install -y -q "$DEB"
check "A: package status is installed" installed
dpkg-query -W -f='Package: ${Package}\nVersion: ${Version}\nDepends: ${Depends}\nRecommends: ${Recommends}\nInstalled-Size: ${Installed-Size} KiB\n' robot-console
cat "$ROOT/BUILD_INFO"

log "dpkg -L robot-console (node_modules collapsed)"
dpkg -L robot-console | grep -v "^$APP/node_modules/." | grep -v "^$APP/packages/.*/dist/."
echo "... plus $(dpkg -L robot-console | grep -c "^$APP/node_modules/.") node_modules entries and $(dpkg -L robot-console | grep -c "^$APP/packages/.*/dist/.") dist entries"

for f in "$NODE" "$ROOT/node/LICENSE" "$ROOT/BUILD_INFO" "$APP/package.json" "$APP/bin/robot-console.js" \
  "$APP/packages/host/dist/cli.js" "$APP/packages/protocol/dist/index.js" "$APP/packages/ui/dist/index.html" \
  "$LAUNCHER" "$UNIT" "$RULES" "$DESKTOP" "$ICON"; do
  check "A: ships $f" test -e "$f"
done
check "A: every packaged path is owned by root:root" \
  test -z "$(dpkg -L robot-console | xargs -d '\n' stat -c '%U:%G %n' | grep -v '^root:root ')"
check "A: nothing under /opt/robot-console is group/world-writable" \
  test -z "$(find "$ROOT" ! -type l -perm /022)"
check "A: launcher and node are 0755" sh -c "[ \$(stat -c %a $LAUNCHER) = 755 ] && [ \$(stat -c %a $NODE) = 755 ]"
for f in "$UNIT" "$RULES" "$DESKTOP" "$ICON"; do check "A: $(basename "$f") is 0644" mode_is 644 "$f"; done
log "native modules shipped"
find "$ROOT" -name '*.node' | sort
check "A: only linux-x64 glibc native prebuilds are shipped" \
  test -z "$(find "$ROOT" -name '*.node' | grep -Ei 'darwin|win32|android|arm|ia32|musl')"
check "A: workspace symlinks resolve (@robot-console/protocol)" test -f "$APP/node_modules/@robot-console/protocol/dist/index.js"
if command -v systemctl >/dev/null 2>&1; then
  check "A: postinst enabled the user unit globally (systemctl pulled in by deps)" test -L "$WANTS"
else
  check "A: no enable symlink without systemctl (postinst guard)" test ! -e "$WANTS"
fi
echo "udevadm: $(command -v udevadm || echo absent); systemctl: $(command -v systemctl || echo absent); udevd running: $([ -d /run/udev ] && echo yes || echo no)"

useradd -m -s /bin/bash student
log "runtime checks as non-root user 'student'"
node_version=$(as_student "$NODE" --version)
echo "node --version: $node_version"
check "A: bundled node runs as student (v$NODE_VERSION)" test "$node_version" = "v$NODE_VERSION"
check "A: native node-hid + @serialport/bindings-cpp load and enumerate; node:sqlite loads" \
  as_student sh -c "cd $APP && $NODE -e '
    const { createRequire } = require(\"node:module\");
    const r = createRequire(\"$APP/packages/host/package.json\");
    require(\"node:sqlite\");
    const HID = r(\"node-hid\");
    console.log(\"node-hid devices():\", HID.devices().length);
    const { autoDetect } = r(\"@serialport/bindings-cpp\");
    autoDetect().list().then((ports) => { console.log(\"serialport list():\", ports.length); },
      (e) => { console.error(e); process.exit(1); });
  '"

state=$(as_student mktemp -d)
exec_start=$(sed -n 's/^ExecStart=//p' "$UNIT")
echo "ExecStart: $exec_start"
as_student sh -c "ROBOT_CONSOLE_STATE_DIR=$state ROBOT_CONSOLE_NO_OPEN=1 exec $exec_start" >/tmp/host.log 2>&1 &
check "A: service ExecStart answers on 127.0.0.1:$PORT within 90 s" wait_http 90
check "A: GET / returns the UI HTML and a JS asset returns 200" as_student "$NODE" -e '
  (async () => {
    const base = `http://127.0.0.1:${process.argv[1]}`;
    const res = await fetch(`${base}/`);
    const html = await res.text();
    const m = html.match(/<script[^>]+src="([^"]+\.js)"/);
    console.log("GET /", res.status, res.headers.get("content-type"), html.length, "bytes; root div:", html.includes("id=\"root\""));
    if (res.status !== 200 || !html.includes("id=\"root\"") || !m) process.exit(1);
    const js = await fetch(new URL(m[1], base));
    const body = await js.arrayBuffer();
    console.log("GET", m[1], js.status, js.headers.get("content-type"), body.byteLength, "bytes");
    process.exit(js.status === 200 && body.byteLength > 0 ? 0 : 1);
  })().catch((e) => { console.error(e); process.exit(1); });' "$PORT"
check "A: WebSocket client receives a snapshot message" as_student "$NODE" -e '
  const ws = new WebSocket(`ws://127.0.0.1:${process.argv[1]}/`);
  setTimeout(() => { console.error("no snapshot within 20 s"); process.exit(1); }, 20000);
  ws.onerror = (e) => { console.error("ws error", e.message ?? e); process.exit(1); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    console.log("ws message type:", msg.type);
    if (msg.type === "snapshot") { console.log("snapshot keys:", Object.keys(msg).join(",")); process.exit(0); }
  };' "$PORT"
check "A: host wrote its store into ROBOT_CONSOLE_STATE_DIR" test -n "$(ls -A "$state")"
ls -l "$state"
show_procs
stop_app
check "A: host process stopped on SIGTERM" test -z "$(app_pids)"
log "host output (tail)"
tail -n 15 /tmp/host.log

check "A: robot-console --help exits 0" as_student "$LAUNCHER" --help
check "A: robot-console --version prints BUILD_INFO" sh -c "runuser -u student -- $LAUNCHER --version | grep -q '^git_sha='"

check "A: apt-get remove" apt-get remove -y -q robot-console
check "A: package no longer installed" not_installed
check "A: /opt/robot-console removed" test ! -e "$ROOT"
check "A: launcher, unit, rule, desktop file, icon removed" \
  sh -c "! ls $LAUNCHER $UNIT $RULES $DESKTOP $ICON 2>/dev/null | grep -q ."

########################################################################
log "Phase B: systemd + udev + desktop-file-utils present (not running)"
apt-get install -y -q --no-install-recommends systemd udev desktop-file-utils >/dev/null 2>&1
check "B: apt-get install ./deb with systemctl/udevadm present" apt-get install -y -q "$DEB"
check "B: postinst enabled the user unit globally" test -L "$WANTS"
ls -l "$WANTS"
check "B: udevadm verify accepts the rules file" udevadm verify "$RULES"
check "B: systemd-analyze verify accepts the user unit" systemd-analyze verify --man=no "$UNIT"
check "B: desktop-file-validate accepts the .desktop file" desktop-file-validate "$DESKTOP"
desktop-file-validate "$DESKTOP" 2>&1 | sed 's/^/    /'

log "launcher: no user systemd session -> detached fallback, fake google-chrome"
mkdir -p /tmp/fakebin
cat >/tmp/fakebin/google-chrome <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >/tmp/chrome-args
EOF
chmod 0755 /tmp/fakebin/google-chrome
student_path="/tmp/fakebin:$student_path"
check "B: launcher exits 0 after starting the server and opening Chrome" timeout 120 \
  runuser -u student -- env -i HOME=/home/student USER=student LOGNAME=student PATH="$student_path" \
  ROBOT_CONSOLE_WAIT_SECONDS=90 "$LAUNCHER"
echo "chrome args:"; sed 's/^/    /' /tmp/chrome-args 2>/dev/null
check "B: Chrome got --app/--class/--user-data-dir" sh -c "
  grep -qx -- '--app=http://localhost:$PORT/' /tmp/chrome-args &&
  grep -qx -- '--class=RobotConsole' /tmp/chrome-args &&
  grep -qx -- '--user-data-dir=/home/student/.local/share/robot-console/chrome' /tmp/chrome-args"
check "B: detached server keeps answering after the launcher exits" wait_http 5
check "B: fallback log at ~/.local/state/robot-console/supervisor.log" \
  test -s /home/student/.local/state/robot-console/supervisor.log
rm -f /tmp/chrome-args
check "B: second launch finds the running server and opens Chrome again" sh -c "
  timeout 30 runuser -u student -- env -i HOME=/home/student USER=student PATH='$student_path' \
    ROBOT_CONSOLE_WAIT_SECONDS=5 $LAUNCHER && test -s /tmp/chrome-args"
check "B: exactly one server process after two launches" test "$(app_pids | wc -l)" = 1
show_procs
echo "launcher log (tail):"
tail -n 5 /home/student/.local/state/robot-console/supervisor.log 2>/dev/null | sed 's/^/    /'
stop_app

check "B: apt-get purge" apt-get purge -y -q robot-console
check "B: package no longer installed" not_installed
check "B: global enable symlink removed" test ! -e "$WANTS"
check "B: /opt/robot-console removed" test ! -e "$ROOT"

########################################################################
log "SUMMARY"
cat "$RESULTS"
fails=$(grep -c '^FAIL' "$RESULTS")
passes=$(grep -c '^PASS' "$RESULTS")
if [ "$fails" = 0 ]; then
  echo "RESULT: PASS ($passes checks)"
  exit 0
fi
echo "RESULT: FAIL ($fails of $((passes + fails)) checks failed)"
exit 1
