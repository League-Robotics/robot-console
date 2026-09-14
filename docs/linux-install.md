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
using the file. `apt` also installs the dependencies (`libudev1`,
`libusb-1.0-0`, `udev`); a desktop install already has them. To upgrade,
install a newer `.deb` the same way. Running instances restart on upgrade.

**After installing, unplug and replug any micro:bit that was already
connected.** The install tries to apply the USB permission rule to connected
boards, but replugging always works.

## First launch

Open **Robot Console** from the app grid, or run `robot-console` in a
terminal. The console opens in its own Chrome window, with the Robot Console
icon in the dock. It uses a separate Chrome profile, so it won't touch the
student's normal browsing profile. The first window can take a few seconds,
because the robot host starts when the window connects.

`robot-console --help` lists the options. `robot-console --version` shows the
build (version, git commit, Node version).

## How it works

- **Launcher.** `/usr/bin/robot-console` checks whether anything answers on
  `http://127.0.0.1:4795/`. If nothing does, it starts the per-user service
  (`systemctl --user start robot-console`) and waits up to 15 s for the port.
  Then it opens `http://localhost:4795/` as a Chrome app window. Without a
  systemd user session, it starts the supervisor as a background process
  instead.
- **Supervisor.** `robot-console.service` runs the supervisor
  (`/opt/robot-console/app/bin/robot-console-supervisor.js`). It is small and
  holds no USB devices. It listens on 127.0.0.1:4795 (local only, not
  reachable from the network) and serves the UI.
- **Host.** When a window connects, the supervisor starts the robot host
  (USB, flashing, radio) on 127.0.0.1:4796 and passes the window's
  connection through to it. The host stops **30 s after the last window
  closes**, which releases the micro:bits for other programs such as MakeCode.
  Reopening a window within those 30 s keeps the same host running.
- **Login.** The service is enabled for every user
  (`systemctl --global enable`), so the supervisor starts at login. Each
  logged-in user gets their own instance.
- **Stopping.** Stopping the service (logout, `systemctl --user stop`,
  uninstall) stops the host first. If a flash is in progress, the host
  finishes it, so a stop can take up to about two minutes.

## Files, logs and state

| What | Where |
| --- | --- |
| App and bundled Node.js | `/opt/robot-console/` (`BUILD_INFO` records the version and git commit) |
| Launcher | `/usr/bin/robot-console` |
| User service | `/usr/lib/systemd/user/robot-console.service` |
| USB permission rule | `/usr/lib/udev/rules.d/70-robot-console-microbit.rules` |
| Firmware release sources (all users) | `/etc/robot-console/robot-console.env` (see "Firmware sources") |
| Firmware release sources (one user) | `~/.config/robot-console/robot-console.env` (optional) |
| App menu entry and icons | `/usr/share/applications/robot-console.desktop`, `/usr/share/icons/hicolor/*/apps/robot-console.*` |
| Supervisor and host log | `journalctl --user -u robot-console` (as the student) |
| Log when started without systemd | `~/.local/state/robot-console/supervisor.log` |
| Per-user state (robot store, settings) | `~/.local/state/robot-console/` |
| Chrome profile for the app window | `~/.local/share/robot-console/chrome/` |

Service and host status for the current user:

```sh
systemctl --user status robot-console
curl -s localhost:4795/__supervisor/status; echo
```

The status endpoint returns JSON:

- `hostState`: `stopped`, `starting`, `running` or `stopping`
- `hostPid`
- `connections`: open windows
- `idleMsRemaining`: time left before an idle host stops
- `restarts`: host crashes the supervisor recovered from
- `lastExit`: how the host last stopped; `expected: true` means a normal idle stop

(`curl` is not installed on a default Ubuntu desktop: `sudo apt install curl`,
or use `wget -qO- localhost:4795/__supervisor/status`.)

## Firmware sources

The Flash buttons offer release builds from the GitHub repositories named in
`/etc/robot-console/robot-console.env`:

```sh
ROBOT_CONSOLE_RELAY_FIRMWARE=https://github.com/League-Robotics/microbit-radio-relay:latest
ROBOT_CONSOLE_ROBOT_FIRMWARE=https://github.com/League-Robotics/nezha-robot-template:latest
```

The format is `https://github.com/<owner>/<repo>:<release tag>`, or `:latest`
for the newest release. This is a package configuration file, so your edits
survive upgrades and reinstalls. `apt purge` deletes it. Put only public
values in it: the file is readable by every user. WiFi credentials never go
here.

- **Applying edits.** The service reads the file when it starts, and each
  robot host it starts gets those values. Closing the windows and waiting is
  **not** enough. Restart the service as each logged-in user, or log out and
  back in:

  ```sh
  systemctl --user restart robot-console
  ```

- **One user.** To give one user different sources, create
  `~/.config/robot-console/robot-console.env` in the same format. It is read
  after the system file, and the keys it sets win for that user. Restart the
  service to apply it.
- **Store state `.env`.** The per-user state file
  `~/.local/state/robot-console/.env` is only consulted for a key that neither
  file above sets. On a packaged install that means it has no effect for these
  two keys unless you delete their lines from `/etc/robot-console/robot-console.env`.
- **Deleting a line.** A value from an earlier start stays in the user's
  robot store, so deleting a line doesn't clear it. To change a value, set a
  new one.

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

Removing the package does the following:

- stops running instances for logged-in users;
- disables the service;
- deletes `/opt/robot-console` and the files above, except
  `/etc/robot-console/robot-console.env`. `apt remove` keeps that file;
  `apt purge` deletes it too.

Per-user state in home directories (`~/.local/state/robot-console`,
`~/.local/share/robot-console`) is kept. Delete it by hand if you don't need
it.

## Troubleshooting

**The window never opens / "server did not answer on 127.0.0.1:4795".**
Look at `journalctl --user -u robot-console -n 50`. The most common cause is
that port 4795 is already in use, for example by another copy of
robot-console started from a checkout (`npm run dev`). The supervisor then
logs one line saying the port is taken and exits. Find the other process with
`ss -ltnp 'sport = :4795'` and stop it. Then run
`systemctl --user restart robot-console` and launch again.

**The window opens but shows no robots or keeps reconnecting.** Check
`curl -s localhost:4795/__supervisor/status`:

- **`hostState` stuck at `starting`, or growing `restarts`:** the host is
  failing to start. The reason is in `journalctl --user -u robot-console`.
- **Something else holds 127.0.0.1:4796:** the host can't bind its port.
  Check with `ss -ltnp 'sport = :4796'`.

**"Google Chrome not found".** Install Chrome
(`sudo apt install ./google-chrome-stable_current_amd64.deb` from
google.com/chrome). The launcher looks for `google-chrome`,
`google-chrome-stable`, `chromium` and `chromium-browser`, in that order. It
falls back to `xdg-open`, which opens a normal browser tab. The Chromium snap
may refuse the separate profile directory, so use Google Chrome.

**The Flash buttons have nothing to offer ("not configured").** Check that
`/etc/robot-console/robot-console.env` exists and has both lines. Then check
what the running service actually got:

```sh
tr '\0' '\n' </proc/$(systemctl --user show -p MainPID --value robot-console)/environ | grep FIRMWARE
```

If the variables are missing there, the service started before the file
existed or was edited. Run `systemctl --user restart robot-console`. A
per-user `~/.config/robot-console/robot-console.env` overrides the system
file, so check that too.

**The micro:bit is not found, or flashing fails with a permission error.**
Unplug and replug the board. If that doesn't help:

- Check the rule is installed:
  `ls /usr/lib/udev/rules.d/70-robot-console-microbit.rules`.
- Check the ACL (see "Checking USB permissions"). Access is granted only to
  the user at the local seat. It doesn't apply to SSH sessions or to a user
  who has switched away.
- MakeCode in another browser tab can hold the board. Disconnect it there.

**MakeCode can't reach a board while Robot Console is open.** The host holds
the boards while a Robot Console window is open. Close the window. The boards
are released 30 s later, when `hostState` goes back to `stopped`.

**The service doesn't exist for a user who was already logged in during
install.** Log out and back in, or run `systemctl --user daemon-reload`. The
launcher still works in the meantime: if the service can't start, it runs the
supervisor as a background process and logs to
`~/.local/state/robot-console/supervisor.log`.
