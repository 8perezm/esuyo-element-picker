param(
  [int]$Port = 9222,
  [string]$ProfileDir = (Join-Path $env:TEMP "chrome-debug-esuyo"),
  [string]$Url = "about:blank",
  [string]$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe",
  [switch]$KillExisting
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ChromePath)) {
  $reg = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction SilentlyContinue
  if ($reg -and $reg.'(default)') { $ChromePath = $reg.'(default)' }
}
if (-not (Test-Path $ChromePath)) { throw "chrome.exe not found at $ChromePath" }

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

# Check if port already serves CDP
$existing = $null
try { $existing = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 } catch {}

if ($existing) {
  if ($KillExisting) {
    Write-Output "Port $Port already has Chrome debug session, killing it first..."
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object {
      $cmd = $_.CommandLine
      if ($cmd -match "--remote-debugging-port=$Port") { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 2
  } else {
    Write-Output "Reusing existing Chrome debug session on port $Port"
    Write-Output ($existing | ConvertTo-Json -Depth 5)
    if ($Url -ne "about:blank") {
      Start-Process -FilePath $ChromePath -ArgumentList "--user-data-dir=`"$ProfileDir`"", $Url
    }
    return
  }
}

Write-Output "Launching Chrome debug: port=$Port profile=$ProfileDir url=$Url"
Start-Process -FilePath $ChromePath -ArgumentList "--remote-debugging-port=$Port","--user-data-dir=`"$ProfileDir`"","--no-first-run","--no-default-browser-check",$Url

# Verify CDP endpoint (up to ~15s)
$verified = $null
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  try {
    $verified = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
    break
  } catch { }
}
if (-not $verified) { throw "Chrome launched but CDP endpoint http://127.0.0.1:$Port/json/version did not respond. Check that port is free and profile is not locked." }

Write-Output "Chrome debug ready:"
Write-Output ($verified | ConvertTo-Json -Depth 5)
Write-Output "CDP: http://127.0.0.1:$Port"
Write-Output "Connect with: npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:$Port"
Write-Output "Connect with: npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:$Port"
