---
status: done
sprint: 018
tickets:
- 018-010
---

# Relay and mbserial cards show wrong, raw, or misleading text and state

## Evidence (stakeholder screenshot + store, 2026-09-13)

- torture card: "Connection to gopiv lost: relayBridger: candidate
  "radio-tigez-via-mbrelay-torture" produced no banner within the identify budget" —
  names the wrong robot (gopiv vs tigez), shows raw internal ids, and is shown with
  Switch/Disconnect as if bridging. torture's own row reads "Not seen since
  9/13/2026, 12:16:31 AM" although it is advertising right now (link `stale`, ttl-expired,
  last_seen 0 min).
- vevav card (relay): "Connection to gopiv lost: Error: No such file or directory…" with
  Switch/Disconnect, while vevav is not bridging anything.
- gopiv mbserial row: "Couldn't connect: the robot didn't answer when we said hello —
  check the USB cable or that it's powered on" — USB advice on a network bridge link.
- vevov card shows a green "Linked" pill while the stakeholder says vevov is not plugged
  in; `mbserial-vevov` flaps `connected`/`failed "transport closed"` (fail_count 5) and
  the hodr bridge accepts TCP but never answers HELLO.

## Expected

- Relay card bridge status names the robot actually attempted, in plain words, and shows
  Switch/Disconnect only while a bridge session exists.
- An advertising mbrelay/mbserial link never reads "Not seen since" while its service is
  present.
- Failure advice matches the transport (USB: cable/power; mbserial: "the bridge answered
  but the robot didn't — is the robot plugged into the farm and powered?"; relay radio:
  "no radio reply — is the robot on and in range?").
- "Linked" only when a link is `connected` with a session that has answered within the
  poll window; a bridge that accepts TCP but never identifies is not Linked.
