/**
 * Ticket 014-001: local stand-in for the DOM lib's `BufferSource` type
 * (`ArrayBufferView | ArrayBuffer`), which `dapjs`'s upstream source
 * relies on implicitly (its own `tsconfig.json` includes the `dom` lib
 * for its WebUSB transport, which this vendor subset excludes -- see
 * this directory's README.md). This repo's `tsconfig.base.json` sets
 * `"lib": ["ES2022"]` with no `"dom"`, so `BufferSource` is not
 * otherwise in scope. Defined once here, matching lib.dom.d.ts's own
 * definition exactly, rather than duplicated per file.
 */
export type BufferSource = ArrayBufferView | ArrayBuffer;
