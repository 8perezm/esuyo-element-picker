# esuyo-element-picker

Visible element picker for a shared debug Chrome. Hover shows a violet
border, click locks a red border and copies a text-only locator payload you
paste into the agent chat. `Esc` clears the lock and voids the pick.
Last-pick-wins, one shared browser, no screenshots — the paste works over SSH.

## Quick start

```powershell
# 1. headed debug Chrome with a dedicated profile (run once, reuse after)
$profile = "$env:TEMP\chrome-debug-esuyo"
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -ArgumentList "--remote-debugging-port=9222","--user-data-dir=`"$profile`"",`
  "--no-first-run","--no-default-browser-check","https://example.com"

# 2. inject the picker into open pages (re-run after navigation)
node scripts/inject-picker.cjs --port 9222
```

In the visible window: `Alt+X` toggles pick mode, click locks + copies,
`Esc` clears. Then paste into the agent chat, e.g. "change it to 'Report for
quarterly analysis'".

## The paste

`@picked-element v2` — sanitized url, viewport + scroll, frame context
(top-level vs framed), unique selector (prefers `data-ref`/`data-testid`),
explicit hook line (`none — consider adding data-ref` when hookless),
visible/enabled state, structural `fullPath` fallback, ancestors, tag + text,
safelisted attrs (secrets redacted), style subset, rect, nearby text, capped
HTML, timestamp. Full field list in [`extension/README.md`](extension/README.md).

`@retrofit-data-ref v1 (whole page)` — whole-page prompt for the agent to add
missing `data-ref` hooks (kebab, feature-scoped, selection-only). Available
from the picker popup or `__esuyoPicker.retrofitText()`.

## Remote / SSH

The agent in the container can't see your browser — the paste bridges that
gap. You pick locally, paste into the remote TUI. The agent resolves your
ingress url to its container-local service to edit and verify. No file
transfer, no image pipeline.

## Why CDP injection, not `--load-extension`

Branded Chrome ignores `--load-extension` since v137 (verified on 156).
Details and alternatives in [`extension/README.md`](extension/README.md).

## Repo layout

| Path | What |
|---|---|
| `extension/` | Unpacked MV3 extension (`picker.js` core, popup, icons, demo page) |
| `scripts/inject-picker.cjs` | CDP injection into the shared debug browser (zero deps) |
| `scripts/verify-picker.cjs` | End-to-end self-test: trusted hover/click/Esc (19/19 on Chrome 156) |

## Verify

```powershell
node scripts/verify-picker.cjs --port 9222
```

## License

See [LICENSE](LICENSE).
