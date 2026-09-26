#!/usr/bin/env bash
# Install test for the robot-console .deb. Runs as root inside a fresh
# ubuntu:24.04 linux/amd64 container (see test-install.sh).
#
# Phase A: minimal container (only the package's own dependencies; nothing
#          running): install, files and permissions, native modules, then the
#          service's ExecStart (the supervisor) end to end: UI and icons with
#          the host stopped, host started by a WebSocket, reconnect within the
#          grace, idle stop, SIGTERM cleanup. Then remove.
# Phase B: systemd + udev + desktop-file-utils installed (not running):
#          global unit enable, rule/unit/desktop validation, the launcher's
#          no-user-systemd fallback (runs the supervisor) with a fake Chrome,
#          purge.
set -uo pipefail

DEB="$1"
PORT=4795
HOST_PORT=4796
ROOT=/opt/robot-console
NODE="$ROOT/node/bin/node"
APP="$ROOT/app"
SUP_JS="$APP/bin/robot-console-supervisor.js"
HOST_JS="$APP/bin/robot-console.js"
UI_DIST="$APP/packages/ui/dist"
UNIT=/usr/lib/systemd/user/robot-console.service
RULES=/usr/lib/udev/rules.d/70-robot-console-microbit.rules
DESKTOP=/usr/share/applications/robot-console.desktop
ICON_SVG=/usr/share/icons/hicolor/scalable/apps/robot-console.svg
ICON_192=/usr/share/icons/hicolor/192x192/apps/robot-console.png
ICON_512=/usr/share/icons/hicolor/512x512/apps/robot-console.png
LAUNCHER=/usr/bin/robot-console
WANTS=/etc/systemd/user/default.target.wants/robot-console.service
CONF=/etc/robot-console/robot-console.env
RELAY_SRC=https://github.com/League-Robotics/microbit-radio-relay:latest
ROBOT_SRC=https://github.com/League-Robotics/nezha-robot-template:latest
IDLE_MS=3000
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

# PIDs of the bundled node running exactly script $1. Parses argv as separate
# NUL-delimited arguments: argv[0] must be the bundled node and a later
# argument exactly $1. Not /proc/<pid>/exe and not a substring: under amd64
# emulation (Docker Desktop on arm64) exe is unreadable and emulator arguments
# are injected ("node node --no-opt -r /proc/.p <script>"), while wrappers
# (runuser, sh -c) carry the path inside one longer argument.
pids_running() {
  local d first arg hit
  for d in /proc/[0-9]*; do
    first="" hit=""
    while IFS= read -r -d '' arg; do
      if [ -z "$first" ]; then first=$arg; continue; fi
      [ "$arg" = "$1" ] && hit=1
    done 2>/dev/null <"$d/cmdline"
    [ "$first" = "$NODE" ] && [ -n "$hit" ] && echo "${d#/proc/}"
  done
  return 0
}
sup_pids() { pids_running "$SUP_JS"; }
host_pids() { pids_running "$HOST_JS"; }
all_pids() { sup_pids; host_pids; }
show_procs() {
  local p
  for p in $(all_pids); do printf '    pid %s: %s\n' "$p" "$(tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null)"; done
}
stop_all() {
  local pids i
  pids=$(all_pids)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  for i in $(seq 150); do [ -z "$(all_pids)" ] && return 0; sleep 0.2; done
  pids=$(all_pids)
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  return 0
}
wait_gone() { # seconds: no supervisor and no host process left
  local end=$((SECONDS + $1))
  while [ "$SECONDS" -le "$end" ]; do [ -z "$(all_pids)" ] && return 0; sleep 0.2; done
  return 1
}
listening() { # port: some TCP socket in LISTEN on it
  local hex
  hex=$(printf ':%04X' "$1")
  awk -v h="$hex" '$4 == "0A" && substr($2, length($2) - 4) == h { found = 1 } END { exit !found }' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null
}
no_host() { [ -z "$(host_pids)" ] && ! listening "$HOST_PORT"; }
no_listeners() { ! listening "$PORT" && ! listening "$HOST_PORT"; }
count_is() { [ "$("$2" | wc -l)" = "$1" ]; }
one_supervisor_no_host() { count_is 1 sup_pids && no_host; }
wait_file() { # path seconds
  local end=$((SECONDS + $2))
  while [ "$SECONDS" -le "$end" ]; do [ -e "$1" ] && return 0; sleep 0.2; done
  return 1
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
http_ok() { # path: 200 with a non-empty body
  as_student "$NODE" -e '
    fetch(`http://127.0.0.1:${process.argv[1]}${process.argv[2]}`).then(async (r) => {
      const b = await r.arrayBuffer();
      console.log("GET", process.argv[2], r.status, r.headers.get("content-type"), b.byteLength, "bytes");
      process.exit(r.status === 200 && b.byteLength > 0 ? 0 : 1);
    }, (e) => { console.error(e.message); process.exit(1); });' "$PORT" "$1"
}
# Fetch /__supervisor/status; sets S_hostState S_hostPid S_connections
# S_restarts S_lastExitExpected and prints the raw JSON.
sup_status() {
  local out
  out=$(as_student "$NODE" -e '
    fetch(`http://127.0.0.1:${process.argv[1]}/__supervisor/status`).then((r) => r.json()).then((s) => {
      console.error("    status:", JSON.stringify(s));
      const le = s.lastExit;
      console.log(`S_hostState=${s.hostState} S_hostPid=${s.hostPid ?? "none"} S_connections=${s.connections} ` +
        `S_restarts=${s.restarts} S_lastExitExpected=${le ? le.expected : "none"}`);
    }, (e) => { console.error(e.message); process.exit(1); });' "$PORT") || return 1
  eval "$out"
}
host_state_is() { sup_status && [ "$S_hostState" = "$1" ]; }
wait_host_state() { # state seconds
  local end=$((SECONDS + $2))
  while [ "$SECONDS" -le "$end" ]; do
    sup_status 2>/dev/null && [ "$S_hostState" = "$1" ] && return 0
    sleep 0.2
  done
  return 1
}
# ws_open TAG: a student WebSocket client through the supervisor. Writes
# /tmp/ws-snap-TAG on the first snapshot, closes when /tmp/ws-close-TAG
# appears, and writes /tmp/ws-done-TAG once closed.
ws_open() {
  rm -f "/tmp/ws-snap-$1" "/tmp/ws-fw-$1" "/tmp/ws-close-$1" "/tmp/ws-done-$1"
  as_student "$NODE" -e '
    const fs = require("node:fs");
    const [port, tag] = process.argv.slice(1);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.onerror = (e) => { console.error(`ws ${tag} error`, e.message ?? ""); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type !== "snapshot") return;
      // Firmware field of the latest snapshot (the first snapshot can precede
      // the release lookups of the firmware watcher, so checks poll this file).
      fs.writeFileSync(`/tmp/ws-fw-${tag}`, JSON.stringify(msg.firmware ?? null));
      if (!fs.existsSync(`/tmp/ws-snap-${tag}`))
        fs.writeFileSync(`/tmp/ws-snap-${tag}`, Object.keys(msg).join(",") + "\n");
    };
    ws.onclose = (ev) => { fs.writeFileSync(`/tmp/ws-done-${tag}`, `${ev.code}\n`); process.exit(0); };
    setInterval(() => { if (fs.existsSync(`/tmp/ws-close-${tag}`)) ws.close(); }, 100);
    setTimeout(() => process.exit(2), 300000);
  ' "$PORT" "$1" &
}
ws_close() { touch "/tmp/ws-close-$1"; wait_file "/tmp/ws-done-$1" 15; }
installed() { [ "$(dpkg-query -W -f='${db:Status-Status}' robot-console 2>/dev/null)" = installed ]; }
not_installed() { ! installed; }
mode_is() { [ "$(stat -c %a "$2")" = "$1" ]; }
no_native_errors() { ! grep -Eq 'ERR_DLOPEN|cannot open shared object' "$1"; }
at_most() { [ "$1" -le "$2" ]; }
dpkg_status_is() { [ "$(dpkg-query -W -f='${db:Status-Status}' robot-console 2>/dev/null)" = "$1" ]; }
conffile_mode_ok() { [ "$(stat -c '%a %U:%G' "$CONF")" = "644 root:root" ]; }
conffile_values_ok() { # exactly the two public firmware sources, nothing else assigned
  grep -qxF "ROBOT_CONSOLE_RELAY_FIRMWARE=$RELAY_SRC" "$CONF" &&
    grep -qxF "ROBOT_CONSOLE_ROBOT_FIRMWARE=$ROBOT_SRC" "$CONF" &&
    [ "$(grep -cE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$CONF")" = 2 ]
}
conffile_listed() {
  local c
  c=$(dpkg-query -W -f='${Conffiles}\n' robot-console)
  echo "    Conffiles:$c"
  grep -qF " $CONF " <<<"$c"
}
# firmware_ok TAG JS-EXPRESSION: poll the latest snapshot's firmware field
# (fw) from that client for up to 30 s until the expression holds. The first
# snapshot is sent before the firmware watcher has resolved the release
# sources, so a single-snapshot check would be wrong. (The host's environment
# can't be inspected directly: under amd64 emulation /proc/<pid>/environ of
# another process is unreadable even for root, so the snapshot is the proof.)
firmware_ok() {
  "$NODE" -e '
    const fs = require("node:fs");
    const [file, expr] = process.argv.slice(1);
    const test = new Function("fw", `return (${expr});`);
    const deadline = Date.now() + 30000;
    let last = "(no snapshot)";
    (function poll() {
      try {
        last = fs.readFileSync(file, "utf8");
        if (test(JSON.parse(last))) { console.log("    firmware:", last); process.exit(0); }
      } catch {}
      if (Date.now() >= deadline) { console.log("    firmware (last seen):", last); process.exit(1); }
      setTimeout(poll, 250);
    })();' "/tmp/ws-fw-$1" "$2"
}

########################################################################
log "Phase A: install into a minimal container (nothing running)"
apt-get update -qq >/dev/null

# mbtools (mbregistry) is a separately installed prerequisite robot-console
# does not bundle (see README): the host has no direct-USB fallback and
# fails startup without an `mbregistry` binary on $PATH. Install it here,
# before the supervisor is ever started below, the same way an admin would
# (packaging/deb/install-mbtools.sh from League-Microbit/mbtools, pinned to
# MBTOOLS_VERSION in pins.env). Idempotent and safe to run as plain root
# (no sudo) since this container has no systemd running yet -- its postinst
# skips the `systemctl enable/restart mbregistry.service` step in that case
# (guarded on `/run/systemd/system`), so this only installs the binaries.
apt-get install -y -q --no-install-recommends curl ca-certificates >/dev/null
log "installing mbtools $MBTOOLS_VERSION (mbregistry) -- required for the host to start"
curl -fsSL https://raw.githubusercontent.com/League-Microbit/mbtools/main/packaging/deb/install-mbtools.sh \
  | sh -s -- "$MBTOOLS_VERSION"
check "A: mbregistry is on \$PATH after installing mbtools" sh -c 'command -v mbregistry'

check "A: apt-get install ./deb" apt-get install -y -q "$DEB"
check "A: package status is installed" installed
dpkg-query -W -f='Package: ${Package}\nVersion: ${Version}\nDepends: ${Depends}\nRecommends: ${Recommends}\nInstalled-Size: ${Installed-Size} KiB\n' robot-console
cat "$ROOT/BUILD_INFO"

log "dpkg -L robot-console (node_modules and dist collapsed)"
dpkg -L robot-console | grep -v "^$APP/node_modules/." | grep -v "^$APP/packages/.*/dist/."
echo "... plus $(dpkg -L robot-console | grep -c "^$APP/node_modules/.") node_modules entries and $(dpkg -L robot-console | grep -c "^$APP/packages/.*/dist/.") dist entries"

for f in "$NODE" "$ROOT/node/LICENSE" "$ROOT/BUILD_INFO" "$APP/package.json" "$SUP_JS" "$HOST_JS" \
  "$APP/packages/host/dist/cli.js" "$APP/packages/host/dist/supervisor/cli.js" \
  "$APP/packages/protocol/dist/index.js" "$UI_DIST/index.html" "$UI_DIST/manifest.webmanifest" \
  "$LAUNCHER" "$UNIT" "$RULES" "$DESKTOP" "$ICON_SVG" "$ICON_192" "$ICON_512"; do
  check "A: ships $f" test -e "$f"
done
check "A: BUILD_INFO entry is the supervisor" grep -qx 'entry=bin/robot-console-supervisor.js' "$ROOT/BUILD_INFO"
deb_version=$(sed -n 's/^deb_version=//p' "$ROOT/BUILD_INFO")
check "A: dpkg Version equals BUILD_INFO deb_version ($deb_version)" \
  test "$(dpkg-query -W -f='${Version}' robot-console)" = "$deb_version"
check "A: Debian revision is part of the version (<version>-<release>)" \
  test "$deb_version" = "$(sed -n 's/^version=//p' "$ROOT/BUILD_INFO")-$(sed -n 's/^deb_release=//p' "$ROOT/BUILD_INFO")"
log "firmware-source conffile"
cat "$CONF"
check "A: ships the conffile $CONF" test -f "$CONF"
check "A: $CONF is 0644 root:root" conffile_mode_ok
check "A: $CONF sets exactly the relay and robot firmware release sources" conffile_values_ok
check "A: dpkg lists $CONF in Conffiles" conffile_listed
check "A: every packaged path is owned by root:root" \
  test -z "$(dpkg -L robot-console | xargs -d '\n' stat -c '%U:%G %n' | grep -v '^root:root ')"
check "A: nothing under /opt/robot-console is group/world-writable" \
  test -z "$(find "$ROOT" ! -type l -perm /022)"
check "A: launcher and node are 0755" sh -c "[ \$(stat -c %a $LAUNCHER) = 755 ] && [ \$(stat -c %a $NODE) = 755 ]"
for f in "$UNIT" "$RULES" "$DESKTOP" "$ICON_SVG" "$ICON_192" "$ICON_512"; do
  check "A: $f is 0644" mode_is 644 "$f"
done
check "A: hicolor icons are the UI's own icon.svg / icon-192.png / icon-512.png" sh -c "
  cmp -s $ICON_SVG $UI_DIST/icon.svg && cmp -s $ICON_192 $UI_DIST/icon-192.png && cmp -s $ICON_512 $UI_DIST/icon-512.png"
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

log "unit file and launcher entry"
cat "$UNIT"
exec_start=$(sed -n 's/^ExecStart=//p' "$UNIT")
check "A: unit ExecStart runs the supervisor with the bundled node" test "$exec_start" = "$NODE $SUP_JS"
check "A: unit has Restart=on-failure" grep -qx 'Restart=on-failure' "$UNIT"
check "A: unit has TimeoutStopSec=150" grep -qx 'TimeoutStopSec=150' "$UNIT"
check "A: unit leaves KillMode at the default (control-group)" sh -c "! grep -q '^KillMode=' $UNIT"
check "A: unit EnvironmentFile= lines: -$CONF, then the per-user -%E/robot-console/robot-console.env" \
  test "$(sed -n 's/^EnvironmentFile=//p' "$UNIT" | tr '\n' ' ')" = "-$CONF -%E/robot-console/robot-console.env "
check "A: launcher ENTRY is the supervisor" grep -qxF 'ENTRY="$ROOT/app/bin/robot-console-supervisor.js"' "$LAUNCHER"

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

log "supervisor: the unit's ExecStart with ROBOT_CONSOLE_IDLE_MS=$IDLE_MS"
state=$(as_student mktemp -d)
# Apply the unit's EnvironmentFile= list the way systemd does: in order, "-"
# marks a file optional (%-specifier paths are per-user files the student
# does not have), variables exported into the supervisor's environment.
env_load="set -a;"
for f in $(sed -n 's/^EnvironmentFile=-\{0,1\}//p' "$UNIT"); do
  case "$f" in *%*) continue ;; esac
  env_load="$env_load [ -r $f ] && . $f;"
done
env_load="$env_load set +a;"
echo "    EnvironmentFile simulation: $env_load"
as_student sh -c "$env_load ROBOT_CONSOLE_STATE_DIR=$state ROBOT_CONSOLE_IDLE_MS=$IDLE_MS exec $exec_start" \
  >/tmp/supervisor.log 2>&1 &
sup_wrapper=$!
check "A: supervisor answers on 127.0.0.1:$PORT within 90 s" wait_http 90
check "A: exactly one supervisor process" count_is 1 sup_pids

log "(a) UI served while the host is stopped"
check "A(a): GET / returns the UI HTML and its JS asset returns 200" as_student "$NODE" -e '
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
for p in /manifest.webmanifest /icon.svg /icon-192.png /icon-512.png; do
  check "A(a): supervisor serves $p (200)" http_ok "$p"
done
check "A(a): status hostState=stopped before any window connects" host_state_is stopped
check "A(a): no host process and nothing listening on :$HOST_PORT" no_host

log "(b) a WebSocket connect starts the host; snapshot through the proxy"
ws_open c1
check "A(b): WebSocket via the supervisor receives the real host's snapshot" wait_file /tmp/ws-snap-c1 90
echo "    snapshot keys: $(cat /tmp/ws-snap-c1 2>/dev/null)"
sup_status
check "A(b): status hostState=running, connections=1" test "$S_hostState:$S_connections" = running:1
p1=$S_hostPid
show_procs
check "A(b): exactly one host process and it is status.hostPid ($p1)" test "$(host_pids)" = "$p1"
check "A(b): host listens on 127.0.0.1:$HOST_PORT" listening "$HOST_PORT"
check "A(b): host wrote its store into ROBOT_CONSOLE_STATE_DIR" test -n "$(ls -A "$state")"
ls -l "$state"
check "A(b): no native-module load errors (ERR_DLOPEN) in the supervisor/host log" no_native_errors /tmp/supervisor.log
# The fresh state dir has no .env and this is no checkout, so the supervisor's
# environment (the unit's EnvironmentFile=, passed on to the host) is the only
# possible source of these values.
check "A(b): host snapshot reaches firmware.relay.configured === true and firmware.robot.configured === true (30 s)" \
  firmware_ok c1 'fw.relay.configured === true && fw.robot.configured === true'
check "A(b): snapshot firmware sources are the conffile's repositories (env passed supervisor -> host)" firmware_ok c1 \
  'fw.relay.repoUrl === "https://github.com/League-Robotics/microbit-radio-relay" && fw.robot.repoUrl === "https://github.com/League-Robotics/nezha-robot-template"'

log "(d) reconnect inside the ${IDLE_MS} ms grace keeps the host"
check "A(d): client c1 disconnects" ws_close c1
ws_open c2
check "A(d): reconnect within the grace receives a snapshot" wait_file /tmp/ws-snap-c2 20
sup_status
check "A(d): same hostPid after the reconnect ($S_hostPid = $p1)" test "$S_hostPid" = "$p1"
check "A(d): status running, connections=1, restarts=0" test "$S_hostState:$S_connections:$S_restarts" = running:1:0

log "(c) idle stop after the last client disconnects"
t0=$(date +%s%N)
check "A(c): client c2 disconnects" ws_close c2
check "A(c): status reaches hostState=stopped within 30 s" wait_host_state stopped 30
stop_ms=$((($(date +%s%N) - t0) / 1000000))
echo "    host stopped ${stop_ms} ms after the disconnect (idle ${IDLE_MS} ms)"
check "A(c): host stopped within idle time + 7 s emulation slack (${stop_ms} ms)" at_most "$stop_ms" $((IDLE_MS + 7000))
check "A(c): stop was not premature (>= ${IDLE_MS} ms after the disconnect)" at_most "$IDLE_MS" "$stop_ms"
check "A(c): lastExit.expected=true" test "$S_lastExitExpected" = true
check "A(c): no host process and nothing listening on :$HOST_PORT" no_host
check "A(c): supervisor still running and serving /" http_ok /

log "(e) SIGTERM on the supervisor while the host runs"
ws_open c3
check "A(e): host running again (snapshot via a new connection)" wait_file /tmp/ws-snap-c3 90
show_procs
sup=$(sup_pids)
kill -TERM $sup
check "A(e): supervisor and host processes gone within 60 s of SIGTERM" wait_gone 60
wait "$sup_wrapper"
sup_rc=$?
check "A(e): supervisor exited 0" test "$sup_rc" = 0
check "A(e): nothing listening on :$PORT or :$HOST_PORT" no_listeners
touch /tmp/ws-close-c3
wait_file /tmp/ws-done-c3 10 >/dev/null
check "A: no native-module load errors in the full supervisor/host log" no_native_errors /tmp/supervisor.log
log "supervisor/host log (tail)"
tail -n 25 /tmp/supervisor.log
stop_all

check "A: robot-console --help exits 0" as_student "$LAUNCHER" --help
check "A: robot-console --version prints BUILD_INFO" sh -c "runuser -u student -- $LAUNCHER --version | grep -q '^git_sha='"

check "A: apt-get remove" apt-get remove -y -q robot-console
check "A: package no longer installed" not_installed
check "A: /opt/robot-console removed" test ! -e "$ROOT"
conffile_kept_after_remove() { [ -f "$CONF" ] && dpkg_status_is config-files; }
check "A: remove keeps $CONF (package in dpkg config-files state)" conffile_kept_after_remove
echo "    dpkg status after remove: $(dpkg-query -W -f='${db:Status-Status}' robot-console 2>&1)"
check "A: launcher, unit, rule, desktop file, icons removed" \
  sh -c "! ls $LAUNCHER $UNIT $RULES $DESKTOP $ICON_SVG $ICON_192 $ICON_512 2>/dev/null | grep -q ."

########################################################################
log "Phase B: systemd + udev + desktop-file-utils present (not running)"
apt-get install -y -q --no-install-recommends systemd udev desktop-file-utils >/dev/null 2>&1
check "B: apt-get install ./deb with systemctl/udevadm present" apt-get install -y -q "$DEB"
check "B: postinst enabled the user unit globally" test -L "$WANTS"
ls -l "$WANTS"
check "B: dpkg lists $CONF in Conffiles" conffile_listed
echo '# local edit: lab admin' >>"$CONF"
check "B: apt-get install ./deb again (same version) succeeds" apt-get install -y -q "$DEB"
check "B: apt-get install --reinstall ./deb (unpacks the package again) succeeds" apt-get install --reinstall -y -q "$DEB"
check "B: the locally edited conffile survives the reinstall (noreplace)" grep -qxF '# local edit: lab admin' "$CONF"
check "B: no .dpkg-new/.dpkg-dist/.dpkg-old copies next to the conffile" \
  test -z "$(ls /etc/robot-console | grep -F .dpkg-)"
check "B: udevadm verify accepts the rules file" udevadm verify "$RULES"
check "B: systemd-analyze verify accepts the user unit" systemd-analyze verify --man=no "$UNIT"
check "B: desktop-file-validate accepts the .desktop file" desktop-file-validate "$DESKTOP"
check "B: desktop-file-validate prints no hints or warnings" test -z "$(desktop-file-validate "$DESKTOP" 2>&1)"

log "(f) launcher: no user systemd session -> detached fallback, fake google-chrome"
mkdir -p /tmp/fakebin
cat >/tmp/fakebin/google-chrome <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >/tmp/chrome-args
EOF
chmod 0755 /tmp/fakebin/google-chrome
student_path="/tmp/fakebin:$student_path"
SUP_LOG=/home/student/.local/state/robot-console/supervisor.log
OVERRIDE_SRC=https://github.com/example/override-robot:v1
USER_CONF=/home/student/.config/robot-console/robot-console.env
as_student sh -c "mkdir -p /home/student/.config/robot-console &&
  printf 'ROBOT_CONSOLE_ROBOT_FIRMWARE=%s\n' '$OVERRIDE_SRC' >$USER_CONF"
check "B(f): launcher exits 0 after starting the server and opening Chrome" timeout 120 \
  runuser -u student -- env -i HOME=/home/student USER=student LOGNAME=student PATH="$student_path" \
  ROBOT_CONSOLE_WAIT_SECONDS=90 "$LAUNCHER"
echo "chrome args:"; sed 's/^/    /' /tmp/chrome-args 2>/dev/null
check "B(f): Chrome got --app/--class/--user-data-dir" sh -c "
  grep -qx -- '--app=http://localhost:$PORT/' /tmp/chrome-args &&
  grep -qx -- '--class=RobotConsole' /tmp/chrome-args &&
  grep -qx -- '--user-data-dir=/home/student/.local/share/robot-console/chrome' /tmp/chrome-args"
check "B(f): detached server keeps answering after the launcher exits" wait_http 5
show_procs
check "B(f): the detached process is the supervisor, and no host runs without a window" one_supervisor_no_host
check "B(f): status hostState=stopped" host_state_is stopped
check "B(f): fallback log ~/.local/state/robot-console/supervisor.log names the supervisor" \
  grep -qF "starting $SUP_JS" "$SUP_LOG"
rm -f /tmp/chrome-args
check "B(f): second launch finds the running server and opens Chrome again" sh -c "
  timeout 30 runuser -u student -- env -i HOME=/home/student USER=student PATH='$student_path' \
    ROBOT_CONSOLE_WAIT_SECONDS=5 $LAUNCHER && test -s /tmp/chrome-args"
check "B(f): still exactly one supervisor and no host after two launches" one_supervisor_no_host
ws_open f1
check "B(f): a window's WebSocket starts the host and receives a snapshot" wait_file /tmp/ws-snap-f1 90
check "B(f): snapshot: relay from the conffile, robot from the per-user file, both configured" firmware_ok f1 \
  'fw.relay.configured === true && fw.robot.configured === true && JSON.stringify(fw.relay).includes("League-Robotics/microbit-radio-relay") && JSON.stringify(fw.robot).includes("example/override-robot")'
ws_close f1 >/dev/null
echo "launcher log (tail):"
tail -n 5 "$SUP_LOG" 2>/dev/null | sed 's/^/    /'
stop_all

check "B: apt-get purge" apt-get purge -y -q robot-console
check "B: package no longer installed" not_installed
check "B: global enable symlink removed" test ! -e "$WANTS"
check "B: /opt/robot-console removed" test ! -e "$ROOT"
check "B: purge removes $CONF and /etc/robot-console" test ! -e /etc/robot-console

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
