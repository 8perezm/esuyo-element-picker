param(
  [int]$Port = 9222,
  [string]$ProfileDir = (Join-Path $env:TEMP "chrome-debug-esuyo"),
  [string]$Url = "https://example.com"
)
# Shared headed debug Chrome + picker injection (no --load-extension:
# ignored by branded Chrome since v137). Re-runnable: reuses a live session.
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../../../..")).Path
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  $reg = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction SilentlyContinue
  if ($reg -and $reg.'(default)') { $chrome = $reg.'(default)' }
}
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$live = $null
try { $live = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 } catch {}
if (-not $live) {
  Write-Output "Starting debug Chrome on port $Port ..."
  Start-Process -FilePath $chrome -ArgumentList "--remote-debugging-port=$Port","--user-data-dir=`"$ProfileDir`"","--no-first-run","--no-default-browser-check",$Url
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try { $live = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3; break } catch {}
  }
  if (-not $live) { throw "Chrome did not answer on port $Port" }
} else {
  Write-Output "Reusing live debug session on port $Port"
}
Write-Output ($live | ConvertTo-Json -Depth 3)

Write-Output "Injecting picker ..."
node (Join-Path $repo "scripts/inject-picker.cjs") --port $Port
Write-Output "Done. In the visible window: Alt+Shift+E to pick, click locks + copies, Esc clears. Paste into TUI."
