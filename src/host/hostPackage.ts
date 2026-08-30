import relayHubSource from '../../server/relay-hub.js?raw';
import hostPsSource from '../../server/host.ps1?raw';

const CLOUDFLARED_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

const NODE_VER = 'v20.18.0';
const NODE_ZIP_URL = `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-win-x64.zip`;

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

/** Собирает самодостаточный .bat: распаковывает сервер и скрипт, качает cloudflared, всё запускает.
 *  ВАЖНО: шаблон в стиле goto-меток, БЕЗ скобочных блоков `if (...)` — в cmd круглая скобка
 *  внутри текста echo закрывает такой блок раньше времени («was unexpected at this time»). */
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
    'if errorlevel 1 goto PORTABLE_NODE',
    'echo [OK] Node.js found in system',
    'goto CHECK_CF',
    '',
    ':PORTABLE_NODE',
    'if exist node-portable\\node.exe goto USE_PORTABLE',
    'echo [..] Node.js not installed - downloading a portable copy - one time, about 30 MB ...',
    `powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${NODE_ZIP_URL}' -OutFile 'node.zip'"`,
    'if not exist node.zip goto NODE_FAIL',
    'echo [..] Unpacking Node.js ...',
    `powershell -NoProfile -Command "Expand-Archive -Path 'node.zip' -DestinationPath '.' -Force"`,
    `if exist "node-${NODE_VER}-win-x64" ren "node-${NODE_VER}-win-x64" node-portable`,
    'del node.zip >nul 2>nul',
    'if not exist node-portable\\node.exe goto NODE_FAIL',
    ':USE_PORTABLE',
    'set "PATH=%~dp0node-portable;%PATH%"',
    'echo [OK] Using portable Node.js from this folder',
    'goto CHECK_CF',
    '',
    ':NODE_FAIL',
    'echo [X] Could not get Node.js automatically.',
    'echo     Either install it from https://nodejs.org',
    'echo     or download the portable zip from the link above,',
    'echo     unpack it as a folder named node-portable next to this file.',
    'echo.',
    'pause',
    'exit /b 1',
    '',
    ':CHECK_CF',
    'if exist cloudflared.exe goto CF_OK',
    'echo [..] Downloading cloudflared.exe - one time, about 30 MB ...',
    `powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${CLOUDFLARED_URL}' -OutFile 'cloudflared.exe'"`,
    'if exist cloudflared.exe goto CF_OK',
    'echo [X] Could not download cloudflared.exe automatically.',
    'echo     Download it manually from:',
    'echo     https://github.com/cloudflare/cloudflared/releases',
    'echo     file cloudflared-windows-amd64.exe - put it in this folder.',
    'echo.',
    'pause',
    'exit /b 1',
    '',
    ':CF_OK',
    'echo [OK] cloudflared.exe ready',
    '',
    '>relay.b64 (',
    relayBlock,
    ')',
    'certutil -decode relay.b64 relay-hub.js >nul 2>nul',
    'if errorlevel 1 goto UNPACK_FAIL',
    'del relay.b64 >nul 2>nul',
    'echo [OK] RETROPOLIA server unpacked',
    'goto UNPACK_HOST',
    '',
    ':UNPACK_HOST',
    '>host.b64 (',
    hostBlock,
    ')',
    'certutil -decode host.b64 host.ps1 >nul 2>nul',
    'if errorlevel 1 goto UNPACK_FAIL',
    'del host.b64 >nul 2>nul',
    'goto RUN_ALL',
    '',
    ':UNPACK_FAIL',
    'echo [X] Failed to unpack files - certutil error.',
    'echo     Try to run this .bat file as Administrator.',
    'pause',
    'exit /b 1',
    '',
    ':RUN_ALL',
    'echo [..] Starting server and Cloudflare tunnel ...',
    'echo.',
    'powershell -NoProfile -ExecutionPolicy Bypass -File host.ps1',
    'echo.',
    'echo ================================================',
    'echo   Script finished. If something went wrong,',
    'echo   read the messages above.',
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
