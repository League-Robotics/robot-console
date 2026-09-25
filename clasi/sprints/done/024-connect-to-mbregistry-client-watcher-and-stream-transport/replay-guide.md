# Replay guide: mbregistry commits onto Lineage L (sprint 024)

Produced 2026-09-25 by a read-only analysis of `old/robotprojects-sprint-018`
against Lineage L (`main` after sprint 023 close). Source issue:
`clasi/issues/reconcile-divergent-robot-console-lineages.md`.

Commits to replay, in order (code only): `58e2e10 c286cc5 3972612 3777026
4e326cb ffe550e ada147a b8ab1d1 f68c160 0198cd6`. Skip every chore/CLASI-only
commit and the radio-map commits `66321fd`, `8dbc60c` (L has its own).

## 0. Mechanics

- Every code commit also touches `.clasi/.clasi.db` and
  `clasi/sprints/018-…` ticket files. Drop all `clasi/` and `.clasi/` paths
  in each pick (keep L's versions). The sprint dir is already re-homed as
  024 on this branch.
- `package-lock.json`: keep L's, regenerate at the end (`npm install`).
- Optional: resolve the heavy host files (`server.ts`, `runtime.ts`,
  `connector.ts`, `relayBridger.ts`) straight to their final form at the first
  conflict, then "ours" for later picks.

## 1. Per commit

**58e2e10 client, c286cc5 watcher, 3972612 stream** — textually clean.
Semantic: in `watchers/mbregistryWatcher.ts` `identify()`, pass
`role: fields.role, commonName: fields.commonName` to `store.upsertDevice`
(L added `devices.common_name`, migration 0003, and
`repair/repairDeviceKindFromRole.ts`).

**3777026 connector** — L changed `createTcpStream` to `(host, port, ip?)`
and added `ip` to `TcpAddress`.
- `ConnectorDeps`: keep L's `createTcpStream`; add `createMbregistryStream`,
  `mbregistryClient`, `mbregistryLabel`.
- `parseLinkAddress`, `resolveExclusivity`: add our `case "mbregistry"` arms
  (final form incl. `host` spread from ffe550e).
- `buildStreamPlan`: keep L's signature + add `createMbregistryStream`; relay
  hop = three-way ternary `usb ? serial : mbrelay ? createTcpStream(host,
  port, ip) : createMbregistryStream(addr, "relay")`; add `case
  "mbregistry"`.
- `createConnector`: keep L's `createTcpStream` default; add our
  `createMbregistryStream` default (final `{uid, host, endpoint}` form).
- `connector.test.ts`: keep both sides.

**4e326cb flash** — do NOT keep our `runFlashTask`. L has
`resolveFlashLinkTarget(rows, linkId, deps)` (also used by
`mcp/tools/flash.ts`), `runFlashTask(linkId, source, identity)` returning
`FlashResultLike`, `runNetworkFlashTask`, hex resolution with `local-file` and
joystick, `setFlashPhase(…, identity)`.
1. Keep L's imports/options; add `flashViaMbregistry`, `flashViaLocalSocket`,
   `mbregistryClient`, `mbregistryLabel`.
2. `FlashTarget` gains `{ kind: "mbregistry"; uid; device: MbregistryStreamDevice }`;
   in `resolveFlashLinkTarget` add `transport === "mbregistry"` before the
   network fallback, built purely from the stored address via
   `parseLinkAddress` (keep it a pure read).
3. Keep L's `buildApp(...)`; pass the mbregistry flash fns into L's
   `createFlasher(...)`.
4. `runFlashTask`: drop our `resolveHexText`; after L's hex block add the
   mbregistry branch: require client, `plan = resolveFlashPlan(...)`,
   `outcome = await flasher.flashMbregistry(linkId, uid, plan, label, hexText,
   p => setFlashPhase(linkId, source, p, identity))`, `finishFlash`, then
   mirror `runNetworkFlashTask`'s post-success `resetting`/`reidentifying`
   and best-effort `runtime.reconciler.requestOpen(linkId)` (flashMbregistry
   calls `requestClose`, which marks the link user-closed). Drop the live
   `find()` fallback.
- `projection.ts`: `flash: link.transport === "usb" || link.transport ===
  "mbregistry" || (device && findCurrentMbflashService(...))`.
- `server.test.ts` cases: fix to `FlashResultLike` and L's wording.

**ffe550e runtime/reconciler/mdns**
- `runtime.ts`: connector is built after `createRelayLeaseRevocationFn()` in
  L — drop our earlier block, extend L's call with `mbregistryClient,
  mbregistryLabel`. `stop()`: keep `harvester.stop()`, replace
  `usbHandle.stop()` with `mbregistryHandle.stop()`, keep
  `mbregistryClient.close()` before `store.close()`. Keep L's
  `wifiDiscoveryGraceMs`, `disableSweep ?? true`, and L's `stop()` doc.
- `runtime.test.ts`: merge `fakeDeps()`; every L test calling
  `startRuntime(` must `await` inside an async test.
- `cli.ts`: `const runtime = await startRuntimeFn({...})`; keep L's
  `PortInUseError`/attach block; add `mbregistryClient`/`mbregistryLabel` to
  L's `startServerFn({...})`.
- `mdnsWatcher.ts`: add `disabledTypes?` option after L's new options;
  `robotlinkTcpBrowser`/`robotlinkUdpBrowser` stay unconditional.
- `reconciler.ts` merges clean.

**ada147a relayBridger** — keep L's `createTcpStream(host, port, ip?)`, add
our three deps and default, three-way ternary keeping `.ip`.
**Auto-merged but wrong:** change L's `const needsLease = relayTransport ===
"usb";` to `relayTransport === "usb" || relayTransport === "mbregistry"`.
Keep L's `commonName` in `upsertDevice`.

**b8ab1d1 shareBoards** — `config.test.ts` import union; add
`getMbregistryShareBoards` default in runtime; `deviceDisplay.test.ts` keep
both; `FrontPage.test.tsx` assertions (`device-link-usb-1`) must be
rewritten against an mbregistry link and L's new card DOM.

**f68c160 gone/unrecognized, socket path**
- `projection.ts` unassigned gate: `(transport === "usb" || transport ===
  "mbregistry") && link.state !== "stale"`.
- `classifyDeviceKind`: relay→relay, joystick→joystick (L's DeviceKind),
  unknown→null (unassigned), else→robot. Fix watcher tests whose
  "unrecognized" fixture uses `role: "JOYSTICK"`; add a JOYSTICK→joystick test.

**0198cd6 bench fixes 2**
- Keep one copy of the relayBridger client wiring in runtime.
- `resolveFlashPlan`/local-socket flash go into the re-expressed server
  branch.
- `FlashPhase "connecting"` + `PHASE_LABEL.connecting` merge clean.
- **`AppHeader.tsx`: take L's version, drop ours and our added
  `AppHeader.test.tsx` cases** (L's `relayConnectionStatusText` already
  shows the failure reason; "No open session…" wording was rejected by the
  stakeholder).

## 2. Required edits no conflict will flag

1. `scripts/dev.mjs` calls `startRuntime()` without `await`; await it and pass
   `mbregistryClient`/`mbregistryLabel` to `startServer`.
2. `mcp/tools/flash.ts` candidate-link filter (`usb|mbserial|wifi`): add and
   prefer `mbregistry`.
3. `packages/ui/src/deviceDisplay.ts` `NO_ANSWER_ADVICE: Record<Transport,…>`:
   add `mbregistry`.
4. UI that only knows `usb`/`mbrelay`: `deviceDisplay.ts`
   `allocateRadioBridge`, `FrontPage.tsx` `RelayBridgeStatus` and
   `currentUsbLink` (front-page Flash bolt), `TransportIcon.transportShortName`
   — add `mbregistry`.
5. `startRuntime`: if the mbregistry `connect()` throws, close the store
   (try/catch).
6. `runtime.stop()` / `client.close()` must end a spawned child (close its
   stdin or kill it) — L's attach path calls `runtime.stop()` then returns.

## 3. Port contention (must fix this sprint)

With `usbWatcher` off, nothing ages L's existing `usb` link rows;
`clearDeadProcessState` resets them to `connectable`, and the reconciler /
sweeper / flasher would open `/dev/cu.usbmodem*` directly. In `startRuntime`,
after the mbregistry connect, age all `usb` links stale
(`store.ageLinks("usb", 0, now)` or equivalent), and make
`resolveFlashLinkTarget` prefer the mbregistry link when a device has one.

## 4. Decisions (team-lead, 2026-09-25)

- mDNS `_mbserial` / `_mbflash` / `_mbrelay`: disabled by default as
  designed, but make the disabled set configurable via env
  `ROBOT_CONSOLE_MDNS_LEGACY=mbserial,mbflash,mbrelay` (listed types are
  re-enabled) so farm paths can be turned back on without a code change.
  Document in README.
- Device kinds: L's classification wins (joystick kind/page/section).
- Architecture doc: add an mbregistry section to `docs/design/architecture.md`
  (owner process = host that runs `startRuntime`; link preference; disabled
  watchers; supervisor note: set `MBREGISTRY_BIN` in
  `/etc/robot-console/robot-console.env`).
