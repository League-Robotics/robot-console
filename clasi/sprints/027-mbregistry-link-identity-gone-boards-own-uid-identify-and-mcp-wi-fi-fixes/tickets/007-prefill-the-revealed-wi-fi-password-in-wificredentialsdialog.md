---
id: '007'
title: Prefill the revealed Wi-Fi password in WifiCredentialsDialog
status: open
use-cases: [SUC-007]
depends-on: []
github-issue: ''
issue: wifi-dialog-show-hide-has-nothing-to-show.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Prefill the revealed Wi-Fi password in WifiCredentialsDialog

## Description

`packages/ui/src/components/WifiCredentialsDialog.tsx` asks for the
host's stored Wi-Fi credentials without `reveal: true`:

```ts
useEffect(() => {
  if (open) {
    send({ type: "get-wifi-credentials" });
  }
}, [open, send]);
```

`packages/ui/src/components/ConfigurationPage.tsx` (~line 223) already
asks the same way `reveal: true` requires:

```ts
send({ type: "get-wifi-credentials", reveal: true });
```

`packages/host/src/server.ts`'s handler (~line 1352) only includes the
saved `password` in its reply when `reveal` is set:

```ts
const revealed = message.reveal ? wifiCredentials.read()?.password : undefined;
...
...(revealed !== undefined ? { password: revealed } : {}),
```

So the dialog never receives a password to prefill, and its Show/Hide
toggle (which does work — verified live) has nothing to act on. The
dialog's own prefill effect currently only sets `ssid`:

```ts
useEffect(() => {
  if (open && stored?.ssid && ssid === "") {
    setSsid(stored.ssid);
  }
}, [open, stored?.ssid]);
```

### What to change

1. `WifiCredentialsDialog.tsx`: change the `get-wifi-credentials` send
   to include `reveal: true`, matching `ConfigurationPage.tsx`.
2. Extend the prefill effect to also set `password` from
   `stored.password` when present and `password === ""` — same
   "only prefill once, on open, if the field is still empty" pattern
   the existing `ssid` prefill already uses (do not clobber a value
   the user has started typing).
3. `packages/ui/src/components/WifiCredentialsForm.tsx`'s
   `WifiCredentialsFormStored` interface (~line 48) does not currently
   declare a `password` field — add `password?: string` to it (the
   dialog reads `stored.password` off the same `useWifiCredentials()`
   result the form component's props narrow from; check
   `WsProvider.tsx`'s own `useWifiCredentials` return type to confirm
   the field name the host actually sends matches `password` before
   wiring this).
4. Do not change `WifiCredentialsForm.tsx`'s rendering itself (the
   show/hide toggle, the placeholder logic, `hasStored`) — it already
   renders whatever `password` prop it is given; the fix is entirely in
   what `WifiCredentialsDialog` requests and prefills, not in the shared
   form component's display logic.

`ConfigurationPage.tsx`'s own Wi-Fi tab is already correct and must be
left unchanged.

## Acceptance Criteria

- [ ] Opening `WifiCredentialsDialog` sends `get-wifi-credentials` with
      `reveal: true`.
- [ ] When the host has a saved password for the current network, the
      dialog's password field is prefilled with it on open (once,
      without clobbering user input already typed into the field).
- [ ] The Show/Hide toggle, applied to the prefilled value, reveals the
      real saved password — not an empty string.
- [ ] `WifiCredentialsFormStored` gains a `password?: string` field;
      `WifiCredentialsForm.tsx`'s own rendering is otherwise unchanged.
- [ ] `ConfigurationPage.tsx` is untouched by this ticket.
- [ ] `server.ts`'s `get-wifi-credentials` handler is untouched (it
      already supports `reveal` correctly) — this ticket is UI-only.

## Testing

- **Existing tests to run**: any existing `WifiCredentialsDialog`/
  `WifiCredentialsForm`/`ConfigurationPage` component test files
  (`*.test.tsx`), to confirm `ConfigurationPage`'s own already-correct
  prefill behavior and the dialog's ssid-prefill/validation/submit flow
  are unaffected.
- **New tests to write**: a `WifiCredentialsDialog` test — with a fake
  WS layer returning `{ssid, hasPassword: true, password: "secret"}` in
  response to `get-wifi-credentials`, assert the password input's value
  is `"secret"` after open, and that toggling Show/Hide changes the
  input's `type` while the value stays `"secret"`.
- **Verification command**: run the workspace's vitest/RTL scripts
  scoped to `packages/ui/src/components/WifiCredentialsDialog.test.tsx`
  (or wherever this component's test file lives) and
  `packages/ui/src/components/ConfigurationPage.test.tsx` if present.
