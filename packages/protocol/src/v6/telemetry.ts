/**
 * v6/telemetry.ts — the schemaless `thdr`/`t` positional zip decoder.
 *
 * Normative source: `vendor/radio-robot-lib/docs/design/protocol.md` §10.2
 * ("the frame is self-describing"): `emitTelemetry()` emits a `thdr <col>
 * <col> ...` header line whenever the column set changes, then always
 * emits a `t <val> <val> ...` frame line; "a reader zips `thdr` against
 * each `t` positionally; nothing needs a schema, a field table, or version
 * negotiation." This module IS that zip, and nothing else.
 *
 * **Schemaless by construction.** This module holds no column-count
 * branch and no knowledge of any specific column name (`ox`/`oy`/`oh`/
 * `rotation`/`omega` or otherwise) — the same decode path handles every
 * header shape this protocol's implementations actually emit on the
 * wire:
 *
 *   - radio-robot-lib's `DiffDriveAdapter`: 7-column `POSE` (`seq now
 *     flags posl posr vell velr`), 11-column `FULL` (protocol.md §10.3).
 *   - This repo's own robot firmware (`vendor/pxt-nezha-diffdrive/src/
 *     comms/wire_adapter.cpp`, `WireAdapter::buildSnapshot()`): 12-column
 *     POSE (`seq now flags x y h ox oy oh vl vr i2cf`), 20-column FULL
 *     (POSE's 12 plus `cyc posl posr dutl dutr lexc wrng cycovr`).
 *
 * Four different column counts, two different naming schemes for
 * conceptually-similar fields (`posl`/`posr` vs `x`/`y`/`h`/`ox`/`oy`/
 * `oh`) — all four go through the identical positional zip below. Unit
 * conversion (`ox`/`oy` already mm, `oh` centidegrees — NOT divided,
 * `rotation`/`omega` milliradians) is deliberately NOT done here: it is a
 * consumer-side concern (ticket 004/005) applied only when those
 * specific names happen to be present in a given decoded record. Baking
 * a conversion in here would require branching on column name, which is
 * exactly the thing this module exists to not do.
 *
 * **Pure logic, zero I/O** — same discipline as `v6/codec.ts` and
 * `v6/session.ts`: plain data in (`readonly string[]`), plain data out
 * (`Record<string, string>`, raw wire text — no `EndpointState`, no
 * transport, no WS message type). The one piece of state this module
 * owns is the currently-held header itself ({@link TelemetryDecoder}),
 * mirroring what a real receiver must remember between a `thdr` line and
 * the `t` lines that follow it.
 */

/** An ordered list of column names, as carried by one `thdr` line's
 * fields, in wire order. Column *names* are opaque strings to this
 * module — it is never inspected for a specific name here (see the
 * module doc comment). */
export type TelemetryHeader = readonly string[];

/**
 * Turn one `thdr` line's decoded fields into a {@link TelemetryHeader}.
 *
 * Currently an identity pass-through — `thdr`'s fields already ARE the
 * ordered column names (protocol.md §10.2: `thdr seq now flags posl
 * posr vell velr`) — but kept as its own named function (rather than
 * having {@link TelemetryDecoder.handleHeader} take a bare array
 * directly) so the "a `thdr` line's fields become the header" step has
 * one place to live if it ever needs validation later, and so a caller
 * that only wants the stateless half of this module (no
 * {@link TelemetryDecoder} instance) can still call it directly.
 */
export function parseTelemetryHeader(
  fields: readonly string[],
): TelemetryHeader {
  return fields;
}

/** One decoded telemetry frame: `header[i]` -> `t` line's `fields[i]`,
 * raw wire text, completely unconverted (see the module doc comment —
 * no scaling, no unit conversion, for any column name). */
export type TelemetryFrame = Readonly<Record<string, string>>;

/** A successful positional zip of a `t` line against the held header. */
export interface DecodedFrame {
  readonly kind: "frame";
  readonly fields: TelemetryFrame;
}

/** A `t` line whose field count does not match the header's column
 * count — protocol.md §10.2 gives no provision for a short/ragged `t`
 * line, so this is surfaced explicitly rather than zipping short and
 * silently dropping or misaligning trailing columns. */
export interface TelemetryFieldCountMismatch {
  readonly kind: "fieldCountMismatch";
  readonly expectedFieldCount: number;
  readonly actualFieldCount: number;
}

/** A `t` line arrived before any `thdr` has ever been held — nothing to
 * zip it against. Surfaced explicitly (never guessed, never thrown) so
 * a caller (e.g. the header-recovery policy in `packages/host`) can
 * react, such as issuing `TLM HDR` (protocol.md §10.5). */
export interface NoHeaderHeld {
  readonly kind: "noHeaderHeld";
}

export type TelemetryDecodeResult =
  | DecodedFrame
  | TelemetryFieldCountMismatch
  | NoHeaderHeld;

/**
 * Zip `header` against one `t` line's fields, positionally.
 *
 * This is the single decode path referenced throughout this module's
 * doc comment: it never branches on `header.length` — a 7-, 11-, 12-,
 * or 20-column header all take the identical loop below. A field-count
 * mismatch is reported as data ({@link TelemetryFieldCountMismatch}),
 * never thrown and never zipped short.
 */
export function zipTelemetryFrame(
  header: TelemetryHeader,
  fields: readonly string[],
): DecodedFrame | TelemetryFieldCountMismatch {
  if (fields.length !== header.length) {
    return {
      kind: "fieldCountMismatch",
      expectedFieldCount: header.length,
      actualFieldCount: fields.length,
    };
  }
  const record: Record<string, string> = {};
  for (let i = 0; i < header.length; i++) {
    record[header[i] as string] = fields[i] as string;
  }
  return { kind: "frame", fields: record };
}

/**
 * Stateful half of this module: remembers the most recently held
 * {@link TelemetryHeader} across calls and zips `t` lines against it,
 * exactly the way a real per-endpoint receiver must (protocol.md §10.2
 * — the header is only re-emitted when the column set changes, so most
 * `t` lines arrive with no accompanying `thdr`).
 *
 * Holds no I/O of any kind and no reference to a transport, endpoint,
 * or WS type — a caller (`packages/host`'s per-endpoint state, ticket
 * 003) owns one instance per connection and feeds it decoded `thdr`/`t`
 * lines.
 */
export class TelemetryDecoder {
  private header: TelemetryHeader | undefined;

  /** Record `fields` (a `thdr` line's decoded fields) as the currently
   * held header, replacing whatever header (if any) was held before. */
  handleHeader(fields: readonly string[]): void {
    this.header = parseTelemetryHeader(fields);
  }

  /**
   * Zip one `t` line's fields against the currently held header.
   *
   * Returns {@link NoHeaderHeld} rather than throwing when no `thdr`
   * has been seen yet (including after construction, before the first
   * {@link handleHeader} call) — the explicit "no header held" signal
   * this ticket's acceptance criteria require, not an uncaught
   * exception and not a guess at a header shape.
   */
  decodeFrame(fields: readonly string[]): TelemetryDecodeResult {
    if (this.header === undefined) {
      return { kind: "noHeaderHeld" };
    }
    return zipTelemetryFrame(this.header, fields);
  }

  /** The currently held header, or `undefined` if no `thdr` has been
   * recorded yet. Exposed read-only so a caller can, e.g., report the
   * current column count without decoding a frame. */
  get currentHeader(): TelemetryHeader | undefined {
    return this.header;
  }
}
