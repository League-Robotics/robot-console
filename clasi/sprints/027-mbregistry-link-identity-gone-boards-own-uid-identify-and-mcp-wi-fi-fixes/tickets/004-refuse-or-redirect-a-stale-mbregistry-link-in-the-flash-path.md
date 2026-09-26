---
id: '004'
title: Refuse or redirect a stale mbregistry link in the flash path
status: in-progress
use-cases:
- SUC-004
depends-on:
- '003'
github-issue: ''
issue: gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Refuse or redirect a stale mbregistry link in the flash path

## Description

`packages/host/src/server.ts`'s `resolveFlashLinkTarget` (~line 583)
already has a redirect pattern for exactly this class of problem in its
**`usb`** branch: if a `usb` link's device already has a live, non-stale
`mbregistry` link, redirect to that one instead of racing mbregistry for
the same port:

```ts
if (linkRow.deviceId !== null) {
  const mbregistryLink = rows.links.find(
    (candidate) => candidate.deviceId === linkRow.deviceId && candidate.transport === "mbregistry" && candidate.state !== "stale",
  );
  if (mbregistryLink !== undefined) {
    return resolveFlashLinkTarget(rows, mbregistryLink.id, deps);
  }
}
```

Its own **`mbregistry`** branch (~line 620) does not apply that same
discipline to itself — it builds a `FlashTarget` straight from the
link row's stored address with **no check of `linkRow.state` at all**:

```ts
if (linkRow.transport === "mbregistry") {
  const address = parseLinkAddress("mbregistry", linkRow.address) as MbregistryAddress;
  const uid = address.uid;
  const device: MbregistryStreamDevice = { uid, host: address.host, endpoint: ... };
  return { ok: true, target: { kind: "mbregistry", uid, device, hasPersistedHost: ... } };
}
```

A `stale` mbregistry link — the gone board's own link, in the observed
bug — resolves `ok: true` just as readily as a live one. `runFlashTask`
(~line 1096) then calls `flasher.flashMbregistry` against a UID that is
not attached, and the 60 s `pyocd` hang / `exit -9` follows exactly as
described in the issue.

### What to change

In the `mbregistry` branch, check `linkRow.state` before building the
target:

- If `linkRow.state !== "stale"`: unchanged, build the target as today.
- If `linkRow.state === "stale"`: look up the same device's current
  non-stale `mbregistry` link (same `linkRow.deviceId`, `transport ===
  "mbregistry"`, `state !== "stale"`, and a **different** link id than
  the one just rejected) and recurse into `resolveFlashLinkTarget` for
  it — the same recursive-redirect shape the `usb` branch already uses.
- If no such current link exists for the device: return `{ok: false,
  reason: "<a plain-language message naming the uid and the fact it is
  not currently attached>"}` instead of a target.

This depends on ticket 003 landing first: the redirect's whole premise
(a device's *current* mbregistry link is reliably non-`stale` while a
gone one reliably is) only holds once `not_found` is classified as
`stale` promptly rather than retried as `failed` — see sprint.md's
Migration Concerns on ticket ordering.

`mcp/tools/flash.ts`'s own precondition check calls this exact function
(sprint 019's own design point: "one precondition set, not two") — no
separate change needed there; it gets the same refusal for free.

## Acceptance Criteria

- [x] A flash request against a device's `stale` mbregistry linkId,
      when that device has a current non-stale mbregistry link, resolves
      (and flashes) against the current link instead — mirroring the
      existing `usb`-branch redirect pattern exactly.
- [x] A flash request against a device's `stale` mbregistry linkId, when
      no current link exists for that device, returns `{ok: false,
      reason: ...}` — `runFlashTask` never proceeds to `flasher
      .flashMbregistry`, never starts the download/verify steps, and
      never reaches mbtools' own watchdog.
- [x] The refusal message is plain-language (names the uid, says it is
      not currently attached) — matches this function's own existing
      style (e.g. the `usb` branch's "no USB device is currently
      enumerated ... is it still plugged in?").
- [x] `mcp/tools/flash.ts`'s precondition check (which calls
      `resolveFlashLinkTarget` directly) is exercised by the same or an
      equivalent test — confirm `request_flash` gets the same refusal,
      not a second, divergently-worded one.
- [x] A non-`stale` mbregistry link's existing resolution behavior is
      byte-for-byte unchanged (regression, not just new coverage).

## Testing

- **Existing tests to run**: `server.test.ts`'s existing
  `resolveFlashLinkTarget` coverage (full suite for that function, to
  confirm the `usb` branch's redirect and the network branch are
  unaffected), `mcp/tools/flash.test.ts` if present.
- **New tests to write**: a `server.test.ts` case — a device with a
  `stale` mbregistry link and a live sibling, flashing the stale linkId
  redirects to the sibling; a case with only the stale link, flashing it
  returns `ok: false` with a clear reason. An MCP-level case confirming
  `mcp/tools/flash.ts`'s precondition check surfaces the same refusal.
- **Verification command**: run the workspace's vitest scripts scoped to
  `packages/host/src/server.test.ts` (or wherever
  `resolveFlashLinkTarget`'s own test file lives) and
  `packages/host/src/mcp/tools/flash.test.ts` — do not run the full
  suite, and do not exercise a real `pyocd`/mbtools flash.
