---
status: pending
---

# Flash controls are unreachable for a silent board, gone from the front page, and absent from every identified device page

## Description

Stakeholder report, from hands-on use:

> When I go into the radio, I can click into a Micro:bit, but I don't
> get any options for flashing. If the Micro:bit is completely
> unflashed, it doesn't have a radio or it doesn't have a hello
> announcement, then you should show the flash buttons right on the
> front. Those used to display, and now they don't. When I go into a
> Micro:bit, I often want to reflash it to something, and there should
> be a Flash option across the top menu.

Three distinct defects, one of which is a real logic bug that makes
flashing impossible for the most common board state on the bench.

---

## Defect 1 (the actual bug): a silent board never satisfies `isFailedIdentify`, so it gets **no** flash controls anywhere

[UnknownDevicePage.tsx:230](packages/ui/src/pages/UnknownDevicePage.tsx#L230)
gates every flash affordance behind one predicate:

```ts
const showFlashControls = isFailedIdentify(endpoint);
```

And [deviceDisplay.ts:60-62](packages/ui/src/deviceDisplay.ts#L60-L62) defines it as:

```ts
return device.role === null && device.sessionError !== undefined;
```

But a completely unflashed board — no radio, no `HELLO` — **does not set
`sessionError`**. From
[deviceRegistry.ts:1475-1495](packages/host/src/deviceRegistry.ts#L1475-L1495):

```ts
state.sessionOpen = true;
state.sessionError = undefined;
this.emitDevices();

// identify() never throws -- a silent board (never replies to
// HELLO) resolves null here rather than hanging or rejecting; the
// session above is already established either way.
const banner = await link.identify();
...
state.classification = classifyBanner(banner);   // -> type "unknown", role null
```

The session opens fine. `identify()` resolves `null`. Classification
becomes `unknown` with `role: null`. **`sessionError` stays
`undefined`.** So:

| board state | `role` | `sessionError` | `isFailedIdentify` | flash UI |
|---|---|---|---|---|
| unflashed / silent, session OK | `null` | `undefined` | **false** | **none** |
| no serial port | `null` | set ([deviceRegistry.ts:1411](packages/host/src/deviceRegistry.ts#L1411)) | true | shown |
| link error mid-session | `null` | set ([deviceRegistry.ts:1514](packages/host/src/deviceRegistry.ts#L1514)) | true | shown |
| identified relay/robot | set | `undefined` | false | none |

The exact case the stakeholder describes — a blank board that needs
flashing — is the one case that renders **no** flash buttons and no file
picker. It falls into the "No role announced" bucket
([deviceDisplay.ts:44-50](packages/ui/src/deviceDisplay.ts#L44-L50)),
which the code comments call "the common, unalarming case", and gets no
recovery path.

`isFailedIdentify`'s own doc comment
([deviceDisplay.ts:53-59](packages/ui/src/deviceDisplay.ts#L53-L59))
states the exclusion deliberately: "never an unprobed device (no
`sessionError`, no `role`)". That rule traces to a sprint architecture
decision, and it's wrong for a silent board — a silent board *has* been
probed, it just didn't answer. The predicate can't tell "probed and
silent" apart from "not probed yet" because both look identical on the
wire.

**This is the fix that matters most.** A board with nothing on it is
currently un-flashable through the UI.

## Defect 2 (regression, and it was intentional): flash controls were removed from the front-page cards

The stakeholder is right that these used to display. The removal is
documented in [FrontPage.tsx:19-25](packages/ui/src/pages/FrontPage.tsx#L19-L25):

> What's dropped: the inline Connect/Disconnect and flash-firmware
> controls `DeviceCard` owned before this sprint. Flash moved to the
> per-device page (`UnknownDevicePage.tsx`, ticket 008)

So this was a deliberate design decision during the two-level
navigation sprint, not an accident. The stakeholder is now overriding
it: for a board that is unflashed / has no radio / never announced,
the flash buttons should appear **on the front page card**, without
requiring a click-through.

Note the interaction with the current card markup: the entire card is a
single `react-router` `Link`
([FrontPage.tsx:128-163](packages/ui/src/pages/FrontPage.tsx#L128-L163)),
per the "you just click the box" note. Nesting `<button>`s inside an
`<a>` is invalid HTML and will fight the navigation. Restoring flash
buttons on the card therefore needs the card restructured — e.g. the
link covering the informational region only, with an action row as a
sibling outside it — not buttons dropped into the existing `Link`.

## Defect 3 (missing feature): no way to reflash an already-identified device

[RelayPage.tsx](packages/ui/src/pages/RelayPage.tsx) and
[RobotPage.tsx](packages/ui/src/pages/RobotPage.tsx) contain no flash
affordance at all — grep for `flash` in either returns nothing. Once a
board identifies successfully, the console offers no path to put
different firmware on it. The stakeholder's workflow ("I often want to
reflash it to something") is unsupported.

The ask is a **Flash option in the top menu**, available on any device
page regardless of classification.

---

## Suggested direction

The three defects share one root cause: flash is currently modeled as
*a recovery path for a broken device* rather than *an action you can
take on any board*. Reframing it that way addresses all three.

1. **Fix the gate.** Show flash controls whenever the board hasn't
   announced a usable role — `role === null`, regardless of
   `sessionError`. Optionally keep a distinction for the genuinely
   not-yet-probed instant (before the first `identify()` resolves) if
   there's a snapshot field that can express it; if there isn't,
   showing flash controls a moment early is far cheaper than never
   showing them at all. Update `isFailedIdentify`'s doc comment, which
   currently asserts the exclusion as intentional.
2. **Extract the flash controls** out of `UnknownDevicePage` into a
   shared component so the same controls can render in three places
   (front-page card, device page body, top-menu panel) without being
   written three times. The release-firmware buttons, the local-hex
   handshake, the progress rendering, and the `onFlashResult`
   subscription all move together —
   [UnknownDevicePage.tsx:136-328](packages/ui/src/pages/UnknownDevicePage.tsx#L136-L328)
   is the body to lift.
3. **Add a Flash entry to the top menu**, in the persistent
   `app-header` ([App.tsx:23-25](packages/ui/src/App.tsx#L23-L25)) —
   the same place the back button from
   [[device-page-needs-a-back-button-to-the-device-list]] wants to
   live, so these two are worth planning together. It should be
   enabled on any device page and open the shared flash controls for
   the current endpoint.
4. **Restore a compact flash affordance on the front-page card** for
   role-less devices, restructuring the card so the buttons aren't
   nested inside the `Link`.

A reflash of a *working* device is more destructive than recovering a
dead one, so the top-menu path for an identified relay/robot probably
wants a confirmation step that the unknown-device path doesn't need.
Worth a stakeholder decision rather than assuming.

## Open question for the stakeholder

"When I go into the radio, I can click into a Micro:bit" — the current
[RelayPage.tsx](packages/ui/src/pages/RelayPage.tsx) is a stub with a
disabled, empty robot dropdown and no clickable device list, so it
isn't clear whether "the radio" here means the relay device page, the
front-page list generally, or in-flight sprint 007 work not yet on
this branch. If it means a micro:bit reached *over the radio* rather
than over USB, note that flashing it is not possible at all — flashing
requires the board's own USB mass-storage/SWD connection, so a
radio-discovered remote node has no flash path and the UI would need to
say so rather than offer a button that can't work. Confirm which view
was meant before ticketing, since it changes scope.

## Acceptance sketch

- A completely unflashed micro:bit (session open, no `HELLO`, `role`
  null, no `sessionError`) shows release-firmware buttons and the
  local-hex file picker on its device page.
- The same board shows a flash affordance on its front-page card,
  without a click-through, and the card's navigation still works
  (click, middle-click, keyboard).
- Every device page — relay, robot, unknown — offers Flash from the top
  menu.
- Flashing an already-identified device is possible and guarded
  appropriately.
- A regression test pins the silent-board case specifically: an
  `EndpointListEntry` fixture with `role: null, sessionError:
  undefined` must render flash controls. That fixture shape is what the
  current gate silently drops, so it's the assertion that keeps this
  from coming back.
