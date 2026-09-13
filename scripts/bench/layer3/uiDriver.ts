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

/**
 * Navigate the front page from scratch and reach the robot page for
 * `target.device` over `target.path`, per this module's own doc
 * comment on how each transport is reached. Resolves the link href to
 * navigate to (or `undefined` on failure, with `reason` explaining
 * why) -- the caller (`checkPath`) does the actual `goto` plus every
 * on-page assertion, so this function's own job is exactly "get
 * Linked," nothing about the console/header/controls yet.
 */
async function reachRobotPage(
  page: Page,
  baseUrl: string,
  target: { device: string; path: string },
  options: DriverOptions,
  screenshots: string[],
): Promise<{ ok: true; relayNamedRobot?: boolean } | { ok: false; reason: string }> {
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid^="device-card-"], [data-testid^="unassigned-card-"]', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  const relayPool = parseRelayPoolName(target.path);
  if (relayPool !== undefined) {
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

    // The robot's own card now has an open arrow once its radio link is
    // connected -- find *that* card (not the relay's), matching the
    // ticket's own "or the card arrow if already Linked" instruction.
    // Clicked directly (client-side route, via React Router's own
    // <Link>) rather than reading `href` and calling `page.goto()`
    // separately -- a full navigation drops and re-establishes the
    // WebSocket connection, which live-verified cost this driver a
    // "header does not say Linked" false failure (the fresh connection
    // hadn't resynced the snapshot within this function's own wait) on
    // the very first live run of this ticket, before this fix.
    const robotCard = await cardLocator(page, target.device);
    const arrow = robotCard.locator('[data-testid^="device-open-"]');
    const appeared = await poll(async () => (await arrow.count()) > 0, options.connectTimeoutMs ?? 20_000);
    if (!appeared) {
      return { ok: false, reason: `"${target.device}" card never showed an open arrow after the relay bridge connected` };
    }
    await arrow.click();
    return { ok: true, relayNamedRobot };
  }

  const prefix = directPathLabelPrefix(target.path);
  if (prefix === undefined) {
    return { ok: false, reason: `unrecognized path "${target.path}" -- not a direct transport or a relay path` };
  }

  const card = await cardLocator(page, target.device);
  if ((await card.count()) === 0) {
    return { ok: false, reason: `no device card found for "${target.device}"` };
  }
  await screenshot(page, options, `front-${target.device}-before`, screenshots);

  const row = card.locator(".device-connection").filter({ has: page.locator(".device-connection-label", { hasText: new RegExp(`^${prefix}`) }) });
  if ((await row.count()) === 0) {
    return { ok: false, reason: `"${target.device}" card has no connection row labeled "${prefix} ..."` };
  }

  // `FrontPage.tsx`'s `DeviceConnectionRow` only ever renders a
  // row-level open arrow for a usable link that is *not* the card's own
  // "primary" link (`isLinkUsable(link) && link !== primary`) -- the
  // primary link's own open arrow is the *card's* top-level one
  // instead (`device-open-<device.id>`, the same one the relay branch
  // above already uses). Live-verified on this ticket's own third full
  // run: gopiv/vevov's mbserial link *was* their card's primary link,
  // so the row-only check below found neither a row arrow nor a
  // Connect button (both correctly absent for a usable primary link)
  // and wrongly reported failure. `resolveArrow` checks both shapes:
  // the row's own arrow, or (when this row's own state text shows
  // `.device-connection-open` -- i.e. this link genuinely is
  // connected) the card's top-level arrow.
  const existingArrow = row.locator('[data-testid^="device-link-open-"]');
  const connectButton = row.locator('[data-testid^="device-link-connect-"]');
  const cardArrow = card.locator('[data-testid^="device-open-"]');
  const rowShowsConnected = row.locator(".device-connection-open");

  type ArrowState = "row-arrow" | "card-arrow" | "connect" | undefined;
  async function resolveArrow(): Promise<ArrowState> {
    if ((await existingArrow.count()) > 0) {
      return "row-arrow";
    }
    if ((await rowShowsConnected.count()) > 0 && (await cardArrow.count()) > 0) {
      return "card-arrow";
    }
    if ((await connectButton.count()) > 0) {
      return "connect";
    }
    return undefined;
  }

  // Poll rather than checking once: a freshly-loaded page's WebSocket
  // round trip (fetch the current snapshot, React re-render) can
  // briefly lag behind an already-settled host.
  const initialState = await poll(resolveArrow, 10_000);

  if (initialState === "row-arrow") {
    await existingArrow.click();
    return { ok: true };
  }
  if (initialState === "card-arrow") {
    await cardArrow.click();
    return { ok: true };
  }
  if (initialState !== "connect") {
    return { ok: false, reason: `"${target.device}"/"${prefix}" row has neither an open arrow (row or card-level) nor a Connect button` };
  }
  await connectButton.click();

  // Only an arrow state ends this wait -- unlike the poll above,
  // "connect" must not be treated as truthy here (the button can
  // legitimately still be present for a moment right after its own
  // click, before the link's state actually transitions), or this
  // would resolve immediately without ever waiting for the link to
  // become usable.
  const finalState = await poll(async () => {
    const state = await resolveArrow();
    return state === "row-arrow" || state === "card-arrow" ? state : undefined;
  }, options.connectTimeoutMs ?? 20_000);
  if (finalState === "row-arrow") {
    await existingArrow.click();
    return { ok: true };
  }
  if (finalState === "card-arrow") {
    await cardArrow.click();
    return { ok: true };
  }
  await screenshot(page, options, `front-${target.device}-timeout`, screenshots);
  return { ok: false, reason: `"${target.device}"/"${prefix}" never became usable (no open arrow) within the bound after Connect` };
}

/**
 * Full Layer 3 check for one device x path row: reach the robot page
 * (per {@link reachRobotPage}), then assert the header/console/
 * controls/card-text truthfulness this ticket's acceptance criteria
 * require. Never clicks a drive button or types a motion verb -- only
 * ever `ID`, matching every other layer's own "no motion" discipline.
 */
export async function checkPath(
  page: Page,
  baseUrl: string,
  target: { device: string; path: string },
  options: DriverOptions,
): Promise<Layer3PathResult> {
  const screenshots: string[] = [];
  const assertions: Layer3Assertion[] = [];

  const reached = await reachRobotPage(page, baseUrl, target, options, screenshots);
  if (!reached.ok) {
    return { device: target.device, path: target.path, status: "fail", reason: reached.reason, assertions, screenshots };
  }

  if (parseRelayPoolName(target.path) !== undefined) {
    assertions.push({
      name: "relay-names-attempted-robot",
      pass: reached.relayNamedRobot === true,
      detail: reached.relayNamedRobot === true ? `relay card showed "Connected to ${target.device}"` : `relay card never named "${target.device}" as connected`,
    });
  }

  // `reachRobotPage` already navigated here via a client-side route
  // click (React Router's own <Link>, not `page.goto()`) -- see that
  // function's own doc comment for why a full navigation must be
  // avoided (it drops and re-establishes the WebSocket connection).
  await page.waitForSelector(".app-header", { timeout: 10_000 }).catch(() => undefined);

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

  let replyPass = false;
  let replyDetail = "link is not Linked -- ID was not sent (per honest-state requirement, matching every other layer's own 'never assume' discipline)";
  if (linked && !sendInputDisabled) {
    await sendInput.click();
    await sendInput.fill("ID");
    await sendInput.press("Enter");
    const gotReply = await poll(async () => {
      const lines = await page.locator('[data-testid="console-log"] [data-testid^="console-line-"]').allInnerTexts().catch(() => [] as string[]);
      return lines.some(isIdReplyLine);
    }, options.replyTimeoutMs ?? 5_000, 250);
    replyPass = gotReply === true;
    replyDetail = replyPass ? "an 'id ...' reply line appeared in the console within the bound" : `no 'id ...' reply line appeared within ${options.replyTimeoutMs ?? 5_000}ms`;
  }
  assertions.push({ name: "reply-within-5s", pass: replyPass, detail: replyDetail });

  await screenshot(page, options, `${target.device}-${target.path}-final`, screenshots);

  const allPass = assertions.every((a) => a.pass);
  return {
    device: target.device,
    path: target.path,
    status: allPass ? "pass" : "fail",
    reason: allPass ? "every assertion passed" : assertions.filter((a) => !a.pass).map((a) => `${a.name}: ${a.detail}`).join("; "),
    assertions,
    screenshots,
  };
}
