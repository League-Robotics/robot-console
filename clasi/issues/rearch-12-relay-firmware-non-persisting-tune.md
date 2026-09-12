---
status: pending
sprint: '016'
---

# Relay firmware: a non-persisting tune (or one-shot probe) so a sweep does not wear the flash

## Description

Cross-repository request against
`https://github.com/League-Robotics/microbit-radio-relay`. Tracked here
because the robot-console sweeper (rearch-10) is the consumer; the
firmware change itself is a PR in that repo (stakeholder approved
firmware changes on 2026-09-11). Filed upstream as
https://github.com/League-Robotics/microbit-radio-relay/issues/1.

The relay's command plane already lets a host send one line over the
radio (`> <text>`) and receive (`< <text>`) without `!GO`
(`docs/radio-relay-protocol.md` §2, §3.1). A background sweep can
therefore probe each remembered robot with `!CG <ch> <grp>` then
`> ID` and never enter the data plane. The one obstacle is that `!CG`
persists to flash on every change:

```
source/relay/RadioRelay.cpp:194-217  saveConfig()  — uBit.storage.put unless unchanged
source/relay/RadioRelay.cpp:1030,1061 !C / !CG handlers call saveConfig()
```

A sweep retuning every 2 s would write the KeyValueStorage page ~40,000
times a day; nRF52 flash is rated for ~10,000 erase cycles per page.
Until this lands the console limits itself to one retune per relay per
30 s (rearch-10), which makes a full pass over a classroom slow.

## Proposed resolution

Either (a) is sufficient; (b) is nicer for the host.

(a) **Transient tune.** `!CGT <ch> <grp>` (or `!CG <ch> <grp> NOSAVE`):
apply the channel/group immediately with `applyRadioConfig()`, echo the
same `# channel: … group: …` line, **do not** call `saveConfig()`. On the
next persisted change or reset the saved config applies as before.
Document in §3.2.

(b) **One-shot probe.** `!TX <ch> <grp> <text>`: tune transiently, send
`text` over the radio, forward any `<` lines received for a fixed window
(say 400 ms), then restore the previous tune. Echo
`# tx: done rx=<n>` at the end so the host knows the window closed.

Either way:

- Advertise the capability in the `?` reply (e.g. append
  `caps: CGT` or `caps: TX`) so the host can feature-detect and lift its
  rate limit only on firmware that has it.
- Add both to `!HELP`.
- Update `docs/radio-relay-protocol.md` §3.2/§3.3 and the wiki page per
  the repo's `AGENTS.md`.
- Unit test in `scripts/relay_test.py` (or the repo's test harness):
  transient tune does not change the value read back after a reset.

Host side (robot-console): rearch-10 parses the capability from `?` and
switches `SWEEP_MIN_INTERVAL_MS` from 30 s to 2 s; protocol gains
`buildTransientChannelGroupLine` (rearch-15).

## Acceptance

- Firmware: after `!CGT 47 60`, `?` reports channel 47 group 60; after a
  reset, `?` reports the previously saved pair. `> ID` while transiently
  tuned reaches a robot on 47/60 (bench test with one robot).
- Firmware: `?` includes the capability token; `!HELP` lists the command.
- robot-console: sweeper drops to the fast interval against a fake relay
  that advertises the capability, and stays slow against one that
  doesn't.

## Depends on

Nothing in robot-console. rearch-10 benefits from it.

## References

- `docs/design/architecture.md` §7.1, §7.3
- `microbit-radio-relay/docs/radio-relay-protocol.md` §2, §3.1, §3.2
- `microbit-radio-relay/source/relay/RadioRelay.cpp` `saveConfig()`, `'>'` handler at `:953`
