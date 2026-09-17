---
status: done
sprint: 018
tickets:
- 018-009
---

# Bridging through the `torture` mbrelay pool fails, though the same handshake works by hand

## Evidence (team-lead, 2026-09-13, live bench)

- Host (stakeholder's `npm run dev`, real state dir) records
  `radio-tigez-via-mbrelay-torture`: `failed`, "relayBridger: candidate … produced no
  banner within the identify budget", and `radio-gopiv-via-mbrelay-torture`: `failed`,
  "transport closed". The UI shows these on the torture card.
- Raw TCP to `torture.local:8760`, replaying the host's exact sequence, works:
  `!ECHO OFF` → `# echo: OFF`, `!MODE RAW250` → `# mode: RAW250`, `!CG 47 60` →
  `# channel: 47 group: 60 …`, `!P 7`, `!GO` → `# entering data plane`, then
  `HELLO` → `device NEZHA2 robot gopiv 2175407711` in ~35 ms, `ID` →
  `id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv`.
- Command plane also works without `!GO`: `> HELLO` → `< device NEZHA2 robot gopiv …`.
- `torture` is a pool: each TCP connection is served by a different relay
  (`zetog:3446622357`, then `gozop:4267970133` on reconnect). Reconnecting returns to
  the command plane, so a failed `!GO` does not strand the pool.
- The first line on connect is the relay banner in colon dialect
  (`DEVICE:RADIOBRIDGE:relay:<name>:<serial>`), possibly delivered only after the first
  command is sent.
- tigez did not answer `> HELLO` on its derived address ch55/grp114 (registry agrees:
  derived); gopiv did on ch47/grp60. tigez's lack of radio reply may be the robot, not
  the host.

## Expected

`session-open {relayLinkId: "mbrelay-torture", name: "gopiv"}` reaches `Linked` and
`ID` answers in the console, every time, from the UI.

## Likely areas

`connect/relayBridger.ts` (reset/`reconnect` handling, candidate loop, identify
schedule after `!GO`), `link/RelayCommandPlane.ts` (`!GO` confirmation matching
`# entering data plane`, sync on the pool's colon banner), `connect/connector.ts`
`buildRelayPreamble`. Reproduce with the host code in isolation against the real pool
before changing anything.
