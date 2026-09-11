---
status: pending
---

# Host rejects the robot template's release because its hex is not named `MICROBIT.hex`

## Description

Reported 2026-09-09 from the flash dialog, with the robot firmware source
pointed at `https://github.com/League-Robotics/nezha-robot-template:latest`:

> The configured build can't be found — ask your instructor to check the setup.
>
> Checked https://github.com/League-Robotics/nezha-robot-template (tag: latest):
> release v0.20260909.1 is missing MICROBIT.hex and MICROBIT.hex.txt

The release is not actually missing its firmware. `v0.20260909.1` carries one
asset, `nezha-robot-template-v0.20260909.1.hex`, and nothing else. The host's
`resolveRelease` (`packages/host/src/releases.ts`) matches assets by the exact
lowercased names `microbit.hex` and `microbit.hex.txt` and returns `no-asset`
when either is absent, so the diagnostic is technically accurate but the
robot firmware is un-flashable through the console.

## Root cause

Two release conventions have diverged:

- **Relay** (`microbit-radio-relay`): every release ships `MICROBIT.hex` plus a
  `MICROBIT.hex.txt` manifest (commit / built / sha256). The host's fetch and
  sha256-verify path was designed against this repo (sprint 002, ticket 003).
- **Robot template** (`nezha-robot-template`, `.github/workflows/release.yml`):
  packages `built/binary.hex` as `nezha-robot-template-<TAG>.hex` and uploads
  only that file via `gh release create`. The name is deliberate — the release
  notes tell students to download that file by name — and there is no
  manifest, so there is nothing to verify the sha256 against. The build
  provenance (commit, extension version, built time, baked profile) lives in
  the release notes body instead.

The host also never anticipated the template repo: `config/prod/public.env`
still points `ROBOT_CONSOLE_ROBOT_FIRMWARE` at `pxt-nezha-diffdrive`, which
publishes no releases at all.

## Proposed resolution

Fix on the host side rather than renaming the template's asset, since the
student-facing filename is intentional and the same divergence will recur for
any future robot image repo:

1. **Asset selection.** In `resolveRelease`, prefer an exact `MICROBIT.hex`
   match; if none, accept a release that carries exactly one `*.hex` asset
   (case-insensitive) and use that. Ambiguity (two or more `.hex` assets and
   no `MICROBIT.hex`) stays a `no-asset` error naming the candidates.
2. **Manifest becomes optional.** Look for `MICROBIT.hex.txt` first, then
   `<hexname>.txt` as a companion. If no manifest exists, skip sha256
   verification in `fetchAndVerifyHex` and instead validate the download as
   parseable Intel HEX (the existing `flash.ts` parse already does this
   downstream); surface `verified: false` / "unverified" in the UI detail so
   instructors know the integrity check did not run. Do not silently weaken
   verification for releases that *do* ship a manifest.
3. **Diagnostics.** The `no-asset` message should list the assets actually
   found (`... has assets: nezha-robot-template-v0.20260909.1.hex`) so the
   next naming drift is self-explaining from the dialog.
4. **Tests.** Extend `releases.test.ts` with a template-shaped release body
   (single `nezha-robot-template-<tag>.hex`, no manifest), the two-hex
   ambiguity case, and the manifest-present path unchanged.
5. **Config.** Update `config/prod/public.env` `ROBOT_CONSOLE_ROBOT_FIRMWARE`
   to the repo that actually publishes robot releases (currently
   `nezha-robot-template`), and note the asset conventions in
   `docs/design/specification.md` §firmware sources.

Alternative, if the stakeholder prefers a single convention: add a step to the
template's `release.yml` that also uploads `MICROBIT.hex` and a
`MICROBIT.hex.txt` manifest alongside the named hex. That fixes today's error
with no host change, but leaves the host brittle against the next repo.

## Affected code

- `packages/host/src/releases.ts` — `HEX_ASSET_NAME`, `MANIFEST_ASSET_NAME`,
  `resolveRelease`, `fetchAndVerifyHex`, `ResolvedRelease`
- `packages/host/src/releases.test.ts`
- `packages/host/src/wsMessages.ts` / `packages/ui/src/deviceDisplay.ts` —
  only if an "unverified" flag is surfaced
- `config/prod/public.env`
- `docs/design/specification.md`, `docs/design/usecases.md` (asset naming
  described as fixed `MICROBIT.hex` + `.txt`)

## Status 2026-09-09: unblocked on the template side

The reported error is gone without a host change. `nezha-robot-template`
now publishes the same image under BOTH names plus a manifest
(`.github/workflows/release.yml`, commit `8ac8537`), and `v0.20260909.1`
was backfilled by hand with the identical two assets — verified by
re-downloading them: `MICROBIT.hex` sha256
`d4ccd972974f85332ee19b38da93ad174494fafb25f4ce6b67005f411add32fc`,
which is exactly what `MICROBIT.hex.txt` declares, so
`fetchAndVerifyHex`'s integrity check runs for real rather than being
skipped.

That deliberately took the "alternative" at the end of §Proposed
resolution, not steps 1-2: making the manifest optional would have meant
flashing the robot image unverified, which is a worse trade than one
duplicated file per release. Steps 1-2 are therefore NOT wanted as
written.

What is still open, and why this issue stays pending:

- **Step 3 (diagnostics).** `no-asset` should list the assets it did
  find. The whole cost of this incident was that "is missing
  MICROBIT.hex" reads as "the release has no firmware" when the release
  had firmware under another name.
- **Step 5 (config).** `config/prod/public.env` still points
  `ROBOT_CONSOLE_ROBOT_FIRMWARE` at `pxt-nezha-diffdrive`, which
  publishes no releases at all; the robot image lives in
  `nezha-robot-template`.
- Documenting the two-name convention in `docs/design/specification.md`
  so the next image repo publishes both from day one.

## Remaining step folded into (2026-09-11)

Step 3 (list the assets found in the `no-asset` message) is part of `rearch-13-firmware-availability-watcher-etag-backoff.md`.
