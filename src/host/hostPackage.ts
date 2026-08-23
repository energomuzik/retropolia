import relayHubSource from '../../server/relay-hub.js?raw';
import hostPsSource from '../../server/host.ps1?raw';

const CLOUDFLARED_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

function toBase64Lines(s: string, width = 60): string[] {
  /* btoa работает только с latin1, поэтому сначала кодируем UTF-8 */
  const b64 = btoa(unescape(encodeURIComponent(s)));
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
  return lines;
}

function b64Block(lines: string[]): string {
  return lines.map((l) => 'echo ' + l).join('\r\n');
}

/** Собирает самодостаточный .bat: распаковывает сервер и скрипт, качает cloudflared, всё запускает. */
export function buildHostBat(): string {
  const relayBlock = b64Block(toBase64Lines(relayHubSource));
  const hostBlock = b64Block(toBase64Lines(hostPsSource));

  return [
    '@echo off',
    'title RETROPOLIA Host Server',
    'cd /d "%~dp0"',
    'echo.',
    'echo ================================================',
    'echo   RETROPOLIA - HOST SERVER',
    'echo ================================================',
    'echo.',
    '',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [X] Node.js NOT found!',
    '  echo     Install the LTS version: https://nodejs.org',
    '  echo     Then run this file again.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo [OK] Node.js found',
    '',
    'if not exist cloudflared.exe (',
    '  echo [..] Downloading cloudflared.exe (one time, ~30 MB)...',
    `  powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${CLOUDFLARED_URL}' -OutFile 'cloudflared.exe'"`,
    ')',
    'if not exist cloudflared.exe (',
    '  echo [X] Could not download cloudflared.exe automatically.',
    '  echo     Download it manually from:',
    '  echo     https://github.com/cloudflare/cloudflared/releases',
    '  echo     (file cloudflared-windows-amd64.exe) and put it in this folder.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo [OK] cloudflared.exe ready',
    '',
    '>relay.b64 (',
    relayBlock,
    ')',
    'certutil -decode relay.b64 relay-hub.js >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [X] Failed to unpack the server (certutil).',
    '  pause',
    '  exit /b 1',
    ')',
    'del relay.b64 >nul 2>nul',
    'echo [OK] RETROPOLIA server unpacked',
    '',
    '>host.b64 (',
    hostBlock,
    ')',
    'certutil -decode host.b64 host.ps1 >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [X] Failed to unpack the launcher (certutil).',
    '  pause',
    '  exit /b 1',
    ')',
    'del host.b64 >nul 2>nul',
    '',
    'echo [..] Starting server and tunnel...',
    'echo.',
    'powershell -NoProfile -ExecutionPolicy Bypass -File host.ps1',
    'echo.',
    'echo ================================================',
    'echo   Script finished. If the window closed too fast,',
    'echo   an error happened - read the messages above.',
    'echo ================================================',
    'pause',
    ''
  ].join('\r\n');
}

/** Скачивает retropolia-host.bat в папку загрузок браузера. */
export function downloadHostBat(): void {
  const bat = buildHostBat();
  const blob = new Blob([bat], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'retropolia-host.bat';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
