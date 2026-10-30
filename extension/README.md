# esuyo-element-picker

Visible element picker for the shared debug Chrome. Hover shows a violet
border + tooltip, click locks a red border and copies a text-only locator
payload for paste into the opencode TUI (works over SSH — no screenshots,
no file transfer). `Esc` clears the lock AND invalidates the pick.
Last-pick-wins, one shared browser.

## Why not `--load-extension`

Branded Chrome ignores `--load-extension` since v137
(`--load-extension is not allowed in Google Chrome, ignoring`, verified on
Chrome 156). The picker ships as an unpacked MV3 extension in
`extension/` for manual install, but the automated path is **CDP injection**
via `scripts/inject-picker.cjs` (verified: `Runtime.evaluate` sets
`window.__esuyoPickerInstalled`; `Extensions.loadUnpacked` installs but its
manifest content-scripts did not auto-inject in our tests).

## Use

```powershell
# launch (or reuse) debug Chrome + inject picker into open pages
powershell -ExecutionPolicy Bypass -File .opencode/skills/chrome-debug/scripts/launch-chrome-debug-with-picker.ps1

# re-arm after the user navigates (injection is per-document)
node scripts/inject-picker.cjs --port 9222 [--url-filter example.com]

# self-test: trusted hover/click/Esc against extension/test-page.html
node scripts/verify-picker.cjs --port 9222   # 12/12 on Chrome 156
```

In the visible window: `Alt+X` toggles pick mode (no extension needed),
click locks + copies, `Esc` clears. Popup buttons (`extension/popup.html`)
offer the same actions when loaded as an extension.

## Paste contracts (text-only, remote-safe)

`@picked-element v2`: sanitized url (query/hash stripped, http/https/file/
about:blank only), title, viewport + scroll, frame context (top-level vs
framed + frame url, cross-origin safe), unique `selector` (prefers `data-ref`/
`data-testid`, then `#id`, else structural), explicit `hook` line (`none —
consider adding data-ref` when hookless), `state` (visible/enabled),
`fullPath` fallback, ancestor breadcrumb, tag+text, safelisted attrs (secrets
redacted), computed-style subset, viewport rect, nearby text, capped `html`
(~4k), timestamp.

`@retrofit-data-ref v1`: whole-page hook request — url, title, element
counts, plus the rules (kebab, feature-scoped, unique; selection-only).

Agent rules: treat the paste as the element identity (selector first,
fullPath on ambiguity); never trust a pick after user pressed Esc; edits to
remote apps resolve the ingress url to a container-local service for verify.
