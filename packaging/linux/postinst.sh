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
  # Enable the user service for every user (offline symlink operation,
  # works without a running systemd).
  systemctl --global enable "$UNIT" >/dev/null 2>&1 || true

  # Tell running user managers about the new/changed unit; on upgrade,
  # restart instances that are running so they pick up the new code.
  if [ -d /run/systemd/system ] && command -v loginctl >/dev/null 2>&1; then
    for user in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $2}'); do
      systemctl --user -M "$user@" daemon-reload >/dev/null 2>&1 || true
      if [ "${1:-}" = configure ] && [ -n "${2:-}" ]; then
        systemctl --user -M "$user@" try-restart "$UNIT" >/dev/null 2>&1 || true
      fi
    done
  fi
fi

exit 0
