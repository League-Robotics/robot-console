---
status: done
sprint: '026'
tickets:
- 026-001
---

# Add `--version` to the console CLIs

Neither console command reports its version. `rconsole --version` and
`rconsole version` both fail with "unknown command", and `robot-console` has
no version flag at all.

## Work

- `rconsole --version`, `rconsole -V` and `rconsole version` print
  `rconsole <version>` and exit 0. List the option in `rconsole help`.
- `robot-console --version` / `-V` prints `robot-console <version>` and exits
  0 **without** starting the host, opening a store or contacting mbregistry.
- `robot-console-supervisor --version` does the same, if it parses arguments.
- The version comes from the root `package.json` (the value `close_sprint`
  bumps, e.g. `0.20260925.2`). Resolve it at runtime relative to the package,
  so it is correct both from the repo and from a global `npm link` install.
- Tests for each command, including one showing `robot-console --version`
  does not start anything.
