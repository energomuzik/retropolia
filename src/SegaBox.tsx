import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './store';
import { DEFAULT_GPAD, DEFAULT_SEGA_GPAD, NES_TO_RETRO, SEGA_TO_RETRO } from './input';

const CDN_DATA = 'https://cdn.emulatorjs.org/stable/data/';

export interface SegaApi {
  snapshot: () => Promise<string | null>; // base64-состояние ядра (живое, без перезапуска)
  /** Перезапуск ядра с применением сохранения (null = старт с начала).
   *  Использует документированный EJS_loadStateURL — гарантированно работает. */
  loadSaveReliable: (b64: string | null) => void;
  pause: (p: boolean) => void; // живая пауза (без перезапуска)
  /** Снимок текущего кадра (dataURL jpeg) для трансляции соперникам. */
  captureFrame: () => Promise<string | null>;
  /** Открыть встроенное меню настроек EmulatorJS (клавиатура + геймпад). */
  openSettings: () => void;
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
  core,
  initialState,
  paused,
  pausedHint,
  onApi,
  onSettingsFail,
  remapSpec,
  chaos,
}: {
  romData: ArrayBuffer;
  ext: string;
  /** Ядро EmulatorJS напрямую ('nes', 'segaMD'…). Если не задано — выбирается по расширению файла. */
  core?: string;
  initialState?: string | null;
  paused?: boolean;
  pausedHint?: string;
  onApi?: (api: SegaApi) => void;
  /** Вызывается, если встроенное меню настроек не удалось открыть программно. */
  onSettingsFail?: () => void;
  /** Пользовательская раскладка: для каждой кнопки — индекс RetroPad и выбранная
   *  клавиша (e.key, нижний регистр). Применяется слоем переназначения, не трогая
   *  внутренние настройки ядра. */
  remapSpec?: { idx: number; key: string }[];
  /** Активные пакости (ChaosKind): искажения картинки/скорости/ввода. */
  chaos?: string[];
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onSettingsFailRef = useRef(onSettingsFail);
  onSettingsFailRef.current = onSettingsFail;
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

  const resolvedCore = core ?? coreFor(ext);
  const coreLabel =
    resolvedCore === 'nes' ? 'NES'
    : resolvedCore === 'segaMS' ? 'SEGA MASTER SYSTEM'
    : resolvedCore === 'segaGG' ? 'SEGA GAME GEAR'
    : 'SEGA';

  // Документ iframe строится СИНХРОННО — iframe получает srcDoc уже при первом
  // рендере (нет состояния «html ещё null»). nonce гарантирует уникальность строки
  // при каждом rebuild, bootStateRef «впекается» как EJS_loadStateURL.
  const remapJson = JSON.stringify(remapSpec ?? []);
  const remapJsonRef = useRef(remapJson);
  remapJsonRef.current = remapJson;
  const chaosJson = JSON.stringify(chaos ?? []);
  const chaosJsonRef = useRef(chaosJson);
  chaosJsonRef.current = chaosJson;

  const html = useMemo(() => {
    const opts = useApp.getState().options;
    const volume = opts.emuSound ? Math.max(0, Math.min(1, opts.emuVolume ?? 1)) : 0;
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return buildHtml(resolvedCore, volume, CDN_DATA, bootStateRef.current, nonce, remapJsonRef.current, chaosJsonRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedCore, romData, bootTick]);

  // живое применение пакостей — без перезапуска ядра
  useEffect(() => {
    if (status !== 'ready') return;
    try { frameRef.current?.contentWindow?.postMessage({ type: 'set-chaos', list: chaos ?? [] }, '*'); } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaosJson, status]);

  // живое обновление раскладки — без перезапуска ядра.
  // Первая отправка (при старте) — молча; последующие — по сохранению в редакторе,
  // поэтому по их результату показываем уведомление.
  const remapSentRef = useRef(false);
  const announceRef = useRef(false);
  useEffect(() => {
    if (status !== 'ready') return;
    if (remapSentRef.current) announceRef.current = true;
    remapSentRef.current = true;
    try { frameRef.current?.contentWindow?.postMessage({ type: 'set-remap-spec', spec: remapSpec ?? [] }, '*'); } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remapJson, status]);

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
      } else if (d.type === 'ejs-remap-status') {
        const rs = d as { direct?: number; rewrite?: number };
        const applied = (rs.direct ?? 0) + (rs.rewrite ?? 0);
        if (announceRef.current) {
          announceRef.current = false;
          useApp.getState().toast(
            applied > 0 ? `Раскладка применена (${applied} кнопок)` : 'Не удалось применить раскладку — попробуйте другие клавиши',
            applied > 0 ? 'ok' : 'err',
          );
        }
      } else if (d.type === 'ejs-controls-live') {
        const ok = !!(d as { ok?: boolean }).ok;
        useApp.getState().toast(
          ok ? 'Раскладка применена' : 'Раскладка сохранена — полностью применится при следующем запуске эмулятора',
          ok ? 'ok' : 'info',
        );
      } else if (d.type === 'ejs-settings-failed') {
        onSettingsFailRef.current?.();
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
      openSettings: () => {
        try { frameRef.current?.contentWindow?.postMessage({ type: 'open-settings' }, '*'); } catch { /* noop */ }
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
            ЗАГРУЗКА ЯДРА {coreLabel}{loadAttempt > 1 ? `… ПОПЫТКА ${loadAttempt}` : '…'}
          </span>
          <span className="text-[11px] text-dim px-6 text-center max-w-sm">
            {loadAttempt > 1
              ? 'Сеть нестабильна — пробуем другое зеркало. Ядро скачается автоматически.'
              : `Первый запуск ${coreLabel}-рома скачивает ядро с CDN (один раз) — дальше браузер берёт его из кэша.`}
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
            Для первого запуска нужен интернет — ядро {coreLabel} берётся с CDN emulatorjs.org
            (один раз, дальше из кэша браузера). Проверьте соединение и перезапустите ром.
          </span>
        </div>
      )}
      <div className="absolute bottom-1 right-2 font-pixel text-[7px] text-[rgba(233,236,255,0.35)] z-10">
        {resolvedCore === 'nes' ? 'FCEUMM · EMULATORJS' : 'GENESIS PLUS GX'}
      </div>
    </div>
  );
}

function buildHtml(core: string, volume: number, base: string, bootStateB64: string | null, nonce: string, remapJson: string, chaosJson: string): string {
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
    // Слой переназначения клавиш: перехватывает нажатия ДО обработчика ядра и
    // подменяет клавишу игрока на ту, которую ожидает ядро (её ключи читаются из
    // EJS_emulator.controls при готовности — не трогаем внутренние настройки,
    // поэтому загрузка ядра не может сломаться).
    `var remapSpec=${remapJson};`,
    // Геймпад: физическая кнопка (W3C-индекс из наших настроек) → действие → RetroPad-индекс ядра.
    // simulateInput принимает ИМЕННО RetroPad-индекс действия (4=вверх, 0=B…), а не номер кнопки падка.
    `var PAD_ACTION_TO_RETRO=${JSON.stringify(core === 'nes' ? NES_TO_RETRO : SEGA_TO_RETRO)};`,
    `var PAD_DEFAULT=${JSON.stringify(core === 'nes' ? DEFAULT_GPAD : DEFAULT_SEGA_GPAD)};`,
    `var PAD_FIELD=${JSON.stringify(core === 'nes' ? 'gpad' : 'segaPad')};`,
    // Фиксированный порядок действий — им разрешается конфликт «несколько действий
    // на одном физическом индексе» (первый по списку забирает кнопку себе)
    `var PAD_ORDER=${JSON.stringify(Object.keys(core === 'nes' ? NES_TO_RETRO : SEGA_TO_RETRO))};`,
    'var keyToIdx={};',
    'var suppressKeys={};',
    // Пакости: активный список + единый путь ввода (инверсия крестовины + задержка кнопок)
    `var CHAOS={list:${chaosJson},invert:0,lag:0};`,
    'var lastSent={};',
    'var inputQueue=[];',
    'function invertIdx(idx){if(!CHAOS.invert)return idx;if(idx===4)return 5;if(idx===5)return 4;if(idx===6)return 7;if(idx===7)return 6;return idx;}',
    'function rawSend(idx,pressed){try{var g=window.EJS_emulator&&window.EJS_emulator.gameManager;if(g&&typeof g.simulateInput==="function"){g.simulateInput(0,idx,pressed?1:0);return true;}}catch(e){}return false;}',
    'function sendInput(idx,pressed){',
    '  idx=invertIdx(idx);',
    '  if(lastSent[idx]===pressed){return;}',
    '  lastSent[idx]=pressed;',
    '  if(CHAOS.lag>0){inputQueue.push({idx:idx,val:pressed?1:0,due:Date.now()+CHAOS.lag});return;}',
    '  rawSend(idx,pressed);',
    '}',
    'function flushAll(){',
    '  inputQueue.length=0;',
    '  for(var k in lastSent){if(lastSent[k]){rawSend(Number(k),0);}}',
    '  lastSent={};',
    '}',
    // отложенная доставка очереди (пакость «задержка кнопок»); недоставленное держим до 2 с
    'setInterval(function(){',
    '  if(!inputQueue.length){return;}',
    '  var now=Date.now();var keep=[];',
    '  for(var i=0;i<inputQueue.length;i++){',
    '    var it=inputQueue[i];',
    '    if(it.due>now){keep.push(it);continue;}',
    '    if(rawSend(it.idx,it.val)){lastSent[it.idx]=!!it.val;}',
    '    else if(now-it.due<2000){keep.push(it);}',
    '  }',
    '  inputQueue=keep;',
    '},15);',
    'function simBtn(idx,pressed){try{var g=window.EJS_emulator&&window.EJS_emulator.gameManager;if(g&&typeof g.simulateInput==="function"){g.simulateInput(0,idx,pressed?1:0);return true;}}catch(e){}return false;}',
    // e.key (нижний регистр) -> e.code
    'function codeOf(k){',
    '  if(!k){return "";}',
    '  k=String(k).toLowerCase();',
    '  if(k==="arrowup"){return "ArrowUp";}',
    '  if(k==="arrowdown"){return "ArrowDown";}',
    '  if(k==="arrowleft"){return "ArrowLeft";}',
    '  if(k==="arrowright"){return "ArrowRight";}',
    '  if(k==="enter"){return "Enter";}',
    '  if(k===" "||k==="space"){return "Space";}',
    '  if(k==="shift"){return "ShiftLeft";}',
    '  if(k==="control"){return "ControlLeft";}',
    '  if(k==="alt"){return "AltLeft";}',
    '  if(k==="backspace"){return "Backspace";}',
    '  if(k==="tab"){return "Tab";}',
    '  if(k.length===1){',
    '    var cc=k.charCodeAt(0);',
    '    if(cc>=97&&cc<=122){return "Key"+k.toUpperCase();}',
    '    if(cc>=48&&cc<=57){return "Digit"+k;}',
    '  }',
    '  return "";',
    '}',
    'function keyCodeOf(k){',
    '  var c=codeOf(k);',
    '  if(c==="ArrowLeft"){return 37;} if(c==="ArrowUp"){return 38;}',
    '  if(c==="ArrowRight"){return 39;} if(c==="ArrowDown"){return 40;}',
    '  if(c==="Enter"){return 13;} if(c==="Space"){return 32;}',
    '  if(c==="ShiftLeft"){return 16;} if(c==="ControlLeft"){return 17;}',
    '  if(c==="AltLeft"){return 18;} if(c==="Backspace"){return 8;} if(c==="Tab"){return 9;}',
    '  if(c.indexOf("Key")===0){return c.charCodeAt(3);}',
    '  if(c.indexOf("Digit")===0){return Number(c.slice(5));}',
    '  return 0;',
    '}',
    // Ищем живой объект раскладок игрока 0 во всех возможных местах
    'function findControls(){',
    '  try{',
    '    var e=window.EJS_emulator;',
    '    if(!e){return null;}',
    '    var list=[e.controls,e.settings&&e.settings.controls,e.gameManager&&e.gameManager.controls];',
    '    for(var i=0;i<list.length;i++){',
    '      var c=list[i];',
    '      if(!c){continue;}',
    '      var p=c[0]||c["0"];',
    '      if(p&&(p[0]||p["0"]||p[3]||p["3"]||p[4]||p["4"]||p[8]||p["8"])){return p;}',
    '    }',
    '  }catch(err){}',
    '  return null;',
    '}',
    // ЖЁСТКОЕ отключение родного геймпада ядра: (1) пустой gamepadSelection —
    // его обработчик gamepadEvent сразу выходит; (2) ВСЕ value2 (метки/индексы
    // родных привязок: BUTTON_*, DPAD_*, стики) во всех игроках — в "".
    // ВАЖНО: у EmulatorJS buttonLabels сдвинуты на 1 (физическая кнопка 0 =
    // метка BUTTON_1), поэтому родные дефолты НЕ СОВПАДАЮТ с нашей раскладкой
    // и при «оживании» жмут чужие кнопки. Вызывается регулярно: настройки ядра
    // могли пересоздать объект controls (Reset) и оживить свои дефолты.
    'function silenceCoreGamepad(){',
    '  try{',
    '    var e=window.EJS_emulator;',
    '    if(!e){return;}',
    '    if(e.gamepadSelection&&e.gamepadSelection.length){e.gamepadSelection.length=0;}',
    '    var objs=[e.controls,e.settings&&e.settings.controls,e.gameManager&&e.gameManager.controls];',
    '    for(var oi=0;oi<objs.length;oi++){',
    '      var oc=objs[oi];',
    '      if(!oc){continue;}',
    '      for(var pi=0;pi<4;pi++){',
    '        var op=oc[pi]||oc[String(pi)];',
    '        if(!op){continue;}',
    '        for(var ri=0;ri<30;ri++){',
    '          var oe=op[ri]||op[String(ri)];',
    '          if(oe&&oe.value2!==undefined&&oe.value2!==""){oe.value2="";}',
    '        }',
    '      }',
    '    }',
    '  }catch(err){}',
    '}',
    'setInterval(silenceCoreGamepad,2000);',
    // -------- ПАКОСТИ: искажения картинки, шторки, скорость (set-chaos) --------
    'function chaosFx(){',
    '  var out={filter:"",flip:false,mirror:false,side:"",pct:0};',
    '  for(var i=0;i<CHAOS.list.length;i++){',
    '    var k=CHAOS.list[i];',
    '    if(k==="grayscale")out.filter+=" grayscale(1)";',
    '    else if(k==="blur")out.filter+=" blur(3px)";',
    '    else if(k==="flip")out.flip=true;',
    '    else if(k==="mirror")out.mirror=true;',
    '    else{var m=/^curtain(Top|Bottom|Left|Right)(\\d+)$/.exec(k);if(m){out.side=m[1];out.pct=Number(m[2]);}}',
    '  }',
    '  return out;',
    '}',
    'function applyChaos(){',
    '  try{',
    '    var fx=chaosFx();',
    '    var cv=document.querySelector("#game canvas");',
    '    if(cv){cv.style.filter=fx.filter.trim();var tr=(fx.flip?" rotate(180deg)":"")+(fx.mirror?" scaleX(-1)":"");cv.style.transform=tr.trim();}',
    '    var host=document.getElementById("game");',
    '    var cur=document.getElementById("chaos-curtain");',
    '    if(fx.side&&!cur&&host){cur=document.createElement("div");cur.id="chaos-curtain";cur.style.cssText="position:absolute;background:#000;z-index:40;pointer-events:none";host.appendChild(cur);}',
    '    if(cur){',
    '      if(!fx.side){cur.style.display="none";}',
    '      else{',
    '        cur.style.display="block";cur.style.top="0";cur.style.left="0";cur.style.right="auto";cur.style.bottom="auto";',
    '        if(fx.side==="Top"){cur.style.width="100%";cur.style.height=fx.pct+"%";}',
    '        else if(fx.side==="Bottom"){cur.style.width="100%";cur.style.height=fx.pct+"%";cur.style.top="auto";cur.style.bottom="0";}',
    '        else if(fx.side==="Left"){cur.style.width=fx.pct+"%";cur.style.height="100%";}',
    '        else{cur.style.width=fx.pct+"%";cur.style.height="100%";cur.style.left="auto";cur.style.right="0";}',
    '      }',
    '    }',
    '    var g=window.EJS_emulator&&window.EJS_emulator.gameManager;',
    '    if(g){',
    '      var ff=0;',
    '      if(CHAOS.list.indexOf("speed150")>=0)ff=1.5;',
    '      else if(CHAOS.list.indexOf("speed200")>=0)ff=2;',
    '      else if(CHAOS.list.indexOf("speed300")>=0)ff=3;',
    '      var sl=CHAOS.list.indexOf("pal50")>=0;',
    '      try{if(typeof g.setFastForwardRatio==="function"&&typeof g.toggleFastForward==="function"){g.setFastForwardRatio(ff);g.toggleFastForward(ff?1:0);}}catch(e){}',
    '      try{if(typeof g.setSlowMotionRatio==="function"&&typeof g.toggleSlowMotion==="function"){g.setSlowMotionRatio(sl?1.2:1);g.toggleSlowMotion(sl?1:0);}}catch(e){}',
    '    }',
    '    CHAOS.invert=CHAOS.list.indexOf("invertPad")>=0?1:0;',
    '    CHAOS.lag=CHAOS.list.indexOf("lagButtons")>=0?400:0;',
    '  }catch(e){}',
    '}',
    'setInterval(applyChaos,2000);',
    // Применение раскладки: стратегия 1 — прямая правка объекта ядра;',
    // стратегия 2 (для непокрытых кнопок) — перехват событий.
    'function buildKeyMap(){',
    '  keyToIdx={};suppressKeys={};var n=0;',
    '  for(var i=0;i<remapSpec.length;i++){',
    '    var it=remapSpec[i];',
    '    var k=String(it.key||"").toLowerCase();',
    '    if(k&&(it.idx!==undefined&&it.idx!==null)){keyToIdx[k]=it.idx;var c=codeOf(k);if(c){keyToIdx[c.toLowerCase()]=it.idx;}n++;}',
    '  }',
    // читаем встроенные привязки ядра: для переназначенных кнопок запоминаем их
    // ПРЕЖНИЕ клавиши, чтобы глушить их и они не срабатывали наравне с новыми
    '  try{',
    '    var ctrl=findControls();',
    '    if(ctrl){',
    '      for(var j=0;j<remapSpec.length;j++){',
    '        var it2=remapSpec[j];',
    '        var entry=ctrl[it2.idx]||ctrl[String(it2.idx)];',
    '        var ck=entry&&(entry.value||entry.value2);',
    '        if(ck){',
    '          var ckl=String(ck).toLowerCase();',
    '          var uk=String(it2.key||"").toLowerCase();',
    '          if(ckl!==uk&&keyToIdx[ckl]===undefined){suppressKeys[ckl]=1;var cc=codeOf(ckl);if(cc){suppressKeys[cc.toLowerCase()]=1;}}',
    '        }',
    '      }',
    '    }',
    '  }catch(err3){}',
    // Глушим РОДНЫЕ геймпад-привязки ядра (все value2 у всех игроков + пустой
    // gamepadSelection) — иначе ядро может параллельно читать пад по своим дефолтам.
    '  silenceCoreGamepad();',
    '  try{parent.postMessage({type:"ejs-remap-status",direct:0,rewrite:n,coreKeys:""},"*");}catch(err2){}',
    '  return n;',
    '}',
    'function remapEvt(ev){',
    '  try{',
    '    var k=(ev.key||"").toLowerCase();',
    '    var cl=(ev.code||"").toLowerCase();',
    // глушим прежние (дефолтные) клавиши переназначенных кнопок
    '    if(suppressKeys[k]||suppressKeys[cl]){ev.preventDefault();if(ev.stopImmediatePropagation){ev.stopImmediatePropagation();}return;}',
    '    var g=window.EJS_emulator&&window.EJS_emulator.gameManager;',
    '    if(!g||typeof g.simulateInput!=="function"){return;}',
    '    var idx=keyToIdx[k];',
    '    if(idx===undefined){idx=keyToIdx[cl];}',
    '    if(idx===undefined){return;}',
    '    sendInput(idx,ev.type==="keydown");',
    '    ev.preventDefault();',
    '    if(ev.stopImmediatePropagation){ev.stopImmediatePropagation();}',
    '  }catch(err){}',
    '}',
    'window.addEventListener("keydown",remapEvt,true);',
    'window.addEventListener("keyup",remapEvt,true);',
    // повторные попытки, пока объект раскладок не появится (он создаётся лениво)
    'var remapTries=0;',
    'function remapPump(){',
    '  remapTries++;',
    '  var applied=buildKeyMap();',
    '  if(applied<remapSpec.length&&remapTries<12){setTimeout(remapPump,500);}',
    '}',
    `window.EJS_pathtodata=${JSON.stringify(base)};`,
    'window.EJS_language="ru";',
    'window.EJS_backgroundText="";',
    'window.EJS_backgroundColor="#0b0e1c";',
    'window.EJS_color="#ffcf3f";',
    `window.EJS_volume=${volume};`,
    'window.EJS_startOnLoaded=true;',
    'window.EJS_askBeforeExit=false;',
    'window.EJS_Buttons={playPause:false,restart:false,mute:false,settings:true,fullscreen:false,saveState:false,loadState:false,screenRecord:false,gamepad:false,cheat:false,volume:false,saveSavFiles:false,loadSavFiles:false,quickSave:false,quickLoad:false,screenshot:false,cacheManager:false,exitEmulation:false};',
    'var booted=false;',
    'var wantPaused=false;',
    'var readyAt=0;',
    'function gm(){return window.EJS_emulator&&window.EJS_emulator.gameManager;}',
    // Открыть встроенное меню настроек EmulatorJS (клавиатура + геймпад).
    // Имя метода differs по версиям — перебираем кандидаты, затем кликаем по
    // шестерёнке тулбара в DOM; если ничего не помогло — сообщаем хосту.
    'function openSettings(){',
    '  var ok=false;',
    '  try{',
    '    var e=window.EJS_emulator;',
    '    if(e){',
    '      var names=["openSettings","showSettings","openControlSettings","openControlsMenu","openMenu"];',
    '      for(var i=0;i<names.length&&!ok;i++){',
    '        var m=e[names[i]];',
    '        if(typeof m==="function"){m.call(e);ok=true;}',
    '        else if(m&&typeof m==="object"&&typeof m.open==="function"){m.open();ok=true;}',
    '      }',
    '      if(!ok&&e.gameManager){',
    '        for(var j=0;j<names.length&&!ok;j++){',
    '          var g2=e.gameManager[names[j]];',
    '          if(typeof g2==="function"){g2.call(e.gameManager);ok=true;}',
    '          else if(g2&&typeof g2==="object"&&typeof g2.open==="function"){g2.open();ok=true;}',
    '        }',
    '      }',
    '      if(!ok){var sb=e.settingsBtn||e.settingsButton;if(sb&&typeof sb.click==="function"){sb.click();ok=true;}}',
    '    }',
    '    if(!ok){',
    '      var all=document.querySelectorAll("button,div,span,a");',
    '      for(var k=0;k<all.length;k++){',
    '        var el=all[k];var cn=el.className;',
    '        if(cn&&cn.baseVal!==undefined){cn=cn.baseVal;}',
    '        if(typeof cn==="string"&&cn.toLowerCase().indexOf("setting")!==-1){el.click();ok=true;break;}',
    '      }',
    '    }',
    '  }catch(err){}',
    '  try{parent.postMessage({type:ok?"ejs-settings-opened":"ejs-settings-failed"},"*");}catch(err2){}',
    '}',
    'function b64(u8){var bin="";for(var i=0;i<u8.length;i+=32768){bin+=String.fromCharCode.apply(null,u8.subarray(i,i+32768));}return btoa(bin);}',
    'function b64ToU8(b){var bin=atob(b);var u8=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++){u8[i]=bin.charCodeAt(i);}return u8;}',
    'function showErr(t){var el=document.getElementById("err");el.textContent=t;el.style.display="block";try{parent.postMessage({type:"ejs-error"},"*");}catch(e){}}',
    // страховка: любые ошибки исполнения внутри эмулятора показываем на экране,
    // чтобы поломка не выглядела как бесконечная загрузка
    'window.onerror=function(m){try{showErr("Ошибка эмулятора: "+m);}catch(e){}};',

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

    'window.EJS_ready=function(){readyAt=Date.now();remapTries=0;remapPump();applyChaos();try{parent.postMessage({type:"ejs-ready"},"*");}catch(e){}};',

    'window.addEventListener("message",function(e){',
    '  var d=e.data||{};',
    '  if(d.type==="set-remap-spec"){remapSpec=d.spec||[];remapTries=0;remapPump();return;}',
    '  if(d.type==="set-chaos"){CHAOS.list=Array.isArray(d.list)?d.list:[];applyChaos();return;}',
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
    '  if(d.type==="open-settings"){openSettings();return;}',
    // кадр для трансляции: отвечаем даже если ядро ещё не готово (иначе запрос повиснет)
    '  if(d.type==="get-frame"){',
    '    var send2=function(out){try{parent.postMessage({type:"ejs-frame",state:out,reqId:d.reqId},"*");}catch(e){}};',
    '    var cv=document.querySelector("#game canvas");',
    '    if(!cv){send2(null);return;}',
    '    try{',
    '      var w=cv.width||320,h=cv.height||240,k=Math.min(1,320/Math.max(1,w));',
    '      var c2=document.createElement("canvas");c2.width=Math.max(1,Math.round(w*k));c2.height=Math.max(1,Math.round(h*k));',
    '      var x2=c2.getContext("2d");',
    // пакости отражаются и в трансляции: фильтры/переворот/зеркало/шторка рисуются на кадре
    '      var fx2=chaosFx();',
    '      if(fx2.filter)x2.filter=fx2.filter.trim();',
    '      if(fx2.flip||fx2.mirror){',
    '        x2.translate(c2.width/2,c2.height/2);',
    '        if(fx2.flip)x2.rotate(Math.PI);',
    '        if(fx2.mirror)x2.scale(-1,1);',
    '        x2.drawImage(cv,-c2.width/2,-c2.height/2,c2.width,c2.height);',
    '      }else{x2.drawImage(cv,0,0,c2.width,c2.height);}',
    '      if(fx2.side&&fx2.pct){x2.fillStyle="#000";',
    '        if(fx2.side==="Top")x2.fillRect(0,0,c2.width,c2.height*fx2.pct/100);',
    '        else if(fx2.side==="Bottom")x2.fillRect(0,c2.height*(1-fx2.pct/100),c2.width,c2.height*fx2.pct/100);',
    '        else if(fx2.side==="Left")x2.fillRect(0,0,c2.width*fx2.pct/100,c2.height);',
    '        else x2.fillRect(c2.width*(1-fx2.pct/100),0,c2.width*fx2.pct/100,c2.height);}',
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
    // -------- ОПРОС ГЕЙМПАДА: читаем navigator.getGamepads() в requestAnimationFrame.
    // Физическая кнопка (W3C-индекс из настроек игрока) → действие → RetroPad-индекс ядра.
    // ГЛАВНОЕ: ОДИН физический индекс = ровно ОДНО действие (первый по PAD_ORDER),
    // поэтому даже испорченная раскладка не может нажать две игровые кнопки разом.
    // Крестовина дублируется ЛЕВЫМ СТИКОМ (крестовина и стик — одно действие, не дублируются),
    // события шлются только при ИЗМЕНЕНИИ состояния (edge-trigger, без «залипаний»),
    // а при уходе фокуса/скрытии вкладки всё зажатое отпускается принудительно.
    // Родные геймпад-привязки ядра глушатся silenceCoreGamepad() (см. выше).
    '(function(){',
    'var prevPressed={};',
    'function getPadPrefs(){',
    '  try{',
    '    var raw=localStorage.getItem("retropolia-emu-prefs");',
    '    if(raw){var p=JSON.parse(raw);if(p&&p[PAD_FIELD])return p[PAD_FIELD];}',
    '  }catch(e){}',
    '  return PAD_DEFAULT;',
    '}',
    'function gm(){var e=window.EJS_emulator;return e&&e.gameManager&&typeof e.gameManager.simulateInput==="function"?e.gameManager:null;}',
    'function releaseAll(){',
    '  for(var act in prevPressed){',
    '    var r=PAD_ACTION_TO_RETRO[act];',
    '    if(prevPressed[act]&&r!==undefined&&r!==null){sendInput(r,false);}',
    '  }',
    '  prevPressed={};',
    '}',
    'function pumpGamepad(){',
    '  var g=gm();',
    '  if(!g){requestAnimationFrame(pumpGamepad);return;}',
    '  var pads;',
    '  try{pads=navigator.getGamepads?navigator.getGamepads():[];}catch(e){pads=[];}',
    '  var gp=null;',
    '  for(var i=0;i<pads.length;i++){if(pads[i]&&pads[i].connected){gp=pads[i];break;}}',
    '  if(!gp){releaseAll();requestAnimationFrame(pumpGamepad);return;}',
    '  var prefs=getPadPrefs();',
    '  var buttons=gp.buttons||[];',
    '  var ax=gp.axes||[],sx=ax[0]||0,sy=ax[1]||0;',
    // 1) физический индекс → действие; дубликат индекса молча игнорируется
    '  var physToAct={};',
    '  for(var n=0;n<PAD_ORDER.length;n++){',
    '    var act=PAD_ORDER[n];',
    '    var phys=prefs?prefs[act]:null;',
    '    if(phys===undefined||phys===null){continue;}',
    '    phys=Number(phys);',
    '    if(phys>=0&&phys<buttons.length&&physToAct[phys]===undefined){physToAct[phys]=act;}',
    '  }',
    // 2) нажатия этого кадра: кнопки + стик (крестовина и стик = одно и то же действие)
    '  var pressedNow={};',
    '  for(var p in physToAct){',
    '    var b=buttons[p];',
    '    var val=(typeof b==="object")?b.value:b;',
    '    if((val!==undefined&&val!==null&&val>0.5)||val===true){pressedNow[physToAct[p]]=true;}',
    '  }',
    '  if(sy<-0.5){pressedNow.UP=true;}else if(sy>0.5){pressedNow.DOWN=true;}',
    '  if(sx<-0.5){pressedNow.LEFT=true;}else if(sx>0.5){pressedNow.RIGHT=true;}',
    // 3) шлём только изменения состояния — никаких повторов и залипаний
    '  for(var act2 in PAD_ACTION_TO_RETRO){',
    '    var retroIdx=PAD_ACTION_TO_RETRO[act2];',
    '    if(retroIdx===undefined||retroIdx===null){continue;}',
    '    var pressed=!!pressedNow[act2];',
    '    var was=!!prevPressed[act2];',
    '    if(pressed&&!was){sendInput(retroIdx,true);}',
    '    else if(!pressed&&was){sendInput(retroIdx,false);}',
    '  }',
    '  prevPressed=pressedNow;',
    '  requestAnimationFrame(pumpGamepad);',
    '}',
    'try{window.addEventListener("blur",function(){releaseAll();flushAll();});}catch(e){}',
    'try{document.addEventListener("visibilitychange",function(){if(document.hidden){releaseAll();flushAll();}});}catch(e){}',
    'pumpGamepad();',
    '})();',
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
