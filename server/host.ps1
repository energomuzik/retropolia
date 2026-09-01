# =====================================================================
# RETROPOLIA host launcher (plain ASCII on purpose - cmd/PS code pages).
# Starts the game hub (node relay-hub.js) and a Cloudflare quick tunnel,
# finds the public URL, copies it to the clipboard, waits for a keypress,
# then stops everything.
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
    Write-Host '  [X] Could not start "node relay-hub.js". Is Node.js installed?'
    Write-Host '  Press any key to exit...'
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}

# wait until the hub actually answers on :9001
$hubOk = $false
for ($i = 0; $i -lt 12 -and -not $hubOk; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:9001/health' -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $hubOk = $true }
    } catch { }
}
if (-not $hubOk) {
    Write-Host '  [X] The RETROPOLIA hub does not answer on port 9001.'
    Write-Host '      Is another copy already running? Close other RETROPOLIA windows first.'
    Write-Host '  Press any key to exit...'
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    if ($hub) { Stop-Process -Id $hub.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}
Write-Host '  [OK] RETROPOLIA hub is up on port 9001'

# --- 2. start the Cloudflare quick tunnel ---
$cfExe = Join-Path $root 'cloudflared.exe'
$outLog = Join-Path $root 'cf-out.log'
$errLog = Join-Path $root 'cf-err.log'
if (Test-Path $outLog) { Remove-Item $outLog -Force }
if (Test-Path $errLog) { Remove-Item $errLog -Force }

$cf = Start-Process -FilePath $cfExe -ArgumentList 'tunnel','--url','http://localhost:9001' -WorkingDirectory $root -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
Write-Host '  [..] Creating the Cloudflare tunnel - 10 to 60 seconds...'

# --- 3. find the public URL ---
# A real quick tunnel address ALWAYS contains hyphens:
#     https://some-words-1234.trycloudflare.com
# Service addresses like https://api.trycloudflare.com must be ignored.
$tunnelRe = 'https://[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com'
$url = ''
for ($i = 0; $i -lt 120 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    foreach ($f in @($outLog, $errLog)) {
        if (Test-Path $f) {
            # -Last 1: on reconnects cloudflared creates a NEW address; only the last one is live
            $m = Select-String -Path $f -Pattern $tunnelRe | Select-Object -Last 1
            if ($m) { $url = $m.Matches[0].Value; break }
        }
    }
    if ($i -eq 20) { Write-Host '  [..] still waiting for the tunnel...' }
    if ($i -eq 60) { Write-Host '  [..] still waiting - slow network or provider blocks trycloudflare.com...' }
}

Write-Host ''
if ($url) {
    Set-Clipboard $url
    Write-Host '  =============================================='
    Write-Host '   LINK COPIED TO CLIPBOARD:'
    Write-Host "   $url"
    Write-Host '  =============================================='
    Write-Host ''
    Write-Host '   What to do next:'
    Write-Host '   1. Open the game -> Options -> Game hub -> paste the link.'
    Write-Host '   2. Send the same link to your friends - they paste it too.'
    Write-Host '   3. Create a room and give friends the room code.'
} else {
    Write-Host '  [!] Could not detect the tunnel URL.'
    Write-Host '      Likely cause: no internet, or your provider blocks trycloudflare.com.'
    Write-Host ''
    Write-Host '      --- last lines of cf-err.log ---'
    if (Test-Path $errLog) {
        Get-Content $errLog -Tail 10 | ForEach-Object { Write-Host ('      ' + $_) }
    } else {
        Write-Host '      (cf-err.log is empty - cloudflared printed nothing)'
    }
    Write-Host '      --------------------------------'
}

Write-Host ''
Write-Host '  The server is running. Keep this window open while you play!'
Write-Host '  Press any key to stop the server and exit.'
Write-Host ''
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

# --- 4. stop everything ---
if ($cf)  { Stop-Process -Id $cf.Id  -Force -ErrorAction SilentlyContinue }
if ($hub) { Stop-Process -Id $hub.Id -Force -ErrorAction SilentlyContinue }
Write-Host ''
Write-Host '  Server stopped. Bye!'
Write-Host ''
