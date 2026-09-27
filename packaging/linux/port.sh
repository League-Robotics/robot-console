# shellcheck shell=sh
# robot-console per-user port helper. POSIX sh; installed at
# /opt/robot-console/lib/port.sh and sourced (never executed directly) by
# both packaging/linux/robot-console-serve (the systemd unit's start
# wrapper) and packaging/linux/robot-console.sh (the interactive
# launcher), so both compute the exact same default.
#
# Design: "start on demand, port per user" (see docs/linux-install.md,
# "How it works"). The old package enabled one systemd unit globally and
# every logged-in user's instance raced for the same fixed
# 127.0.0.1:4795/4796 -- the first bound, the rest crash-looped against
# it. Deriving the default port from the caller's uid instead means every
# user gets their own, private, stable pair of ports with no shared
# state and no coordination needed.
#
# robot_console_default_port() prints this user's default *public* port
# on stdout:
#
#   PORT = 20000 + (uid % 6000) * 2
#
# which spans 20000..31998 (6000 distinct uids, 2 apart) -- comfortably
# below Linux's ephemeral port range (32768 and up on most distros; see
# /proc/sys/net/ipv4/ip_local_port_range), so a per-user default here
# can never collide with a port the kernel hands out on its own to some
# unrelated program. The host (child process) port is always the public
# port + 1; callers needing it compute that themselves rather than this
# helper defining a second function, since it is a pure function of the
# public port.
#
# ROBOT_CONSOLE_PORT / ROBOT_CONSOLE_HOST_PORT still override: this
# helper only supplies the *default* when a caller has not already set
# one, and it never reads those variables itself.
robot_console_default_port() {
  uid="$(id -u)"
  echo $(( 20000 + (uid % 6000) * 2 ))
}
