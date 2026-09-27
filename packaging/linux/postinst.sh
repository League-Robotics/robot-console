#!/bin/sh
# robot-console postinst. POSIX sh, idempotent; never fails the install
# because udev or systemd is absent or not running (containers, chroots).
set -e

UNIT=robot-console.service

# Apply the micro:bit udev rule to boards that are already plugged in.
if command -v udevadm >/dev/null 2>&1 && [ -d /run/udev ]; then
  udevadm control --reload-rules >/dev/null 2>&1 || true
  udevadm trigger --action=change \
    --subsystem-match=usb --subsystem-match=hidraw --subsystem-match=tty \
    >/dev/null 2>&1 || true
fi

if command -v systemctl >/dev/null 2>&1; then
  # Static unit, started on demand by the launcher (see robot-console.service:
  # it ships with no [Install] section and cannot be enabled) -- never
  # `--global enable` it. Clean up an earlier version's global enable
  # (offline symlink operation, works without a running systemd); belt and
  # braces alongside postrm.sh's own rm/rmdir, since `--global disable`
  # already removes the symlink itself when it finds one.
  systemctl --global disable "$UNIT" >/dev/null 2>&1 || true
  rm -f /etc/systemd/user/default.target.wants/"$UNIT"
  rmdir /etc/systemd/user/default.target.wants 2>/dev/null || true

  # Tell running user managers about the new/changed unit; on upgrade, stop
  # (not restart) instances that are running -- they hold the old shared
  # port or are crash-looping against it, and the launcher now starts the
  # right (per-user-port) instance itself the next time someone opens the
  # app.
  if [ -d /run/systemd/system ] && command -v loginctl >/dev/null 2>&1; then
    for user in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $2}'); do
      systemctl --user -M "$user@" daemon-reload >/dev/null 2>&1 || true
      if [ "${1:-}" = configure ] && [ -n "${2:-}" ]; then
        systemctl --user -M "$user@" stop "$UNIT" >/dev/null 2>&1 || true
      fi
    done
  fi
fi

exit 0
