---
name: chrome-debug
description: Open a visible Chrome window in remote-debug mode (port 9222) so the user and the agent share the same browser. Use when the user says open/show chrome in debug mode, let me see the browser, watch what you do, shared/visible browser, or needs CDP on 127.0.0.1:9222.
---

# chrome-debug - Shared visible Chrome

Launches headed Chrome with `--remote-debugging-port=9222` and a dedicated
profile, so the window is visible on the user's desktop AND reachable over CDP
at `http://127.0.0.1:9222`. Verified on Windows + `Chrome/156`.

## When to use

Trigger phrases: "open chrome in debug", "show me the browser", "let me watch",
"visible chrome", "shared browser", "connect to my chrome".

## Workflow

### 1. Launch (Windows PowerShell)

Script lives beside this skill at `scripts/launch-chrome-debug.ps1`
(paths inside the skill are relative to this SKILL.md directory):

```powershell
# default: port 9222, profile %TEMP%\chrome-debug-esuyo, blank page
powershell -ExecutionPolicy Bypass -File .opencode/skills/chrome-debug/scripts/launch-chrome-debug.ps1

# open a URL immediately
powershell -ExecutionPolicy Bypass -File .opencode/skills/chrome-debug/scripts/launch-chrome-debug.ps1 -Url "https://example.com"

# force-restart a stale debug session on 9222
powershell -ExecutionPolicy Bypass -File .opencode/skills/chrome-debug/scripts/launch-chrome-debug.ps1 -KillExisting
```

Manual equivalent (no script):

```powershell
$profile = "$env:TEMP\chrome-debug-esuyo"
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=`"$profile`"","--no-first-run","--no-default-browser-check","about:blank"
Invoke-RestMethod http://127.0.0.1:9222/json/version
```

Rules:
- Always use a dedicated `--user-data-dir` (never the default profile — it
  locks if Chrome is already running and would leak user state).
- Default port `9222`, profile `%TEMP%\chrome-debug-esuyo`.
- Headed (no `--headless`) so the user can see it.

### 2. Verify

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version
netstat -ano | findstr 9222
```

Expected: JSON with `Browser`, `Protocol-Version`, `webSocketDebuggerUrl`.
If it fails: port in use by non-Chrome process, or profile locked — rerun
with `-KillExisting`, or pick another port and update MCP args below.

### 3. Drive the shared browser

The MCP servers running in this session were started isolated (own hidden
profile). To drive the VISIBLE window, reconnect one of them to CDP:

**chrome-devtools-mcp (preferred for shared viewing):**
```jsonc
// in ~/.config/opencode/opencode.json
{ "mcp": { "chrome-devtools": { "type": "local",
  "command": ["npx","-y","chrome-devtools-mcp@latest","--browserUrl","http://127.0.0.1:9222"] } } }
```

**playwright-mcp:**
```jsonc
{ "mcp": { "playwright": { "type": "local",
  "command": ["npx","-y","@playwright/mcp@latest","--cdp-endpoint","http://127.0.0.1:9222"] } } }
// omit --isolated when using --cdp-endpoint, otherwise you get a second browser
```

Then restart the MCP/backend (`opencode service restart` or reload window)
and confirm with `opencode mcp list`. Until reconnect, you can still navigate
by relaunching the script with `-Url "<url>"`.

### 4. Cleanup

Close the window normally, or:

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '--remote-debugging-port=9222' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Profile data persists at `%TEMP%\chrome-debug-esuyo` — delete it for a fresh
login state.

### 5. Element picker (talk about what you see)

`scripts/inject-picker.cjs` + `scripts/verify-picker.cjs`, source in
`extension/picker.js` (see `extension/README.md` for the Chrome-137
`--load-extension` background).

```powershell
# launch (or reuse) debug Chrome + inject picker into open pages
powershell -ExecutionPolicy Bypass -File .opencode/skills/chrome-debug/scripts/launch-chrome-debug-with-picker.ps1
# re-arm after the user navigates (injection is per-document)
node scripts/inject-picker.cjs --port 9222
# self-test, 12/12 on Chrome 156
node scripts/verify-picker.cjs --port 9222
```

In the visible window: `Alt+Shift+E` picks, hover shows violet border, click
locks red + copies `@picked-element v1` (selector + structural fullPath +
context, text-only for SSH paste), `Esc` clears and invalidates. Whole-page
`@retrofit-data-ref v1` prompt available from popup or
`__esuyoPicker.retrofitText()`. Agent rule: selector first, fullPath on
ambiguity; a pick after `Esc` is void.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `DevTools listening` but `json/version` empty | Still starting — wait 2-3s and retry |
| Port 9222 answers but wrong browser | Previous debug session — reuse it or rerun with `-KillExisting` |
| `profile locked / SingletonLock` | Default profile in use — always pass `--user-data-dir` |
| No visible window | `--headless` was passed or session is RDP-disconnected — relaunch without it |
| MCP still drives hidden browser | MCP started with `--isolated` / no `--browserUrl` — apply step 3 and restart |
