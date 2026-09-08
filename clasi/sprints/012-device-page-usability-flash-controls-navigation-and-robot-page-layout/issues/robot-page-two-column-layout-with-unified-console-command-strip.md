---
status: in-progress
sprint: '012'
tickets:
- 012-003
- 012-005
- 012-006
---

# Rebuild the robot page as a two-column layout with one console and a command strip beneath it

## Description

Stakeholder report from hands-on use of [RobotPage.tsx](packages/ui/src/pages/RobotPage.tsx):

> All right, the robot structure here is a bit weird. I've got the Get
> and Set, and then there's this big area that's got a log and an auto
> scroll, but that seems to be different than the console. If I enter a
> value into the console line, it shows up in both places, and they get
> bigger. I don't need two consoles, and the consoles need to scroll.
> The Status button has its own place to display status. Let's just put
> those right below the Send line.

The current page stacks four independent panels in a single narrow
column ([RobotPage.tsx:53-78](packages/ui/src/pages/RobotPage.tsx#L53-L78)):
E-stop, sequencing indicator, Drive, Status, Get/Set, and console. Three
of those render their own separate response area reading the same
underlying log, which is what produces the "two consoles" effect.

---

## The "second console" is a real bug, not just a layout complaint

[GetSetPanel.tsx:55](packages/ui/src/components/GetSetPanel.tsx#L55) computes
its reply area as:

```ts
const replies = log.filter((entry) => entry.direction === "rx" && entry.id > watermarkId);
```

with `watermarkId` initialized to `-1`
([GetSetPanel.tsx:52](packages/ui/src/components/GetSetPanel.tsx#L52)).
Two consequences:

1. **Before any GET/SET is sent, `watermarkId` is `-1`, so the filter
   matches every rx line the device has ever sent.** The panel labelled
   "No reply yet" is in fact displaying the endpoint's entire receive
   history. That is the duplicate console the stakeholder is seeing, and
   it appears without them touching GET or SET at all.
2. **After a GET/SET, it still shows every subsequent rx line** — not
   just the reply. Any unsolicited telemetry, any device chatter, any
   reply to a line typed into the console send box lands here too. The
   doc comment describes this as intentional ("watches the endpoint's log
   for whatever arrives *after* the most recent `GET`/`SET` was sent"),
   which is a defensible choice for a reply pane but makes it a
   full-fidelity second log in practice.

And it cannot scroll. [GetSetPanel.css:76](packages/ui/src/components/GetSetPanel.css#L76)
sets `min-height: 2rem` with **no `max-height` and no `overflow`**, so
the region grows without bound and pushes the rest of the page down —
exactly "they get bigger."

For contrast, the real console *does* scroll —
[DeviceConsole.css:65-67](packages/ui/src/components/DeviceConsole.css#L65-L67)
sets `min-height: 16rem; max-height: 32rem; overflow-y: auto`. So "the
consoles need to scroll" applies to the Get/Set reply area (and any
other panel-local log region), not to `DeviceConsole` itself.

[StatusPanel.tsx:69-71](packages/ui/src/components/StatusPanel.tsx#L69-L71)
has the same shape but is bounded to a single line (the most recent
`status`-prefixed rx line), so it's a third view of the same log rather
than a third unbounded one.

## The page is also artificially narrow

> Put the console on the right side of the screen. Split the screen in
> half. [...] let's split the screen in half. We've got a much wider
> screen than you're using here.

[RobotPage.css:5](packages/ui/src/pages/RobotPage.css#L5) caps the whole
page at `max-width: 46rem` in a single flex column. Nothing uses the
horizontal space beyond that, on any display.

---

## Requested layout

Verbatim from the stakeholder, as the spec:

- **Get rid of Status and its button and its separate response area.**
- **Get rid of Get and Set and its separate response area.**
- **Put those all below the line for the console.**
- **A command strip below the console:** `Hello`, `ID`, `Ver`, `Status`,
  then a pull-down for Get and Set with a value entry, then `Get` and
  `Set` buttons. No separate areas for any of it — all replies land in
  the one console log.
- **Console on the right side of the screen; split the screen in half.**
  Left half: commands to do with motion, plus charts and graphs. Right
  half: the console.
- Possibly **tabs on the right**: charts and graphs in one tab, console
  in another.

### Structural notes for whoever implements this

**The four verb buttons are all unsequenced,** so they can all go
through `sendCommand` exactly as `StatusPanel` does today. `HELLO`,
`ID`, `VER`, and `STATUS` are none of them in `SEQUENCED_VERBS`
([session.ts:120-132](packages/protocol/src/v6/session.ts#L120-L132) —
the 11 id-bearing verbs are `GET`, `SET`, `TLM`, `STOP`, `RUN`,
`WHEELS_X`, `WHEELS_V`, `MOVE_X`, `MOVE_V`, `GO_TO_R`, `GO_TO_W`). So
the strip needs no sequencing state; their replies arrive as ordinary
`line` messages and render in the console log like everything else.
`GET`/`SET` *are* sequenced, but `sendCommand` already handles that.

**The Get/Set pull-down needs a source of field names, and the codebase
deliberately has none.** [GetSetPanel.tsx:1-11](packages/ui/src/components/GetSetPanel.tsx#L1-L11)
records the reason: per protocol.md "no config field table lives in this
library", so there is no enumerable list of legal names to build a
picker from, and the recorded team-lead decision was to revisit this
when calibration (sprint 010) gives the fields meaning. This request
brings that forward. The one mechanism already available: a **bare
`GET`** returns one `get` line per known field, so the dropdown could be
populated by firing a bare `GET` on page load (or on first open) and
harvesting the field names from the replies — discovered from the device
rather than hardcoded. That keeps the "no invented vocabulary" property
intact. It should stay editable (a combo box, not a closed select) so an
unlisted name can still be typed.

**Deleting the panels' reply areas is the point, but check what's lost.**
`StatusPanel`'s value was pulling the newest `status` line out without
scrolling for it; folding it into the console means a `STATUS` reply is
findable only by reading the log. The stakeholder has asked for exactly
that, and the console's own line classification
([DeviceConsole.tsx:50-65](packages/ui/src/components/DeviceConsole.tsx#L50-L65))
already styles replies distinctly, so this is likely fine — noting it so
it's a known consequence rather than a surprise.

**Charts and graphs don't exist yet.** No telemetry visualization
component exists in [packages/ui/src/components/](packages/ui/src/components/).
`TLM` is a sequenced verb, so the wire support is there, but the left
column's "charts and graphs" half is net-new work. This issue should
probably be split: the layout + console unification + command strip is
one coherent piece that can ship immediately; charts are a separate,
larger piece. The left column can hold `DriveControls` and `EstopControl`
alone in the first pass, with the chart area added later.

**`EstopControl` is pinned and must stay reachable.** Its CSS keeps it
at the top of the viewport as the page scrolls, and
[RobotPage.tsx:18-27](packages/ui/src/pages/RobotPage.tsx#L18-L27)
documents that it is deliberately mounted unconditionally, above every
other panel, and never nested inside a panel that could hide it. A
two-column split must not put it inside either column's scroll
container, and a tabbed right side must never be able to cover it.

**Two-column plus tabs interact with the scroll fix.** If the right
column becomes a full-height flex container, the console log should
scroll to fill it rather than keeping the fixed `max-height: 32rem` —
otherwise there's dead space below the log on a tall window.

## Open question for the stakeholder

The charts placement is stated two ways: first "sending commands that
have to do with motion and charts and graphs on the left-hand side, and
on the right-hand side, you get the console", then "maybe we've got tabs
for the console where you can show the charts and graphs in one tab and
the console in another tab." Those put the charts on opposite sides.
Worth settling before ticketing:

- **(a)** Left = motion controls + charts, right = console only.
- **(b)** Left = motion controls, right = tabs \[Console | Charts\].

(b) gives charts more width, which suits a time-series plot; (a) lets a
student watch a chart and the console at the same time. Since the charts
themselves are future work, (a) with the charts area stubbed on the left
is the lower-risk first pass, and the tabs can be added on the right
later without redoing the split.

## Acceptance sketch

- Exactly one log region on the robot page. `GetSetPanel`'s and
  `StatusPanel`'s separate response areas are gone, along with the
  Status button's dedicated panel.
- No region on the page grows without bound; every scrollable log region
  has a bounded height with `overflow-y: auto`.
- A command strip below the console send line offers HELLO, ID, VER,
  STATUS, a Get/Set field selector, a value entry, and GET/SET, with all
  replies appearing in the single console log.
- The page uses the full window width, split roughly in half, with the
  console on the right. `max-width: 46rem` is gone.
- `EstopControl` remains visible and clickable regardless of scroll
  position in either column.
- A regression test pins the `GetSetPanel` bug's absence: with a
  populated rx log and nothing sent, no second region echoes the log.
  (Applies to whatever replaces the panel — the assertion is about the
  page, not the deleted component.)
- Existing tests to update:
  [RobotPage.test.tsx](packages/ui/src/pages/RobotPage.test.tsx),
  [GetSetPanel.test.tsx](packages/ui/src/components/GetSetPanel.test.tsx),
  [StatusPanel.test.tsx](packages/ui/src/components/StatusPanel.test.tsx),
  and `RobotPage.transportBlind.test.ts` — the last one source-scans this
  page and its children for transport-specific references, so any new
  component added to the left or right column must stay transport-blind
  or that scan will fail.

## Related

- [[device-page-needs-a-back-button-to-the-device-list]] and
  [[flash-controls-unreachable-for-silent-boards-and-missing-from-every-device-page]]
  both want controls in the persistent app header. A robot page that
  fills the window interacts with that header, so the three are worth
  sequencing together.
