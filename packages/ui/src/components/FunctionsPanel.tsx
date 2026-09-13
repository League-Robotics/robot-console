/**
 * FunctionsPanel.tsx — the robot's `RUN`-able function list, discovered
 * via `FUNCS` and run from here (added out-of-process, 2026-09-09;
 * reshaped to a single compact line out-of-process, same day).
 *
 * Reads `link.session?.functions` (`wsMessages.ts`'s
 * `RobotFunction[] | null` on `SnapshotLink.session`), populated
 * host-side: the harvester (ticket 003) starts a fresh `[]` the moment a
 * session opens and appends one entry per `funcs <name> [signature]`
 * reply line thereafter -- `null` (no `FUNCS` round yet this session)
 * and "session not open at all" both collapse to `undefined` here (see
 * this component's own destructuring below), since neither has a list
 * to show. Three distinct states this component must render: `undefined`
 * ("No function list yet"), `[]` (the robot answered with zero
 * functions -- a real, different fact from "haven't asked"), and a
 * populated array (one `<option>` per function in a `<select>`).
 *
 * ## Sprint 015 ticket 009: `{ link, name }`, no more probes elsewhere
 *
 * This panel never sent its own `FUNCS` probe (only a manual Refresh
 * button) and is unchanged in that respect -- migrated here only because
 * `device.functions`/`device.sessionOpen`/`device.endpointId` are all
 * retired `EndpointListEntry` fields. `name` (the caller's already-
 * resolved `SnapshotDevice.name`) replaces the old `device.name ??
 * device.endpointId` fallback for the remembered-arguments storage key --
 * a `SnapshotDevice.name` is always a resolved string, so there is
 * nothing left to fall back from.
 *
 * **Layout.** Rather than one row per function, the panel is a single
 * line: a `<select>` choosing which function is "current", the
 * argument input(s) for *that* function only, and one Go button. This
 * keeps the panel compact regardless of how many functions the robot
 * reports.
 *
 * **Argument entry, three shapes**, per {@link parseSignature}: an
 * unknown signature (`undefined`, the common case -- firmware today
 * omits it) gets a single free-form "arguments, space-separated" text
 * input, split on whitespace at Go time; a signature that parses to a
 * non-empty parameter list gets one labelled input per parameter name,
 * combined via {@link positionalArgs}; a signature that parses to `[]`
 * (an explicit `()`) gets no inputs at all. All three converge on the
 * same `sendCommand(linkId, "RUN", [name, ...args])` call.
 *
 * **Memory of last-used arguments.** Per the stakeholder's spec, this
 * panel remembers, per function name, the raw input values as they
 * stood the last time Go was pressed for that function -- not merely
 * as typed, so that a value changed and then abandoned (switching away
 * without pressing Go) does not leak into the remembered state.
 * Switching the `<select>` back to a function pre-fills its inputs from
 * that memory if present, else blank; the robot's own declared
 * defaults are never used to pre-fill a value, only shown as
 * `placeholder` text. The memory lives in component state for the life
 * of this panel instance, and is mirrored best-effort to `localStorage`
 * (wrapped in try/catch -- a private-browsing quota error or disabled
 * storage must never break the panel) under a key scoped to the
 * device's friendly `name`, so the memory also survives a remount of
 * this component for the same device. It is loaded once, on mount.
 */
import { useEffect, useState } from "react";
import type { RobotFunction, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useSendable, useWsActions } from "../ws/WsProvider";
import { isLinkUsable } from "../deviceDisplay";
import "./FunctionsPanel.css";

/** One parameter parsed out of a `funcs` signature -- see
 * {@link parseSignature}. */
export interface SignatureParam {
  name: string;
  /** Type hint, if the signature carried one (`speed:number`). */
  type?: string;
  /** Default value text, if the signature carried one (`speed=60`). */
  defaultValue?: string;
}

/**
 * Parse the signature the robot advertises on its `funcs <name>
 * <signature>` line into positional parameters. Accepts the
 * declaration-shaped grammar the firmware is meant to publish --
 *
 *     (side_mm, speed=60)
 *     (side_mm:number, speed:number=60)
 *
 * -- with or without the parentheses, commas, spaces, or the `:type`
 * and `=default` parts (each parameter is `name[:type][=default]`), and
 * also the bare whitespace-separated form (`dist speed`). Returns
 * `undefined` for an absent or empty signature, which the panel
 * treats as "parameters unknown" (free-form args field), never as
 * "takes none". `()` is an explicit "takes none": an empty list.
 */
export function parseSignature(signature: string | undefined): SignatureParam[] | undefined {
  if (signature === undefined) {
    return undefined;
  }
  let text = signature.trim();
  if (text.length === 0) {
    return undefined;
  }
  const parenthesized = text.startsWith("(") && text.endsWith(")");
  if (parenthesized) {
    text = text.slice(1, -1).trim();
    if (text.length === 0) {
      return [];
    }
  }
  const tokens = text.split(text.includes(",") ? /\s*,\s*/ : /\s+/).filter((t) => t.length > 0);
  const params: SignatureParam[] = [];
  for (const token of tokens) {
    const eq = token.indexOf("=");
    const head = eq === -1 ? token : token.slice(0, eq);
    const defaultValue = eq === -1 ? undefined : token.slice(eq + 1).trim();
    const colon = head.indexOf(":");
    const name = (colon === -1 ? head : head.slice(0, colon)).trim();
    const type = colon === -1 ? undefined : head.slice(colon + 1).trim();
    if (name.length === 0) {
      continue;
    }
    const param: SignatureParam = { name };
    if (type !== undefined && type.length > 0) {
      param.type = type;
    }
    if (defaultValue !== undefined && defaultValue.length > 0) {
      param.defaultValue = defaultValue;
    }
    params.push(param);
  }
  return params;
}

/** Positional argument list for `RUN`: every input through the last
 * one the user filled in, with a skipped middle one falling back to
 * its declared default (or `0`, since `runArg()` reads numbers) so the
 * later values keep their positions. Trailing empties are dropped so
 * the robot's own defaults apply. */
/** The function as a declaration, for the dropdown: `line(speed: number =
 * 25, kp: number = 120)`, `cala()`, or just `sense` when the robot did not
 * declare a signature -- so the list itself says what each one takes. */
export function declarationLabel(fn: RobotFunction): string {
  const params = parseSignature(fn.signature);
  if (!params) {
    return fn.name;
  }
  const inner = params
    .map((p) => `${p.name}${p.type ? `: ${p.type}` : ""}${p.defaultValue !== undefined ? ` = ${p.defaultValue}` : ""}`)
    .join(", ");
  return `${fn.name}(${inner})`;
}

export function positionalArgs(params: SignatureParam[], values: string[]): string[] {
  const trimmed = params.map((_, index) => (values[index] ?? "").trim());
  let last = trimmed.length - 1;
  while (last >= 0 && trimmed[last]!.length === 0) {
    last--;
  }
  return trimmed.slice(0, last + 1).map((value, index) => (value.length > 0 ? value : params[index]!.defaultValue ?? "0"));
}

/** Storage key for a device's remembered function arguments -- scoped
 * by friendly name (`SnapshotDevice.name` is always a resolved string,
 * so there is no fallback to fall back to any more). */
function storageKeyFor(name: string): string {
  return `robot-console:function-args:${name}`;
}

/** Best-effort load of the remembered-arguments map. Never throws --
 * a disabled or quota-exceeded `localStorage` (private browsing, etc.)
 * degrades to "no memory", not a broken panel. */
function loadStoredArgs(key: string): Map<string, string[]> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return new Map();
    }
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

/** Best-effort save of the remembered-arguments map -- see
 * {@link loadStoredArgs}. */
function saveStoredArgs(key: string, map: Map<string, string[]>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Storage unavailable or full -- the in-memory map still works for
    // the rest of this session, which is the best that can be done.
  }
}

export interface FunctionsPanelProps {
  link: SnapshotLink;
  /** The owning device's already-resolved name -- see this module's doc
   * comment ("Sprint 015 ticket 009"). */
  name: string;
}

export function FunctionsPanel({ link, name }: FunctionsPanelProps) {
  const { sendCommand } = useWsActions();
  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const functions = link.session?.functions ?? undefined;

  const [argsMap, setArgsMap] = useState<Map<string, string[]>>(() => loadStoredArgs(storageKeyFor(name)));
  const [selectedName, setSelectedName] = useState<string>("");
  const [paramValues, setParamValues] = useState<string[]>([]);
  const [freeformValue, setFreeformValue] = useState("");

  // If a fresh FUNCS round drops the currently-selected function (a
  // stale draft for a function the robot may have redefined should not
  // silently carry over), fall back to the placeholder.
  useEffect(() => {
    if (selectedName.length > 0 && !(functions ?? []).some((fn) => fn.name === selectedName)) {
      setSelectedName("");
      setParamValues([]);
      setFreeformValue("");
    }
    // Only re-check when the list itself changes -- selectedName
    // changes are handled by handleSelect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [functions]);

  const selectedFn: RobotFunction | undefined = functions?.find((fn) => fn.name === selectedName);
  const params = selectedFn ? parseSignature(selectedFn.signature) : undefined;

  function handleSelect(name: string): void {
    setSelectedName(name);
    const fn = functions?.find((f) => f.name === name);
    const p = fn ? parseSignature(fn.signature) : undefined;
    const remembered = argsMap.get(name);
    if (p) {
      setParamValues(p.map((_, index) => remembered?.[index] ?? ""));
      setFreeformValue("");
    } else {
      setParamValues([]);
      setFreeformValue(remembered?.[0] ?? "");
    }
  }

  function handleGo(): void {
    if (!linkOpen || !selectedFn) {
      return;
    }
    const p = parseSignature(selectedFn.signature);
    const args = p ? positionalArgs(p, paramValues) : freeformValue.trim().length > 0 ? freeformValue.trim().split(/\s+/) : [];
    const remembered = p ? p.map((_, index) => paramValues[index] ?? "") : [freeformValue];
    sendCommand(link.id, "RUN", [selectedFn.name, ...args]);

    const next = new Map(argsMap);
    next.set(selectedFn.name, remembered);
    setArgsMap(next);
    saveStoredArgs(storageKeyFor(name), next);
  }

  const selectDisabled = !linkOpen || !functions || functions.length === 0;

  return (
    <section className="functions-panel" aria-label="Functions">
      <div className="functions-panel-bar">
        <button
          type="button"
          className="functions-panel-button"
          data-testid="functions-panel-refresh"
          disabled={!linkOpen}
          onClick={() => sendCommand(link.id, "FUNCS")}
        >
          Refresh
        </button>

        <select
          className="functions-panel-select"
          data-testid="functions-panel-select"
          value={selectedName}
          disabled={selectDisabled}
          onChange={(event) => handleSelect(event.target.value)}
        >
          <option value="" disabled>
            Choose a function…
          </option>
          {(functions ?? []).map((fn) => (
            <option key={fn.name} value={fn.name}>
              {declarationLabel(fn)}
            </option>
          ))}
        </select>

        {selectedFn ? (
          <div className="functions-panel-args">
            {params && params.length > 0 ? (
              params.map((param, index) => (
                <label key={`${param.name}-${index}`} className="functions-panel-arg-field">
                  <span>
                    {param.name}
                    {param.type ? <span className="functions-panel-arg-type"> {param.type}</span> : null}
                  </span>
                  <input
                    type="text"
                    data-testid={`function-arg-${selectedFn.name}-${index}`}
                    placeholder={param.defaultValue ?? ""}
                    value={paramValues[index] ?? ""}
                    onChange={(event) => {
                      const next = paramValues.slice();
                      next[index] = event.target.value;
                      setParamValues(next);
                    }}
                    disabled={!linkOpen}
                  />
                </label>
              ))
            ) : params ? (
              <span className="functions-panel-noargs">no parameters</span>
            ) : (
              <input
                type="text"
                data-testid={`function-args-${selectedFn.name}`}
                value={freeformValue}
                onChange={(event) => setFreeformValue(event.target.value)}
                placeholder="arguments, space-separated"
                disabled={!linkOpen}
              />
            )}
          </div>
        ) : null}

        <button
          type="button"
          className="functions-panel-go"
          data-testid="functions-panel-go"
          disabled={!linkOpen || !selectedFn}
          onClick={handleGo}
        >
          Go
        </button>
      </div>

      {functions === undefined ? (
        <p className="functions-panel-hint" role="status">
          No function list yet — press FUNCS.
        </p>
      ) : functions.length === 0 ? (
        <p className="functions-panel-hint" role="status">
          The robot reported no functions.
        </p>
      ) : null}
    </section>
  );
}
