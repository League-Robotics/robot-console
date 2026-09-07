---
id: '004'
title: 'protocol: v6/codec.ts (line grammar, case-as-direction)'
status: done
use-cases:
- SUC-002
depends-on:
- '001'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# protocol: v6/codec.ts (line grammar, case-as-direction)

## Description

Build `packages/protocol/src/v6/codec.ts`, the line-framing layer for
the v6 protocol. Per `sprint.md`'s Architecture and
`docs/design/specification.md` §3.4:

- Grammar: `verb field* '#'id '\n'`.
- Max line length: **240 bytes** (reject or refuse to encode anything
  longer, rather than silently truncating).
- Fields are base-10 ASCII integers.
- A `flags` field is lowercase hex with **no** `0x` prefix.
- **Case is direction**: commands are UPPERCASE (host → device), replies
  are lowercase (device → host). This is not cosmetic — a lowercase
  inbound verb that is **not** a recognized reply verb is another device
  overheard on a shared radio channel and must be dropped silently (not
  treated as an error, not surfaced to the UI). This drop-silently rule
  belongs in this module (or is exposed as a classification the caller
  uses to drop it) since it depends on codec-level verb/case knowledge.

Only 11 verbs carry an id (`GET SET TLM STOP RUN WHEELS_X WHEELS_V
MOVE_X MOVE_V GO_TO_R GO_TO_W`) — per `sprint.md`, this fact belongs to
the session layer (ticket 005), but `codec.ts` must at minimum parse the
optional `#id` suffix correctly when present and leave it absent
(`undefined`/`null`, not `0` or `''`) when it is not, so ticket 005 can
apply the 11-verb rule on top without the codec silently defaulting a
missing id to a valid-looking value.

Check parsed/encoded output against relevant lines in
`vendor/radio-robot-lib/tests/protocol/golden_vectors.txt` and the reference
implementation `radio-robot-lib/src/host/robot_v6/codec.py` for behavior
to match — not to port line-for-line, since this is a TypeScript
reimplementation, but any line-framing edge case that vectors file
covers should produce the same parsed result here.

## Acceptance Criteria

- [x] `encodeLine(verb, fields, id?)` produces a line matching the
      grammar (`VERB field field ... #id\n` when an id is given, no `#`
      section when it is not), with `flags`-typed fields rendered as
      lowercase hex without `0x`.
- [x] `decodeLine(line)` parses a well-formed line into `{ verb, fields,
      id }`, with `id` absent (not a sentinel value) when no `#id`
      suffix was present.
- [x] Encoding a line that would exceed 240 bytes refuses (throws or
      returns an explicit error result) rather than truncating.
- [x] Decoding a line longer than 240 bytes is rejected the same way.
- [x] A helper (e.g. `isReplyVerb`/`classifyLine`) distinguishes
      UPPERCASE (command-direction) from lowercase (reply-direction)
      verbs, and flags a lowercase verb that is not a known reply verb
      as "foreign traffic to drop silently" rather than as a decode
      error.
- [x] Relevant framing cases from
      `vendor/radio-robot-lib/tests/protocol/golden_vectors.txt` (HELLO/banner/
      ack/nack framing specifically — full drive-verb coverage is
      sprint 3's concern) decode to the expected fields.
- [x] All tests run under `npm test` with no hardware attached.

## Testing

- **Existing tests to run**: `npm test` (protocol suite from prior
  tickets continues passing).
- **New tests to write**: encode/decode round-trip tests, the 240-byte
  boundary (239/240/241-byte cases), the id-present/id-absent cases, the
  lowercase-hex-no-prefix `flags` case, the foreign-lowercase-verb
  classification case, and applicable golden-vector lines.
- **Verification command**: `npm test -- packages/protocol`.

## Implementation Plan

**Approach**:
1. Read the relevant sections of
   `radio-robot-lib/src/host/robot_v6/codec.py` and the HELLO/banner/
   ack/nack lines in `vendor/radio-robot-lib/tests/protocol/golden_vectors.txt` before implementing, to
   confirm the exact grammar and byte-length boundary behavior.
2. Implement `decodeLine`: split on whitespace, extract trailing
   `#id` if present, parse fields as base-10 integers (leaving
   `flags`-typed fields as raw lowercase-hex strings for the caller to
   interpret, or parse them to a number if that is cleaner — implementer's
   choice, document whichever is chosen).
3. Implement `encodeLine`: inverse of the above, enforcing the 240-byte
   limit before returning.
4. Implement the UPPERCASE/lowercase classification helper, including a
   list or lookup of known reply verbs (an implementation of "case is
   direction," per specification §3.4) that callers use to distinguish a
   real reply from foreign radio traffic.
5. Add tests that read the relevant lines directly from the submodule
   at `vendor/radio-robot-lib/tests/protocol/golden_vectors.txt` —
   parse and filter that file at test time rather than inlining or
   copying its lines, so the vectors cannot drift from upstream. Fail
   with an actionable "submodule not initialized" message if the file
   is absent.

**Files to create**:
- `packages/protocol/src/v6/codec.ts`
- `packages/protocol/src/v6/codec.test.ts`

**Files to modify**: none.

**Testing plan**: `npm test` from the repo root.

**Documentation updates**: none beyond inline comments on the
240-byte limit and the case-as-direction rule (both are the kind of
detail a future editor could accidentally relax without a comment
flagging why they exist).
