import { useEffect, useRef, useState } from 'react';

const EJS_DATA = 'https://cdn.emulatorjs.org/stable/data/';

function coreFor(ext: string): string {
  if (ext === 'sms') return 'segaMS';
  if (ext === 'gg') return 'segaGG';
  return 'segaMD'; // md, gen, bin
}

/**
 * Эмулятор SEGA (Mega Drive / Master System / Game Gear) на ядре RetroArch (Genesis Plus GX)
 * через EmulatorJS. Ядро подгружается один раз с CDN и кэшируется браузером.
 * Управление (клавиатура + геймпады PS/Xbox) и сохранения — встроены в само ядро:
 * меню эмулятора → иконка дискеты (save state), шестерёнка — настройки управления.
 */
export default function SegaBox({
  romData,
  ext,
  resetKey,
}: {
  romData: ArrayBuffer;
  ext: string;
  resetKey?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setStatus('loading');
    host.innerHTML = '';

    const blob = new Blob([romData], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const divId = `ejs-${Math.random().toString(36).slice(2, 9)}`;
    const slot = document.createElement('div');
    slot.id = divId;
    slot.style.width = '100%';
    slot.style.height = '100%';
    host.appendChild(slot);

    const w = window as unknown as Record<string, unknown>;
    w.EJS_player = `#${divId}`;
    w.EJS_core = coreFor(ext);
    w.EJS_gameUrl = url;
    w.EJS_pathtodata = EJS_DATA;
    w.EJS_language = 'ru';
    w.EJS_backgroundText = 'Загрузка ядра SEGA…';
    w.EJS_backgroundColor = '#0b0e1c';
    w.EJS_color = '#ffcf3f';
    w.EJS_volume = 1;
    w.EJS_defaultControls = undefined;

    const script = document.createElement('script');
    script.src = `${EJS_DATA}loader.js`;
    script.async = true;
    script.onload = () => setStatus('ready');
    script.onerror = () => setStatus('error');
    document.body.appendChild(script);

    return () => {
      try {
        const emu = (window as unknown as { EJS_emulator?: { destroy?: () => void; exit?: () => void } }).EJS_emulator;
        if (emu?.destroy) emu.destroy();
        else if (emu?.exit) emu.exit();
      } catch { /* noop */ }
      script.remove();
      host.innerHTML = '';
      URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [romData, ext, resetKey]);

  return (
    <div className="relative w-full aspect-[4/3] bg-black border-[3px] border-edge shadow-[0_0_40px_rgba(255,139,63,0.12)] overflow-hidden">
      <div ref={hostRef} className="absolute inset-0" />
      {status === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#05070f]">
          <span className="font-pixel text-[9px] text-magma blink-hard">ЗАГРУЗКА ЯДРА SEGA…</span>
          <span className="text-[11px] text-dim px-6 text-center">
            Ядро скачивается один раз (~10–20 МБ) и кэшируется браузером
          </span>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#05070f] p-6 text-center">
          <span className="font-pixel text-[9px] text-coral">НЕ УДАЛОСЬ ЗАГРУЗИТЬ ЯДРО</span>
          <span className="text-[11px] text-dim leading-relaxed">
            Для SEGA нужен интернет — ядро Genesis Plus GX берётся с CDN emulatorjs.org (один раз, дальше из кэша).
            Проверьте соединение и перезапустите ром.
          </span>
        </div>
      )}
      <div className="absolute bottom-1 right-2 font-pixel text-[7px] text-[rgba(233,236,255,0.4)] z-10">GENESIS PLUS GX</div>
    </div>
  );
}
