---
id: '011'
title: 'Robot page: header shows active connection label + state, with connect/switch
  when no open session'
status: done
use-cases:
- SUC-009
depends-on: []
github-issue: ''
issue: robot-page-shows-active-connection.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Robot page: header shows active connection label + state, with connect/switch when no open session

## Description

`AppHeader.tsx` renders only the routed device's name; nothing on the
robot page tells the student which connection (USB, mbserial, WiFi, or
radio via a relay) they are on, nor whether it is actually usable right
now. Stakeholder bench feedback, 2026-09-12: a robot with several links
(gopiv: mbserial via loki, WiFi, radio via torture) leaves the student
guessing, and the page must never quietly present a connection it
cannot use — "You don't have an open session. Don't try to use that for
the connection."

This ticket extends `AppHeader` (already the single place that renders
per-link chrome — the back link, the disconnected-from-host banner,
Flash/Radio/WiFi dialogs) to show the routed link's identity and state,
and, when that link has no open session, to say so plainly and offer
the only two host-approved ways forward: open a session on it, or
navigate to a sibling link on the same device that already has one.
Both are existing host mechanics (`session-open`, plain routing) — no
new client-side connection policy.

`connectionLabel` (today a private function in `FrontPage.tsx`) moves
into `deviceDisplay.ts`, next to `linkStateText` (already relocated
there by ticket 017-007), so `AppHeader` and `FrontPage` both read one
shared definition — consistent with this sprint's SUC-007 UI-dedupe
goal rather than adding a second copy.

`RobotPage.tsx` and everything it mounts stay untouched: the transport
text lives entirely in the header, not the page body, preserving the
transport-blindness property `RobotPage.transportBlind.test.ts` checks
by source scan.

**Bench re-check**: ticket 010's final USB/radio driving pass was run
before this ticket landed. Because this ticket touches only `AppHeader`
and `deviceDisplay.ts` — files ticket 010's bench pass exercised only
incidentally — its own new FakeSocket coverage is the acceptance gate
for this ticket, but the stakeholder's final drive check (ticket 010)
should be re-run once this ticket lands, to confirm the header change
doesn't visually regress the live bench session. This is a note for the
sprint close, not a new `depends-on` edge: 010 already depends on every
other ticket and is not reopened by this addition.

## Acceptance Criteria

- [x] `connectionLabel` is moved from `FrontPage.tsx` into
      `deviceDisplay.ts` (exported alongside `linkStateText`);
      `FrontPage.tsx` imports it from there instead of defining its own
      copy. No behavior change to `FrontPage`'s existing rendering.
- [x] `AppHeader`, when a routed link resolves (`useLink`), renders
      `connectionLabel(link)` followed by `linkStateText(link)` under
      the device/link name, for USB, mbserial, and via-relay links
      alike.
- [x] When `link.session` is undefined, the header shows "No open
      session on this link" instead of the state text, plus a Connect
      button gated by `useSendable` that sends exactly
      `{ type: "session-open", linkId: link.id }` (mirroring
      `DeviceConsole.tsx`'s existing `openLink` pattern) and is disabled
      (or hidden) when `useSendable()` is false.
- [x] When `link.session` is undefined and the owning device
      (`useDeviceForLink`) has another link with `session !== undefined`,
      the header additionally renders a "Use `<label>` instead" link
      (`react-router` `Link`) to `/d/<thatLinkId>` — navigation only, no
      auto-connect, no client-side choice of which link is "better".
      Absent when no such sibling link exists. (Extended scope below
      generalizes the gate from "session !== undefined" to "usable" —
      see item C.)
- [x] No new client-side connection/switch policy is added anywhere:
      the only messages this ticket's code sends are `session-open`
      requests a student explicitly triggers via the Connect button;
      the switch affordance is a plain route link.
- [x] `RobotPage.tsx` and every file in
      `RobotPage.transportBlind.test.ts`'s `FILES_UNDER_TEST` list are
      unmodified by this ticket; that test still passes unchanged.
- [x] FakeSocket tests cover: a USB link with an open session, an
      mbserial link with an open session, a via-relay (radio) link with
      an open session, and a link with no open session (Connect button
      present, sends `session-open`; when a sibling link with a session
      exists, the "Use `<label>` instead" link is also present and
      points at the right `/d/<linkId>`).

## Implementation Plan

**Approach**

1. In `packages/ui/src/deviceDisplay.ts`, add an exported
   `connectionLabel(link: SnapshotLink): string` with the same body
   `FrontPage.tsx` has today (`link.via ? \`${link.label} (via relay
   ${link.via.relayName})\` : link.label`), placed next to
   `linkStateText` per that function's own ticket-017-007 doc-comment
   convention (shared per-link presentation helpers live here).
2. In `packages/ui/src/pages/FrontPage.tsx`, delete the local
   `connectionLabel` function and import it from `../deviceDisplay`
   instead; no other change to `FrontPage.tsx`.
3. In `packages/ui/src/components/AppHeader.tsx`:
   - Import `connectionLabel` and `linkStateText` from `../deviceDisplay`,
     and `useSendable` and `useWsActions` from `../ws/WsProvider`
     (`AppHeader` already imports `useDeviceForLink`, `useLink`,
     `useHostConnection` from the same module).
   - Below the existing `<h1>robot-console</h1>` / back-link row (or in
     a new row directly under it — implementer's call on exact markup,
     acceptance criteria drive the testable content, not DOM shape),
     when `link` resolves: render `connectionLabel(link)` and, if
     `link.session !== undefined`, `linkStateText(link)`; if
     `link.session === undefined`, render "No open session on this
     link" instead, plus:
     - A Connect button (`data-testid="app-header-connect"` or similar)
       that calls `send({ type: "session-open", linkId: link.id })` on
       click, disabled when `!useSendable()`.
     - If `device` (via `useDeviceForLink`) has another link with
       `session !== undefined`, a `Link to={`/d/${thatLink.id}`}`
       reading "Use `<connectionLabel(thatLink)>` instead"
       (`data-testid="app-header-switch-link"` or similar).
   - No change to the existing back-link, banner, or
     Flash/Radio/WiFi-dialog rendering.
4. Update `AppHeader.test.tsx` with the FakeSocket cases listed in
   Acceptance Criteria, following that file's existing harness
   conventions (mirrors `RelayPage.test.tsx`/`DeviceConsole.test.tsx`'s
   `socket().sent` assertion style for the `session-open` send).

**Files to create/modify**

- `packages/ui/src/deviceDisplay.ts` (modified — add `connectionLabel`)
- `packages/ui/src/pages/FrontPage.tsx` (modified — import instead of
  local definition)
- `packages/ui/src/components/AppHeader.tsx` (modified — render
  connection label/state/connect/switch)
- `packages/ui/src/components/AppHeader.test.tsx` (modified — new
  FakeSocket cases)

**Testing plan**

- Scoped run: `npx vitest run packages/ui` (per this sprint's rule that
  a per-ticket run is scoped to the modules the ticket touches; the
  full suite runs once, in `close_sprint`).
- No hardware bench pass is required for this ticket's own acceptance
  (FakeSocket only) — see the Description's "Bench re-check" note for
  the separate stakeholder re-run against ticket 010's live session.

**Documentation updates**

- None beyond this ticket and `sprint.md`'s SUC-009 (already written).
  No `specification.md`/`architecture.md` claim changes, since this is
  a UI presentation addition, not a new module or contract.

## Extended scope (team-lead, 2026-09-13)

Stakeholder bench pass ("completely broken") surfaced a wider send-
gating bug this ticket's own header work sits directly on top of: every
send-capable control across the app gated on `link.session !== undefined`
alone, which cannot tell "open and answering" from "open, but the
harvester has marked this link `unresponsive`/`failed`/`stale` while
deliberately keeping its session row" — a robot ("zapuz"/`tigez`) could
show "Unreachable: no reply to 3 STATUS polls" on its card while its own
Drive/Command/Console controls rendered fully enabled. Team-lead
dispatched one extended-scope pass (items A-G below) alongside this
ticket's own base scope; all items landed together, verified both by
FakeSocket/unit tests and a live browser walk against the bench host.

- [x] **A. `isLinkUsable` predicate.** Added
      `isLinkUsable(link) = link.state === "connected" && link.session
      !== undefined` to `packages/ui/src/deviceDisplay.ts`. Every
      send-gating `session !== undefined` site converted:
      `DriveControls.tsx`, `CommandStrip.tsx`, `StatusPanel.tsx`,
      `FunctionsPanel.tsx`, `DriveTab.tsx`,
      `RotationCalibrationWizard.tsx`, `DistanceCalibrationWizard.tsx`,
      `DeviceConsole.tsx`, `ConfigurationPage.tsx`,
      `FrontPage.tsx` (`primaryLinkFor`), `AppHeader.tsx` (Set Wi-Fi's
      `linkOpen` prop). The one deliberately unconverted site
      (`WsProvider.tsx`'s telemetry-reset-on-session-close transition
      check) is a session-identity/lifecycle detector, not a send gate
      or display read — converting it would clear telemetry on every
      `unresponsive` transition even though the session itself never
      closed, which is wrong. `StatusPanel.tsx` additionally labels its
      table "last known" (`data-testid="status-panel-stale"`) when
      `status` exists but the link is no longer usable — a pure display
      read, left visible, per this item's own "leave pure display uses"
      instruction.
- [x] **B. Front-page card: no phantom open arrow.** `FrontPage.tsx`'s
      `primaryLinkFor` now requires `isLinkUsable`, with no `links[0]`
      fallback for a non-relay device (relay cards keep the old
      fallback — their own connectivity link legitimately has no session
      most of the time). A device with no usable link renders no open
      arrow at all (main or per-link); instead each link row shows its
      state text, its `reason` in plain words
      (`data-testid="device-link-reason-<linkId>"`), and a Connect
      button (`data-testid="device-link-connect-<linkId>"`) for any link
      whose state is `connectable`/`discovered`/`failed`/`stale`/
      `unresponsive`, gated by `sendable`, sending `{type:
      "session-open", linkId}`.
- [x] **C. Robot page header, not-usable case generalized.** `AppHeader`
      now shows "No open session on this link" only when
      `link.session === undefined`; when a session survives but the link
      itself dropped (`isLinkUsable` false with a session present), it
      shows "Not connected over `<label>`: `<reason>`" instead
      (`connectionStatusText`), with the same Connect button and "Use
      `<label>` instead" sibling link (now gated on the sibling being
      *usable*, not merely session-bearing).
- [x] **D. Relay page: no console banner while idle.** `RelayPage.tsx`
      now mounts the relay's own `DeviceConsole` only when its own
      connectivity link `isLinkUsable` — an idle relay with no session
      shows only its own state (idle/sweeping/bridging) via
      `RelayConnectControls`, never the "No link open..."/"No session..."
      banners.
- [x] **E. Connector host-identity cross-check.** `connect/connector.ts`'s
      `attempt()` now: (1) rejects a banner whose own name disagrees with
      its own serial (`bannerNameMatchesSerial`, previously defined but
      never wired in); (2) for a `usb` link whose row already carries a
      `deviceId` from SWD naming (`LinkRow.deviceId`, threaded through
      `reconciler.ts`'s `toConnectorLinkRow`), rejects a banner reporting
      a different serial — no device upsert, `owned` never set,
      `recordFailure` with reason `"banner identity <bannerName>
      disagrees with SWD name <swdName> -- serial data corrupted, check
      the USB cable"`, link closed. This reason reaches the front-page
      card via `linkStateText`'s existing `Unreachable: <reason>`
      rendering (item B).
- [x] **F. `connectionLabel` in `deviceDisplay.ts`.** Same change as the
      ticket's own AC1 above — tracked here too since it's part of the
      lettered list the team-lead's dispatch used.
- [x] **G. Console showed no real device replies.** Root cause (found by
      team-lead against live hardware): `LineLink.handleRawLine`
      dispatched a decoded, successfully-routed reply (`id`/`status`/
      `ack`/`nack`) only to `onLine`/`onAckNack`, never to `onRawLine` --
      but `server.ts`'s student-console broadcast read only `onRawLine`,
      so every real reply was invisible; only unsolicited `DBG:` lines
      (unroutable, and so `onRawLine`-visible) ever showed. Fixed by
      adding `LineLink.onInboundLine` (fires for every inbound line not
      consumed as a banner reply, decoded or not) and switching
      `server.ts`'s console-echo subscription to it. `onRawLine`'s own
      semantics/call sites (`connector.ts`'s relay preamble) are
      unchanged.

### Tests (extended scope)

`npx vitest run packages/ui packages/host/src`: **84 files, 1281 tests,
all passing** (includes every FakeSocket/unit test below plus every
pre-existing test, none regressed). `npm run typecheck` and `npm run
build` both clean.

- `packages/ui/src/deviceDisplay.test.ts`: `isLinkUsable` (connected+
  session true; session-with-non-connected-state false -- the exact
  bench bug; connected-no-session false; neither false),
  `connectionLabel` (plain + via-relay).
- `packages/ui/src/components/AppHeader.test.tsx`: USB/mbserial/
  via-relay links with an open session ("Linked"); no-session link
  (Connect + sibling switch link); Connect disabled once
  `useSendable()` is false; item C's "Not connected over `<label>`:
  `<reason>`" case for a session-surviving-but-unresponsive link.
- `packages/ui/src/pages/FrontPage.test.tsx`: a card with no usable
  link renders no open arrow (main or per-link); shows state text +
  reason + a Connect button that sends `session-open`; Connect disabled
  when `sendable` is false; no Connect button for a non-qualifying
  state (`connecting`); a relay card keeps its open arrow regardless.
- `packages/ui/src/pages/RelayPage.test.tsx`: no console/sequencing
  banner while the relay's own link has no session; console renders
  once that link is usable.
- `packages/ui/src/components/StatusPanel.test.tsx`: "last known" label
  appears only when a status exists and the link is not usable.
- `packages/host/src/link/LineLink.test.ts`: `onInboundLine` fires for
  a decoded reply, an unrouted/foreign line, and a well-formed ack, but
  NOT for a line consumed as the `identify()` banner reply.
- `packages/host/src/connect/connector.test.ts`: a self-inconsistent
  banner is rejected (no device upserted); a `usb` link's SWD-named
  `deviceId` disagreeing with the banner's serial is rejected (no
  device upsert, `owned` never set, link failed with the cable reason);
  the ordinary matching case still connects (no false positive).
- `packages/host/src/server.test.ts`: a decoded reply delivered via
  `onInboundLine` broadcasts as an `rx` line; an unrouted line still
  does too (onRawLine's own former case is not lost).
- `packages/host/src/mbserialEndToEnd.test.ts`: a real `send-command
  {verb: "ID"}` round trip through the full reconciler/connector/server
  stack broadcasts the fake robot's `id ...` reply as an `rx` line.

### Browser walk (live bench host, 2026-09-13)

Fresh host: `ROBOT_CONSOLE_STATE_DIR=<dir> node bin/robot-console.js
--port 4797`, state dir seeded with read-only copies of the real
`known-robots.json`/`wifi-credentials.json`. Script:
`ui-walk-after.mjs` (extends `ui-walk.mjs`, kept unmodified alongside
it), screenshots in `<scratchpad>/ui-walk-after/`.

Cards (front page): `torture` (relay, idle, no usable child -- open
arrow present per item B's relay carve-out, "Choose a robot..." +
Connect), `vevov`/`gopiv`/`tovez`/`tigez` (each one card, `Linked`,
open arrow present, no Connect buttons -- all four have a usable
link). No card showed a phantom "no usable link but has an open arrow"
combination (`CARD_ASSERTIONS`: empty).

Per-robot-page header connection text (item C/ticket 011, live):

- `torture`: `"mbrelay · ch?/grp?No open session on this linkConnect"`
  -- no console/sequencing banner (item D), just "idle" + the connect
  bar.
- `vevov`: `"mbserial · hodr.local:36237Linked"`
- `gopiv`: `"mbserial · loki.local:40293Linked"`
- `tovez`: `"USB · /dev/cu.usbmodem2121102Linked"`
- `tigez`: `"mbserial · magni.local:43837Linked"`

Enabled-control assertion: every ENABLED Forward/Backward/Turn-left/
Turn-right button, and the console send input, belonged to a page whose
header read "...Linked" -- `vevov`/`gopiv`/`tovez`/`tigez`, 4 drive
buttons + 1 send input each (20 total), zero exceptions.
`ASSERTION PASS` printed by the script.

Item G proof, live: on each of the four usable robot pages, typed `ID`
into the console send box and pressed Enter (no motion verb ever sent
or clicked); each rendered a real `id ...` reply within 3s:

- `vevov`: `id diffdrive calibration-0.20260913.1 1.20260912.8 vevov`
- `gopiv`: `id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv`
- `tovez`: `id diffdrive unbaked 1.20260912.8 tovez` (this board's own
  very high-rate `L=0 R=0` telemetry initially pushed the reply out of
  the script's first, too-narrow tail-8 sampling window -- widened to
  search the full rendered log; the reply was there all along, at
  wall-clock parity with the other three boards)
- `tigez`: `id diffdrive unbaked 1.20260912.8 tigez`

Before this fix (item G), none of these `id ...` lines would have
reached the console at all -- only `onRawLine`-visible traffic (foreign/
unrouted lines) did.

Item E note: no `"banner identity ... disagrees with SWD name ..."`
line appeared in this session's `host.log` -- the previously-flaky USB
cable behaved consistently as `tovez` for this entire run (no phantom
"zapuz"-style re-identification observed this pass, consistent with the
cable issue being intermittent, not constant). The fix's own correctness
is proven at the unit level (`connector.test.ts`); this bench pass did
not happen to reproduce the physical fault live, which is an honest
limitation of a single bench window, not a gap in the fix.

Host left running for the stakeholder: PID and state dir in ticket
010's own "Browser walk" section below (010 is the ticket that owns
bench hand-off bookkeeping).
