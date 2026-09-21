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
import type { FirmwareAvailability, FirmwareKind, FlashPhase, SnapshotDevice, SnapshotLink, SnapshotRelay, Transport } from "@robot-console/host/src/wsMessages.js";

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

/** The release version to show for a robot's `program` string -- ticket
 * 018-017 (stakeholder-found defect the same day as 018-016): a
 * calibration build's program is `calibration-0.20260913.1`, and the
 * card should show the release version (`0.20260913.1`), not the whole
 * program string. The pattern is `<word-or-hyphen-chars>-<version>`
 * (one or more lowercase-letter/hyphen segments, a literal `-`, then a
 * version starting with a digit) -- matched generically rather than
 * hardcoding the `calibration-` prefix, so any future release-program
 * naming scheme following the same shape is covered without a code
 * change. A program string that doesn't match this shape (no parsing
 * assumed for it) is returned unchanged -- there is nothing to strip
 * out of it. */
export function programVersionText(program: string): string {
  const match = /^[a-z-]+-(\d[\w.]*)$/.exec(program);
  return match ? match[1]! : program;
}

/** A device's role text.
 *
 * For `kind === "robot"` (018-016, stakeholder verbatim: "show the
 * common name, the role, and the version number all on the same
 * line"; corrected by 018-017, stakeholder-found defect the same day:
 * the third part is the firmware release's own version, derived from
 * `program` via {@link programVersionText} -- not `device.version`,
 * which is the pxt-nezha-diffdrive *library* version bundled into
 * whatever program is running, e.g. `1.20260912.8`, and moved to the
 * Diagnostics tab as "Library version" instead of being shown here as
 * "the" version): joins whichever of `commonName`, `role`, the parsed
 * program version are currently known with ` · `, e.g. `robot · NEZHA2
 * · 0.20260913.1` in full, `robot · NEZHA2` before a program is known,
 * down to a bare `NEZHA2` for a robot identified before commonName was
 * ever written -- and "Role unknown" only once all three are absent
 * (never yet identified at all).
 *
 * For `kind === "relay"`, unchanged from ticket 018-010, item 3 --
 * "relay hosts are hosts, not 'No role announced'": the announced
 * `role` when there is one; otherwise say what it *is* by the
 * transport its own links actually use -- a `mbrelay` link means this
 * device is only known as an mbrelay pool's own host
 * (`watchers/mdnsWatcher.ts`'s `handleMbrelay` minting, never
 * identified over USB), so "mbrelay host"; a `mbserial` link means the
 * same for a serial-bridge farm host, "mbserial host". A relay
 * identified over USB always has a role by construction
 * (`connect/connector.ts` writes `kind`/`role` together from the same
 * banner, the instant it becomes `kind: "relay"` at all -- see
 * `repair/repairDeviceKindFromRole.ts`'s own doc comment) -- these two
 * transport labels are for the *other* way a relay row comes to exist,
 * mDNS-only, never plugged into this host directly. A relay with
 * neither falls back to "Role unknown", same as before. */
export function roleDisplay(device: SnapshotDevice): string {
  if (device.kind === "robot") {
    const programVersion = device.program !== null && device.program.length > 0 ? programVersionText(device.program) : null;
    const parts = [device.commonName, device.role, programVersion].filter(
      (part): part is string => part !== null && part !== undefined && part.length > 0,
    );
    return parts.length > 0 ? parts.join(" · ") : "Role unknown";
  }
  if (device.role !== null) {
    return device.role;
  }
  if (device.links.some((link) => link.transport === "mbrelay")) {
    return "mbrelay host";
  }
  if (device.links.some((link) => link.transport === "mbserial")) {
    return "mbserial host";
  }
  return "Role unknown";
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

/** Whether a link is eligible for the flash controls -- a direct read
 * of the host-computed `SnapshotLink.capabilities.flash` rather than a
 * UI-side guess. The rule lives in `projection.ts` and is deliberately
 * not restated here beyond its shape: any `usb` link, plus any link
 * whose DEVICE currently advertises `_mbflash._tcp`.
 *
 * Note the second half is about the device, not the link's transport
 * (corrected 2026-09-21): a robot bridged by radio through an mbrelay
 * is flashable when it advertises the service, because the flash dials
 * that service directly and never crosses the link this console is
 * talking over. An earlier version of this comment claimed "only its
 * `usb` one is ever flashable", which was already untrue when written
 * -- mbserial/wifi links could be flashed too -- and is now doubly so.
 * Flashability remains per-link only because an unidentified board (no
 * device at all) is still flashable over USB. */
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
    // Out-of-process, 2026-09-16: reasons only a local-hex source can
    // produce (`host/src/localFirmware.ts`'s `LocalHexError`). Kept in
    // the same calm, student-facing register as every branch above --
    // the path that is actually wrong is instructor detail, and belongs
    // in `firmwareDiagnosticDetail`, not here.
    case "file-missing":
    case "not-a-file":
      return "The build file isn't where it's expected — ask your instructor to check the setup.";
    case "unreadable":
      return "The build file couldn't be read — ask your instructor to check the setup.";
    case "invalid-hex":
      return "The build file looks incomplete — if it's still building, try again in a moment.";
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
  if (availability.kind === "local-file") {
    // The configured path *is* the diagnostic here -- "no file at
    // /Volumes/…/MICROBIT.hex" is the whole answer for whoever set it.
    return `Checked ${availability.hexPath}: ${availability.message}`;
  }
  return `Checked ${availability.repoUrl} (tag: ${availability.tag}): ${availability.message}`;
}

/** A GitHub repo URL's own short display name -- its final path segment
 * (e.g. `https://github.com/League-Robotics/nezha-robot-template` ->
 * `nezha-robot-template`). Ticket 018-017: this is the name flash
 * progress/result copy and the modal/Calibration-panel source line both
 * use in place of the generic `FIRMWARE_LABEL` word ("relay"/"robot"),
 * so a student sees exactly what release is being flashed. Falls back
 * to the full URL on the (never expected in practice) shape with no
 * path segment at all. */
export function repoShortName(repoUrl: string): string {
  const segments = repoUrl.replace(/\/+$/, "").split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : repoUrl;
}

/** "`<repo short name>` `<tag>`" for a configured release, e.g.
 * `nezha-robot-template v0.20260913.1` -- the name flash progress/result
 * copy names (ticket 018-017 acceptance: "Flashing nezha-robot-template
 * v0.20260913.1: writing…", "Flashed nezha-robot-template
 * v0.20260913.1"). `null` when nothing is configured for this firmware
 * kind at all -- callers fall back to {@link FIRMWARE_LABEL}'s generic
 * word in that case (there is nothing more specific to name). */
export function releaseDisplayName(availability: FirmwareAvailability | undefined): string | null {
  if (!availability || !availability.configured) {
    return null;
  }
  if (availability.kind === "local-file") {
    // e.g. "MICROBIT.hex built 2026-09-13 10:52" -- the same
    // "<what> <which build>" shape a release gets, so flash progress
    // copy ("Flashing MICROBIT.hex built …: writing…") reads the same
    // either way and no call site needs to know which kind it has.
    return `${availability.fileName} ${availability.tag}`;
  }
  return `${repoShortName(availability.repoUrl)} ${availability.tag}`;
}

/** Short, relative-time phrasing for "how long ago" `at` was --
 * "just now" / "N minutes ago" / "N hours ago" -- falling back to a
 * locale date/time string once it's a day or older, so a check from
 * last week never reads as an absurd "168 hours ago". Used only by
 * {@link firmwareSourceText}'s "checked …" text. */
export function relativeTimeText(at: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - at);
  if (diffMs < 45_000) {
    return "just now";
  }
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return new Date(at).toLocaleString();
}

/** Repo link + tag + "checked …" info for one configured firmware
 * release -- the small source line the flash modal (`FlashControls.tsx`)
 * and `CalibrationFirmwarePanel.tsx` both render under each release
 * button (ticket 018-017; one shared helper per the ticket's own
 * instruction so the two surfaces can never drift). `href` points at the
 * GitHub release page (`<repoUrl>/releases/tag/<tag>`), meant to be
 * rendered as a link opened in a new tab. `null` when nothing is
 * configured for this firmware kind -- callers already show {@link
 * firmwareDisabledReason}'s plain text in that case (and whenever the
 * firmware isn't currently available at all: each call site renders the
 * reason paragraph and this source line as mutually exclusive, per the
 * ticket's "if unavailable, show the plain reason instead"). */
export function firmwareSourceText(
  availability: FirmwareAvailability | undefined,
  now: number = Date.now(),
): { href: string | null; repoName: string; tag: string; checkedText: string } | null {
  if (!availability || !availability.configured) {
    return null;
  }
  const checkedText =
    availability.checkedAt === null ? "checked: never" : `checked ${relativeTimeText(availability.checkedAt, now)}`;
  if (availability.kind === "local-file") {
    // `href: null` is the signal to render plain text instead of a
    // link (out-of-process, 2026-09-16). A local build has no release
    // page -- and a `file://` link would be worse than none, since it
    // either does nothing or opens the raw hex in a browser tab.
    return { href: null, repoName: availability.fileName, tag: availability.tag, checkedText };
  }
  return {
    href: `${availability.repoUrl}/releases/tag/${availability.tag}`,
    repoName: repoShortName(availability.repoUrl),
    tag: availability.tag,
    checkedText,
  };
}

/** Student-facing label for a configured release firmware kind. */
export const FIRMWARE_LABEL: Record<FirmwareKind, string> = {
  relay: "relay",
  robot: "robot",
  joystick: "joystick",
};

/** Student-facing label for one stage of an in-flight flash. */
export const PHASE_LABEL: Record<FlashPhase, string> = {
  fetching: "downloading",
  verifying: "verifying",
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
 *
 * ## Freshest match, not first match (ticket 018-010)
 *
 * Bench evidence (`torture` relay card): more than one device can
 * legitimately carry a qualifying via-linked link to the *same*
 * `relayLinkId` at once -- e.g. `gopiv` was bridged through `torture`
 * earlier and is now `stale`/`failed`, and `tigez` was bridged through
 * it more recently and is also now `failed`. The old "first match in
 * `devices` order wins" rule could surface `gopiv`'s own stale row
 * (with `gopiv`'s own unrelated reason text) as "the" child even while
 * `tigez` was the actually-just-attempted one -- a card naming the
 * wrong robot for its own displayed failure reason. This now picks the
 * qualifying link with the newest `since` (its own state's start time)
 * across every device, so a card always describes the most recent
 * attempt through this relay, never a stale leftover one.
 */
export function findRelayChild(
  devices: readonly SnapshotDevice[],
  relayLinkId: string,
): { device: SnapshotDevice; link: SnapshotLink } | undefined {
  let best: { device: SnapshotDevice; link: SnapshotLink } | undefined;
  for (const device of devices) {
    for (const link of device.links) {
      if (link.via?.relayLinkId === relayLinkId && link.state !== "connectable" && link.state !== "discovered") {
        if (best === undefined || link.since > best.link.since) {
          best = { device, link };
        }
      }
    }
  }
  return best;
}

/** How long ago a {@link findRelayChild} match's own `since` (its state's
 * start time) may sit before {@link currentRelayChild} stops treating it
 * as "the" child a relay card/page shows connected/lost status for --
 * ticket 018-010 (team-lead bench walk 2026-09-13). Bench evidence: the
 * `torture` card read a red "Connection to gopiv lost: ttl-expired" box,
 * and `vitut`'s card read a bare "Connection to tigez lost" with no
 * reason at all -- both for a bridge that had genuinely ended hours (in
 * `torture`'s case) or longer ago, resurrected purely because
 * `findRelayChild` itself never expires a `failed`/`unresponsive` match
 * by age, only by state shape. A relay card must describe a bridge that
 * dropped recently, in this host process's own lifetime -- never
 * resurrect old bridge history read back from a copied/restarted store.
 * Five minutes is comfortably above every retry/backoff window this
 * sprint's transports use, while still being "recent" in the plain
 * English sense the ticket's own acceptance criteria use. */
export const RELAY_CHILD_RECENT_MS = 5 * 60_000;

/**
 * {@link findRelayChild}'s own match, additionally required to still be
 * "current" for status/connected-view purposes -- the single function
 * `RelayConnectControls.tsx` and `RelayPage.tsx` both call instead of
 * `findRelayChild` directly, so a relay's status text and its own
 * decision to mount `RobotPage`/`AddressSourceChip` for "the" child never
 * disagree (ticket 018-010).
 *
 * A match is current when either:
 * - it is genuinely live right now (answering, still usable/`connecting`
 *   -- {@link isLinkAnswering}/{@link isLinkUsable}), regardless of how
 *   long ago it started (a long-healthy bridge must never expire just
 *   because it is old); or
 * - it carries a live session ({@link hasBridgeSession}-equivalent,
 *   `link.session !== undefined`) -- a session the reconciler is still
 *   actively tracking is never "old history", whatever its age; or
 * - it is a recent drop: not `stale`, and its own `since` is within
 *   {@link RELAY_CHILD_RECENT_MS} of `now`.
 *
 * Anything else -- a `stale` link (aged out by
 * `store/index.ts`'s `ageRadioLinks`), or a `failed`/`unresponsive`/
 * `closed_by_user` link with no session that dropped longer ago than
 * that -- is old bridge history and is never "the" child: this returns
 * `undefined`, exactly as if `findRelayChild` had found nothing, so a
 * card/page falls back to its ordinary idle/sweeping/bridging rendering
 * instead of resurrecting a long-dead connection.
 */
export function currentRelayChild(
  devices: readonly SnapshotDevice[],
  relayLinkId: string,
  now: number = Date.now(),
): { device: SnapshotDevice; link: SnapshotLink } | undefined {
  const found = findRelayChild(devices, relayLinkId);
  if (found === undefined) {
    return undefined;
  }
  const { link } = found;
  if (link.state === "stale") {
    return undefined;
  }
  if (isLinkAnswering(link, now) || isLinkUsable(link) || link.state === "connecting" || link.session !== undefined) {
    return found;
  }
  return now - link.since <= RELAY_CHILD_RECENT_MS ? found : undefined;
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

/** How recently a session must have answered something (see
 * `SnapshotLink.session.answeredAt`'s own doc comment) to still count
 * as "Linked" -- generously above `connect/harvester.ts`'s own default
 * poll cadence and missed-poll ceiling (`DEFAULT_STATUS_POLL_INTERVAL_MS`
 * 2000ms x `DEFAULT_MISSED_POLL_LIMIT` 3 = 6000ms before the harvester
 * itself would declare the link dead) so a single slow tick can't
 * flicker the pill off, while still going stale well before a genuinely
 * unresponsive link would otherwise be caught. */
export const LINK_ANSWERED_FRESH_MS = 15_000;

/** How recently a `stale` link's own `lastSeen` must have refreshed for
 * {@link linkStateText} to treat it as still advertised (ticket
 * 018-010) rather than trusting the `stale` state name alone -- see
 * that function's own doc comment for the bench evidence
 * (`state: "stale"`, `lastSeen` 0 minutes old). Generous enough to cover
 * one aging-watcher pass lagging one fresh mDNS/registry observation,
 * without being so long that a link genuinely gone quiet keeps reading
 * "Not linked" forever instead of eventually saying so. */
export const STALE_ADVERTISED_GRACE_MS = 90_000;

/**
 * Whether a link is not merely {@link isLinkUsable} (transport open,
 * session object present) but has actually **answered** something
 * recently -- the "Linked"/green-pill criterion (ticket 018-010; bench
 * defect: `vevov`'s mbserial bridge accepted a TCP connection and
 * flipped its link to `connected` while its own robot never once
 * replied to `HELLO` -- the front page still showed a green "Linked"
 * pill, because the old criterion read only `state === "connected"`).
 * `link.session.answeredAt` is `undefined`/`null` for a session that has
 * never answered anything (including one that pre-dates this ticket's
 * migration, or a test fixture that never set it -- see that field's
 * own doc comment) -- both correctly never "Linked" here. */
export function isLinkAnswering(link: SnapshotLink, now: number = Date.now()): boolean {
  if (!isLinkUsable(link)) {
    return false;
  }
  const answeredAt = link.session?.answeredAt;
  if (answeredAt === undefined || answeredAt === null) {
    return false;
  }
  return now - answeredAt <= LINK_ANSWERED_FRESH_MS;
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
 * connect: connector: link "usb-9906…2820" produced no banner…", and (a
 * relay card, ticket 018-010) "Connection to gopiv lost: relayBridger:
 * candidate "radio-tigez-via-mbrelay-torture" produced no banner…" --
 * the quoted candidate id can even name a *different* robot than the one
 * the link legitimately belongs to (the id is minted from whichever name
 * was requested at connect time, not from whoever's device row the link
 * ends up attached to), which is exactly why it must always be removed
 * outright rather than trusted for anything. Only the prefix and quoted
 * id fragments are removed; the rest of the message (including a
 * banner's own quoted `name`, which is student-meaningful) is untouched.
 *
 * Exported (ticket 018-010) so `RelayConnectControls.tsx`'s
 * `relayStatusText` -- the other place a raw `link.reason`/bridging
 * error reaches a card -- routes through the exact same cleaning rather
 * than keeping its own, previously-absent, copy.
 */
export function stripInternalIds(reason: string): string {
  return reason
    .replace(/^\s*(?:connector|relayBridger):\s*/, "")
    .replace(/\b(?:link|candidate)\s+"[^"]*"\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** `connect/connector.ts`'s own `BRIDGE_CONTENTION_REASON` (018-008),
 * duplicated here as a plain string rather than imported: that module
 * pulls in Node-only transports (`serialport`, `node:sqlite` via the
 * store) this browser-side package cannot bundle. Kept in sync by name
 * (both reference "018-008" in their own doc comments) -- already plain
 * words with no id to strip, so {@link plainFailureReason} passes it
 * through unchanged; matched here only so it is never mistaken for one
 * of the generic "something went wrong" shapes below and re-worded. */
const BRIDGE_CONTENTION_REASON = "another app is connected to this bridge";

/** Plain-word USB port-lock advice (ticket 018-010's own required
 * truth): a second process already has the serial port open. Distinct
 * from {@link BRIDGE_CONTENTION_REASON} -- that one names a *network*
 * bridge's own single-client limit (mbserial/WiFi, 018-008); a local USB
 * port has no such bridge to contend over, only the OS-level exclusive
 * lock a `serialport` open failure (`EBUSY`/"Resource busy"/"Permission
 * denied"/"already in use") reports. */
const USB_PORT_LOCK_REASON = "another app has this board open";

/** No-answer advice, one plain-word phrase per transport (ticket
 * 018-010's own required truths list) -- covers both "no banner within
 * the identify budget" (nothing at all came back) and a bare connect
 * timeout, since both mean the same thing to a student: nobody answered.
 * Bench evidence: `gopiv`'s mbserial row used to show the USB-specific
 * "check the USB cable" advice for a network-bridge link -- the old
 * {@link plainFailureReason} had exactly one phrasing for every
 * transport. */
const NO_ANSWER_ADVICE: Record<Transport, string> = {
  usb: "the robot didn't answer when we said hello — check the USB cable or that it's powered on",
  mbserial: "the bridge answered but the robot didn't — is the robot plugged into the farm and powered?",
  wifi: "no answer from the robot over WiFi — is it on the network?",
  radio: "no radio reply — is the robot on and in range?",
  mbrelay: "no radio reply — is the robot on and in range?",
};

/** No-answer advice for a relay device's OWN connectivity link (`kind:
 * "relay"`, ticket 018-010 bench defect: `vevav`, a RADIOBRIDGE relay
 * plugged in over USB, showed {@link NO_ANSWER_ADVICE}`.usb`'s robot
 * wording -- "check the USB cable or that it's powered on" -- for a
 * board that is not a robot at all). Used instead of {@link
 * NO_ANSWER_ADVICE} whenever the failing link's owning device is a
 * relay, regardless of that link's own transport (`usb` for a
 * physically-attached bridge, `mbrelay` for one discovered over the
 * network -- both read this same text; a relay never gets robot-shaped
 * advice). "Parked in the data plane" names the specific known failure
 * mode this sprint's own relay firmware has (018-004/016-001: a relay
 * that answered a banner once can get stuck forwarding radio traffic
 * without re-arming its own identify listener) rather than a generic
 * "is it plugged in" guess, since the relay firmware answering that
 * question is usually "yes, and its LED is on". */
const RELAY_NO_ANSWER_ADVICE =
  "the relay didn't answer when we said hello — it may be parked in the data plane; unplug and replug it to reset";

/** A raw system/transport-level error (a Node `Error.message`, an
 * `ENOENT`/`EACCES`/etc. `errno` code, …) that never got translated to a
 * known shape above -- bench evidence: a relay card read "Connection to
 * `<name>` lost: Error: No such file or directory…" verbatim. There is
 * no useful engineer detail to preserve in front of a student here (this
 * is exactly the raw-plumbing leak {@link stripInternalIds} cannot
 * clean, since it isn't a `connector`/`relayBridger` prefix or quoted
 * id), so it falls back to the same per-transport "nobody answered"
 * phrasing as a genuine no-banner failure -- still truthful (something
 * kept this link from ever reaching the robot) without repeating
 * engineer jargon. */
const RAW_SYSTEM_ERROR_PATTERN = /^Error:|ENOENT|ECONNREFUSED|ECONNRESET|EACCES|EPIPE|No such file or directory/i;

/**
 * Turn a raw `link.reason` (a `LineLink`/harvester/connector/
 * relayBridger error message, engineer-facing) into a short, plain-word
 * phrase a student can read -- after {@link stripInternalIds} removes
 * the internal module-name prefix and any quoted link/candidate id. A
 * handful of shapes are known well enough to name explicitly; anything
 * else recognizable as raw system plumbing falls back to a per-transport
 * "nobody answered" phrasing rather than being shown verbatim, so a
 * student never sees a bare `Error:`/`errno` string.
 *
 * `transport` picks the right words for *who* failed to answer -- a USB
 * board, a farm bridge (mbserial), a WiFi robot, or a robot reached
 * through a relay (radio/mbrelay) -- ticket 018-010's own required
 * truth: "failure advice matches the transport that actually failed".
 *
 * - No banner at all within the identify budget (`connector.ts`'s/
 *   `relayBridger.ts`'s own "produced no banner within the identify
 *   budget"), or an unrecognized raw system error, both read as
 *   {@link NO_ANSWER_ADVICE}`[transport]` -- the transport-specific
 *   phrasing this ticket's required truths name.
 * - A banner/serial identity mismatch (`connector.ts`'s item-E checks,
 *   both ending "... check the USB cable") is already a specific,
 *   actionable instruction -- kept verbatim (once cleaned of ids) rather
 *   than genericized.
 * - 018-008's own bridge-contention text ({@link BRIDGE_CONTENTION_REASON})
 *   is kept verbatim -- already plain words, and already distinguishes
 *   "someone else is using this" from "nobody answered".
 * - A USB port already held by another process reads as
 *   {@link USB_PORT_LOCK_REASON}.
 * - A connect timeout (`LineLink.connect()`'s own `"... timed out after
 *   Nms"`, or any other "timed out" message) reads as "no answer (timed
 *   out)" -- kept transport-agnostic (pre-dates this ticket; not one of
 *   its named defects) rather than folded into {@link NO_ANSWER_ADVICE}.
 * - A harvester missed-poll reason (`"no reply to N STATUS polls --
 *   link presumed dead"`) reads as "stopped answering", regardless of
 *   transport (this is "it was answering, then it stopped", not "it
 *   never came back to begin with").
 *
 * `kind` (ticket 018-010, defaults to `"robot"` so every pre-existing
 * caller is unaffected): a device whose own `kind` is `"relay"` gets
 * {@link RELAY_NO_ANSWER_ADVICE} in place of {@link NO_ANSWER_ADVICE}
 * `[transport]` for the no-banner/raw-system-error case -- see that
 * constant's own doc comment for the bench defect (`vevav`'s card,
 * robot-shaped USB advice for a relay).
 */
export function plainFailureReason(reason: string, transport: Transport, kind: SnapshotDevice["kind"] = "robot"): string {
  if (reason === BRIDGE_CONTENTION_REASON && transport === "wifi") {
    // A WiFi robot has one TCP slot; "bridge" is the wrong word for it.
    return "another connection is already open to this robot over Wi-Fi";
  }
  const cleaned = stripInternalIds(reason);
  if (cleaned === BRIDGE_CONTENTION_REASON) {
    return cleaned;
  }
  if (transport === "usb" && /EBUSY|resource busy|permission denied|already in use/i.test(cleaned)) {
    return USB_PORT_LOCK_REASON;
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
  if (/no banner within the identify budget/i.test(cleaned) || RAW_SYSTEM_ERROR_PATTERN.test(cleaned)) {
    return kind === "relay" ? RELAY_NO_ANSWER_ADVICE : NO_ANSWER_ADVICE[transport];
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
 * pending).
 *
 * **`"Linked" requires an answered session, not just `state ===
 * "connected"`** (ticket 018-010; bench defect: `vevov`'s mbserial
 * bridge accepted a TCP connection and flipped its link to `connected`
 * while its own robot never once replied to `HELLO` -- the front page
 * still showed "Linked"). `state === "connected"` with a session that
 * has not yet answered (or has gone stale, see {@link isLinkAnswering})
 * now reads "Connecting" instead -- still true (a session exists, is
 * being established/confirmed) without claiming a fact nobody has
 * verified yet.
 *
 * **An advertised link never reads "Not seen since …"** (ticket 018-010;
 * bench defect: the `torture` relay's own row read "Not seen since …"
 * while `state: "stale"` but `lastSeen` only 0 minutes old -- the aging
 * watcher can mark a link `stale` on its own schedule moments before a
 * fresh observation of the still-present service, and nothing walks
 * that state back until the *next* aging pass). A `stale` link whose
 * `lastSeen` is still within {@link STALE_ADVERTISED_GRACE_MS} is
 * presumed still advertised -- "Not linked" (true: no session) rather
 * than the contradicted "Not seen since" claim.
 *
 * `kind` (ticket 018-010, defaults to `"robot"`): passed straight through
 * to {@link plainFailureReason} so a relay's own connectivity link gets
 * relay-shaped no-answer advice instead of robot-shaped advice -- see
 * that function's own doc comment. */
export function linkStateText(link: SnapshotLink, now: number = Date.now(), kind: SnapshotDevice["kind"] = "robot"): string {
  switch (link.state) {
    case "connected":
      return isLinkAnswering(link, now) ? "Linked" : "Connecting";
    case "connecting":
      return "Connecting";
    case "failed":
    case "unresponsive": {
      const base = link.reason ? `Couldn't connect: ${plainFailureReason(link.reason, link.transport, kind)}` : "Couldn't connect";
      if (link.nextRetryAt !== null && link.nextRetryAt > now) {
        const seconds = Math.max(1, Math.ceil((link.nextRetryAt - now) / 1000));
        return `${base} · retrying in ${seconds}s`;
      }
      return base;
    }
    case "stale": {
      if (link.lastSeen !== null && Math.abs(now - link.lastSeen) <= STALE_ADVERTISED_GRACE_MS) {
        return "Not linked";
      }
      return link.lastSeen !== null ? `Not seen since ${new Date(link.lastSeen).toLocaleString()}` : "Not linked";
    }
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

/**
 * The links a device card should actually list (ticket 018-010 bench
 * defect: every card cluttered with aged rows -- `vevov` showing two
 * `Not seen since …` radio rows from a day+ ago, `gopiv` showing four
 * radio rows including "yesterday's", `tovez` showing a `USB ·
 * /dev/cu.usbmodem2121102` row for a port that now belongs to a
 * different device entirely (`vitut`), `tigez` showing USB/WiFi rows
 * from 9/12). Ticket 018-005 taught the store to age a quiet link to
 * `stale` (`ageLinks`/`ageRadioLinks`), and ticket 018-010's own
 * `linkStateText` already renders that state honestly ("Not seen
 * since …", or "Not linked" within {@link STALE_ADVERTISED_GRACE_MS}) --
 * but nothing before this stopped a card from listing a `stale` row at
 * all. This is that filter: a `stale` link is never rendered as one of
 * the device's connections, full stop -- the aging watcher having
 * marked it so already means its own service/port is gone, however
 * "honest" the leftover row's own text is.
 *
 * This is also what hides a USB link whose physical path a different
 * device now holds: `watchers/usbWatcher.ts`'s `handleRemoved` marks a
 * departed board's own link `stale` (event-driven, immediately -- not
 * waiting on any TTL) the moment it is unplugged, and a *new* board at
 * the same path always gets its own distinct link id (keyed by USB
 * serial number, not by port path -- see that module's own doc
 * comment) -- so the OLD device's own link row is always `stale` by the
 * time a different device's row exists at that path, and is filtered
 * out here exactly like any other aged link, with no separate
 * path-collision check needed.
 *
 * Everything else -- usable/connecting, a fresh sighting not yet
 * connected (`discovered`/`connectable`), or a `failed`/`unresponsive`/
 * `closed_by_user` link whose underlying port/service is still current
 * (not yet aged) -- is shown, in `device.links`' own order. */
export function cardLinks(device: SnapshotDevice): SnapshotLink[] {
  return device.links.filter((link) => link.state !== "stale");
}

/** How many of `device.links` {@link cardLinks} hides -- the count a
 * card's own quiet "N older connections hidden" summary line reports
 * (ticket 018-010's own acceptance criterion, "optionally summarised as
 * one quiet line"), so a student can tell "nothing" apart from
 * "something was hidden here" without the clutter itself coming back. */
export function hiddenLinkCount(device: SnapshotDevice): number {
  return device.links.length - cardLinks(device).length;
}

// ---------------------------------------------------------------------
// Radio bridge allocation (stakeholder, 2026-09-14): a robot card's radio
// chip finds a bridge itself -- a free directly-attached USB radio bridge
// first, then an mbrelay pool -- instead of a student picking a robot on
// a bridge's card.
// ---------------------------------------------------------------------

/** Whether a link rides a radio bridge: a USB radio bridge (`radio`) or
 * an mbrelay pool (`mbrelay`). */
export function isRadioLink(link: SnapshotLink): boolean {
  return link.transport === "radio" || link.transport === "mbrelay";
}

/** Whether a link holds a session (answering or not) or is mid-connect --
 * what counts as a radio bridge being in use by it. */
export function isLinkActive(link: SnapshotLink): boolean {
  return link.state !== "stale" && (link.session !== undefined || link.state === "connecting");
}

/** The child link id `server.ts`'s `session-open {relayLinkId, name}`
 * handler creates for one (robot, bridge) pair. */
export function radioChildLinkId(name: string, relayLinkId: string): string {
  return `radio-${name}-via-${relayLinkId}`;
}

/** The link with id `linkId` on any of `devices`. */
export function findLink(devices: readonly SnapshotDevice[], linkId: string): SnapshotLink | undefined {
  for (const device of devices) {
    const found = device.links.find((link) => link.id === linkId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Every robot link currently bridged, or being bridged, through
 * `relayLinkId` -- in host order. A USB radio bridge has at most one; an
 * mbrelay pool can have several. */
export function relayConnections(
  devices: readonly SnapshotDevice[],
  relayLinkId: string,
): Array<{ device: SnapshotDevice; link: SnapshotLink }> {
  const found: Array<{ device: SnapshotDevice; link: SnapshotLink }> = [];
  for (const device of devices) {
    for (const link of device.links) {
      if (link.via?.relayLinkId === relayLinkId && isLinkActive(link)) {
        found.push({ device, link });
      }
    }
  }
  return found;
}

/** A USB radio bridge link in one of these states cannot take a robot
 * right now: gone, broken, or still identifying. */
const USB_BRIDGE_UNAVAILABLE_STATES = new Set<SnapshotLink["state"]>(["stale", "failed", "unresponsive", "connecting"]);

/**
 * The radio bridge a robot's radio chip should connect through -- the
 * relay link id to send in `session-open {relayLinkId, name}`, or
 * `undefined` when none is available:
 *
 * 1. the first directly-attached USB radio bridge carrying no robot
 *    (one serial port, one robot at a time);
 * 2. otherwise the first mbrelay pool -- a pool serves each connection
 *    with its own relay board, so it is never "in use" from here; a pool
 *    with no free board fails the connect instead.
 */
export function allocateRadioBridge(devices: readonly SnapshotDevice[]): string | undefined {
  const bridgeLinks = devices.filter((device) => device.kind === "relay").flatMap((device) => device.links);
  const freeUsb = bridgeLinks.find(
    (link) => link.transport === "usb" && !USB_BRIDGE_UNAVAILABLE_STATES.has(link.state) && relayConnections(devices, link.id).length === 0,
  );
  if (freeUsb) {
    return freeUsb.id;
  }
  return bridgeLinks.find((link) => link.transport === "mbrelay" && link.state !== "stale")?.id;
}
