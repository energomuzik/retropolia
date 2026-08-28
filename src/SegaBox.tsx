import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './store';

const CDN_DATA = 'https://cdn.emulatorjs.org/stable/data/';

export interface SegaApi {
  snapshot: () => Promise<string | null>; // base64-состояние ядра (живое, без перезапуска)
  /** Перезапуск ядра с применением сохранения (null = старт с начала).
   *  Использует документированный EJS_loadStateURL — гарантированно работает. */
  loadSaveReliable: (b64: string | null) => void;
  pause: (p: boolean) => void; // живая пауза (без перезапуска)
  /** Снимок текущего кадра (dataURL jpeg) для трансляции соперникам. */
  captureFrame: () => Promise<string | null>;
}

function coreFor(ext: string): string {
  if (ext === 'sms') return 'segaMS';
  if (ext === 'gg') return 'segaGG';
  return 'segaMD'; // md, gen, bin
}

/**
 * Эмулятор SEGA (Genesis Plus GX / EmulatorJS) в изолированном iframe.
 *
 * — Сохранения грузятся перезапуском ядра с EJS_loadStateURL (единственный
 *   надёжный путь в stable-версии EmulatorJS). Ядро при этом берётся из кэша
 *   браузера — повторного скачивания нет, только быстрый рестарт (~1–2 c).
 * — Пауза — «живая», без перезапуска: применяется каскадом
 *   (EJS_emulator.pause → gameManager.pause → blur-событие) с повторами первые
 *   секунды после старта — гонка с инициализацией ядра исключена.
 * — Звук: при размонтировании iframe браузер гарантированно глушит все его
 *   аудиоконтексты и воркеры — «звук прошлого рома» невозможен.
 */
export default function SegaBox({
  romData,
  ext,
  initialState,
  paused,
  pausedHint,
  onApi,
}: {
  romData: ArrayBuffer;
  ext: string;
  initialState?: string | null;
  paused?: boolean;
  pausedHint?: string;
  onApi?: (api: SegaApi) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // номер текущей попытки загрузки ядра (виден в оверлее «ЗАГРУЗКА ЯДРА SEGA…»)
  const [loadAttempt, setLoadAttempt] = useState(0);
  const pausedRef = useRef(paused ?? false);
  pausedRef.current = paused ?? false;
  const pendingRef = useRef<Record<string, (s: string | null) => void>>({});
  const readyRef = useRef(false);
  // получили ли хоть одно «hello» от iframe (для точного сторожевого таймера)
  const gotHelloRef = useRef(false);
  const romNameRef = useRef('game.' + (ext || 'md'));
  const romDataRef = useRef(romData);
  romDataRef.current = romData;
  // Сохранение, которое нужно применить при старте ядра (EJS_loadStateURL).
  // null = старт с начала рома. Меняется через loadSaveReliable → перезапуск.
  const bootStateRef = useRef<string | null>(initialState ?? null);
  const [bootTick, setBootTick] = useState(0);
  // ядро уже поднималось в этом экземпляре? (для лёгкого оверлея перезапуска вместо полной загрузки)
  const firstBootRef = useRef(false);

  const core = coreFor(ext);

  // Документ iframe строится СИНХРОННО — iframe получает srcDoc уже при первом
  // рендере (нет состояния «html ещё null»). nonce гарантирует уникальность строки
  // при каждом rebuild, bootStateRef «впекается» как EJS_loadStateURL.
  const html = useMemo(() => {
    const opts = useApp.getState().options;
    const volume = opts.emuSound ? Math.max(0, Math.min(1, opts.emuVolume ?? 1)) : 0;
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return buildHtml(core, volume, CDN_DATA, bootStateRef.current, nonce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, romData, bootTick]);

  // Слушатель сообщений — один на всё время жизни компонента (работает через ref'ы,
  // поэтому не зависит от пересоздания iframe при смене bootTick).
  useEffect(() => {
    const sendBoot = () => {
      try {
        frameRef.current?.contentWindow?.postMessage({ type: 'boot', rom: romDataRef.current, name: romNameRef.current }, '*');
      } catch { /* noop */ }
    };
    const onMsg = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (frame && e.source && e.source !== frame.contentWindow) return;
      const d = e.data as { type?: string; state?: string | null; reqId?: string } | null;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'ejs-hello') {
        gotHelloRef.current = true; // iframe жив и отвечает — скрипт цел
        sendBoot();
      } else if (d.type === 'ejs-ready') {
        readyRef.current = true;
        firstBootRef.current = true; // ядро поднялось — следующие перезапуски будут «лёгкими»
        setStatus('ready');
        // применим текущую паузу сразу после старта (сохранение уже «впечено» через EJS_loadStateURL)
        try { frameRef.current?.contentWindow?.postMessage({ type: 'pause', paused: pausedRef.current }, '*'); } catch { /* noop */ }
      } else if (d.type === 'ejs-retrying') {
        // ядро не скачалось с первого раза — идёт автоповтор
        setLoadAttempt((d as { attempt?: number }).attempt ?? 0);
      } else if (d.type === 'ejs-error') {
        setStatus((prev) => (prev === 'ready' ? prev : 'error'));
      } else if ((d.type === 'ejs-state' || d.type === 'ejs-frame') && d.reqId) {
        const cb = pendingRef.current[d.reqId];
        if (cb) {
          delete pendingRef.current[d.reqId];
          cb(d.state ?? null);
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('message', onMsg);
      pendingRef.current = {};
    };
  }, []);

  // API стабилен (внутри — только ref'ы и setBootTick), отдаём его родителю один раз.
  useEffect(() => {
    const api: SegaApi = {
      snapshot: () =>
        new Promise<string | null>((resolve) => {
          const reqId = 's' + Math.random().toString(36).slice(2);
          pendingRef.current[reqId] = resolve;
          try { frameRef.current?.contentWindow?.postMessage({ type: 'get-state', reqId }, '*'); } catch { /* noop */ }
          setTimeout(() => {
            if (pendingRef.current[reqId]) {
              delete pendingRef.current[reqId];
              resolve(null);
            }
          }, 3500);
        }),
      loadSaveReliable: (b64) => {
        bootStateRef.current = b64 ?? null;
        setBootTick((t) => t + 1); // перестроить html + перемонтировать iframe → сохранение применится при старте
      },
      pause: (p) => {
        try { frameRef.current?.contentWindow?.postMessage({ type: 'pause', paused: !!p }, '*'); } catch { /* noop */ }
      },
      captureFrame: () =>
        new Promise<string | null>((resolve) => {
          const reqId = 'f' + Math.random().toString(36).slice(2);
          pendingRef.current[reqId] = resolve;
          try { frameRef.current?.contentWindow?.postMessage({ type: 'get-frame', reqId }, '*'); } catch { /* noop */ }
          setTimeout(() => {
            if (pendingRef.current[reqId]) {
              delete pendingRef.current[reqId];
              resolve(null);
            }
          }, 1500);
        }),
    };
    onApi?.(api);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Каждый (пере)запуск: статус loading + сторожевой таймер.
  // Если iframe за 20 секунд не прислал даже «hello» — встроенный скрипт бит (или
  // ядро не грузится вовсе) → показываем ошибку. Если «hello» было, но ядро ещё не
  // готово — просто медленный CDN, оставляем «загрузка».
  useEffect(() => {
    setStatus('loading');
    setLoadAttempt(0);
    readyRef.current = false;
    gotHelloRef.current = false;
    const t = setTimeout(() => {
      if (!readyRef.current && !gotHelloRef.current) setStatus((prev) => (prev === 'ready' ? prev : 'error'));
    }, 20000);
    return () => clearTimeout(t);
  }, [bootTick]);

  // внешняя пауза — сообщением в работающее ядро
  useEffect(() => {
    if (status !== 'ready') return;
    try { frameRef.current?.contentWindow?.postMessage({ type: 'pause', paused: !!paused }, '*'); } catch { /* noop */ }
  }, [paused, status]);

  return (
    <div className="relative w-full aspect-[4/3] bg-black border-[3px] border-edge shadow-[0_0_40px_rgba(255,139,63,0.12)] overflow-hidden">
      <iframe
        key={bootTick}
        ref={frameRef}
        title="SEGA Emulator"
        srcDoc={html}
        className="absolute inset-0 w-full h-full border-0"
        allow="autoplay; fullscreen; gamepad"
      />
      {paused && status === 'ready' && (
        <div className="absolute inset-0 z-20 bg-[rgba(4,6,14,0.6)] flex flex-col items-center justify-center gap-2 pointer-events-none">
          <span className="font-pixel text-[10px] text-gold blink-hard">{pausedHint ? 'ОЖИДАНИЕ' : 'ПАУЗА'}</span>
          {pausedHint && <span className="text-[11px] text-dim">{pausedHint}</span>}
        </div>
      )}
      {status === 'loading' && !firstBootRef.current && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#05070f]">
          <span className="font-pixel text-[9px] text-magma blink-hard">
            ЗАГРУЗКА ЯДРА SEGA{loadAttempt > 1 ? `… ПОПЫТКА ${loadAttempt}` : '…'}
          </span>
          <span className="text-[11px] text-dim px-6 text-center max-w-sm">
            {loadAttempt > 1
              ? 'Сеть нестабильна — пробуем другое зеркало. Ядро скачается автоматически.'
              : 'Первый запуск SEGA-рома скачивает ядро с CDN (~10–20 МБ, один раз) — дальше браузер берёт его из кэша.'}
          </span>
        </div>
      )}
      {status === 'loading' && firstBootRef.current && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 hud-chip pixel-corners px-4 py-1.5">
          <span className="font-pixel text-[8px] text-gold blink-hard">ПЕРЕЗАПУСК С СОХРАНЕНИЕМ…</span>
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
      <div className="absolute bottom-1 right-2 font-pixel text-[7px] text-[rgba(233,236,255,0.35)] z-10">GENESIS PLUS GX</div>
    </div>
  );
}

function buildHtml(core: string, volume: number, base: string, bootStateB64: string | null, nonce: string): string {
  // Внутренний документ: чистое окно без тулбара, общается с хостом через postMessage.
  // Ром приходит сообщением 'boot' как ArrayBuffer; blob-URL создаётся ВНУТРИ iframe —
  // с именем и расширением файла (иначе ядро стартует «пустым» и показывает меню RetroArch).
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;padding:0;background:#000;height:100%;overflow:hidden}',
    '#game{position:absolute;inset:0;width:100%;height:100%}',
    '#err{display:none;position:absolute;inset:0;color:#ff5d73;font-family:monospace;font-size:12px;padding:16px;background:#05070f;white-space:pre-wrap;z-index:50}',
    '</style></head><body><div id="game"></div><div id="err"></div><script>',
    `/* boot ${nonce} */`,
    // чтобы toDataURL видел последний кадр WebGL (нужно для трансляции)
    '(function(){var _gc=HTMLCanvasElement.prototype.getContext;',
    'HTMLCanvasElement.prototype.getContext=function(t,a){',
    'if(t==="webgl"||t==="webgl2"||t==="experimental-webgl"){a=Object.assign({},a,{preserveDrawingBuffer:true});}',
    'return _gc.call(this,t,a);};})();',
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
    'var wantPaused=false;',
    'var readyAt=0;',
    'function gm(){return window.EJS_emulator&&window.EJS_emulator.gameManager;}',
    'function b64(u8){var bin="";for(var i=0;i<u8.length;i+=32768){bin+=String.fromCharCode.apply(null,u8.subarray(i,i+32768));}return btoa(bin);}',
    'function b64ToU8(b){var bin=atob(b);var u8=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++){u8[i]=bin.charCodeAt(i);}return u8;}',
    'function showErr(t){var el=document.getElementById("err");el.textContent=t;el.style.display="block";try{parent.postMessage({type:"ejs-error"},"*");}catch(e){}}',

    // -------- пауза: каскад методов + повторы, пока ядро поднимается --------
    'function doPause(p){',
    '  var done=false;var emu=window.EJS_emulator;',
    '  try{if(emu&&typeof emu.pause==="function"&&typeof emu.play==="function"){if(p){emu.pause();}else{emu.play();}done=true;}}catch(e){}',
    '  if(!done){var g=gm();try{if(g){if(p&&g.pause){g.pause();done=true;}if(!p&&g.play){g.play();done=true;}}}catch(e){}}',
    '  if(!done){try{window.dispatchEvent(new Event(p?"blur":"focus"));done=true;}catch(e){}}',
    '  return done;',
    '}',
    // насос: первые ~3.5 секунды после готовности периодически подтверждаем требуемое
    // состояние паузы — иначе ядро может стартовать раньше, чем дойдёт первое сообщение
    'setInterval(function(){',
    '  if(!readyAt)return;',
    '  if(Date.now()-readyAt>3500)return;',
    '  if(gm()){doPause(wantPaused);}',
    '},450);',

    'window.EJS_ready=function(){readyAt=Date.now();try{parent.postMessage({type:"ejs-ready"},"*");}catch(e){}};',

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
    // сохранение при старте: байты состояния → blob-URL → EJS_loadStateURL (до загрузки ядра)
    '      if(' + JSON.stringify(bootStateB64) + '){',
    '        try{',
    '          var sb=b64ToU8(' + JSON.stringify(bootStateB64) + ');',
    '          window.EJS_loadStateURL=URL.createObjectURL(new Blob([sb],{type:"application/octet-stream"}));',
    '        }catch(e){}',
    '      }',
      // Автоповтор загрузки ядра: перебираем зеркала по кругу с растущей задержкой.
      // Уже скачанное ядро браузер берёт из кэша мгновенно; при сбое сети пробуем снова.
      '      var bases=[' + JSON.stringify(base) + ',"https://static.emulatorjs.org/stable/data/"];',
      '      if(bases[0]===bases[1]){bases.pop();}',
      '      var attempt=0;var MAX=8;',
      '      var loadAttempt=function(){',
      '        if(attempt>=MAX){showErr("Не удалось загрузить ядро после "+MAX+" попыток. Проверьте интернет и обновите страницу.");return;}',
      '        var b=bases[attempt%bases.length];',
      '        window.EJS_pathtodata=b;',
      '        try{parent.postMessage({type:"ejs-retrying",attempt:attempt+1,round:Math.floor(attempt/bases.length)+1},"*");}catch(e){}',
      '        var s=document.createElement("script");',
      '        s.src=b+"loader.js?r="+attempt;',
      '        s.onerror=function(){attempt++;setTimeout(loadAttempt,Math.min(4000,800*attempt));};',
      '        document.body.appendChild(s);',
      '      };',
      '      loadAttempt();',    '    }catch(err){showErr("Ошибка запуска: "+err);}',
    '    return;',
    '  }',
    '  if(d.type==="pause"){',
    '    wantPaused=!!d.paused;',
    '    if(gm()){doPause(wantPaused);}',
    '    return;',
    '  }',
    // кадр для трансляции: отвечаем даже если ядро ещё не готово (иначе запрос повиснет)
    '  if(d.type==="get-frame"){',
    '    var send2=function(out){try{parent.postMessage({type:"ejs-frame",state:out,reqId:d.reqId},"*");}catch(e){}};',
    '    var cv=document.querySelector("#game canvas");',
    '    if(!cv){send2(null);return;}',
    '    try{',
    '      var w=cv.width||320,h=cv.height||240,k=Math.min(1,320/Math.max(1,w));',
    '      var c2=document.createElement("canvas");c2.width=Math.max(1,Math.round(w*k));c2.height=Math.max(1,Math.round(h*k));',
    '      c2.getContext("2d").drawImage(cv,0,0,c2.width,c2.height);',
    '      send2(c2.toDataURL("image/jpeg",0.5));',
    '    }catch(err){send2(null);}',
    '    return;',
    '  }',
    '  var g=gm();',
    '  if(!g)return;',
    '  try{',
    '    if(d.type==="get-state"){',
    '      var r=g.getState();',
    '      var send=function(s){var out=null;if(typeof s==="string"){out=s;}else if(s&&s.length!==undefined){out=b64(s);}parent.postMessage({type:"ejs-state",state:out,reqId:d.reqId},"*");};',
    '      if(r&&typeof r.then==="function"){r.then(send,function(){send(null);});}else{send(r);}',
    '    }',
    '  }catch(err){parent.postMessage({type:"ejs-error"},"*");}',
    '});',
    // «hello-насос»: повторяем приветствие, пока хост не пришлёт boot —
    // страхует от гонки, если слушатель сообщений добавился чуть позже
    '(function(){var n=0;',
    'function h(){try{parent.postMessage({type:"ejs-hello"},"*");}catch(e){}}',
    'h();',
    'var iv=setInterval(function(){',
    '  n++;',
    '  if(booted||n>20){clearInterval(iv);return;}',
    '  h();',
    '},250);',
    '})();',
    '</script>',
    '</body></html>',
  ].join('\n');
}
