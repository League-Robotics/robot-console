# `packages/host/src/store/`

The console's one SQLite database (`console.sqlite`), and the only code
in `packages/host` allowed to touch it directly.

## No SQL outside `store/`

Every other module — watchers, the reconciler, the dump CLI, `server.ts`
— talks to the store exclusively through the typed operations
`index.ts` exports (`Store`'s methods, or `openStore()`). Nothing
outside this directory may call `.prepare(` or `.exec(` on a sqlite
handle.

This is enforced by `noRawSqlOutsideStore.test.ts`, a vitest test that
scans `packages/host/src` for those calls. It is **not** a blanket ban
on the substrings `prepare(`/`exec(` anywhere in the codebase — that
would false-positive on, say, `someRegExp.exec(line)` — so the test
scopes `.exec(` to files that actually `import` from `"node:sqlite"`
(the only way a file could plausibly mean *sqlite* `exec`), while
`.prepare(` is flagged unconditionally, since nothing else in this
codebase defines a `.prepare` method. See that test file for the exact
rule if you need to extend it.

Why a rule instead of a type-system guarantee: `DatabaseSync` is a
concrete class with public `prepare`/`exec` methods, and nothing stops
another module from importing `node:sqlite` directly and using them.
The grep-shaped test is the enforcement mechanism until/unless the
`Store` class is the only thing that ever holds a `DatabaseSync`
reference (it already is, in practice — this test is what keeps it
that way as the codebase grows).

## Layout

- `stateDir.ts` — resolves the host's state directory (ticket 001).
- `db.ts` / `migrations/` — opens/migrates `console.sqlite` (ticket 002).
- `index.ts` — typed operations, the change feed (ticket 003, this one).
- `importers/` — one-time JSON → SQLite importers for the two legacy
  files (`knownRobots.ts`, `wifiCredentials.ts`), also ticket 003.
- `knownRobots.ts` / `wifiCredentials.ts` — the pre-existing JSON
  stores. Left unchanged and still in active use this sprint; the
  importers above read their file format but do not replace them yet.

See `docs/design/architecture.md` §4 for the schema and its rationale.
