import { useEffect, useRef, useState } from 'react';
import { useApp } from './store';

const CDN_DATA = 'https://cdn.emulatorjs.org/stable/data/';

export interface SegaLoadResult { ok: boolean; how: string; errs?: string[]; }

export interface SegaApi {
  snapshot: () => Promise<string | null>; // base64-состояние ядра
  loadState: (state: string, onResult?: (r: SegaLoadResult) => void) => void; // без перезапуска
  reset: () => void;
  pause: (p: boolean) => void;
}

function coreFor(ext: string): string {
  if (ext === 'sms') return 'segaMS';
  if (ext === 'gg') return 'segaGG';
  return 'segaMD'; // md, gen, bin
}

/**
 * Эмулятор SEGA (Genesis Plus GX / EmulatorJS) в изолированном iframe.
 *
 * — Звук: при размонтировании iframe браузер гарантированно глушит все его
 *   аудиоконтексты и воркеры — «звук прошлого рома» невозможен.
 * — Сохранения: грузятся сообщением в работающий экземпляр (без перезапуска).
 * — Ядро: подгружается с CDN emulatorjs.org. Первый запуск SEGA-рома скачивает
 *   его один раз (~10–20 МБ), дальше браузер берёт из кэша — повторных загрузок нет.
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
  const [html, setHtml] = useState<string | null>(null);
  const pausedRef = useRef(paused ?? false);
  pausedRef.current = paused ?? false;
  const initStateRef = useRef<string | null>(initialState ?? null);
  initStateRef.current = initialState ?? null;
  const pendingRef = useRef<Record<string, (s: string | null) => void>>({});
  const resultRef = useRef<Record<string, (r: SegaLoadResult) => void>>({});
  const readyRef = useRef(false);
  const romNameRef = useRef('game.' + (ext || 'md'));

  const core = coreFor(ext);

  // документ iframe строится сразу; ядро подтянется с CDN (кэш браузера после 1-го запуска)
  useEffect(() => {
    const opts = useApp.getState().options;
    const volume = opts.emuSound ? Math.max(0, Math.min(1, opts.emuVolume ?? 1)) : 0;
    setHtml(buildHtml(core, volume, CDN_DATA));
  }, [core, romData]);

  useEffect(() => {
    if (!html) return;
    setStatus('loading');
    readyRef.current = false;
    const frame = frameRef.current;
    if (frame) frame.srcdoc = html;

    const sendBoot = () => {
      try {
        frameRef.current?.contentWindow?.postMessage({ type: 'boot', rom: romData, name: romNameRef.current }, '*');
      } catch { /* noop */ }
    };

    const onMsg = (e: MessageEvent) => {
      if (frame && e.source && e.source !== frame.contentWindow) return;
      const d = e.data as { type?: string; state?: string | null; reqId?: string; ok?: boolean; how?: string; errs?: string[] } | null;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'ejs-hello') {
        sendBoot();
      } else if (d.type === 'ejs-ready') {
        readyRef.current = true;
        setStatus('ready');
        try { frameRef.current?.contentWindow?.postMessage({ type: 'pause', paused: pausedRef.current }, '*'); } catch { /* noop */ }
        if (initStateRef.current) {
          const st = initStateRef.current;
          setTimeout(() => {
            try { frameRef.current?.contentWindow?.postMessage({ type: 'load-state', state: st }, '*'); } catch { /* noop */ }
          }, 500);
        }
      } else if (d.type === 'ejs-error') {
        setStatus((prev) => (prev === 'ready' ? prev : 'error'));
      } else if (d.type === 'ejs-state' && d.reqId) {
        const cb = pendingRef.current[d.reqId];
        if (cb) {
          delete pendingRef.current[d.reqId];
          cb(d.state ?? null);
        }
      } else if (d.type === 'ejs-load-result' && d.reqId) {
        const cb = resultRef.current[d.reqId];
        if (cb) {
          delete resultRef.current[d.reqId];
          cb({ ok: !!d.ok, how: d.how ?? '?', errs: d.errs });
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
      loadState: (st, onResult) => {
        if (!st) {
          onResult?.({ ok: false, how: 'пустое состояние' });
          return;
        }
        if (onResult) {
          const reqId = Math.random().toString(36).slice(2);
          resultRef.current[reqId] = onResult;
          try { frameRef.current?.contentWindow?.postMessage({ type: 'load-state', state: st, reqId }, '*'); } catch { /* noop */ }
          setTimeout(() => {
            const cb = resultRef.current[reqId];
            if (cb) {
              delete resultRef.current[reqId];
              cb({ ok: false, how: 'таймаут ответа ядра' });
            }
          }, 4000);
        } else {
          try { frameRef.current?.contentWindow?.postMessage({ type: 'load-state', state: st }, '*'); } catch { /* noop */ }
        }
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
      resultRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

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
          <span className="text-[11px] text-dim px-6 text-center max-w-sm">
            Первый запуск SEGA-рома скачивает ядро с CDN (~10–20 МБ, один раз) —
            дальше браузер берёт его из кэша и повторной загрузки нет.
          </span>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#05070f] p-6 text-center">
          <span className="font-pixel text-[9px] text-coral">НЕ УДАЛОСЬ ЗАГРУЗИТЬ ЯДРО</span>
          <span className="text-[11px] text-dim leading-relaxed max-w-sm">
            Для первого запуска SEGA нужен интернет — ядро Genesis Plus GX берётся с CDN emulatorjs.org
            (один раз, дальше из кэша браузера). Проверьте соединение и перезапустите ром.
          </span>
        </div>
      )}
      <div className="absolute bottom-1 left-2 font-pixel text-[7px] text-[rgba(233,236,255,0.35)] z-10">
        CORE: CDN
      </div>
      <div className="absolute bottom-1 right-2 font-pixel text-[7px] text-[rgba(233,236,255,0.35)] z-10">GENESIS PLUS GX</div>
    </div>
  );
}

function buildHtml(core: string, volume: number, base: string): string {
  // Внутренний документ: чистое окно без тулбара, общается с хостом через postMessage.
  // Ром приходит сообщением 'boot' как ArrayBuffer; blob-URL создаётся ВНУТРИ iframe —
  // с именем и расширением файла (иначе ядро стартует «пустым» и показывает меню RetroArch).
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;padding:0;background:#000;height:100%;overflow:hidden}',
    '#game{position:absolute;inset:0;width:100%;height:100%}',
    '#err{display:none;position:absolute;inset:0;color:#ff5d73;font-family:monospace;font-size:12px;padding:16px;background:#05070f;white-space:pre-wrap}',
    '</style></head><body><div id="game"></div><div id="err"></div><script>',
    'window.EJS_player="#game";',
    `window.EJS_core=${JSON.stringify(core)};`,
    `window.EJS_pathtodata=${JSON.stringify(base)};`,
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
    // Загрузка состояния: пробуем нативный формат (Uint8Array → setState),
    // затем официальный «файловый» путь (loadState c blob-URL), затем raw-строку.
    'function tryLoad(g,s){',
    '  var errs=[];',
    '  try{if(typeof g.setState==="function"){g.setState(b64ToU8(s));return {ok:true,how:"setState(bytes)"};}}catch(e){errs.push("setState: "+e);}',
    '  try{if(typeof g.loadState==="function"){var u=URL.createObjectURL(new Blob([s],{type:"text/plain"}));g.loadState(u);setTimeout(function(){URL.revokeObjectURL(u);},10000);return {ok:true,how:"loadState(file-url)"};}}catch(e){errs.push("loadState(url): "+e);}',
    '  try{if(typeof g.loadState==="function"){g.loadState(s);return {ok:true,how:"loadState(raw)"};}}catch(e){errs.push("loadState(raw): "+e);}',
    '  return {ok:false,how:"нет подходящего метода",errs:errs};',
    '}',
    'function showErr(t){var el=document.getElementById("err");el.textContent=t;el.style.display="block";try{parent.postMessage({type:"ejs-error"},"*");}catch(e){}}',
    'window.EJS_ready=function(){try{parent.postMessage({type:"ejs-ready"},"*");}catch(e){}};',
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
    '      s.src=' + JSON.stringify(base) + '+"loader.js";',
    '      s.onerror=function(){showErr("Не удалось загрузить ядро (нужен интернет при первом запуске или папка public/data)");};',
    '      document.body.appendChild(s);',
    '    }catch(err){showErr("Ошибка запуска: "+err);}',
    '    return;',
    '  }',
    '  var g=gm();',
    // ядро ещё поднимается — отложим управляющие сообщения (до 2 сек)
    '  if(!g){',
    '    if((d.type==="load-state"||d.type==="pause"||d.type==="reset")&&(d.__r||0)<8){',
    '      d.__r=(d.__r||0)+1;var dd={};for(var k in d){dd[k]=d[k];}',
    '      setTimeout(function(){window.dispatchEvent(new MessageEvent("message",{data:dd}));},250);',
    '    }',
    '    return;',
    '  }',
    '  try{',
    '    if(d.type==="load-state"&&d.state){',
    '      var res=tryLoad(g,d.state);',
    '      parent.postMessage({type:"ejs-load-result",reqId:d.reqId||null,ok:res.ok,how:res.how,errs:res.errs||[]},"*");',
    '    }',
    '    else if(d.type==="reset"){g.restart&&g.restart();}',
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
