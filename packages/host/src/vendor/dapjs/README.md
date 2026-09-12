# Vendored subset of `dapjs` 2.3.0

Ticket 014-001 (build hygiene). Why this exists, and what's here.

## Why vendored instead of `npm install dapjs`

`dapjs`'s published package (`dist/dap.umd.js`) is a bundled UMD build
with no ESM entry point. Its `DAPLink`/`CmsisDAP` classes are documented
(and typed, in the package's own `.d.ts`) as extending Node's
`events.EventEmitter` — but the *shipped bundle*, verified against real
hardware (sprint 003 ticket 005's bench session), is rolled up with its
own minimal, browser-safe event-emitter shim instead of actually
resolving Node's real `events` module. That shim implements
`on`/`emit`/`removeListener` but has **no `.off` alias**, unlike Node's
real `EventEmitter`. Calling `.off()` against the real runtime object
threw `"daplink.off is not a function"` — `packages/host/src/flash.ts`
carried a defensive `try/catch` around a `removeListener` call instead,
for exactly this reason (see that file's git history / ticket 014-001).

This directory vendors `dapjs`'s own TypeScript **source** (not its
bundle) instead, compiled by this repo's own `tsc` as part of the host
package. Compiled this way, `import { EventEmitter } from 'node:events'`
resolves to Node's real `events.EventEmitter` — which does implement
`.off` — so the workaround in `flash.ts` is no longer needed and has
been removed.

## What's vendored, and what isn't

`DAPLink` (what `flash.ts` uses) and `CortexM` (what `swdName.ts` uses)
both sit on top of a small dependency chain: `HID` (transport) ->
`CmsisDAP` (proxy) -> `ADI` (dap) -> `CortexM` (processor), and
`DAPLink` (daplink) directly on `CmsisDAP`. There is no smaller subset
of `dapjs` that compiles and provides both classes — this is the full
transitive closure, not an arbitrarily large vendor. What's **excluded**:
`transport/usb.ts` and `transport/webusb.ts` (WebUSB/USB transports —
this repo only ever talks to DAPLink boards via `node-hid`, never real
USB or a browser).

```
dap/            ADI (Arm Debug Interface) — ~2 files + enums
daplink/        DAPLink (the class flash.ts uses) — 3 files
processor/      CortexM (the class swdName.ts uses) — ~2 files + enums
proxy/          CmsisDAP (the CMSIS-DAP wire protocol) — ~2 files + enums
transport/      HID transport only (usb.ts/webusb.ts dropped)
```

Only change from upstream: relative imports rewritten with explicit
`.js` extensions (this repo's `tsconfig.base.json` uses
`"module"/"moduleResolution": "NodeNext"`, which requires them; `dapjs`'s
own build tooling did not). No behavioral change beyond that plus the
`.off` fix described above, which is a byproduct of compiling real
source against Node's real `events` module rather than a patch to any
vendored file's logic.

Source: https://github.com/ARMmbed/dapjs (MIT license, `LICENSE` in this
directory).
