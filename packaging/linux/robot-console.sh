#!/bin/sh
# robot-console launcher, installed as /usr/bin/robot-console by the .deb.
#
# 1. If nothing answers on http://127.0.0.1:$PORT/, start the server: the
#    per-user systemd service when there is a user systemd session, else a
#    detached background process logging to the state directory.
# 2. Wait for the port, then open the UI as a Chrome app window with its own
#    profile (so --class/StartupWMClass gives it its own dock icon).
set -u

ROOT=/opt/robot-console
NODE="$ROOT/node/bin/node"
# PHASE 1: plain host. Phase 2 switches to bin/robot-console-supervisor.js
# (keep in sync with ExecStart in robot-console.service).
ENTRY="$ROOT/app/bin/robot-console.js"
DEFAULT_PORT=4795
PORT="${ROBOT_CONSOLE_PORT:-$DEFAULT_PORT}"
URL="http://localhost:$PORT/"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/robot-console"
CHROME_PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/robot-console/chrome"
WAIT_SECONDS="${ROBOT_CONSOLE_WAIT_SECONDS:-15}"

usage() {
  cat <<EOF
Usage: robot-console [--no-browser] [--version] [--help]

Starts the Robot Console server if it is not already running on
127.0.0.1:$PORT, then opens it as a Google Chrome app window.

  --no-browser  only make sure the server is running; do not open a window
  --version     print the installed package build information
  --help        show this help

Environment:
  ROBOT_CONSOLE_PORT          port to use (default $DEFAULT_PORT; a non-default
                              port bypasses the systemd user service)
  ROBOT_CONSOLE_WAIT_SECONDS  how long to wait for the server (default 15)

Server logs: journalctl --user -u robot-console
             (or $STATE_DIR/supervisor.log without systemd)
EOF
}

open_browser=1
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --version) cat "$ROOT/BUILD_INFO"; exit 0 ;;
    --no-browser) open_browser=0 ;;
    *) echo "robot-console: unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

# Exit 0 as soon as anything answers HTTP on 127.0.0.1:$PORT, 1 after $1
# seconds. Uses the bundled Node (curl is not on a default Ubuntu desktop).
wait_for_server() {
  "$NODE" -e '
    const port = Number(process.argv[1]);
    const deadline = Date.now() + Number(process.argv[2]) * 1000;
    (async () => {
      for (;;) {
        try {
          await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
          process.exit(0);
        } catch {}
        if (Date.now() >= deadline) process.exit(1);
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
  ' "$PORT" "$1"
}

start_server() {
  if [ "$PORT" = "$DEFAULT_PORT" ] && command -v systemctl >/dev/null 2>&1 &&
    systemctl --user start robot-console.service >/dev/null 2>&1; then
    how="systemd user service (journalctl --user -u robot-console)"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  log="$STATE_DIR/supervisor.log"
  how="background process (log: $log)"
  printf '\n--- %s robot-console launcher starting %s\n' "$(date -Is)" "$ENTRY" >>"$log"
  if command -v setsid >/dev/null 2>&1; then
    ROBOT_CONSOLE_PORT="$PORT" ROBOT_CONSOLE_NO_OPEN=1 \
      setsid nohup "$NODE" "$ENTRY" --no-open </dev/null >>"$log" 2>&1 &
  else
    ROBOT_CONSOLE_PORT="$PORT" ROBOT_CONSOLE_NO_OPEN=1 \
      nohup "$NODE" "$ENTRY" --no-open </dev/null >>"$log" 2>&1 &
  fi
}

if ! wait_for_server 0; then
  start_server
  if ! wait_for_server "$WAIT_SECONDS"; then
    echo "robot-console: server did not answer on 127.0.0.1:$PORT within ${WAIT_SECONDS}s" >&2
    echo "robot-console: started via $how" >&2
    command -v notify-send >/dev/null 2>&1 &&
      notify-send "Robot Console" "The server did not start. See: $how" >/dev/null 2>&1
    exit 1
  fi
fi

[ "$open_browser" = 1 ] || exit 0

for browser in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$browser" >/dev/null 2>&1; then
    mkdir -p "$CHROME_PROFILE"
    exec "$browser" --app="$URL" --class=RobotConsole \
      --user-data-dir="$CHROME_PROFILE" --no-first-run --no-default-browser-check
  fi
done

if command -v xdg-open >/dev/null 2>&1; then
  echo "robot-console: Google Chrome not found; opening the default browser" >&2
  exec xdg-open "$URL"
fi

echo "robot-console: no browser found; open $URL yourself" >&2
exit 1
