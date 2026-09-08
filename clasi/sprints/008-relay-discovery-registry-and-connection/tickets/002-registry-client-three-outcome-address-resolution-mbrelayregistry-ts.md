---
id: '002'
title: 'Registry client: three-outcome address resolution (mbrelayRegistry.ts)'
status: open
use-cases:
- SUC-002
depends-on: []
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Registry client: three-outcome address resolution (mbrelayRegistry.ts)

## Description

Create `packages/host/src/mbrelayRegistry.ts`:
`resolveRobotAddress(name, { host, port }, opts?) → Promise<ResolvedAddress>`,
**never throws** (mirrors `KnownRobotsStore`'s "never throws" contract
from sprint 005). `ResolvedAddress` carries the resolved `{ channel,
group }` plus exactly one of three outcome tags:

- `"config"` or `"registry"` — the registry actually knew (its reply
  indicates a real, previously-stored mapping, not a same-request
  derivation).
- `"derived"` — the registry replied but its own reply indicates it
  just derived the address on this request (mirrors `httpapi.py`'s
  `source: "derived"` field, per the roadmap plan's finding 1) — surface
  this as prominently as a fallback, since the failure mode it
  represents (a locally-derivable guess presented as a 200 OK) is
  identical to one.
- `"local-derived"` — the registry was unreachable (timeout, network
  error, or no registry host/port was ever supplied at all) — the host
  computes `{ channel, group }` itself via
  `@robot-console/protocol`'s `nameToRadioAddress`.

Only ever issue a `GET` — never `POST`/`DELETE` (the registry's HTTP
API has no auth, per the roadmap plan; staying read-only is a policy
choice this client enforces, not something the API itself prevents).
Client-side timeout ~1.5s (shorter than mbrelay's own 3s client, since
this blocks a UI click). Short TTL cache keyed by `name` (pick a
concrete default, e.g. matching the ~1.5s timeout's order of
magnitude — see `sprint.md`'s Open Questions) so a re-click on the same
name within the window doesn't re-trigger a registry write.

The injected `fetch` function (mirroring `releases.ts`'s own
network-call injection pattern) is the only I/O seam — every outcome
branch above must be testable by scripting what that fake `fetch`
returns, including a timeout/rejection for the `local-derived` case.

## Acceptance Criteria

- [ ] `resolveRobotAddress` never throws — every failure path
      (network error, timeout, malformed response) resolves to
      `"local-derived"` with a locally-computed address, never a
      rejected promise.
- [ ] An injected fetch returning the registry's actual-hit response
      shape yields outcome `"config"`/`"registry"`.
- [ ] An injected fetch returning the registry's derived-on-miss
      response shape yields outcome `"derived"`, correctly distinguished
      from the actual-hit case above (assert on the outcome tag, not
      just the resolved address, since the two cases can return the
      same numeric channel/group).
- [ ] An injected fetch that times out (fake timer, no real wall-clock
      delay in the test) or throws a network error yields
      `"local-derived"`, with the address computed via
      `nameToRadioAddress` directly (assert the same value that function
      would return for the given name, not a re-derivation).
- [ ] Calling `resolveRobotAddress` twice for the same name within the
      TTL window results in exactly one fetch call; calling it again
      after the TTL expires issues a second fetch.
- [ ] No code path in this module issues anything but `GET` — a test
      asserts the fake fetch is only ever called with a GET-shaped
      request (no method, or `method: "GET"` explicitly, matching
      whatever convention the implementation uses).
- [ ] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- host` (packages/host).
- **New tests to write**: `mbrelayRegistry.test.ts` covering all three
  outcomes, the TTL cache, the read-only contract, and the never-throws
  contract, against an injected fake `fetch`.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

No dependency on any other ticket — this is a standalone HTTP client
module, testable entirely against a fake `fetch`. Read
`microbit-radio-relay`'s `httpapi.py`/`registry.py` (referenced in the
roadmap plan) to confirm the exact response shape distinguishing an
actual hit from a derived-on-miss reply before implementing the
outcome classification.

### Files to create/modify

- `packages/host/src/mbrelayRegistry.ts` — new.
- `packages/host/src/mbrelayRegistry.test.ts` — new.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Module doc comment on `mbrelayRegistry.ts`, matching `releases.ts`'s
documentation depth — state the write-on-read trap plainly up front
(quoting or closely paraphrasing the roadmap plan's finding 1), since
this is the single most important thing a future reader of this file
must not get wrong.
