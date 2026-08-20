import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './store';

const EJS_DATA = 'https://cdn.emulatorjs.org/stable/data/';

export interface SegaApi {
  snapshot: () => Promise<string | null>; // base64-состояние ядра
  loadState: (state: string | null) => void; // загрузить сохранение БЕЗ перезапуска
  reset: () => void; // сброс (с начала)
  pause: (p: boolean) => void;
}

function coreFor(ext: string): string {
  if (ext === 'sms') return 'segaMS';
  if (ext === 'gg') return 'segaGG';
  return 'segaMD'; // md, gen, bin
}



/**
 * Эмулятор SEGA (Genesis Plus GX / EmulatorJS), запущенный в изолированном iframe.
 *
 * Почему iframe — это решает обе застарелые проблемы разом:
 *  1. Звук. RetroArch крутит WebAudio внутри своей песочницы; при удалении iframe
 *     браузер гарантированно глушит ВСЕ его аудиоконтексты и воркеры. Никакого
 *     «звук прошлого рома играет в фоне» быть не может.
 *  2. Повторная загрузка. Сохранения того же рома грузятся сообщением loadState
 *     в уже работающий экземпляр — ядро не перезапускается. Перезапуск (и короткая
 *     загрузка ядра) происходит только при смене рома, что естественно.
 */
export default function SegaBox({
  romData,
  ext,
  initialState,
  paused,
  onApi,
}: {
  romData: ArrayBuffer;
  ext: string;
  initialState?: string | null;
  paused?: boolean;
  onApi?: (api: SegaApi) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const pausedRef = useRef(paused ?? false);
  pausedRef.current = paused ?? false;
  const initStateRef = useRef<string | null>(initialState ?? null);
  initStateRef.current = initialState ?? null;
  const pendingRef = useRef<Record<string, (s: string | null) => void>>({});
  const readyRef = useRef(false);

  const core = coreFor(ext);
  const opts = useApp((s) => s.options);
  const volume = opts.emuSound ? Math.max(0, Math.min(1, opts.emuVolume ?? 1)) : 0;
  const romNameRef = useRef('game.' + (ext || 'md'));

  // srcdoc пересоздаётся только при смене рома/ядра — это и есть «чистый запуск»
  const srcdoc = useMemo(
    () => buildHtml(core, volume),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [core],
  );

  useEffect(() => {
    setStatus('loading');
    readyRef.current = false;
    const frame = frameRef.current;
    if (frame) frame.srcdoc = srcdoc;

    const sendBoot = () => {
      try {
        frameRef.current?.contentWindow?.postMessage(
          { type: 'boot', rom: romData, name: romNameRef.current },
          '*',
        );
      } catch { /* noop */ }
    };

    const onMsg = (e: MessageEvent) => {
      if (frame && e.source !== frame.contentWindow) return;
      const d = e.data as { type?: string; state?: string | null; reqId?: string } | null;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'ejs-hello') {
        // документ iframe готов — отправляем ром (двоично), он сам создаст blob-URL
        sendBoot();
      } else if (d.type === 'ejs-ready') {
        readyRef.current = true;
        setStatus('ready');
        // применим текущую паузу сразу после старта
        try { frame?.contentWindow?.postMessage({ type: 'pause', paused: pausedRef.current }, '*'); } catch { /* noop */ }
        // подгрузим стартовое сохранение задания, если оно задано
        if (initStateRef.current) {
          const st = initStateRef.current;
          setTimeout(() => {
            try { frameRef.current?.contentWindow?.postMessage({ type: 'load-state', state: st }, '*'); } catch { /* noop */ }
          }, 350);
        }
      } else if (d.type === 'ejs-error') {
        setStatus('error');
      } else if (d.type === 'ejs-state' && d.reqId) {
        const cb = pendingRef.current[d.reqId];
        if (cb) {
          delete pendingRef.current[d.reqId];
          cb(d.state ?? null);
        }
      }
    };
    window.addEventListener('message', onMsg);

    const api: SegaApi = {
      snapshot: () =>
        new Promise<string | null>((resolve) => {
          const reqId = Math.random().toString(36).slice(2);
          pendingRef.current[reqId] = resolve;
          try { frameRef.current?.contentWindow?.postMessage({ type: 'get-state', reqId }, '*'); } catch { /* noop */ }
          setTimeout(() => {
            if (pendingRef.current[reqId]) {
              delete pendingRef.current[reqId];
              resolve(null);
            }
          }, 3500);
        }),
      loadState: (st) => {
        if (!st) return;
        try { frameRef.current?.contentWindow?.postMessage({ type: 'load-state', state: st }, '*'); } catch { /* noop */ }
      },
      reset: () => {
        try { frameRef.current?.contentWindow?.postMessage({ type: 'reset' }, '*'); } catch { /* noop */ }
      },
      pause: (p) => {
        try { frameRef.current?.contentWindow?.postMessage({ type: 'pause', paused: !!p }, '*'); } catch { /* noop */ }
      },
    };
    onApi?.(api);

    return () => {
      window.removeEventListener('message', onMsg);
      // уничтожение документа iframe = гарантированная остановка звука и ядра
      const f = frameRef.current;
      if (f) f.srcdoc = '';
      pendingRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcdoc]);

  // внешняя пауза — сообщением в работающее ядро
  useEffect(() => {
    if (status !== 'ready') return;
    try { frameRef.current?.contentWindow?.postMessage({ type: 'pause', paused: !!paused }, '*'); } catch { /* noop */ }
  }, [paused, status]);

  return (
    <div className="relative w-full aspect-[4/3] bg-black border-[3px] border-edge shadow-[0_0_40px_rgba(255,139,63,0.12)] overflow-hidden">
      <iframe
        ref={frameRef}
        title="SEGA Emulator"
        className="absolute inset-0 w-full h-full border-0"
        allow="autoplay; fullscreen; gamepad"
      />
      {paused && status === 'ready' && (
        <div className="absolute inset-0 z-20 bg-[rgba(4,6,14,0.6)] flex flex-col items-center justify-center gap-2 pointer-events-none">
          <span className="font-pixel text-[10px] text-gold blink-hard">ПАУЗА</span>
        </div>
      )}
      {status === 'loading' && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#05070f]">
          <span className="font-pixel text-[9px] text-magma blink-hard">ЗАГРУЗКА ЯДРА SEGA…</span>
          <span className="text-[11px] text-dim px-6 text-center">
            Ядро скачивается один раз и кэшируется браузером. При загрузке сохранений перезапуска нет.
          </span>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#05070f] p-6 text-center">
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

function buildHtml(core: string, volume: number): string {
  // Внутренний документ: чистое окно без тулбара, общается с хостом через postMessage.
  // Ром приходит сообщением 'boot' как ArrayBuffer; blob-URL создаётся ВНУТРИ iframe —
  // с именем и расширением файла (иначе ядро стартует «пустым» и показывает меню RetroArch).
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;padding:0;background:#000;height:100%;overflow:hidden}',
    '#game{position:absolute;inset:0;width:100%;height:100%}',
    '#err{display:none;position:absolute;inset:0;color:#ff5d73;font-family:monospace;font-size:12px;padding:16px;background:#05070f}',
    '</style></head><body><div id="game"></div><div id="err"></div><script>',
    'window.EJS_player="#game";',
    `window.EJS_core=${JSON.stringify(core)};`,
    `window.EJS_pathtodata=${JSON.stringify(EJS_DATA)};`,
    'window.EJS_language="ru";',
    'window.EJS_backgroundText="";',
    'window.EJS_backgroundColor="#0b0e1c";',
    'window.EJS_color="#ffcf3f";',
    `window.EJS_volume=${volume};`,
    'window.EJS_startOnLoaded=true;',
    'window.EJS_askBeforeExit=false;',
    'window.EJS_Buttons={playPause:false,restart:false,mute:false,settings:false,fullscreen:false,saveState:false,loadState:false,screenRecord:false,gamepad:false,cheat:false,volume:false,saveSavFiles:false,loadSavFiles:false,quickSave:false,quickLoad:false,screenshot:false,cacheManager:false,exitEmulation:false};',
    'var booted=false;',
    'function gm(){return window.EJS_emulator&&window.EJS_emulator.gameManager;}',
    'function b64(u8){var bin="";for(var i=0;i<u8.length;i+=32768){bin+=String.fromCharCode.apply(null,u8.subarray(i,i+32768));}return btoa(bin);}',
    'function b64ToU8(b){var bin=atob(b);var u8=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++){u8[i]=bin.charCodeAt(i);}return u8;}',
    'function showErr(t){var el=document.getElementById("err");el.textContent=t;el.style.display="block";parent.postMessage({type:"ejs-error"},"*");}',
    'window.EJS_ready=function(){parent.postMessage({type:"ejs-ready"},"*");};',
    'window.addEventListener("message",function(e){',
    '  var d=e.data||{};',
    '  if(d.type==="boot"&&!booted){',
    '    booted=true;',
    '    try{',
    '      var buf=d.rom instanceof ArrayBuffer?d.rom:(d.rom&&d.rom.buffer?d.rom.buffer:null);',
    '      if(!buf){showErr("Ром не передан в эмулятор");return;}',
    '      var name=d.name||"game.bin";',
    '      var url=URL.createObjectURL(new Blob([buf],{type:"application/octet-stream"}));',
    '      window.EJS_gameUrl=url;',
    '      window.EJS_gameName=name;',
    '      var s=document.createElement("script");',
    '      s.src=' + JSON.stringify(EJS_DATA) + '+"loader.js";',
    '      s.onerror=function(){showErr("Не удалось загрузить ядро с CDN (нужен интернет при первом запуске)");};',
    '      document.body.appendChild(s);',
    '    }catch(err){showErr("Ошибка запуска: "+err);}',
    '    return;',
    '  }',
    '  var g=gm();if(!g)return;',
    '  try{',
    '    if(d.type==="load-state"&&d.state){',
    '      var st=d.state;var loaded=false;',
    '      if(typeof g.setState==="function"){try{g.setState(typeof st==="string"?b64ToU8(st):st);loaded=true;}catch(e){}}',
    '      if(!loaded&&typeof g.loadState==="function"){try{g.loadState(st);loaded=true;}catch(e){}}',
    '      if(!loaded){parent.postMessage({type:"ejs-error"},"*");}',
    '    }',
    '    else if(d.type==="reset"){g.restart();}',
    '    else if(d.type==="pause"){if(d.paused){g.pause&&g.pause();}else{g.play&&g.play();}}',
    '    else if(d.type==="get-state"){',
    '      var r=g.getState();',
    '      var send=function(s){var out=null;if(typeof s==="string"){out=s;}else if(s&&s.length!==undefined){out=b64(s);}parent.postMessage({type:"ejs-state",state:out,reqId:d.reqId},"*");};',
    '      if(r&&typeof r.then==="function"){r.then(send,function(){send(null);});}else{send(r);}',
    '    }',
    '  }catch(err){parent.postMessage({type:"ejs-error"},"*");}',
    '});',
    'parent.postMessage({type:"ejs-hello"},"*");',
    '</script>',
    '</body></html>',
  ].join('\n');
}
