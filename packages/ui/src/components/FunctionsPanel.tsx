/**
 * FunctionsPanel.tsx — the robot's `RUN`-able function list, discovered
 * via `FUNCS` and run from here (added out-of-process, 2026-09-09).
 *
 * Reads `device.functions` (`wsMessages.ts`'s `RobotFunction[]`),
 * populated host-side: reset to `[]` on every `FUNCS` send, then one
 * entry appended per `funcs <name> [signature]` reply line. Three
 * distinct states this component must render, per that lifecycle:
 * `undefined` (no `FUNCS` sent yet this session -- "No function list
 * yet"), `[]` (the robot answered with zero functions -- a real,
 * different fact from "haven't asked"), and a populated array (one row
 * per function).
 *
 * **Argument entry, two shapes.** Firmware today omits `signature`
 * (`RobotFunction`'s own doc comment), so the common case is a single
 * free-form "arguments, space-separated" text input, split on
 * whitespace at Run time. When a `signature` *is* present, it is
 * whitespace-separated parameter names (per `wsMessages.ts`) -- this
 * component renders one labelled input per name instead, so a student
 * sees what each argument means rather than an opaque blank. Both paths
 * converge on the same `sendCommand(endpointId, "RUN", [name, ...args])`
 * call; only how `args` is collected differs. Per-parameter values are
 * trimmed and empty ones dropped (so a function called with only its
 * first two of four parameters filled in still sends a well-formed,
 * if short, arg list rather than empty-string placeholders); the
 * free-form field is trimmed and split on whitespace, exactly like
 * `CommandStrip`'s own `GET`/`SET` free-text handling.
 *
 * Per-row input state (`FunctionRow` below) is local to each row, keyed
 * by nothing but the row's own lifetime -- there is no shared draft
 * state across functions, and a row remounts (losing its draft) if its
 * `RobotFunction` identity changes across a fresh `FUNCS` round, which
 * is the correct behavior: a stale draft for a function the robot may
 * have redefined should not silently carry over.
 */
import { useState } from "react";
import type { EndpointListEntry, RobotFunction } from "@robot-console/host/src/wsMessages.js";
import { useWsActions } from "../ws/WsProvider";
import "./FunctionsPanel.css";

function paramNames(fn: RobotFunction): string[] | undefined {
  if (fn.signature === undefined) {
    return undefined;
  }
  const names = fn.signature.trim().split(/\s+/).filter((name) => name.length > 0);
  return names.length > 0 ? names : undefined;
}

interface FunctionRowProps {
  device: EndpointListEntry;
  fn: RobotFunction;
}

function FunctionRow({ device, fn }: FunctionRowProps) {
  const { sendCommand } = useWsActions();
  const linkOpen = device.sessionOpen;
  const params = paramNames(fn);

  const [paramValues, setParamValues] = useState<string[]>(() => (params ? params.map(() => "") : []));
  const [freeformValue, setFreeformValue] = useState("");

  function handleRun(): void {
    if (!linkOpen) {
      return;
    }
    const args = params
      ? paramValues.map((value) => value.trim()).filter((value) => value.length > 0)
      : freeformValue.trim().length > 0
        ? freeformValue.trim().split(/\s+/)
        : [];
    sendCommand(device.endpointId, "RUN", [fn.name, ...args]);
  }

  return (
    <div className="functions-panel-row" data-testid={`function-row-${fn.name}`}>
      <span className="functions-panel-row-name">{fn.name}</span>
      <div className="functions-panel-row-args">
        {params ? (
          params.map((paramName, index) => (
            <label key={`${paramName}-${index}`} className="functions-panel-arg-field">
              <span>{paramName}</span>
              <input
                type="text"
                data-testid={`function-arg-${fn.name}-${index}`}
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
        ) : (
          <input
            type="text"
            data-testid={`function-args-${fn.name}`}
            value={freeformValue}
            onChange={(event) => setFreeformValue(event.target.value)}
            placeholder="arguments, space-separated"
            disabled={!linkOpen}
          />
        )}
      </div>
      <button
        type="button"
        className="functions-panel-run-button"
        data-testid={`function-run-${fn.name}`}
        disabled={!linkOpen}
        onClick={handleRun}
      >
        Run
      </button>
    </div>
  );
}

export interface FunctionsPanelProps {
  device: EndpointListEntry;
}

export function FunctionsPanel({ device }: FunctionsPanelProps) {
  const { sendCommand } = useWsActions();
  const linkOpen = device.sessionOpen;
  const functions = device.functions;

  return (
    <section className="functions-panel" aria-label="Functions">
      <div className="functions-panel-toolbar">
        <button
          type="button"
          className="functions-panel-button"
          data-testid="functions-panel-refresh"
          disabled={!linkOpen}
          onClick={() => sendCommand(device.endpointId, "FUNCS")}
        >
          Refresh
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
      ) : (
        <div className="functions-panel-rows">
          {functions.map((fn) => (
            <FunctionRow key={fn.name} device={device} fn={fn} />
          ))}
        </div>
      )}
    </section>
  );
}
