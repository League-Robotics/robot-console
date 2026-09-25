/**
 * deviceDisplay.ts — presentational helpers for rendering a
 * `SnapshotDevice`/`SnapshotLink` (sprint 015 ticket 007: migrated off
 * the retired `EndpointListEntry`), shared across the front page and
 * every per-device page.
 *
 * ## Ticket 007: device/link split
 *
 * `EndpointListEntry` folded a device's identity, its one connection,
 * and that connection's session state into one flat object -- `name`
 * could be `null` (naming not yet resolved or failed), and
 * `sessionError` doubled as an "unresponsive" signal. Under the new
 * `Snapshot` contract, `devices[]` only ever lists an *identified*
 * device (`SnapshotDevice.name` is always a resolved string -- read
 * directly from `devices.name`, never absent, and never derived from
 * `id` here: for a `kind='robot'` row or a grammar-named `kind='relay'`
 * row, `devices.name` and `deviceIdToName(id)` agree by construction
 * [`store/index.ts`'s consistency check], but a non-grammar-named mDNS
 * relay (ticket 017-005, synthetic negative id) has no such relationship
 * -- `nameDisplay` below must keep reading `device.name`, never
 * `deviceIdToName(device.id)`, for exactly that reason); a board that
 * hasn't identified yet has no device row at all, and shows up in
 * `Snapshot.unassigned` as a bare `SnapshotLink` with no name to
 * display -- so `nameDisplay`'s old "flagged"/"Naming…" states have no
 * device-level equivalent any more. `roleDisplay`'s old
 * `sessionError`-driven "Unresponsive" case moves the same way: link
 * reachability (`state`/`reason`) is now a per-`SnapshotLink` concept,
 * rendered by `linkStateText` below (ticket 017-007: moved here from
 * `FrontPage.tsx`'s own former local `linkStatusText`, the single
 * shared copy every per-link status rendering site now reads), not
 * folded into a device's role text.
 */
import type { FirmwareAvailability, FirmwareKind, FlashPhase, SnapshotDevice, SnapshotLink, SnapshotRelay } from "@robot-console/host/src/wsMessages.js";

/** A device's display name. `SnapshotDevice.name` is always a resolved
 * string (see this module's doc comment), so this is never anything
 * but that name -- the `{ text, flagged }` shape is kept (rather than
 * returning a bare string) only so a future caller that still expects
 * this wrapper (ticket 008/009's per-device pages) doesn't need to
 * change its own destructuring, not because `flagged` can ever be
 * `true` for an identified device any more. */
export function nameDisplay(device: SnapshotDevice): { text: string; flagged: boolean } {
  return { text: device.name, flagged: false };
}

/** A device's role text: the announced `role`, or a calm "not yet
 * announced" placeholder. The old `sessionError`-driven "Unresponsive"
 * branch has no device-level equivalent -- see this module's doc
 * comment. */
export function roleDisplay(device: SnapshotDevice): string {
  return device.role ?? "No role announced";
}

/** Whether `device.program` marks it as a calibration build --
 * `SnapshotDevice` carries `program`/`version` directly (no
 * `classification.type` field any more; that concept was folded into
 * `kind: "robot" | "relay"` plus these two strings), so this is now a
 * simple prefix check rather than a read of a pre-computed
 * classification. Mirrors the pre-ticket-007 `classification.type ===
 * "calibration"` rule (a program name prefixed `calibration-`). */
export function isCalibrationProgram(program: string | null): boolean {
  return program !== null && program.startsWith("calibration-");
}

/** Whether a link is eligible for the flash controls -- now a direct
 * read of the host-computed `SnapshotLink.capabilities.flash`
 * (`projection.ts`: true for any `usb` link, regardless of whether its
 * owning device has identified) rather than a UI-side `role === null`
 * guess. Renamed input only (`link`, not `device`) -- flashability is a
 * per-link capability under the new contract, since a device can have
 * several links (only its `usb` one is ever flashable) and an
 * unidentified board (no device at all) is still flashable. */
export function canBeFlashed(link: SnapshotLink): boolean {
  return link.capabilities.flash;
}

/** Turn one firmware's live availability into either `null` (button
 * enabled) or a short, student-facing explanation of why it isn't --
 * never a hardcoded flag, always derived from the live
 * `firmwareStatus` the server polls and pushes (see `WsProvider`'s
 * `firmwareStatus` doc comment). Phrased as what the student should do
 * next -- not an engineer-facing error code. */
export function firmwareDisabledReason(availability: FirmwareAvailability | undefined): string | null {
  if (!availability || !availability.configured) {
    return "Not set up for this classroom yet — ask your instructor.";
  }
  if (availability.available) {
    return null;
  }
  switch (availability.reason) {
    case "not-yet-checked":
      // Poll hasn't completed yet -- must read as "still loading", not
      // "broken" or "permanently unavailable".
      return "Checking whether this firmware is available…";
    case "no-releases":
      return "No build has been published yet — ask your instructor when one's ready.";
    case "tag-not-found":
    case "no-asset":
      return "The configured build can't be found — ask your instructor to check the setup.";
    case "network":
      return "Couldn't check for firmware just now — try again in a moment.";
    default:
      return "This firmware isn't available right now.";
  }
}

/**
 * The instructor-facing counterpart to {@link firmwareDisabledReason}
 * (out-of-process, 2026-09-08): a diagnosable failure -- which repo/tag
 * was checked, and `releases.ts`'s specific `resolveRelease` message
 * (e.g. `"release v0.20260909.1 is missing MICROBIT.hex"`) -- for
 * whoever is troubleshooting *why* a build isn't showing up, since
 * {@link firmwareDisabledReason}'s calm, deliberately generic student
 * text ("ask your instructor") is not that.
 *
 * Returns `null` whenever there is nothing more specific to add than the
 * student-facing line already says: firmware not configured at all, a
 * live (`available: true`) firmware, or the pre-poll `"not-yet-checked"`
 * placeholder (never ran a real check, so it has no diagnostic detail).
 * Callers should render this *alongside*, never *instead of*,
 * {@link firmwareDisabledReason}'s text -- see this module's own doc
 * comment and `FlashControls.tsx`'s disclosure for where it's shown.
 */
export function firmwareDiagnosticDetail(availability: FirmwareAvailability | undefined): string | null {
  if (!availability || !availability.configured || availability.available) {
    return null;
  }
  if (availability.message === undefined) {
    return null;
  }
  return `Checked ${availability.repoUrl} (tag: ${availability.tag}): ${availability.message}`;
}

/** Student-facing label for a configured release firmware kind. */
export const FIRMWARE_LABEL: Record<FirmwareKind, string> = {
  relay: "relay",
  robot: "robot",
};

/** Student-facing label for one stage of an in-flight flash. */
export const PHASE_LABEL: Record<FlashPhase, string> = {
  fetching: "downloading",
  verifying: "verifying",
  connecting: "connecting",
  erasing: "erasing",
  writing: "writing",
  resetting: "resetting",
  reidentifying: "waiting for the board to come back",
};

// ---------------------------------------------------------------------
// Sprint 016 ticket 004 (SUC-004): relay/robot rendering the sweeper's
// takeover flow needs -- shared by `RelayPage.tsx` and `FrontPage.tsx`
// (both previously kept their own, identical copy of `findRelayChild`).
// ---------------------------------------------------------------------

/**
 * Find the device (and its own radio/mbrelay link) currently bridged
 * through `relayLinkId`, if any.
 *
 * ## Why a state guard, not a plain `via.relayLinkId` match
 *
 * `watchers/relaySweeper.ts` (sprint 016 ticket 003) records a
 * `links(radio)` row for EVERY remembered robot it ever probes over a
 * relay -- success or failure alike -- using the exact same
 * `via.relayLinkId` convention a real bridge uses
 * (`connect/relayBridger.ts`'s own `defaultFailoverChildLinkId`/
 * `radioChildLinkId`: one shared id space, so a sighting and a later
 * bridge converge on one row rather than two). A sweep-only sighting
 * leaves that link in `"connectable"` (answered) or `"discovered"`
 * (never yet attempted/answered) -- never any state a real bridge
 * attempt produces (`"connecting"`/`"connected"` while live,
 * `"failed"`/`"unresponsive"`/`"closed_by_user"`/`"stale"` once it was
 * and stopped being). Without this guard, the first remembered robot
 * the sweep ever sights on a relay would be mistaken for its
 * actively-bridged child, hiding the "idle · sweeping" label behind a
 * bogus "Connection to `<name>` lost" the moment a single sweep pass
 * completes.
 */
export function findRelayChild(
  devices: readonly SnapshotDevice[],
  relayLinkId: string,
): { device: SnapshotDevice; link: SnapshotLink } | undefined {
  for (const device of devices) {
    for (const link of device.links) {
      if (link.via?.relayLinkId === relayLinkId && link.state !== "connectable" && link.state !== "discovered") {
        return { device, link };
      }
    }
  }
  return undefined;
}

/** How long a device's most recent sighting still counts as "the
 * sweeper is probing this name right now" for the relay card's "idle ·
 * sweeping `<name>`" label (sprint 016 ticket 004) -- comfortably above
 * `watchers/relaySweeper.ts`'s own default per-candidate rate-limit
 * window (`SWEEP_MIN_INTERVAL_MS`, 30s) so the label doesn't flicker
 * off between one successful probe and the next, while still going
 * stale once the sweeper has clearly moved off this relay (or stopped
 * sweeping it altogether). No wire field carries "which candidate is
 * mid-probe right now" -- the sprint ticket's own Description leaves
 * this as a "ticket-level UI call" between a small wire addition and
 * client-side inference; this file chooses inference, from
 * `SnapshotDevice.lastChecked` (the newest `sightings` row for that
 * device across any transport, already on the wire). */
export const SWEEP_LABEL_FRESH_MS = 45_000;

/**
 * Which remembered robot the sweeper most recently (and still plausibly
 * currently) probed over `relayLinkId`, for the relay card's "idle ·
 * sweeping `<name>`" label -- the most-recently-`lastChecked` device
 * among those carrying a `via.relayLinkId === relayLinkId` link, as long
 * as that check is still within {@link SWEEP_LABEL_FRESH_MS} of `now`.
 * Returns `undefined` when nothing qualifies (no via-linked device yet,
 * or its last check has gone stale) -- callers render plain "idle ·
 * sweeping" in that case, which still correctly indicates an active
 * sweep via `relays[].lease === "sweep"` alone.
 */
export function findSweepingCandidateName(devices: readonly SnapshotDevice[], relayLinkId: string, now: number): string | undefined {
  let best: { name: string; at: number } | undefined;
  for (const device of devices) {
    if (device.lastChecked === null || now - device.lastChecked > SWEEP_LABEL_FRESH_MS) {
      continue;
    }
    if (!device.links.some((link) => link.via?.relayLinkId === relayLinkId)) {
      continue;
    }
    if (!best || device.lastChecked > best.at) {
      best = { name: device.name, at: device.lastChecked };
    }
  }
  return best?.name;
}

/**
 * The "(fast)"/"(slow)" suffix appended to the relay card's "idle ·
 * sweeping" label (ticket 016-007; rearch-12,
 * `League-Robotics/microbit-radio-relay#1`, merged) -- a diagnosable
 * reason for a slow classroom-wide sweep pass ("this relay hasn't
 * advertised the fast tune") rather than the sweeper simply looking slow
 * for no visible reason. Empty string when `relay.sweep` is absent or
 * `null` -- either an older snapshot with no `sweep` field at all, or a
 * relay for which no lease-acquisition sync has completed yet -- so the
 * existing plain "idle · sweeping `<name>`" label is unchanged in either
 * case (both `RelayPage.tsx` and `FrontPage.tsx`'s own pre-016-007 tests
 * still pass unmodified).
 */
export function sweepRateSuffix(relay: SnapshotRelay | undefined): string {
  if (!relay?.sweep) {
    return "";
  }
  return ` (${relay.sweep.rate})`;
}

/**
 * Whether a link is actually usable for sending right now -- the single
 * predicate every send-capable control and every "is this link open"
 * computation must read (extended scope, team-lead 2026-09-13; bench
 * defect: `zapuz`/`tigez` showed drive controls ENABLED while the card
 * read "Unreachable: no reply to 3 STATUS polls", because every call
 * site gated on `link.session !== undefined` alone -- the harvester
 * marks a link `unresponsive` while deliberately *keeping* its session
 * row, so `session !== undefined` alone cannot tell "open and answering"
 * from "open, but the device has stopped replying").
 *
 * `link.state === "connected"` is required in addition to `session !==
 * undefined`: a link's own `session` field survives far more than a
 * reconnect (see `useSendable`'s own doc comment) -- it also survives
 * the link itself going `unresponsive`/`failed`/`stale` while the host
 * keeps the (now-useless) session row around so a later good reply can
 * resume it without a fresh handshake. Neither half alone is sufficient:
 * `state === "connected"` with no `session` happens for the instant
 * between a link resolving and its session actually opening; `session
 * !== undefined` with `state !== "connected"` is exactly this bug.
 *
 * A caller that wants to gate an actual send (not just render "is this
 * link open") must additionally check `useSendable()` -- this predicate
 * says nothing about the host connection itself being live; see
 * `useSendable`'s own doc comment.
 */
export function isLinkUsable(link: SnapshotLink): boolean {
  return link.state === "connected" && link.session !== undefined;
}

/** A short label for one link: the host-built `label` (e.g. "USB ·
 * /dev/tty.usbmodem1234", "Radio · ch41/grp3"), with the relay's own
 * name appended for a `via` link so a student doesn't have to resolve
 * `via.relayLinkId` themselves. Moved here from `FrontPage.tsx` (ticket
 * 017-011) so `AppHeader` and `FrontPage` both read one shared
 * definition, per this sprint's SUC-007 UI-dedupe goal, rather than each
 * keeping its own copy. */
export function connectionLabel(link: SnapshotLink): string {
  return link.via ? `${link.label} (via relay ${link.via.relayName})` : link.label;
}

/**
 * Strip internal plumbing from a raw `link.reason` before it is ever
 * matched against {@link plainFailureReason}'s known shapes or shown to a
 * student (ticket 017-010, team-lead bench walk 2026-09-13): a link's
 * `reason` frequently comes straight from `connect/connector.ts`'s or
 * `connect/relayBridger.ts`'s own thrown `Error.message`, which is
 * engineer-facing by construction -- prefixed with the throwing module's
 * own name (`"connector: "`, `"relayBridger: "`) and naming the internal
 * `links.id`/candidate id in quotes (`link "usb-9906…2820"`, `candidate
 * "radio-gopiv-via-mbrelay-torture"`). Neither the module name nor the
 * internal id means anything to a student reading a front-page card --
 * bench evidence showed both leaking straight through into "Couldn't
 * connect: connector: link "usb-9906…2820" produced no banner…". Only the
 * prefix and quoted id fragments are removed; the rest of the message
 * (including a banner's own quoted `name`, which is student-meaningful)
 * is untouched.
 */
function stripInternalIds(reason: string): string {
  return reason
    .replace(/^\s*(?:connector|relayBridger):\s*/, "")
    .replace(/\b(?:link|candidate)\s+"[^"]*"\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Turn a raw `link.reason` (a `LineLink`/harvester/connector error
 * message, engineer-facing) into a short, plain-word phrase a student
 * can read -- after {@link stripInternalIds} removes the internal
 * module-name prefix and any quoted link/candidate id. A handful of
 * shapes are known well enough to name explicitly; anything else is
 * shown verbatim (cleaned of ids, but otherwise untranslated) rather than
 * swallowed, so an unanticipated reason is still visible rather than
 * silently genericized.
 *
 * - No banner at all within the identify budget (`connector.ts`'s/
 *   `relayBridger.ts`'s own "produced no banner within the identify
 *   budget") reads as "the robot didn't answer when we said hello —
 *   check the USB cable or that it's powered on" -- bench evidence
 *   (2026-09-13): this was the literal, untranslated reason shown twice
 *   on `tovez`'s card.
 * - A banner/serial identity mismatch (`connector.ts`'s item-E checks,
 *   both ending "... check the USB cable") is already a specific,
 *   actionable instruction -- kept verbatim (once cleaned of ids) rather
 *   than genericized.
 * - A connect timeout (`LineLink.connect()`'s own `"... timed out after
 *   Nms"`, or any other "timed out" message) reads as "no answer (timed
 *   out)".
 * - A harvester missed-poll reason (`"no reply to N STATUS polls --
 *   link presumed dead"`) reads as "stopped answering".
 */
function plainFailureReason(reason: string): string {
  const cleaned = stripInternalIds(reason);
  if (/no banner within the identify budget/i.test(cleaned)) {
    return "the robot didn't answer when we said hello — check the USB cable or that it's powered on";
  }
  if (cleaned.includes("check the USB cable")) {
    return cleaned;
  }
  if (/STATUS poll/i.test(cleaned)) {
    return "stopped answering";
  }
  if (/timed out/i.test(cleaned)) {
    return "no answer (timed out)";
  }
  return cleaned;
}

/** Per-link status text -- "Linked" / "Connecting" / "Couldn't connect:
 * …" (optionally "… · retrying in Ns") / "Not seen since …" / "Not
 * linked", derived from `state`/`reason`/`lastSeen`/`nextRetryAt`
 * (`sprint.md`'s own wording). Ticket 017-007: moved here from
 * `FrontPage.tsx`'s own former `linkStatusText` (the single shared copy
 * every per-link status rendering site now reads, rather than each
 * re-deriving it from `link.state` itself).
 *
 * **Bench defect (team-lead walk 017-012, 2026-09-13)**: `gopiv`'s WiFi
 * row read "Retrying in 0s" forever -- `state: "failed"` with a
 * `nextRetryAt` that had already passed (the reconciler's `plan()`
 * never schedules a second retry once the device has another connected
 * link), so the old unconditional "Retrying in Ns" both lied about an
 * active retry and hid `reason` entirely. Now: `failed`/`unresponsive`
 * always lead with "Couldn't connect" plus a plain-word `reason` (via
 * {@link plainFailureReason}) when one is recorded, and the "· retrying
 * in Ns" suffix is appended only while `nextRetryAt` is still in the
 * future -- never "0s" or a negative count (a past/absent
 * `nextRetryAt` just omits the suffix, telling the truth: no retry is
 * pending). */
export function linkStateText(link: SnapshotLink, now: number = Date.now()): string {
  switch (link.state) {
    case "connected":
      return "Linked";
    case "connecting":
      return "Connecting";
    case "failed":
    case "unresponsive": {
      const base = link.reason ? `Couldn't connect: ${plainFailureReason(link.reason)}` : "Couldn't connect";
      if (link.nextRetryAt !== null && link.nextRetryAt > now) {
        const seconds = Math.max(1, Math.ceil((link.nextRetryAt - now) / 1000));
        return `${base} · retrying in ${seconds}s`;
      }
      return base;
    }
    case "stale":
      return link.lastSeen !== null ? `Not seen since ${new Date(link.lastSeen).toLocaleString()}` : "Not linked";
    case "discovered":
    case "connectable":
    case "closed_by_user":
      return "Not linked";
    default: {
      const exhaustive: never = link.state;
      return String(exhaustive);
    }
  }
}

/** "Last checked `<time>`" text for a `via`-linked (radio/mbrelay) link
 * row on a device card (sprint 016 ticket 004; architecture.md §7.3) --
 * `undefined` when there's nothing to show (not a `via` link, or the
 * device has never been sighted at all). Reads `SnapshotDevice
 * .lastChecked` -- the newest `sightings` row for this device across
 * any transport; the field itself has been on the wire since sprint 015
 * ticket 004's own `projection.ts`, but nothing populated `sightings`
 * with real rows until sprint 016 ticket 003's sweeper started
 * recording them -- this component is simply the first to render it --
 * rather than the link's own `lastSeen`, a link-state timestamp with
 * different semantics. */
export function lastCheckedText(device: SnapshotDevice, link: SnapshotLink): string | undefined {
  if (!link.via || device.lastChecked === null) {
    return undefined;
  }
  return `Last checked ${new Date(device.lastChecked).toLocaleString()}`;
}
