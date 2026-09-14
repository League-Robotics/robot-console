#!/bin/sh
# robot-console postrm. POSIX sh; never fails because udev/systemd is absent.
# Per-user state (~/.local/state/robot-console, ~/.local/share/robot-console)
# is left in home directories, also on purge.
set -e

case "${1:-}" in
  remove|purge)
    # Belt and braces: drop a leftover enable symlink if prerm could not.
    rm -f /etc/systemd/user/default.target.wants/robot-console.service
    rmdir /etc/systemd/user/default.target.wants 2>/dev/null || true

    if command -v udevadm >/dev/null 2>&1 && [ -d /run/udev ]; then
      udevadm control --reload-rules >/dev/null 2>&1 || true
    fi
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] &&
      command -v loginctl >/dev/null 2>&1; then
      for user in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $2}'); do
        systemctl --user -M "$user@" daemon-reload >/dev/null 2>&1 || true
      done
    fi
    ;;
esac

exit 0
