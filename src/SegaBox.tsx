import { useEffect, useRef, useState } from 'react';
import { useApp } from './store';

const EJS_DATA = 'https://cdn.emulatorjs.org/stable/data/';

export interface SegaApi {
  snapshot: () => string | null; // base64-состояние ядра
  reload: (state?: string | null) => void;
  reset: () => void;
}

function coreFor(ext: string): string {
  if (ext === 'sms') return 'segaMS';
  if (ext === 'gg') return 'segaGG';
  return 'segaMD'; // md, gen, bin
}

interface EJSGame {
  gameManager?: {
    getState?: () => string | Uint8Array;
    loadState?: (s: string | Uint8Array) => void;
    restart?: () => void;
  };
  destroy?: () => void;
  exit?: () => void;
}

const getEjs = (): EJSGame | undefined =>
  (window as unknown as { EJS_emulator?: EJSGame }).EJS_emulator;

/**
 * Эмулятор SEGA (Mega Drive / Master System / Game Gear) на ядре Genesis Plus GX (EmulatorJS).
 * Интерфейс намеренно чистый, как у NES-окна: весь встроенный тулбар скрыт,
 * а сохранения/сброс/пауза управляются снаружи через SegaApi — как в NesBox.
 * Громкость берётся из общих опций. Состояния снимаются через gameManager.getState()
 * и хранятся в общей библиотеке сохранений (как у NES).
 */
export default function SegaBox({
  romData,
  ext,
  initialState,
  paused,
  resetKey,
  onApi,
}: {
  romData: ArrayBuffer;
  ext: string;
  initialState?: string | null;
  paused?: boolean;
  resetKey?: number;
  onApi?: (api: SegaApi) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const stateRef = useRef<string | null>(initialState ?? null);
  stateRef.current = initialState ?? null;
  const pausedRef = useRef(paused ?? false);
  pausedRef.current = paused ?? false;

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

    const opts = useApp.getState().options;
    const vol = opts.emuSound ? (opts.emuVolume ?? 1) : 0;
    const w = window as unknown as Record<string, unknown>;
    w.EJS_player = `#${divId}`;
    w.EJS_core = coreFor(ext);
    w.EJS_gameUrl = url;
    w.EJS_pathtodata = EJS_DATA;
    w.EJS_language = 'ru';
    w.EJS_backgroundText = 'Загрузка ядра SEGA…';
    w.EJS_backgroundColor = '#0b0e1c';
    w.EJS_color = '#ffcf3f';
    w.EJS_volume = Math.max(0, Math.min(1, vol));
    w.EJS_startOnLoaded = true; // стартуем сразу, без кнопки Play
    w.EJS_askBeforeExit = false;
    // Чистое окно: прячем весь встроенный тулбар — управление только снаружи
    w.EJS_Buttons = {
      playPause: false, restart: false, mute: false, settings: false,
      fullscreen: false, saveState: false, loadState: false, screenRecord: false,
      gamepad: false, cheat: false, volume: false, saveSavFiles: false,
      loadSavFiles: false, quickSave: false, quickLoad: false, screenshot: false,
      cacheManager: false, exitEmulation: false,
    };
    w.EJS_ready = () => {
      setStatus('ready');
      // подгружаем сохранение задания, если оно есть
      const st = stateRef.current;
      if (st) {
        setTimeout(() => {
          try { getEjs()?.gameManager?.loadState?.(st); } catch { /* noop */ }
        }, 400);
      }
    };

    const api: SegaApi = {
      snapshot: () => {
        try {
          const gm = getEjs()?.gameManager;
          const s = gm?.getState?.();
          if (s == null) return null;
          return typeof s === 'string' ? s : null;
        } catch {
          return null;
        }
      },
      reload: (st) => {
        try {
          const gm = getEjs()?.gameManager;
          const target = st ?? stateRef.current;
          if (target) gm?.loadState?.(target);
          else gm?.restart?.();
        } catch { /* noop */ }
      },
      reset: () => {
        try { getEjs()?.gameManager?.restart?.(); } catch { /* noop */ }
      },
    };
    onApi?.(api);

    if (!document.querySelector('script[data-ejs-loader]')) {
      const script = document.createElement('script');
      script.src = `${EJS_DATA}loader.js`;
      script.async = true;
      script.dataset.ejsLoader = '1';
      script.onerror = () => setStatus('error');
      document.body.appendChild(script);
    }

    return () => {
      const w = window as unknown as Record<string, unknown>;
      try {
        const emu = getEjs();
        // останавливаем ядро и звук
        (emu as { gameManager?: { exit?: () => void; pause?: () => void } } | null)?.gameManager?.pause?.();
        (emu as { gameManager?: { exit?: () => void } } | null)?.gameManager?.exit?.();
        // официальная функция уничтожения EmulatorJS (закрывает аудио-контексты)
        (w.EJS_terminate as (() => void) | undefined)?.();
      } catch { /* noop */ }
      try {
        w.EJS_emulator = null;
        w.EJS_gameUrl = '';
        w.EJS_ready = undefined;
      } catch { /* noop */ }
      host.innerHTML = '';
      URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [romData, ext, resetKey]);

  // настоящая пауза ядра (кадры + звук), если она доступна
  useEffect(() => {
    if (status !== 'ready') return;
    try {
      const gm = (getEjs() as { gameManager?: { pause?: () => void; play?: () => void } } | null)?.gameManager;
      if (paused) gm?.pause?.();
      else gm?.play?.();
    } catch { /* noop */ }
  }, [paused, status]);

  // внешняя пауза: у ядра нет публичного pause, поэтому просто стопорим кадры оверлеем
  // (таймер задания при этом честно останавливается движком)
  return (
    <div className="relative w-full aspect-[4/3] bg-black border-[3px] border-edge shadow-[0_0_40px_rgba(255,139,63,0.12)] overflow-hidden">
      <div ref={hostRef} className="absolute inset-0" />
      {paused && status === 'ready' && (
        <div className="absolute inset-0 z-20 bg-[rgba(4,6,14,0.6)] flex flex-col items-center justify-center gap-2">
          <span className="font-pixel text-[10px] text-gold blink-hard">ПАУЗА</span>
        </div>
      )}
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
