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
    'chcp 65001 >nul',
    'title RETROPOLIA - Host Server',
    'cd /d "%~dp0"',
    'echo.',
    'echo ================================================',
    'echo   RETROPOLIA - HOST SERVER (станция хоста)',
    'echo ================================================',
    'echo.',
    '',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [X] Node.js не найден!',
    '  echo     Установите LTS-версию: https://nodejs.org',
    '  echo     Затем запустите этот файл снова.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo [OK] Node.js найден',
    '',
    'if not exist cloudflared.exe (',
    '  echo [..] Скачиваю cloudflared.exe (один раз, ~30 МБ)...',
    `  powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${CLOUDFLARED_URL}' -OutFile 'cloudflared.exe'"`,
    ')',
    'if not exist cloudflared.exe (',
    '  echo [X] Не удалось скачать cloudflared.exe автоматически.',
    '  echo     Скачайте вручную:',
    '  echo     https://github.com/cloudflare/cloudflared/releases',
    '  echo     (файл cloudflared-windows-amd64.exe) и положите в эту папку.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo [OK] cloudflared.exe готов',
    '',
    '>relay.b64 (',
    relayBlock,
    ')',
    'certutil -decode relay.b64 relay-hub.js >nul 2>nul',
    'del relay.b64 >nul 2>nul',
    'echo [OK] Сервер RETROPOLIA распакован',
    '',
    '>host.b64 (',
    hostBlock,
    ')',
    'certutil -decode host.b64 host.ps1 >nul 2>nul',
    'del host.b64 >nul 2>nul',
    '',
    'echo [..] Запускаю сервер и туннель...',
    'echo.',
    'powershell -NoProfile -ExecutionPolicy Bypass -File host.ps1',
    'echo.',
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
