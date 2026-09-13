---
status: in-progress
sprint: 018
tickets:
- 018-007
---

# WiFi robot connects hang on the `.local` hostname; the same robot answers instantly by IPv4

## Evidence (team-lead, 2026-09-13, fresh WiFi bricks gopiv and vevov)

- Both robots advertise `_robotlink._tcp` and `_robotlink._udp`, resolve
  (`gopiv.local` → 192.168.1.193, `vevov.local` → 192.168.1.184) and ping in ~3.5 ms.
- Raw `net.connect({ host: "gopiv.local", port: 7654 })` / `vevov.local`: no `connect`
  event within 4 s (no error either).
- Raw connect to the IPv4 address: connected in ~15 ms; `HELLO` →
  `device NEZHA2 robot gopiv 2175407711` in ~30 ms, `ID` →
  `id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv`; vevov likewise
  (`device NEZHA2 robot vevov 1198504156`, `id … vevov`).
- The host records exactly this failure for WiFi: `wifi-gopiv` `failed`
  "LineLink.connect() timed out after 5000ms" (sprint 017 bench) while the robot is up.
- WiFi robots emit the banner twice after `HELLO` and interleave `DBG:wifi …` lines;
  the reply parser must tolerate both.
- Farm bridge hosts (e.g. `loki.local`) did not show the hang in earlier probes; the
  difference is likely the robot's ESP8266 mDNS answering A but not AAAA, and macOS
  `getaddrinfo` waiting on the AAAA query or trying an IPv6 path first.

## Expected

The host connects to WiFi robots as fast as the raw IPv4 probe: resolve the address
from the mDNS record (A record already in the `services` row) or look up with
`family: 4` / `autoSelectFamily`, and connect to the IP. A WiFi `session-open` reaches
`Linked` and `ID` answers in the UI within a few seconds.

## Likely areas

`packages/host/src/link/adapters/tcpStream.ts` (hostname passed straight to
`net.connect`), `watchers/mdnsWatcher.ts` (whether the resolved IPv4 address is stored
in the link address), `connect/connector.ts` stream plan for `wifi`/`mbserial`.
