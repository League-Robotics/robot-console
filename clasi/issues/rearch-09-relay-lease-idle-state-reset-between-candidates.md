---
status: pending
---

# Relay ownership: leases and an idle state, no console auto-open, reset between failover candidates, no registry write-on-read

## Description

A relay can never be idle today. On USB attach every DAPLink device,
relays included, gets a console `UsbSerialLink` opened automatically
(`deviceRegistry.ts:3078-3192`), and it is re-opened after every bridge
failure or close (`:2276`, `:2298`, `:2405-2408`). The only claim
mechanism is `KeyedMutex`, which serialises operations, not ownership;
there is no lease, no owner, no way for a background task to know a
student wants the relay (`02-host-transport.md` §3).

Bridging defects that go with it:

- **Default failover is structurally broken on Linux.** `resetOverSwd`
  runs once before the candidate loop (`:2243`). After candidate 1's
  `!GO` the relay is in its data plane; candidate 2's `?` sync is
  forwarded over the radio and times out after 8 s, as does every later
  candidate. It works on macOS only because opening the port DTR-resets
  the board. `RelayConnectionCoordinator.test.ts:181` passes because the
  fake link has no plane state.
- Each candidate does a write-on-read `GET /names/<name>` against the
  shared classroom registry (`RelayConnectionCoordinator.ts:335`,
  `mbrelayRegistry.ts:5-21`), enrolling every remembered name as a derived
  guess — the spec's §6 "one name, at connect time" rule says never.
- After any child closes, `connectAndIdentify(relayState)` sends a plain
  HELLO into a relay still in its data plane, gets null, and reclassifies
  the relay `unknown` (`:3315`), so the next Connect is refused as "not a
  relay" (`:2180-2186`).
- A dropped radio child has no recovery; neither the child nor the
  relay's own session is reopened (`:3785-3791`).
- `relayBridge: connecting` can persist for minutes: the relay mutex is
  held for N × ~12.5 s during failover with no cancel.

Facts from the relay firmware (architecture §7.1): no in-band escape from
the data plane; reset by DAPLink over HID, or by a **serial break**
(reliable on Linux, unlike DTR), or by port reopen (macOS only).

## Proposed resolution

- `relay_leases` (rearch-01): owner `sweep` or `session:<childLinkId>`.
  `connect/relayBridger.ts` acquires `session:` before touching the port
  and releases it in `finally`. The sweeper (rearch-10) acquires `sweep`.
  A user `session-open` on a leased-by-sweep relay aborts the sweep's
  signal and waits for the release (bounded, ≤ 1.5 s).
- Remove the relay console auto-open. When no lease is held the relay is
  idle. The relay page's console, when no child is connected, takes a
  short `session:console` lease on first send and releases it after a
  quiet period; while idle the console shows "idle · sweeping" or "idle".
- `relayBridger.bridge(relayLink, target, signal)`: reset → boot wait →
  `?` sync → preamble → `!GO` → probe → identify, **per candidate**, with
  the reset step chosen by capability: DAPLink over HID when the relay
  has a HID path, else serial break (`port.set({brk: true})`, 100 ms),
  else port reopen (macOS). Per-candidate deadline; overall
  `AbortSignal`. Salvage the sequence from `openRobotViaRelay` (`:2232-2258`)
  and the trail/result types from the coordinator (`:181-214`).
- Address resolution per rearch-08 order; the registry lookup uses a
  non-mutating path when the server exposes one, and is skipped entirely
  during default failover (use device override → last radio sighting →
  derived).
- Failover candidate order: robots with a recent radio `sighting` first,
  then remembered robots by `last_seen`.
- On child drop (`onClose`/unresponsive), the child link goes
  `unresponsive` and the reconciler offers Reconnect (user-initiated; no
  auto-rebridge). The relay link returns to idle; it is never
  re-identified over a data-plane port. Relay classification is written
  only from a command-plane banner.
- Delete `relay/RelayConnectionCoordinator.ts` and its test.

## Acceptance

- Fake relay with plane state: two candidates where the first answers
  `!GO` but never `pong` → the second still succeeds, and the fake saw a
  reset between them. The same fixture without the reset step fails (the
  test that guards the Linux bug).
- No registry GET is issued during default failover; exactly one for a
  named connect, and none when an override exists.
- Bridge while a sweep lease is held → sweep aborts within one probe,
  bridge proceeds, `relay_leases.owner` transitions `sweep` →
  `session:<child>` → NULL on close.
- Child close leaves the relay `connected`-classified as a relay, and a
  second bridge succeeds without re-attach.
- Serial-only relay (no HID) uses the break path in tests.

## Depends on

rearch-01, rearch-04 (abortable preamble), rearch-05 (connector,
reconciler).

## References

- `docs/design/architecture.md` §7.1, §7.2, §8
- `docs/reviews/2026-09-11/02-host-transport.md` §3, §5 items 5, 12
- `docs/reviews/2026-09-11/01-host-device-model.md` §2.4
- `docs/design/usecases.md` UC-016
- `clasi/issues/background-roster-sweep-over-radio-and-firmware-tcp-slots.md` (constraint list; superseded by this issue and rearch-10)
