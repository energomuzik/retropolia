# =====================================================================
# RETROPOLIA host launcher (generated-friendly, plain ASCII comments).
# Starts the game hub (node relay-hub.js) and a Cloudflare quick tunnel,
# finds the public URL, copies it to the clipboard, waits for a keypress,
# then stops everything.
# =====================================================================
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

Write-Host ''
Write-Host '  RETROPOLIA HOST - запуск...'
Write-Host ''

# --- 1. start the game hub (port 9001) ---
$hub = Start-Process -FilePath 'node' -ArgumentList 'relay-hub.js' -WorkingDirectory $root -PassThru -WindowStyle Minimized
if (-not $hub) {
    Write-Host '  [X] Не удалось запустить node relay-hub.js. Установлен ли Node.js?'
    Write-Host '  Нажмите любую клавишу для выхода...'
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}
Start-Sleep -Seconds 2
Write-Host '  [OK] Сервер RETROPOLIA запущен (порт 9001)'

# --- 2. start the Cloudflare quick tunnel ---
$cfExe = Join-Path $root 'cloudflared.exe'
$outLog = Join-Path $root 'cf-out.log'
$errLog = Join-Path $root 'cf-err.log'
if (Test-Path $outLog) { Remove-Item $outLog -Force }
if (Test-Path $errLog) { Remove-Item $errLog -Force }

$cf = Start-Process -FilePath $cfExe -ArgumentList 'tunnel','--url','http://localhost:9001' -WorkingDirectory $root -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
Write-Host '  [..] Создаю публичный туннель Cloudflare (10-40 секунд)...'

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
    Write-Host '   ССЫЛКА СКОПИРОВАНА В БУФЕР ОБМЕНА:'
    Write-Host "   $url"
    Write-Host '  =============================================='
    Write-Host ''
    Write-Host '   Что дальше:'
    Write-Host '   1. Откройте игру и вставьте ссылку:'
    Write-Host '      Опции -> Игровой хаб'
    Write-Host '   2. Передайте эту ссылку друзьям (соцсети, мессенджер).'
    Write-Host '      Они вставят её в том же поле "Игровой хаб".'
    Write-Host '   3. Создайте комнату и назовите друзьям код.'
} else {
    Write-Host '  [!] Не удалось автоматически получить ссылку.'
    Write-Host '      Откройте файлы cf-out.log / cf-err.log в этой папке -'
    Write-Host '      там будет строка вида https://....trycloudflare.com'
}

Write-Host ''
Write-Host '  Сервер работает. Держите это окно открытым, пока играете!'
Write-Host '  Нажмите любую клавишу, чтобы остановить сервер и выйти.'
Write-Host ''
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

# --- 4. stop everything ---
if ($cf)  { Stop-Process -Id $cf.Id  -Force -ErrorAction SilentlyContinue }
if ($hub) { Stop-Process -Id $hub.Id -Force -ErrorAction SilentlyContinue }
Write-Host ''
Write-Host '  Сервер остановлен. До встречи!'
Write-Host ''
