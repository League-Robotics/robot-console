/**
 * uiDriver.ts — Layer 3's Playwright driving logic: load the real,
 * production-built UI (`packages/ui/dist`, served by a real host) in
 * headless Chrome, click Connect (or a relay card's robot picker +
 * Connect, or a card's own arrow if already Linked), type `ID` in the
 * console, and assert the reply/header/controls/card-text truthfulness
 * this ticket's acceptance criteria require.
 *
 * Selectors below are the same `data-testid`/class contract the UI's
 * own components already commit to (`FrontPage.tsx`'s `device-card-*`/
 * `device-connection-*`/`relay-quick-connect-*`, `AppHeader.tsx`'s
 * `app-header-connection*`, `DeviceConsole.tsx`'s `console-send-input`/
 * `console-log`/`console-line-*` and its `aria-label="Line to send"`) —
 * verified against the real running app in this same session's own
 * prior bench walks (`scratchpad/team-lead-walk2.mjs`,
 * `scratchpad/ui-walk-after.mjs`), not guessed from source alone.
 *
 * Pure, directly-testable pieces (no `Page` involved) are kept
 * separate from the async Playwright orchestration below, per this
 * harness's own established split (every other layer's probe module
 * keeps its classification logic pure and its socket/DOM I/O thin).
 */
import type { Page } from "playwright-core";
import type { SnapshotLink } from "@robot-console/host";
import type { BenchWsClient } from "../layer2/wsClient.js";
import { findLinkById, findRadioChildLink, type SnapshotLike } from "../layer2/pathChecks.js";
import type { Layer3Assertion, Layer3PathResult } from "./types.js";

/** Direct (non-relay) path labels, matched against `connectionLabel()`'s
 * own prefix (`projection.ts`'s `buildLabel`: `"USB · ..."`, `"WiFi ·
 * ..."`, `"mbserial · ..."`). */
const DIRECT_PATH_LABEL_PREFIX: Record<string, string> = {
  usb: "USB",
  mbserial: "mbserial",
  wifi: "WiFi",
};

/** `radio-via-mbrelay:<pool>` -> `<pool>`, or `undefined` for any other
 * path string. Pure. */
export function parseRelayPoolName(path: string): string | undefined {
  const match = /^radio-via-mbrelay:(.+)$/.exec(path);
  return match ? match[1] : undefined;
}

/** Whether `path` is one of the direct (non-relay) transports this
 * driver matches by connection-row label prefix. Pure. */
export function directPathLabelPrefix(path: string): string | undefined {
  return DIRECT_PATH_LABEL_PREFIX[path];
}

/**
 * Raw internal ids/plumbing that must never leak into card/page text a
 * student reads — the exact patterns this ticket names
 * (`connector:`, `relayBridger:`, `link "`, `candidate "`, a raw USB
 * serial prefix like `usb-9906`), matching `deviceDisplay.ts`'s own
 * `stripInternalIds` shapes so Layer 3 is checking that the *output* of
 * that stripping is actually clean, not re-deriving the rule
 * independently. Pure.
 */
export function isRawIdLeak(text: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/connector:/i, 'connector:'],
    [/relayBridger:/i, "relayBridger:"],
    [/link\s+"/i, 'link "'],
    [/candidate\s+"/i, 'candidate "'],
    [/usb-9906/i, "usb-9906"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return undefined;
}

/** Whether an `app-header-connection`-style text genuinely says
 * "Linked" -- a plain substring check (not a `\b`-bounded regex):
 * `.innerText()` across adjacent DOM elements with no literal
 * whitespace between them (e.g. a connection-label span directly
 * followed by the "Linked" pill span) concatenates with nothing in
 * between (observed live: `"mbserial · loki.local:36627Linked"`), so a
 * word-boundary check before "Linked" incorrectly fails there even
 * though the page plainly does say Linked -- matches this session's
 * own prior-verified bench walk (`ui-walk-after.mjs`)'s
 * `.includes("Linked")`, not a regex. Pure. */
export function looksLinked(headerText: string): boolean {
  return headerText.includes("Linked");
}

/** Whether a console log line is a genuine `id ...` reply (not the
 * echoed `»ID` tx line) -- `DeviceConsole.tsx` prefixes an rx line with
 * `«` and a tx line with `»` (no space), per this session's own
 * prior-verified bench walk (`ui-walk-after.mjs`). Pure. */
export function isIdReplyLine(line: string): boolean {
  return /^«\s*id\b/i.test(line.trim());
}

/** Whether a console log line is a genuine relay `?` status reply
 * (018-004) -- same `«`/`»` rx/tx prefix convention as {@link
 * isIdReplyLine}, matched against the live-observed shape (this
 * ticket's own bench evidence): `# channel: 0 group: 10 mode: RAW250
 * power: 7`. A relay has no `ID` verb (`!HELP` lists `HELLO` and `?`,
 * not `ID`), so a path whose device kind is `"relay"` is probed with
 * `?` instead and must match this predicate rather than {@link
 * isIdReplyLine}. `?`, not `HELLO`, on purpose: live verification found
 * a relay does not reliably repeat its full banner on a second `HELLO`
 * sent after the link is already Linked (the connector's own identify
 * already consumed the first one to reach Linked at all), while `?` is
 * a status query the relay always answers regardless of session
 * history -- see `layer2/pathChecks.ts`'s own doc comment for the full
 * story (this module's own `checkPath` mirrors that fix exactly). Pure. */
export function isRelayStatusReplyLine(line: string): boolean {
  return /^«\s*#\s*channel:/i.test(line.trim());
}

/**
 * 018-007 Step 0: whether a header's own `.app-header-connection-label`
 * text (`connectionLabel(link)` verbatim -- `"USB · ..."`, `"WiFi ·
 * ..."`, `"mbserial · ..."`, or `"Radio · ... (via relay <pool>)"`)
 * actually matches the path this check is supposed to be exercising.
 * This is the harness's own regression guard for the bug this ticket
 * fixed: Layer 3 used to click a device card's top-level arrow (the
 * device's "primary" link, whichever transport that happened to be)
 * rather than the specific link for the path under test, so a
 * `radio-via-mbrelay:<pool>` check could silently land on and pass an
 * already-usable `mbserial` link instead (018-007's own bench
 * evidence: header read "mbserial · loki.local:36627 · Linked" while
 * the report recorded a radio PASS). Pure. */
export function connectionLabelMatchesPath(labelText: string, path: string): boolean {
  const trimmed = labelText.trim();
  const pool = parseRelayPoolName(path);
  if (pool !== undefined) {
    return new RegExp(`^Radio · .*\\(via relay ${escapeRegExp(pool)}\\)$`).test(trimmed);
  }
  const prefix = directPathLabelPrefix(path);
  return prefix !== undefined && new RegExp(`^${escapeRegExp(prefix)} · `).test(trimmed);
}

const MOTION_BUTTON_TEXT = /Forward|Backward|Turn left|Turn right|rotate/i;

export interface DriverOptions {
  screenshotDir: string;
  /** Bound on the reply-within assertion. Default 5000ms per the
   * ticket's own acceptance criterion. */
  replyTimeoutMs?: number;
  /** Bound on a Connect click producing a usable (arrow-showing) link.
   * Default 20000ms -- generous relative to Layer 2's own observed
   * ~15s host identify budget. */
  connectTimeoutMs?: number;
  /** Bound on a relay bridge reaching "Connected to <robot>". Default
   * 30000ms -- generous relative to the live-verified ~9s torture
   * handshake schedule plus its own retry margin. */
  relayConnectTimeoutMs?: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeForFilename(text: string): string {
  return text.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

async function screenshot(page: Page, options: DriverOptions, name: string, screenshots: string[]): Promise<void> {
  const fileName = `${String(screenshots.length + 1).padStart(2, "0")}-${sanitizeForFilename(name)}.png`;
  await page.screenshot({ path: `${options.screenshotDir}/${fileName}` });
  screenshots.push(fileName);
}

async function cardLocator(page: Page, name: string) {
  return page.locator('[data-testid^="device-card-"]').filter({
    has: page.locator(".device-name", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
  });
}

/** Poll `check` every `intervalMs` until it returns a truthy value or
 * `timeoutMs` elapses; returns the last (possibly falsy) result. Used
 * throughout instead of Playwright's own auto-waiting locators where
 * the condition spans more than one element/attribute (e.g. "does this
 * card now show an open arrow"). */
async function poll<T>(check: () => Promise<T>, timeoutMs: number, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await check();
  while (!last && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await check();
  }
  return last;
}

/** Same "Linked" predicate the UI itself uses (`deviceDisplay.ts`'s
 * `isLinkUsable`, reimplemented here rather than imported so this
 * harness never depends on `packages/ui`'s internals -- matches
 * `layer2/pathChecks.ts`'s own identical inline check). Pure. */
function isUsableLink(link: SnapshotLink | undefined): link is SnapshotLink {
  return link !== undefined && link.state === "connected" && link.session !== undefined;
}

/** `deviceName`'s own link of the given direct transport, from a live
 * snapshot -- the ground truth this module resolves a target's exact
 * link id from, rather than ever clicking a device card's "primary"
 * arrow (018-007 Step 0's own fix; see {@link connectionLabelMatchesPath}'s
 * doc comment for the bug this replaces). Pure. */
function findDirectLink(snapshot: SnapshotLike, deviceName: string, transport: "usb" | "mbserial" | "wifi"): SnapshotLink | undefined {
  return snapshot.devices.find((d) => d.name === deviceName)?.links.find((l) => l.transport === transport);
}

/** `relayName`'s own `mbrelay` connectivity link -- the link id
 * `session-open {relayLinkId, name}` needs, and the id
 * {@link findRadioChildLink} matches a radio child link's own
 * `via.relayLinkId` against. Pure. */
function findRelayLink(snapshot: SnapshotLike, relayName: string): SnapshotLink | undefined {
  return snapshot.devices.find((d) => d.name === relayName)?.links.find((l) => l.transport === "mbrelay");
}

/**
 * 018-007 Step 0: closes every other currently-usable link on
 * `deviceName` (per the live snapshot `linkClient` is tracking) before
 * this function's caller opens the path under test, so a reply can
 * only ever have arrived over that path -- see
 * `layer2/pathChecks.ts`'s identical `closeSiblingLinks` for the full
 * rationale (this is Layer 3's own copy, driving the same
 * `BenchWsClient` wire calls directly rather than through the browser,
 * since the front page offers no per-row Disconnect for a direct
 * link). This harness owns a fresh host per run, so nothing closed
 * here is ever restored. Waits a short, fixed grace period for the
 * close(s) to land -- best-effort isolation, not itself a checked
 * assertion, so it is not polled to a hard "session gone" state.
 */
async function closeOtherLinksAndWait(linkClient: BenchWsClient, deviceName: string, keepLinkId: string | undefined): Promise<string[]> {
  const snapshot = linkClient.snapshot;
  if (snapshot === undefined) {
    return [];
  }
  const device = snapshot.devices.find((d) => d.name === deviceName);
  if (device === undefined) {
    return [];
  }
  const toClose = device.links.filter((l) => l.id !== keepLinkId && l.state === "connected");
  for (const link of toClose) {
    linkClient.sessionClose(link.id);
  }
  if (toClose.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return toClose.map((l) => l.id);
}

/**
 * Navigate the front page from scratch and reach the robot page for
 * `target.device` over `target.path`, per this module's own doc
 * comment on how each transport is reached. Resolves the *exact* link
 * id for `target.path` directly from `linkClient`'s live snapshot (the
 * same resolution `layer2/pathChecks.ts` uses: `findDirectLink`/
 * `findRelayLink`/`findRadioChildLink`, never a device card's own
 * "primary" link) and navigates straight to `/d/<that id>` -- the
 * 018-007 Step 0 fix. The previous version clicked a device card's
 * top-level open arrow, which follows whichever link the card
 * considers "primary" regardless of the path this check was actually
 * supposed to exercise; live bench evidence (this ticket's own
 * screenshots) showed a `radio-via-mbrelay:torture` check landing on
 * and passing an already-usable `mbserial` link instead, because that
 * link -- not the freshly-bridged radio link -- was gopiv's/vevov's
 * card-level primary. On failure, returns `reason` explaining why; the
 * caller (`checkPath`) does every on-page assertion once this function
 * has navigated to the resolved link's own page.
 */
async function reachRobotPage(
  page: Page,
  baseUrl: string,
  target: { device: string; path: string },
  linkClient: BenchWsClient,
  options: DriverOptions,
  screenshots: string[],
): Promise<{ ok: true; linkId: string; relayNamedRobot?: boolean } | { ok: false; reason: string }> {
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid^="device-card-"], [data-testid^="unassigned-card-"]', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  const relayPool = parseRelayPoolName(target.path);
  if (relayPool !== undefined) {
    const relaySnapshotLink = linkClient.snapshot !== undefined ? findRelayLink(linkClient.snapshot, relayPool) : undefined;
    if (relaySnapshotLink === undefined) {
      return { ok: false, reason: `no mbrelay link found in the live snapshot for pool "${relayPool}"` };
    }

    // 018-007 Step 0: this device's traffic must only be able to arrive
    // over the radio path under test -- close any other currently-usable
    // link on the robot first (e.g. mbserial), so a reply can never be
    // mistaken for coming through the wrong transport. This harness owns
    // a fresh host per run, so nothing closed here is restored.
    const closedBefore = await closeOtherLinksAndWait(linkClient, target.device, undefined);
    if (closedBefore.length > 0) {
      console.log(`[bench:layer3] closed sibling link(s) ${closedBefore.join(", ")} on "${target.device}" before checking radio-via-mbrelay:${relayPool}`);
    }

    const relayCard = await cardLocator(page, relayPool);
    if ((await relayCard.count()) === 0) {
      return { ok: false, reason: `no relay card found for pool "${relayPool}"` };
    }
    await screenshot(page, options, `front-${relayPool}-before`, screenshots);

    const alreadyConnectedText = await relayCard.locator(".device-relay-connect").innerText().catch(() => "");
    let relayNamedRobot = new RegExp(`Connected to ${escapeRegExp(target.device)}\\b`).test(alreadyConnectedText);

    if (!relayNamedRobot) {
      const select = relayCard.locator('select[data-testid^="relay-quick-connect-select-"]');
      if ((await select.count()) === 0) {
        return { ok: false, reason: `relay card "${relayPool}" has no robot picker` };
      }
      await select.selectOption({ label: target.device }).catch(() => select.selectOption(target.device));
      // Scoped to "Connect"/"Switch" text specifically -- once a relay
      // already has a bridged child (e.g. a previous path in this same
      // run already bridged a different robot through it), its own
      // Disconnect button is *also* a `button` inside
      // `.device-relay-connect-row`, and an unscoped locator resolves
      // to both, which Playwright's strict mode correctly refuses to
      // click ambiguously -- caught live running this exact sequence
      // (gopiv then vevov, both via torture) before this fix.
      const connectButton = relayCard.locator(".device-relay-connect-row button", { hasText: /^(Connect|Switch)$/ });
      await connectButton.click();

      const connectedText = await poll(
        async () => {
          const text = await relayCard.locator(".device-relay-connect").innerText().catch(() => "");
          return new RegExp(`Connected to ${escapeRegExp(target.device)}\\b`).test(text) ? text : undefined;
        },
        options.relayConnectTimeoutMs ?? 30_000,
      );
      relayNamedRobot = connectedText !== undefined;
      if (!relayNamedRobot) {
        await screenshot(page, options, `front-${relayPool}-timeout`, screenshots);
        return { ok: false, reason: `relay "${relayPool}" never showed "Connected to ${target.device}" within the bound` };
      }
    }

    // 018-007 Step 0: resolve the *radio child link for this specific
    // relay* directly from the live snapshot -- the same lookup
    // `layer2/pathChecks.ts` uses (`findRadioChildLink`, matching
    // `via.relayLinkId`), never the robot card's own top-level arrow.
    // See this function's own doc comment for the bug this replaces.
    const radioLink = await poll(
      async () => {
        const snapshot = linkClient.snapshot;
        if (snapshot === undefined) {
          return undefined;
        }
        const child = findRadioChildLink(snapshot, target.device, relaySnapshotLink.id);
        return isUsableLink(child) ? child : undefined;
      },
      options.connectTimeoutMs ?? 20_000,
    );
    if (radioLink === undefined) {
      await screenshot(page, options, `front-${target.device}-radio-timeout`, screenshots);
      return { ok: false, reason: `"${target.device}"'s radio link via relay "${relayPool}" never reached state "connected" with a session within the bound` };
    }

    await page.goto(`${baseUrl}d/${radioLink.id}`);
    return { ok: true, linkId: radioLink.id, relayNamedRobot };
  }

  const prefix = directPathLabelPrefix(target.path);
  if (prefix === undefined) {
    return { ok: false, reason: `unrecognized path "${target.path}" -- not a direct transport or a relay path` };
  }
  const transport = target.path as "usb" | "mbserial" | "wifi";

  const initialLink = linkClient.snapshot !== undefined ? findDirectLink(linkClient.snapshot, target.device, transport) : undefined;
  if (initialLink === undefined) {
    return { ok: false, reason: `no live-snapshot link of transport "${transport}" found for "${target.device}"` };
  }
  const linkId = initialLink.id;

  // 018-007 Step 0: same "isolate the path under test" discipline as
  // the radio branch above, only for wifi (the ticket's own "before a
  // radio/wifi check" instruction -- an mbserial/usb *target* itself is
  // left alone, matching Layer 2's identical scope decision).
  if (transport === "wifi") {
    const closedBefore = await closeOtherLinksAndWait(linkClient, target.device, linkId);
    if (closedBefore.length > 0) {
      console.log(`[bench:layer3] closed sibling link(s) ${closedBefore.join(", ")} on "${target.device}" before checking wifi`);
    }
  }

  const card = await cardLocator(page, target.device);
  if ((await card.count()) === 0) {
    return { ok: false, reason: `no device card found for "${target.device}"` };
  }
  await screenshot(page, options, `front-${target.device}-before`, screenshots);

  const row = card.locator(`[data-testid="device-link-${linkId}"]`);
  if ((await row.count()) === 0) {
    return { ok: false, reason: `"${target.device}" card has no row for link "${linkId}" (transport "${transport}")` };
  }

  if (!isUsableLink(initialLink)) {
    const connectButton = row.locator(`[data-testid="device-link-connect-${linkId}"]`);
    if ((await connectButton.count()) > 0) {
      await connectButton.click();
    }
    // else: no Connect button -- `FrontPage.tsx`'s `CONNECT_BUTTON_STATES`
    // deliberately excludes `"connecting"` (nothing to press mid-attempt).
    // For an *owned* wifi/mbserial link the reconciler auto-connects on
    // its own (architecture.md's auto-connect rule), so this is the
    // common case for a fast transport, not a failure -- live-verified
    // 018-007: closing the mbserial sibling above is itself what frees
    // the reconciler to retry wifi immediately, and it can easily reach
    // "connecting" before this page's own first snapshot round-trip
    // lands. Poll below regardless; only the poll's own bound decides
    // pass/fail, never the button's mere absence.
  }

  // Poll the live snapshot (not the DOM) for this exact link id
  // becoming usable -- a freshly-loaded page's own WebSocket round trip
  // can briefly lag behind an already-settled host, and this way the
  // wait is scoped to the one link under test, not "some arrow appeared
  // somewhere on this card."
  const connectedLink = await poll(async () => {
    const snapshot = linkClient.snapshot;
    const link = snapshot !== undefined ? findLinkById(snapshot, linkId) : undefined;
    return isUsableLink(link) ? link : undefined;
  }, options.connectTimeoutMs ?? 20_000);
  if (connectedLink === undefined) {
    await screenshot(page, options, `front-${target.device}-timeout`, screenshots);
    return { ok: false, reason: `"${target.device}"/"${transport}" (link "${linkId}") never reached state "connected" with a session within the bound` };
  }

  await page.goto(`${baseUrl}d/${linkId}`);
  return { ok: true, linkId };
}

/**
 * Full Layer 3 check for one device x path row: reach the robot page
 * (per {@link reachRobotPage}), then assert the header/console/
 * controls/card-text truthfulness this ticket's acceptance criteria
 * require. Never clicks a drive button or types a motion verb -- only
 * ever `ID` (or, for a relay-kind target, `?` -- 018-004: a relay has no
 * `ID` verb, `!HELP` lists `HELLO` and `?` instead; see
 * {@link isRelayStatusReplyLine}'s own doc comment for why `?` rather
 * than a second `HELLO`), matching every other layer's own "no motion"
 * discipline. `target.deviceKind` is threaded through from Layer 2's
 * own report (`index.ts`'s `targetsFromLayer2`) so this module never
 * has to re-derive it.
 */
export async function checkPath(
  page: Page,
  baseUrl: string,
  target: { device: string; path: string; deviceKind: string },
  options: DriverOptions,
  linkClient: BenchWsClient,
): Promise<Layer3PathResult> {
  const screenshots: string[] = [];
  const assertions: Layer3Assertion[] = [];

  const reached = await reachRobotPage(page, baseUrl, target, linkClient, options, screenshots);
  if (!reached.ok) {
    return { device: target.device, path: target.path, status: "fail", reason: reached.reason, assertions, screenshots };
  }
  const linkId = reached.linkId;

  if (parseRelayPoolName(target.path) !== undefined) {
    assertions.push({
      name: "relay-names-attempted-robot",
      pass: reached.relayNamedRobot === true,
      detail: reached.relayNamedRobot === true ? `relay card showed "Connected to ${target.device}"` : `relay card never named "${target.device}" as connected`,
    });
  }

  // `reachRobotPage` navigated here via `page.goto(baseUrl + "d/" +
  // linkId)` directly, to the exact link id resolved from the live
  // snapshot (018-007 Step 0) -- never an ambiguous DOM arrow click.
  await page.waitForSelector(".app-header", { timeout: 10_000 }).catch(() => undefined);

  // 018-007 Step 0's own regression guard: before ever typing a probe
  // verb, assert the header's own connection label actually names the
  // path this check is supposed to be exercising. Navigating by the
  // resolved link id above should make a mismatch impossible in
  // practice, but this assertion is what turns "should be impossible"
  // into checked evidence, per the ticket's own instruction -- and it
  // is exactly what would have caught the pre-fix bug (a header reading
  // "mbserial · loki.local:36627 · Linked" while the report recorded a
  // radio-via-mbrelay PASS).
  const labelText = await page.locator(".app-header-connection-label").innerText().catch(() => "");
  const labelMatches = connectionLabelMatchesPath(labelText, target.path);
  assertions.push({
    name: "connection-label-matches-path",
    pass: labelMatches,
    detail: labelMatches ? `header shows "${labelText.trim()}", matching path "${target.path}"` : `page is on "${labelText.trim()}", not "${target.path}"`,
  });

  const headerText = await poll(
    async () => {
      const text = (await page.locator('[data-testid="app-header-connection"]').innerText().catch(() => "")) || (await page.locator(".app-header").innerText().catch(() => ""));
      return looksLinked(text) ? text : "";
    },
    5_000,
    250,
  );
  const linked = looksLinked(headerText);
  const rawHeaderText = linked ? headerText : (await page.locator('[data-testid="app-header-connection"]').innerText().catch(() => "")) || (await page.locator(".app-header").innerText().catch(() => ""));
  assertions.push({
    name: "header-shows-linked",
    pass: linked,
    detail: linked ? `header shows: ${rawHeaderText}` : `header does not say Linked: ${JSON.stringify(rawHeaderText)}`,
  });

  const pageText = await page.locator("body").innerText().catch(() => "");
  const idLeak = isRawIdLeak(pageText);
  assertions.push({
    name: "no-raw-ids-in-card-text",
    pass: idLeak === undefined,
    detail: idLeak === undefined ? "no raw internal id patterns found in page text" : `found raw internal id pattern "${idLeak}" in page text`,
  });

  const allButtons = await page
    .locator("button")
    .evaluateAll((els) => els.map((el) => ({ text: (el.textContent ?? "").trim(), disabled: (el as unknown as { disabled: boolean }).disabled })));
  const sendInput = page.locator('[data-testid="console-send-input"]');
  const sendInputDisabled = (await sendInput.count()) > 0 ? await sendInput.isDisabled() : true;
  const enabledMotionOrSend = [
    ...allButtons.filter((b) => MOTION_BUTTON_TEXT.test(b.text) && !b.disabled).map((b) => b.text),
    ...(!sendInputDisabled ? ["console-send-input"] : []),
  ];
  assertions.push({
    name: "no-disabled-controls-when-not-linked",
    pass: linked || enabledMotionOrSend.length === 0,
    detail: linked
      ? "page is Linked -- enabled controls are expected"
      : enabledMotionOrSend.length === 0
        ? "page is not Linked and no drive/send control is enabled"
        : `page is not Linked but these controls are enabled: ${enabledMotionOrSend.join(", ")}`,
  });

  // 018-004: a relay has no `ID` verb -- probe it with `?` instead and
  // match its own status reply, matching Layer 2's own `pathChecks.ts`
  // fix for the same underlying bug (see `isRelayStatusReplyLine`'s own
  // doc comment for why `?`, not a second `HELLO`).
  const isRelay = target.deviceKind === "relay";
  const probeVerb = isRelay ? "?" : "ID";
  const matchesReply = isRelay ? isRelayStatusReplyLine : isIdReplyLine;
  const replyDescription = isRelay ? "'# channel: ...' status" : "'id ...'";

  let replyPass = false;
  let replyDetail = `link is not Linked -- ${probeVerb} was not sent (per honest-state requirement, matching every other layer's own 'never assume' discipline)`;
  if (!labelMatches) {
    // 018-007 Step 0: never send a probe verb on a page that is on the
    // wrong path -- a mismatch here already fails the check via
    // `connection-label-matches-path`; sending `ID` anyway risks a
    // coincidental reply from the wrong transport masking that failure.
    replyDetail = `${probeVerb} was not sent -- connection-label-matches-path already failed (page is on "${labelText.trim()}", not "${target.path}")`;
  } else if (linked && !sendInputDisabled) {
    await sendInput.click();
    await sendInput.fill(probeVerb);
    await sendInput.press("Enter");
    const gotReply = await poll(async () => {
      const lines = await page.locator('[data-testid="console-log"] [data-testid^="console-line-"]').allInnerTexts().catch(() => [] as string[]);
      return lines.some(matchesReply);
    }, options.replyTimeoutMs ?? 5_000, 250);
    replyPass = gotReply === true;
    replyDetail = replyPass ? `a ${replyDescription} reply line appeared in the console within the bound` : `no ${replyDescription} reply line appeared within ${options.replyTimeoutMs ?? 5_000}ms`;
  }
  assertions.push({ name: "reply-within-5s", pass: replyPass, detail: replyDetail });

  // 018-007 Step 0: screenshot names carry the exact link id this check
  // navigated to, so a report reader can visually confirm (the header
  // shows the same label the `connection-label-matches-path` assertion
  // above checked) which link the screenshot was actually taken on.
  await screenshot(page, options, `${target.device}-${target.path}-${linkId}-final`, screenshots);

  const allPass = assertions.every((a) => a.pass);
  return {
    device: target.device,
    path: target.path,
    status: allPass ? "pass" : "fail",
    reason: allPass ? "every assertion passed" : assertions.filter((a) => !a.pass).map((a) => `${a.name}: ${a.detail}`).join("; "),
    assertions,
    screenshots,
    linkId,
  };
}
