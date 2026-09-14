# Installing Robot Console on Ubuntu lab machines

The `robot-console_<version>_amd64.deb` package installs Robot Console on
**Ubuntu 24.04, x86_64**. It includes its own Node.js runtime, so nothing else
needs installing except Google Chrome.

## Prerequisites

- Ubuntu 24.04 LTS desktop, 64-bit Intel/AMD (`uname -m` prints `x86_64`).
- Google Chrome (`google-chrome-stable`). The package lists it as recommended,
  not required. If Chrome is missing, the launcher tries Chromium and then the
  default browser.
- An admin account to install (`sudo`). Students don't need admin rights or
  group membership to use the micro:bits.

## Install

```sh
sudo apt install ./robot-console_<version>_amd64.deb
```

Keep the `./`: without it, `apt` searches the online repositories instead of
using the file. To upgrade, install a newer `.deb` the same way.

**After installing, unplug and replug any micro:bit that was already
connected.** The install tries to apply the USB permission rule to connected
boards, but replugging always works.

## First launch

Open **Robot Console** from the app menu, or run `robot-console` in a
terminal. The first start can take a few seconds. The console opens in its own
Chrome window, with its own dock icon. It uses a separate Chrome profile, so
it won't touch the student's normal browsing profile.

`robot-console --help` lists the options. `robot-console --version` shows the
build (version, git commit, Node version).

## How it works

- `/usr/bin/robot-console` (the launcher) checks whether anything answers on
  `http://127.0.0.1:4795/`. If nothing does, it starts the per-user
  service `robot-console.service` (`systemctl --user start`) and waits for the
  port. Then it opens `http://localhost:4795/` as a Chrome app window.
- The service runs the supervisor. The supervisor listens on 127.0.0.1:4795
  (local only, not reachable from the network) and serves the UI. It starts
  the robot host process (port 4796) only while a Robot Console window is
  connected, and stops it 30 s after the last window closes. That releases the
  USB boards for other programs, such as MakeCode.
- The service is enabled for every user (`systemctl --global enable`), so it
  also starts at login. Each user who is logged in gets their own instance.

> **Current build (Phase 1):** the service runs the robot host directly
> (`bin/robot-console.js --no-open`) instead of the supervisor. The host keeps
> running for the whole login session, and it holds the USB boards until
> logout or `systemctl --user stop robot-console`.

## Files, logs and state

| What | Where |
| --- | --- |
| App and bundled Node.js | `/opt/robot-console/` (`BUILD_INFO` records the version and git commit) |
| Launcher | `/usr/bin/robot-console` |
| User service | `/usr/lib/systemd/user/robot-console.service` |
| USB permission rule | `/usr/lib/udev/rules.d/70-robot-console-microbit.rules` |
| Service log | `journalctl --user -u robot-console` (as the student) |
| Log when started without systemd | `~/.local/state/robot-console/supervisor.log` |
| Per-user state (robot store, settings) | `~/.local/state/robot-console/` |
| Chrome profile for the app window | `~/.local/share/robot-console/chrome/` |

Service status for the current user:

```sh
systemctl --user status robot-console
```

## Checking USB permissions

Plug in a micro:bit, then check as the student (not with `sudo`):

```sh
ls -l /dev/hidraw* /dev/ttyACM*
getfacl /dev/ttyACM0      # should list user:<student>:rw-
udevadm info /dev/ttyACM0 | grep -E 'ID_VENDOR_ID|TAGS|ID_MM_DEVICE_IGNORE'
```

The micro:bit's vendor id is `0d28`. The rule tags its `hidraw` (flashing),
`ttyACM` (serial console) and raw USB nodes with `uaccess`. That gives the
user at the local seat read/write access. The rule also tells ModemManager
not to probe the serial port.

## Uninstall

```sh
sudo apt remove robot-console     # or: sudo apt purge robot-console
```

Removing the package stops running instances for logged-in users, disables
the service, and deletes `/opt/robot-console` and the files above. Per-user
state in home directories (`~/.local/state/robot-console`,
`~/.local/share/robot-console`) is kept. Delete it by hand if you don't need
it.

## Troubleshooting

**The window never opens / "server did not answer on 127.0.0.1:4795".**
Look at `journalctl --user -u robot-console -n 50`. The most common cause is
that port 4795 is already in use, for example by another copy of
robot-console started from a checkout (`npm run dev`) or by an old
`robot-console` process. Find it with `ss -ltnp 'sport = :4795'` and stop it.
Then run `systemctl --user restart robot-console` and launch again.

**"Google Chrome not found".** Install Chrome
(`sudo apt install ./google-chrome-stable_current_amd64.deb` from
google.com/chrome). The launcher looks for `google-chrome`,
`google-chrome-stable`, `chromium` and `chromium-browser`, in that order. It
falls back to `xdg-open`, which opens a normal browser tab. The Chromium snap
may refuse the separate profile directory, so use Google Chrome.

**The micro:bit is not found, or flashing fails with a permission error.**
Unplug and replug the board. If that doesn't help, check the rule is installed
(`ls /usr/lib/udev/rules.d/70-robot-console-microbit.rules`) and check the ACL
(see "Checking USB permissions"). Access is granted only to the user at the
local seat. It doesn't apply to SSH sessions or to a user who has switched
away. MakeCode in another browser tab can also hold the board. Disconnect it
there first.

**The service doesn't exist for a user who was already logged in during
install.** Log out and back in, or run `systemctl --user daemon-reload`. The
launcher still works in the meantime: if the service can't start, it runs the
server as a background process and logs to
`~/.local/state/robot-console/supervisor.log`.
