# =====================================================================
# RETROPOLIA host launcher. Plain ASCII only (safe for any Windows
# codepage). Starts the game hub (node relay-hub.js) and a Cloudflare
# quick tunnel, finds the public URL, copies it to the clipboard, waits
# for a keypress, then stops everything.
# =====================================================================
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

Write-Host ''
Write-Host '  RETROPOLIA HOST - starting...'
Write-Host ''

# --- 1. start the game hub (port 9001) ---
$hub = Start-Process -FilePath 'node' -ArgumentList 'relay-hub.js' -WorkingDirectory $root -PassThru -WindowStyle Minimized
if (-not $hub) {
    Write-Host '  [X] Failed to start: node relay-hub.js. Is Node.js installed?'
    Write-Host '  Press any key to exit...'
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}
Start-Sleep -Seconds 2
Write-Host '  [OK] RETROPOLIA hub started (port 9001)'

# --- 2. start the Cloudflare quick tunnel ---
$cfExe = Join-Path $root 'cloudflared.exe'
$outLog = Join-Path $root 'cf-out.log'
$errLog = Join-Path $root 'cf-err.log'
if (Test-Path $outLog) { Remove-Item $outLog -Force }
if (Test-Path $errLog) { Remove-Item $errLog -Force }

$cf = Start-Process -FilePath $cfExe -ArgumentList 'tunnel','--url','http://localhost:9001' -WorkingDirectory $root -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
Write-Host '  [..] Creating Cloudflare public tunnel (10-40 seconds)...'

# --- 3. find the public URL ---
$url = ''
for ($i = 0; $i -lt 90 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    foreach ($f in @($outLog, $errLog)) {
        if (Test-Path $f) {
            $m = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
            if ($m) { $url = $m.Matches[0].Value; break }
        }
    }
}

Write-Host ''
if ($url) {
    Set-Clipboard $url
    Write-Host '  =============================================='
    Write-Host '   LINK COPIED TO CLIPBOARD:'
    Write-Host "   $url"
    Write-Host '  =============================================='
    Write-Host ''
    Write-Host '   Next steps:'
    Write-Host '   1. Open the game and paste the link into:'
    Write-Host '      Options -> Game hub (Igrovoi hab)'
    Write-Host '   2. Send this link to your friends.'
    Write-Host '      They paste it into the same "Game hub" field.'
    Write-Host '   3. Create a room and share the room code.'
} else {
    Write-Host '  [!] Could not get the link automatically.'
    Write-Host '      Open cf-out.log / cf-err.log in this folder -'
    Write-Host '      look for a line like https://....trycloudflare.com'
}

Write-Host ''
Write-Host '  Server is RUNNING. Keep this window open while playing!'
Write-Host '  Press any key to stop the server and exit.'
Write-Host ''
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

# --- 4. stop everything ---
if ($cf)  { Stop-Process -Id $cf.Id  -Force -ErrorAction SilentlyContinue }
if ($hub) { Stop-Process -Id $hub.Id -Force -ErrorAction SilentlyContinue }
Write-Host ''
Write-Host '  Server stopped. Bye!'
Write-Host ''
