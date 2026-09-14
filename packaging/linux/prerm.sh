#!/bin/sh
# robot-console prerm. POSIX sh; never fails because systemd is absent.
set -e

UNIT=robot-console.service

case "${1:-}" in
  remove|deconfigure)
    if command -v systemctl >/dev/null 2>&1; then
      # Stop running instances for logged-in users before the files go away.
      if [ -d /run/systemd/system ] && command -v loginctl >/dev/null 2>&1; then
        for user in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $2}'); do
          systemctl --user -M "$user@" stop "$UNIT" >/dev/null 2>&1 || true
        done
      fi
      systemctl --global disable "$UNIT" >/dev/null 2>&1 || true
    fi
    ;;
esac

exit 0
