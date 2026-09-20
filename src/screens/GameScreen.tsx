import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, getRomData, useBlobImage } from '../store';
import { dispatch, streamBus, type StreamPacket } from '../useGame';
import { CELL, cellAtPoint, cellCenter, drawBoard, drawRubgOverlay, fitView, mapSize, smoothPxPerFrame, jumpFrameFactor, DEF_MOVE_SPEED, clampMoveSpeed } from '../render';
import { cellTaskOf, fmtClock, spentInfo } from '../engine';
import { effectLabel } from './TaskEditor';
import { cardArt, cartridgeArt } from '../assets';
import SegaBox, { type SegaApi } from '../SegaBox';
import KeyBinder from '../KeyBinder';
import {
  loadEmuPrefs, PREFS_EVENT, codeToEjsKey, listGamepads,
  PAD_ACTIONS, SEGA_ACTIONS,
  NES_TO_RETRO, SEGA_TO_RETRO,
} from '../input';
import { saveSessionSnapshot } from './Lobby';
import QuizOverlay from './QuizOverlay';
import { AnimPreview, EmuVolumeChip, Field, GhostBtn, Ic, Modal, PxBtn, Stepper } from '../ui';
import { PLAYER_COLORS, SKIP_COST, SKIP_COINS_DEFAULT, SKILL_TURNS, CHAOS_LIST, chaosLabel, JOY_LIST, SAVE_KIND_LABEL, saveKindOf, isJourneyLike, tileAt, tileRectOf, tileNumOf, coinsShort, coinsStr, RUBG_ITEMS, RUBG_ZONE_PHASES, RUBG_STOP_CD, RUBG_STEAL_RANGE, RUBG_HP_MAX, RUBG_WIN_HP, RUBG_LOSE_HP } from '../types';
import type { AnimClip, CardDef, ChaosKind, GameMap, PortalZone, TaskDef, TokenDir, RubgItem } from '../types';
import Randomizer from './Randomizer';
import { idbGet } from '../db';
import { sfx } from '../sound';
import { startLoop, stopLoop, syncLoops, stopGroup, killGroup, stopOneShot, playOneShot } from '../loopsnd';

/* единичные векторы направлений фишки — для расчёта хода чужой фишки со СКОРОСТЬЮ КАРТЫ */
const DIRV: Record<TokenDir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/* НЕВИДИМЫЕ СТЕНЫ (JOURNEY): точка (центр фишки) внутри прямоугольника стены?
   Стены в игре НЕ рисуются — фишка просто не проходит сквозь них, скользя по краю. */
const inWall = (m: GameMap, x: number, y: number): boolean =>
  (m.walls ?? []).some((w) => x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h);

export default function GameScreen() {
  const st = useApp();
  const { session: s, sessionMap: map, selfId: me, options, room } = st;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // единый API эмулятора EmulatorJS (и NES, и SEGA)
  const ejsApiRef = useRef<SegaApi | null>(null);

  const [viewMode, setViewMode] = useState<'follow' | 'world'>('follow');
  const [peekMap, setPeekMap] = useState(false);
  const [worldZoom, setWorldZoom] = useState(1);
  const worldPanRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const mysteryRef = useRef<Set<number> | undefined>(undefined);
  // осмотр карты своим ходом ДО броска: смещение и зум камеры в режиме слежения
  const lookPanRef = useRef({ x: 0, y: 0 });
  const lookZoomRef = useRef(1);
  const lookDragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const [isFs, setIsFs] = useState(false);
  const emuWrapRef = useRef<HTMLDivElement>(null);
  const prevPeekRef = useRef(false);
  const [shake, setShake] = useState<{ holding: boolean; a: number; b: number }>({ holding: false, a: 1, b: 1 });
  /* «rolling» — кубики крутятся после отпускания кнопки, пока не придёт АВТОРИТЕТНЫЙ
     результат от хоста. Так у всех игроков кубики «останавливаются» одновременно и
     показывают одни и те же числа — никаких расхождений из-за пинга. */
  const [rolling, setRolling] = useState(false);
  const lastRollRef = useRef(0);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
  const [aimItemId, setAimItemId] = useState<string | null>(null); // RUBG: выбранное оружие для атаки
  // осмотр ячейки на карте (клик по ней) — доступен всем, включая зрителей
  const [inspectIdx, setInspectIdx] = useState<number | null>(null);
  // увеличенная трансляция поверх карты (зритель переключается на трансляцию целиком)
  const [streamBig, setStreamBig] = useState(false);
  const inspectDownRef = useRef<{ x: number; y: number } | null>(null);

  /* ---------- жеребьёвка: тряска кубика и автозапуск ---------- */
  const [roShake, setRoShake] = useState(false);
  const [roFace, setRoFace] = useState(6);
  const roShakeIntRef = useRef(0);
  const roStartRef = useRef(0);
  /* roWaiting — отпустили кнопку, но официальное значение ещё не пришло от хоста.
     Пока ждём, кубик продолжает вращаться (не «замирает» на дефолтной шестёрке). */
  const [roWaiting, setRoWaiting] = useState(false);
  const startRoShake = () => {
    if (roShake || roWaiting) return;
    roStartRef.current = Date.now();
    setRoShake(true);
    roShakeIntRef.current = window.setInterval(() => {
      const f = 1 + Math.floor(Math.random() * 6);
      setRoFace(f);
      /* транслируем перемешивание соперникам — они видят, как трясётся кубик */
      room?.send('shake', { from: me, a: f, b: f });
      sfx.dice();
    }, 75);
  };
  const endRoShake = () => {
    if (!roShake) return;
    const holdMs = Date.now() - roStartRef.current;
    setRoShake(false);
    setRoWaiting(true); // кубик докрутится, пока не придёт значение
    sfx.drop();
    dispatch({ t: 'roll', id: me, holdMs });
  };
  /* официальное значение пришло — останавливаем докрутку на нём */
  useEffect(() => {
    if (!roWaiting) return;
    if (s?.rollOffValues?.[me] !== undefined) {
      clearInterval(roShakeIntRef.current);
      setRoWaiting(false);
    }
  }, [roWaiting, s?.rollOffValues, me]);
  /* страховка: если значение так и не пришло — не крутим вечно */
  useEffect(() => {
    if (!roWaiting) return;
    const t = setTimeout(() => { clearInterval(roShakeIntRef.current); setRoWaiting(false); }, 6000);
    return () => clearTimeout(t);
  }, [roWaiting]);
  /* зрители видят тряску кубика жеребьёвки из сетевых сообщений shake.
     Запоминаем последний кадр, чтобы в паузах не «мигала» дефолтная шестёрка. */
  const roRoller = s?.phase === 'rollOff' ? s.players[s.rollOffIdx] : undefined;
  const roRemoteShake = !!st.diceShake && !!roRoller && st.diceShake.from === roRoller.id && st.diceShake.from !== me && Date.now() - st.diceShake.ts < 700;

  const [romBuf, setRomBuf] = useState<ArrayBuffer | null>(null);
  const [saveState, setSaveState] = useState<unknown>(null);
  const [emuKey, setEmuKey] = useState(0);
  const [stream, setStream] = useState<StreamPacket | null>(null);
  const [, setTick] = useState(0);
  const [tplOpen, setTplOpen] = useState(false);

  const viewRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dispRef = useRef<Record<string, { x: number; y: number }>>({});
  const prevDispRef = useRef<Record<string, { x: number; y: number }>>({}); // позиция фишки в прошлом кадре — для направления анимации
  const hopRef = useRef<Record<string, { queue: number[]; last: number; lastDir?: 'up' | 'down' | 'left' | 'right'; speed?: number }>>({});
  const arrivedRef = useRef(0);
  /* игроки, чья фишка СЕЙЧАС идёт со СВОИМ звуком (anim.snd) — вместо «щелчков» шагов */
  const moveSndRef = useRef<Set<string>>(new Set());
  const holdStartRef = useRef(0);
  const shakeIntRef = useRef(0);
  /* ---------- JOURNEY: прямое управление фишкой ----------
    journeyKeys — зажатые направления (клавиши и D-pad), journeySelf —
    локальная позиция СВОЕЙ фишки (мгновенный отклик; хосту — апдейты ~6 раз/с) */
  const journeyKeys = useRef<Set<TokenDir>>(new Set());
  /* tp — обновление несёт прыжок через портал; pinside — зоны порталов, внутри которых
     фишка СЕЙЧАС стоит (вход срабатывает только при переходе снаружи внутрь — без
     повторного срабатывания, пока не выйдешь); snapCam — камера мгновенно за фишкой */
  const journeySelf = useRef<{ x: number; y: number; dir?: TokenDir; moving: boolean; dirty: boolean; lastSent: number; tp?: boolean; pinside: Set<string> } | null>(null);
  const snapCamRef = useRef(false);
  const journeyPress = (d: TokenDir, on: boolean) => { if (on) journeyKeys.current.add(d); else journeyKeys.current.delete(d); };
  /* ---------- FX: разовые анимации-спектакль (5-я/6-я фишки, реакции боссов) ----------
     fxStart — локальный старт клипа (rAF-мс) по id fx С УЧЁТОМ паузы delay;
     звук и fxDone — по ОДНОМУ разу; fxBreak — разбитие ячейки в момент старта клипов */
  const fxStartRef = useRef<Map<string, number>>(new Map());
  const fxDoneSentRef = useRef<Set<string>>(new Set());
  const fxBreakSentRef = useRef<Set<string>>(new Set());
  const fxSndRef = useRef<Set<string>>(new Set());
  const fxSndTimersRef = useRef<number[]>([]); // отложенные звуки fx (старт после паузы)
  /* ЛОКАЛЬНЫЙ момент появления разбитых ячеек — для короткой анимации осколков
     (считаем от своего clock: рассинхрон часов хоста не ломает анимацию) */
  const brokenAtRef = useRef<Record<number, number>>({});
  /* ---------- JOURNEY: стрелки ДЖОЙСТИКА (геймпад) ---------- */
  const journeyPadRef = useRef<Set<TokenDir>>(new Set());
  /* чужие фишки JOURNEY (трансляция): якорь (последняя авторитетная точка), направление,
     флаг «идёт» и точная скорость карты (px/с). Апдейты (~6/с) лишь ПОДТВЕРЖДАЮТ движение */
  const journeyRemote = useRef<Record<string, { ax: number; ay: number; vx: number; vy: number; t: number; dir?: TokenDir; mv: boolean }>>({});

  const mePlayer = s?.players.find((p) => p.id === me);
  const active = s ? s.players[s.turn % s.players.length] : null;
  const myTurn = !!active && active.id === me;
  const ch = s?.challenge ?? null;
  const isJourney = isJourneyLike(map?.mode); // TRIATHLON и одиночный JOURNEY — одна механика свободного хождения
  const isSoloJourney = map?.mode === 'journey1p';
  const isSkill = map?.mode === 'skill';
  /* БЕЗ КАРТЫ: только СТАРЫЕ карты-челленджи v0.36.0 (возможность создавать убрана).
     SKILL CHALLENGE снова играется НА КАРТЕ. */
  const isMapless = !!(map?.mapless);
  /* ---------- RUBG (Retro Ultimate Battle Ground) — «ретро-PUBG» ---------- */
  const isRubg = map?.mode === 'rubg';
  const rubg = s?.rubg;
  const myJob = isRubg && s && rubg ? rubg.jobs?.[me] : undefined;
  const myRubgTask = s && map && myJob !== undefined ? cellTaskOf(s, map, myJob.cellIdx) : null;
  const mySteal = isRubg && rubg ? rubg.steals?.[me] : undefined; // воруется У МЕНЯ из кармана
  const myStealing = isRubg && rubg ? Object.values(rubg.steals ?? {}).find((x) => x.thief === me) : undefined; // я ворую
  const inStealth = !!mePlayer?.stealth;
  const coinsActive = map?.startCoins !== undefined; // монеты включены на карте
  const coinsOnly = coinsActive && !!map?.coinsOnly; // только монеты — время/попытки не предлагаются
  const skipCoinsNeed = Math.max(0, Math.floor(map?.skipCoins ?? SKIP_COINS_DEFAULT)); // цена пропуска в бронзе
  const task = s && map && ch ? cellTaskOf(s, map, ch.cellIdx) : null;
  const activeChaos = task?.chaos ? [task.chaos] : [];
  // «Реверс крестовины»: смена кнопок запрещена, пока задание с этой пакостью идёт
  const controlsLocked = task?.chaos === 'invertPad';
  // «Штраф ×2»: цена пропуска удваивается (10 вместо 5)
  const skipNeed = SKIP_COST * (task?.chaos === 'skipX2' ? 2 : 1);
  const invCount = mePlayer?.inventory?.length ?? 0;
  const incomingTrades = (s?.trades ?? []).filter((o) => o.to === me && (o.status === 'pending' || o.status === 'countered'));
  const taskRom = task ? st.roms.find((r) => r.id === task.romId) : undefined;
  const isSega = !!taskRom && taskRom.ext !== 'nes';

  /* раскладка клавиш для слоя переназначения эмулятора; пересчитывается при
     сохранении в редакторе «Управление» (событие PREFS_EVENT) */
  const [prefsTick, setPrefsTick] = useState(0);
  useEffect(() => {
    const bump = () => setPrefsTick((x) => x + 1);
    window.addEventListener(PREFS_EVENT, bump);
    return () => window.removeEventListener(PREFS_EVENT, bump);
  }, []);
  const remapSpec = useMemo(() => {
    const p = loadEmuPrefs();
    const spec: { idx: number; key: string }[] = [];
    if (isSega) {
      for (const a of SEGA_ACTIONS) {
        const idx = SEGA_TO_RETRO[a];
        const key = (p.segaKeys[a] || '').toLowerCase();
        if (idx !== undefined && key) spec.push({ idx, key });
      }
    } else {
      for (const a of PAD_ACTIONS) {
        const idx = NES_TO_RETRO[a];
        const key = codeToEjsKey(p.keys[a] || '');
        if (idx !== undefined && key) spec.push({ idx, key });
      }
    }
    return spec;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSega, emuKey, prefsTick]);
  const segExt = (taskRom?.fileName.split('.').pop() ?? 'md').toLowerCase();
  const romName = taskRom?.name ?? 'ROM';
  const taskImg = useBlobImage(task?.imageId);
  const cardImg = useBlobImage(s?.pendingCard?.card.imageId);

  /* ---------- загрузка рома и сохранения под челлендж ----------
     Гость сначала смотрит in-memory кэш (полученный по сети от хоста), затем свою
     IndexedDB. Если рома нет нигде — просит хост прислать бинарник (needRom). */
  const romReadyTick = useApp((x) => x.romReadyTick);
  const isHost = !!room?.isHost;
  useEffect(() => {
    let on = true;
    setRomBuf(null);
    setSaveState(null);
    if (!task) return;
    void (async () => {
      const cache = useApp.getState();
      let buf: ArrayBuffer | null = cache.romCache[task.romId] ?? null;
      if (!buf) buf = (await getRomData(task.romId)) ?? null;
      if (!on) return;
      if (!buf) {
        if (!isHost) {
          // рома нет — запрашиваем у хоста; эффект перезапустится по romReadyTick
          room?.send('needRom', { romId: task.romId, saveId: task.saveId });
        } else {
          useApp.getState().toast('Ром не найден в библиотеке — загрузите его в эмуляторе', 'err');
        }
        return;
      }
      const cache2 = useApp.getState();
      const sv = task.saveId
        ? (cache2.saveCache[task.saveId] ?? st.saves.find((x) => x.id === task.saveId)?.state ?? null)
        : null;
      if (!on) return;
      setRomBuf(buf);
      setSaveState(sv);
      setEmuKey((k) => k + 1);
    })();
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch?.cellIdx, s?.challenge?.status === 'choose' ? 0 : 1, romReadyTick, isHost]);

  /* ---------- перезагрузка сохранения (попытка / нарушение) ---------- */
  const reloadId = ch?.reloadId ?? 0;
  useEffect(() => {
    if (reloadId > 0) {
      // и NES, и SEGA теперь на EmulatorJS: перезапуск ядра с сохранением (или с начала)
      ejsApiRef.current?.loadSaveReliable((saveState as string | null) ?? null);
      sfx.alarm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadId]);

  /* ---------- RUBG: загрузка рома ЛИЧНОГО задания (эмулятор у самого игрока) ---------- */
  const [rRomBuf, setRRomBuf] = useState<ArrayBuffer | null>(null);
  const [rSaveState, setRSaveState] = useState<unknown>(null);
  const [rEmuKey, setREmuKey] = useState(0);
  const rRomDef = myRubgTask ? st.roms.find((r) => r.id === myRubgTask.romId) : undefined;
  useEffect(() => {
    let on = true;
    setRRomBuf(null); setRSaveState(null);
    if (!myRubgTask) return;
    void (async () => {
      const cache = useApp.getState();
      let buf: ArrayBuffer | null = cache.romCache[myRubgTask.romId] ?? null;
      if (!buf) buf = (await getRomData(myRubgTask.romId)) ?? null;
      if (!on) return;
      if (!buf) {
        if (!isHost) room?.send('needRom', { romId: myRubgTask.romId, saveId: myRubgTask.saveId });
        return;
      }
      const sv = myRubgTask.saveId
        ? (cache.saveCache[myRubgTask.saveId] ?? st.saves.find((x) => x.id === myRubgTask.saveId)?.state ?? null)
        : null;
      if (!on) return;
      setRRomBuf(buf); setRSaveState(sv); setREmuKey((k) => k + 1);
    })();
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myJob?.cellIdx, romReadyTick]);

  /* ---------- RUBG: локальный тик перерисовки (позиция самолёта, таймер кармана) ---------- */
  useEffect(() => {
    if (!isRubg) return;
    if (s?.phase !== 'rollOff' && !myStealing && !mySteal) return;
    const t = setInterval(() => setTick((x) => x + 1), 120);
    return () => clearInterval(t);
  }, [isRubg, s?.phase, !!myStealing, !!mySteal]);

  /* ---------- трансляция (NES — canvas напрямую, SEGA — снимок кадра из iframe) ---------- */
  const streaming = options.broadcast && myTurn && ch?.status === 'playing';
  const streamMs = Math.round(1000 / Math.min(30, Math.max(2, options.streamFps || 10)));
  useEffect(() => {
    if (!streaming || !room) return;
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return;
      busy = true;
      let data: string | null = null;
      try {
        // и NES, и SEGA теперь в EmulatorJS (iframe) — кадр берётся одинаково
        data = (await ejsApiRef.current?.captureFrame()) ?? null;
      } catch { data = null; }
      busy = false;
      if (data) {
        try { room.send('stream', { from: me, name: mePlayer?.name ?? '?', data, ts: Date.now() } satisfies StreamPacket); } catch { /* noop */ }
      }
    }, streamMs);
    return () => clearInterval(t);
  }, [streaming, streamMs, room, me, mePlayer?.name]);

  useEffect(() => {
    return streamBus.on((p) => {
      if (p.from !== me && options.broadcast) setStream(p);
    });
  }, [me, options.broadcast]);

  /* ---------- ЗВУКИ РАДИУСА у анимаций со звуком ----------
     Триггер — фишка ИГРАЮЩЕГО игрока: вошла в круг (pa.r) — звук играет (фейд-ин),
     вышла — затихает. Слышит только играющий; пока крутится его ЗАДАНИЕ (эмулятор),
     все звуки радиуса приглушаются и возобновляются после. */
  useEffect(() => {
    const t = window.setInterval(() => {
      const cur = useApp.getState();
      const m = cur.sessionMap;
      const sess = cur.session;
      if (!m || !sess || sess.phase !== 'playing') { stopGroup('amb-'); return; }
      const act = sess.players[sess.turn % sess.players.length];
      const ch = sess.challenge;
      const emuRunning = !!ch && ch.started && (ch.status === 'playing' || ch.status === 'voting');
      const mine = act?.id === cur.selfId;
      const d = mine ? dispRef.current[cur.selfId] : null;
      const wanted = new Map<string, string>();
      if (d && !emuRunning) {
        const alib = new Map((m.animLib ?? []).map((a) => [a.id, a]));
        for (const pa of m.anims ?? []) {
          const e = alib.get(pa.aid);
          if (!e?.snd || !pa.r || pa.r <= 0) continue;
          if (Math.hypot(d.x - pa.x, d.y - pa.y) <= pa.r) wanted.set(pa.id, e.snd);
        }
        /* БОССЫ: звук ожидания живого босса — по тому же радиусу; повержённый молчит */
        const blib = new Map((m.bossLib ?? []).map((b) => [b.id, b]));
        for (const pb of m.bosses ?? []) {
          if (sess.bossDown?.[pb.id]) continue;
          const def = blib.get(pb.bid);
          if (!def?.idleSnd || !pb.r || pb.r <= 0) continue;
          if (Math.hypot(d.x - pb.x, d.y - pb.y) <= pb.r) wanted.set('boss-' + pb.id, def.idleSnd);
        }
      }
      syncLoops('amb-', wanted);
    }, 250);
    return () => { window.clearInterval(t); killGroup('amb-'); killGroup('mv-'); stopOneShot(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- тик таймера ---------- */
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);

  /* ---------- полный экран эмулятора ---------- */
  useEffect(() => {
    const fn = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', fn);
    return () => document.removeEventListener('fullscreenchange', fn);
  }, []);
  const toggleFs = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    } else {
      emuWrapRef.current?.requestFullscreen().catch(() => useApp.getState().toast('Браузер запретил полный экран', 'err'));
    }
  };

  /* ---------- карта мира поверх задания: эмулятор не сбрасывается, а встаёт на паузу ---------- */
  useEffect(() => {
    if (peekMap && !prevPeekRef.current) {
      const cur = useApp.getState();
      const sess = cur.session;
      const c = sess?.challenge;
      const act = sess ? sess.players[sess.turn % sess.players.length] : null;
      if (c && c.status === 'playing' && c.started && !c.paused && act?.id === cur.selfId) {
        dispatch({ t: 'togglePause', id: cur.selfId });
      }
    }
    prevPeekRef.current = peekMap;
  }, [peekMap]);

  /* ---------- сброс полноэкранного режима при смене челленджа ---------- */
  useEffect(() => {
    const c = s?.challenge;
    if (!c || c.status === 'choose') {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.challenge?.cellIdx, s?.challenge?.status]);

  /* ---------- очередь hops при moving ---------- */
  useEffect(() => {
    if (s?.moving) {
      hopRef.current[s.moving.player] = { queue: [...s.moving.path], last: 0 };
      setViewMode('follow');
      /* ЗВУК ХОДА ФИШКИ: у фишки с анимацией со звуком — её собственный звук на всё время
         движения (слышат все, как и «щелчки» шагов); у фишек без звука — шаги как раньше */
      const cur = useApp.getState();
      const mp = cur.session?.players.find((x) => x.id === s.moving!.player);
      const snd = mp?.tokenKey ? (cur.sessionMap?.mapTokens ?? []).find((x) => x.id === mp.tokenKey)?.anim?.snd : undefined;
      for (const k of [...moveSndRef.current]) {
        if (k !== s.moving.player) { moveSndRef.current.delete(k); stopLoop(`mv-${k}`, 0.25); }
      }
      if (snd) {
        moveSndRef.current.add(s.moving.player);
        startLoop(`mv-${s.moving.player}`, snd, { instant: true, spd: 0.3 });
      }
    } else {
      // движение кончилось — гасим все звуки хода
      for (const k of [...moveSndRef.current]) { moveSndRef.current.delete(k); stopLoop(`mv-${k}`, 0.25); }
    }
  }, [s?.moving?.ts]);

  /* ---------- FX: разовые ЗВУКИ победы/поражения ----------
     5-я/6-я анимации фишки — её winSnd/loseSnd; реакции боссов — winSnd/loseSnd босса.
     Каждый fx озвучивается ОДИН раз по факту появления в сессии, но С УЧЁТОМ паузы
     delay: сначала секунда тишины после задания, звук — в момент старта клипов.
     ОДНОВРЕМЕННОСТЬ: реакции боссов и фишка стартуют в один момент — звуки играют
     ПАРАЛЛЕЛЬНО (overlap), иначе фишкин звук глушал босский и у босса слышали только idle. */
  useEffect(() => {
    const fxList = s?.fxs ?? [];
    if (!fxList.length) return;
    const m = useApp.getState().sessionMap;
    if (!m) return;
    for (const fx of fxList) {
      if (fxSndRef.current.has(fx.id)) continue;
      fxSndRef.current.add(fx.id);
      let snd: string | undefined;
      if (fx.kind === 'tokenWin' || fx.kind === 'tokenLose') {
        const pl = s!.players.find((x) => x.id === fx.player);
        const tk = pl?.tokenKey ? (m.mapTokens ?? []).find((x) => x.id === pl.tokenKey) : null;
        snd = fx.kind === 'tokenWin' ? tk?.anim?.winSnd : tk?.anim?.loseSnd;
      } else {
        const b = (m.bosses ?? []).find((x) => x.id === fx.bossId);
        const def = b ? (m.bossLib ?? []).find((x) => x.id === b.bid) : null;
        snd = fx.kind === 'bossWin' ? def?.winSnd : fx.kind === 'bossDef' ? def?.defSnd : def?.loseSnd;
      }
      if (snd) {
        const delay = Math.max(0, fx.delay ?? 0);
        if (delay > 0) {
          const to = window.setTimeout(() => playOneShot(snd!, { overlap: true }), delay);
          fxSndTimersRef.current.push(to);
        } else {
          playOneShot(snd, { overlap: true });
        }
      }
    }
    if (fxSndRef.current.size > fxList.length) {
      const ids = new Set(fxList.map((f) => f.id));
      for (const k of [...fxSndRef.current]) if (!ids.has(k)) fxSndRef.current.delete(k);
    }
  }, [s?.fxs]);

  /* отложенные звуки fx: гасим при размонтировании, чтобы не «догоняли» после выхода */
  useEffect(() => () => {
    for (const to of fxSndTimersRef.current) clearTimeout(to);
    fxSndTimersRef.current = [];
  }, []);

  /* ---------- осмотр карты своим ходом сбрасывается при броске/челлендже ---------- */
  useEffect(() => {
    if (s?.moving || s?.challenge || s?.pendingCard || s?.quiz || s?.awaitPost) {
      lookPanRef.current = { x: 0, y: 0 };
      lookZoomRef.current = 1;
    }
  }, [s?.moving?.ts, s?.challenge, s?.pendingCard, s?.quiz, s?.awaitPost]);

  /* ---------- авто-доезд (страховка хоста) ----------
     Бюджет движения — по РЕАЛЬНОЙ длине пути: ячейки на карте стоят где угодно в пикселях
     (свободное размещение), стрелки-переходы и карточки дают перегоны любой длины, а не 64px.
     Раньше бюджет считался «по одной клетке на запись пути» — на скорости 0.5 кл/с и на любых
     длинных перегонах он был КОРЧЕ реального хода: страховка обрывала ход на полпути, камера
     прыгала на следующего игрока, а фишка телепортировалась. Теперь: сумма длин отрезков
     (подход + перегоны между ячейками) / скорость карты × запас ×2 + 10 с. Каким бы долгим
     ни был ход — фишка обязана дойти до конца, и это все должны увидеть.
     Там же страховка спектакля fx: если у виновника зависло/потерялось — хост доводит сам. */
  useEffect(() => {
    if (!room?.isHost) return;
    const t = setInterval(() => {
      const cur = useApp.getState();
      const sess = cur.session;
      if (!sess) return;
      /* зависший fx-спектакль: пауза+клипы+запас — и хост сам разбивает/завершает */
      const gfx = (sess.fxs ?? []).find((f) => f.gate);
      if (gfx) {
        if (Date.now() - gfx.ts > (gfx.delay ?? 0) + gfx.ms + 4000) {
          if (gfx.after === 'post' && !sess.broken?.[gfx.cellIdx]) dispatch({ t: 'fxBreak', id: gfx.player });
          dispatch({ t: 'fxDone', id: gfx.player });
        }
        return;
      }
      const mv = sess.moving;
      if (!mv) return;
      const mp = cur.sessionMap;
      const cps = clampMoveSpeed(mp?.moveSpeed ?? DEF_MOVE_SPEED); // кл/с из карты
      let dist = 0;
      const firstC = mp && mp.cells[mv.path[0]] ? cellCenter(mp, mv.path[0]) : null;
      if (firstC && mp) {
        /* подход: обычно ровно клетка (фишка стоит в центре своей ячейки), но берем МАКСИМУМ
           с фактическим отрисованным положением и стартовой ячейкой — карточки/телепорты
           дают первый перегон любой длины; завышение безопасно (ход просто не оборвётся) */
        const moverP = sess.players.find((x) => x.id === mv.player);
        const dispSt = dispRef.current[mv.player];
        let approach = CELL;
        if (dispSt) approach = Math.max(approach, Math.hypot(firstC.x - dispSt.x, firstC.y - dispSt.y));
        if (moverP) { const c0 = cellCenter(mp, moverP.pos); approach = Math.max(approach, Math.hypot(firstC.x - c0.x, firstC.y - c0.y)); }
        dist += approach;
        let prev = firstC;
        for (let i = 1; i < mv.path.length; i++) {
          const c = mp.cells[mv.path[i]] ? cellCenter(mp, mv.path[i]) : null;
          if (c) { dist += Math.hypot(c.x - prev.x, c.y - prev.y); prev = c; }
        }
      } else {
        dist = mv.path.length * CELL;
      }
      const walkMs = (dist / (cps * CELL)) * 1000; // время пути при скорости карты, мс
      const budget = Math.max(8000, walkMs * 2 + 10000); // двойной запас + 10 с
      if (Date.now() - mv.ts > budget) {
        dispatch({ t: 'arrived', id: mv.player });
      }
    }, 2000);
    return () => clearInterval(t);
  }, [room?.isHost]);

  /* ---------- главный цикл отрисовки ---------- */
  useEffect(() => {
    let raf = 0;
    let lastT = 0;
    const loop = (t: number) => {
      // dt в «кадрах по 60fps» — анимация не зависит от производительности ПК.
      // Кап 30 кадров (~0.5 с): скорость фишки верна реальному времени даже при просадке
      // до 2 FPS — ход не «растягивается», страховка хоста не обрывает его, фишка доходит.
      const dt = lastT ? Math.min(30, (t - lastT) / 16.7) : 1;
      lastT = t;
      const cv = canvasRef.current;
      const cur = useApp.getState();
      const m = cur.sessionMap;
      const sess = cur.session;
      if (cv && m && sess) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
          cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr);
        }
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // токены — медленное, «рукотворное» перемещение по ячейкам
        const act = sess.players[sess.turn % sess.players.length];
        const smooth = !!m.smoothMove; // плавный ход (без прыжков) задан картой
        // скорость фишек — ТОЛЬКО из карты (кл/с); менять её можно в редакторе карт,
        // прямо во время партии скорость не меняется (не было такой функции и не нужно)
        const cps = clampMoveSpeed(m.moveSpeed ?? DEF_MOVE_SPEED);
        const journeyMode = isJourneyLike(m.mode);
        const mszJ = journeyMode ? mapSize(m) : null;
        let anyoneMoving = false;
        const mapToks = m.mapTokens ?? [];
        /* ---------- FX: локальный старт разовых анимаций (по id) ----------
           Клипы играются от ЛОКАЛЬНОГО кадра появления fx + пауза delay (секунда
           тишины после задания); протухшие id чистим.
           В МОМЕНТ старта клипов у ИГРОКА-виновника шлётся fxBreak (ячейка разлетается
           осколками); когда клип доиграл (с учётом «послевкусия») — шлём fxDone. */
        const fxList = sess.fxs ?? [];
        /* JOURNEY: «свободный режим» — очереди ходов нет, все фишки ходят одновременно.
           Пока идёт задание/окно карточки/квиз/анимация победы — фишки ВСЕХ стоят:
           задание в прямом эфире смотрят все (после него снова свободный ход). */
        const journeyFree = journeyMode && !sess.moving && !sess.challenge && !sess.pendingCard && !sess.quiz && !sess.awaitPost && !fxList.some((f) => f.gate);
        for (const fx of fxList) if (!fxStartRef.current.has(fx.id)) fxStartRef.current.set(fx.id, t + (fx.delay ?? 0));
        if (fxStartRef.current.size > fxList.length) {
          const ids = new Set(fxList.map((f) => f.id));
          for (const k of [...fxStartRef.current.keys()]) if (!ids.has(k)) fxStartRef.current.delete(k);
        }
        for (const fx of fxList) {
          if (!fx.gate || fx.player !== me || fxDoneSentRef.current.has(fx.id)) continue;
          const st0 = fxStartRef.current.get(fx.id) ?? t;
          if (fx.after === 'post' && !fxBreakSentRef.current.has(fx.id) && t >= st0) {
            // пауза прошла — клипы начались: разбиваем ячейку (осколки) синхронно с анимацией
            fxBreakSentRef.current.add(fx.id);
            dispatch({ t: 'fxBreak', id: me });
          }
          if (t - st0 >= fx.ms) {
            fxDoneSentRef.current.add(fx.id);
            dispatch({ t: 'fxDone', id: me });
          }
        }
        const tokensAll = sess.players.map((p, pi) => {
          const center = cellCenter(m, p.pos);
          let d = dispRef.current[p.id];
          if (!d) { d = { ...center }; dispRef.current[p.id] = d; }

          /* ---------- JOURNEY: фишки ходят НАПРЯМУЮ, БЕЗ ОЧЕРЕДИ ХОДОВ ----------
             НОВЫЙ JOURNEY: ВСЕ игроки двигают свои фишки ОДНОВРЕМЕННО — своя фишка
             всегда локальная симуляция (мгновенный отклик, апдейты хосту ~6 раз/с).
             Чужие фишки плавно идут от авторитетной позиции из сети. Пока идёт
             задание одного из игроков — все фишки стоят, ходит только задание. */
          if (journeyMode) {
            const jp = sess.journeyPos?.[p.id];
            let jdir: TokenDir | undefined;
            if (p.id === me && p.alive && !p.spect) {
              let self = journeySelf.current;
              if (!self) {
                // при появлении считаем фишку УЖЕ СТОЯЩЕЙ во всех зонах порталов, содержащих точку старта,
                // чтобы портал под стартом не сработал сразу
                const sx0 = jp?.x ?? center.x, sy0 = jp?.y ?? center.y;
                const pin0 = new Set<string>();
                for (const q of m.portals ?? []) if (sx0 >= q.x && sx0 < q.x + q.w && sy0 >= q.y && sy0 < q.y + q.h) pin0.add(q.id);
                self = journeySelf.current = { x: sx0, y: sy0, dir: undefined, moving: false, dirty: false, lastSent: 0, pinside: pin0 };
              }
              let vx = 0, vy = 0;
              const canWalk = sess.phase === 'playing' && !sess.moving && !sess.challenge && !sess.pendingCard && !sess.quiz && !sess.awaitPost && !fxList.some((f) => f.gate);
              if (canWalk) {
                for (const kd of [...journeyKeys.current, ...journeyPadRef.current]) {
                  if (kd === 'up') vy -= 1; else if (kd === 'down') vy += 1;
                  else if (kd === 'left') vx -= 1; else if (kd === 'right') vx += 1;
                }
              }
              const walking = vx !== 0 || vy !== 0;
              if (walking) {
                const len = Math.hypot(vx, vy);
                const spd = cps * CELL * (dt / 60); // px за кадр — скорость из карты
                // НЕВИДИМЫЕ СТЕНЫ: пробуем ось X и ось Y отдельно — фишка СКОЛЬЗИТ по стене,
                // а не залипает в ней; центр фишки не заходит внутрь прямоугольника стены
                let nx = Math.max(8, Math.min((mszJ?.w ?? 2048) - 8, self.x + (vx / len) * spd));
                let ny = Math.max(8, Math.min((mszJ?.h ?? 2048) - 8, self.y + (vy / len) * spd));
                // ПЛИТОЧНЫЙ РЕЖИМ КАРТ: фишка НЕ выходит за край СВОЕЙ карты-плитки
                // (скользит по краю, как по стене); портал переносит НАПРЯМУЮ — без зажима
                const tgJ = m.tileGrid;
                if (tgJ) {
                  const ct = tileAt(tgJ, self.x, self.y) ?? tileAt(tgJ, nx, ny);
                  if (ct) {
                    const tr = tileRectOf(tgJ, ct);
                    nx = Math.max(tr.x + 8, Math.min(tr.x + tr.w - 8, nx));
                    ny = Math.max(tr.y + 8, Math.min(tr.y + tr.h - 8, ny));
                  }
                }
                if (!inWall(m, nx, self.y)) self.x = nx;
                if (!inWall(m, self.x, ny)) self.y = ny;
                self.dir = Math.abs(vx) >= Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : (vy > 0 ? 'down' : 'up');
                self.moving = true;
                self.dirty = true;
                jdir = self.dir;
              } else {
                self.moving = false;
              }
              /* ПОРТАЛЫ: фишка ВОШЛА в зону (снаружи внутрь) — мгновенный перенос в точку
                 перехода (обычно на другой плитке). Повторное срабатывание — только после
                 выхода из зоны; после переноса зоны, содержащие точку выхода, считаются
                 «уже внутри» — не телепортируем обратно сразу. */
              const pzs = m.portals ?? [];
              if (pzs.length && canWalk) {
                const inPz = (q: PortalZone) => self.x >= q.x && self.x < q.x + q.w && self.y >= q.y && self.y < q.y + q.h;
                for (const pz of pzs) {
                  const inside = inPz(pz);
                  const was = self.pinside.has(pz.id);
                  if (inside && !was && pz.tx !== undefined && pz.ty !== undefined) {
                    self.x = Math.max(8, Math.min((mszJ?.w ?? 2048) - 8, pz.tx));
                    self.y = Math.max(8, Math.min((mszJ?.h ?? 2048) - 8, pz.ty));
                    self.tp = true; // хост примет прыжок без анти-телепорта, зрители — снапнутся
                    self.dirty = true;
                    snapCamRef.current = true; // камера мгновенно за фишкой
                    self.pinside.clear();
                    for (const q of pzs) if (inPz(q)) self.pinside.add(q.id);
                    sfx.portal();
                    break; // один портал за кадр
                  }
                  if (inside) self.pinside.add(pz.id);
                  else self.pinside.delete(pz.id);
                }
              }
              d.x = self.x; d.y = self.y;
              if (self.moving) anyoneMoving = true;
              // сетевые апдейты: в движении ~6 раз/с, на остановке — финальная точка
              const nowMs = Date.now();
              if (self.dirty && ((self.moving && nowMs - self.lastSent > 160) || !self.moving)) {
                self.dirty = false;
                self.lastSent = nowMs;
                dispatch({ t: 'journeyMove', id: me, x: Math.round(self.x), y: Math.round(self.y), dir: self.dir, mv: self.moving, tp: self.tp || undefined });
                self.tp = false;
              }
            } else {
              // ЧУЖАЯ ФИШКА (трансляция): ходит СО СКОРОСТЬЮ КАРТЫ — той же, с какой ходит
              // сам игрок. Апдейты (~6/с) лишь ПОДТВЕРЖДАЮТ движение: якорь + направление +
              // флаг «идёт/стоит» (mv). Между апдейтами фишка идёт от якоря по направлению
              // ровно со скоростью карты — БЕЗ оценки скорости по дельтам (округление до
              // целого пикселя + джиттер телефона делали её «плавающей» — отсюда
              // подтормаживание у зрителей) и БЕЗ «тающего» окна экстраполяции (пауза в
              // апдейтах тормозила фишку). Лизр глушит остаточную погрешность округления.
              const nowMs = Date.now();
              let rj = journeyRemote.current[p.id];
              const tgt0 = jp ?? center;
              if (!rj) rj = journeyRemote.current[p.id] = { ax: tgt0.x, ay: tgt0.y, vx: 0, vy: 0, t: nowMs, dir: jp?.dir, mv: !!jp?.mv };
              if (jp && (jp.x !== rj.ax || jp.y !== rj.ay || jp.dir !== rj.dir || !!jp.mv !== rj.mv)) {
                rj.ax = jp.x; rj.ay = jp.y; rj.dir = jp.dir; rj.mv = !!jp.mv; rj.t = nowMs;
                if (jp.tp) { d.x = jp.x; d.y = jp.y; } // прыжок через портал — у зрителя мгновенный перенос
                const spd = cps * CELL; // px/с — РОВНО скорость карты, как у самого игрока
                const dv = rj.dir ? DIRV[rj.dir] : null;
                rj.vx = rj.mv && dv ? dv[0] * spd : 0;
                rj.vy = rj.mv && dv ? dv[1] * spd : 0;
              }
              // апдейтов нет ~полсекунды (стоп-обновление потерялось) — гасим скорость
              const fresh = nowMs - rj.t < 500;
              if (!fresh) { rj.vx = 0; rj.vy = 0; }
              const age = Math.max(0, (nowMs - rj.t) / 1000);
              const exX = rj.ax + rj.vx * age, exY = rj.ay + rj.vy * age;
              d.x += (exX - d.x) * Math.min(1, 0.16 * dt);
              d.y += (exY - d.y) * Math.min(1, 0.16 * dt);
              jdir = fresh && rj.mv ? rj.dir : undefined; // идёт — походка по направлению; стоит — idle
              if (journeyFree && p.id === act?.id && fresh && rj.mv) anyoneMoving = true;
            }
            const tokDefJ = p.tokenKey ? mapToks.find((x) => x.id === p.tokenKey) : null;
            const tokSizeJ = tokDefJ ? (tokDefJ.size ?? (tokDefJ.anim ? 64 : 34)) : (p.tokenSize ?? 34);
            // FX: пока играет 5-я/6-я анимация этого игрока — клип идёт ОДИН раз вместо обычной анимации.
            // Пока длится пауза delay (секунда тишины) — фишка живёт обычной анимацией, клип ещё НЕ начался.
            const fxA = fxList.find((f) => f.player === p.id && (f.kind === 'tokenWin' || f.kind === 'tokenLose'));
            const fxASt = fxA ? fxStartRef.current.get(fxA.id) : undefined;
            const fxAOn = !!fxA && fxASt !== undefined && t >= fxASt; // пауза прошла?
            const fxAClip: AnimClip | undefined = fxA && fxAOn
              ? (fxA.kind === 'tokenWin' ? tokDefJ?.anim?.win : tokDefJ?.anim?.lose)
              : undefined;
            return {
              x: d.x, y: d.y, color: PLAYER_COLORS[p.color],
              active: act?.id === p.id, alive: p.alive, label: p.name,
              img: p.tokenImg ?? null,
              anim: tokDefJ?.anim,
              dir: jdir,
              mv: jdir !== undefined, // идёт СЕЙЧАС — только у идущей фишки покачивание (на месте фишка стоит ровно)
              phase: pi * 0.53,
              size: tokSizeJ,
              override: fxAClip?.frames.length ? fxAClip : undefined,
              overrideStart: fxAClip?.frames.length ? fxASt : undefined,
            };
          }

          const hop = hopRef.current[p.id];
          let lift = 0; // вертикальный «подскок» фишки при движении (в плавном режиме — нет)
          let movingNow = false;
          const mvActive = !!sess.moving && sess.moving.player === p.id;
          // Хост уже завершил движение (moving null или принадлежит другому ходу)? Очередь
          // НЕ сбрасываем: фишка САМА доигрывает путь до последней ячейки — все видят,
          // как она доходит до места назначения, и лишь потом сходится с авторитетной
          // позицией (она = последняя ячейка пути). Раньше очередь обнулялась мгновенно,
          // и фишка «прыгала» к концу, не дойдя.
          if (hop && hop.queue.length) {
            anyoneMoving = true;
            movingNow = true;
            if (smooth) {
              /* ПЛАВНЫЙ ХОД БЕЗ ОСТАНОВОК: фишка идёт с ПОСТОЯННОЙ скоростью по всему
                 пути сразу — не тормозит у каждой клетки и не «отсчитывает» их;
                 излишек шага переносится на следующий отрезок, повороты пути = смена направления.
                 Скорость — ровно та, что задал автор карты (moveSpeed): считаем её от размера
                 клетки, а НЕ от расстояния до первой клетки пути — раньше seg0 «плавал»
                 от хода к ходу (фишка не по центру, лаг, доводка) и ход шёл то быстро, то медленно. */
              if (hop.speed === undefined) {
                hop.speed = smoothPxPerFrame(CELL, cps); // px за кадр 60fps — одинаковый на каждом ходу
              }
              let remain = hop.speed * dt;
              while (remain > 0 && hop.queue.length) {
                const tgt = cellCenter(m, hop.queue[0]);
                const dx = tgt.x - d.x, dy = tgt.y - d.y;
                const dist = Math.hypot(dx, dy);
                if (dist <= remain || dist < 0.5) { // dist < 0.5 — нулевой отрезок (стоим в этой клетке): сразу пройти
                  d.x = tgt.x; d.y = tgt.y; remain -= dist;
                  hop.queue.shift();
                  if (!moveSndRef.current.has(p.id)) sfx.step(); // у фишки свой звук хода — «щелчки» не дублируем
                  if (hop.queue.length === 0 && sess.moving && sess.moving.player === p.id && p.id === me && arrivedRef.current !== sess.moving.ts) {
                    arrivedRef.current = sess.moving.ts;
                    dispatch({ t: 'arrived', id: me });
                  }
                } else {
                  d.x += (dx / dist) * remain;
                  d.y += (dy / dist) * remain;
                  remain = 0;
                }
              }
            } else {
              const nextIdx = hop.queue[0];
              const tgt = cellCenter(m, nextIdx);
              const dx = tgt.x - d.x, dy = tgt.y - d.y;
              const dist = Math.hypot(dx, dy);
              if (dist < 3) {
                hop.queue.shift();
                d.x = tgt.x; d.y = tgt.y;
                if (!moveSndRef.current.has(p.id)) sfx.step(); // у фишки свой звук хода — «щелчки» не дублируем
                if (hop.queue.length === 0 && sess.moving && sess.moving.player === p.id && p.id === me && arrivedRef.current !== sess.moving.ts) {
                  arrivedRef.current = sess.moving.ts;
                  dispatch({ t: 'arrived', id: me });
                }
              } else {
                const hf = jumpFrameFactor(cps); // 95% клетки за 1/cps сек — скорость из карты
                d.x += dx * Math.min(1, hf * dt); // плавный шаг, не зависит от FPS
                d.y += dy * Math.min(1, hf * dt);
                lift = -Math.abs(Math.sin(t / 110)) * 7; // подскок — только в прыжковом режиме
              }
            }
            // фишка дошла (очередь пуста) — гасим её звук хода, если ещё играет
            if (moveSndRef.current.has(p.id) && !hop.queue.length) {
              moveSndRef.current.delete(p.id);
              stopLoop(`mv-${p.id}`, 0.25);
            }
          } else if (!mvActive) {
            // тянем к авторитетной клетке только когда это движение не «висит» в ожидании
            d.x += (center.x - d.x) * Math.min(1, 0.14 * dt);
            d.y += (center.y - d.y) * Math.min(1, 0.14 * dt);
          }
          // если mvActive, а очередь пуста — стоим на месте (ждём подтверждения хоста),
          // иначе фишка визуально «отскакивала» назад к старой клетке
          // НАПРАВЛЕНИЕ для анимации фишки — по фактическому сдвигу за кадр;
          // между клетками помним последнее направление, на месте — idle
          const prevD = prevDispRef.current[p.id];
          let dir: 'up' | 'down' | 'left' | 'right' | undefined;
          if (movingNow && prevD) {
            const mdx = d.x - prevD.x, mdy = d.y - prevD.y;
            if (Math.abs(mdx) + Math.abs(mdy) > 0.4) {
              dir = Math.abs(mdx) > Math.abs(mdy) ? (mdx > 0 ? 'right' : 'left') : (mdy > 0 ? 'down' : 'up');
            } else if (hop && hop.lastDir) {
              dir = hop.lastDir;
            }
          }
          if (dir) { if (hop) hop.lastDir = dir; }
          prevDispRef.current[p.id] = { x: d.x, y: d.y };
          const tokDef = p.tokenKey ? mapToks.find((x) => x.id === p.tokenKey) : null;
          const tokSize = tokDef ? (tokDef.size ?? (tokDef.anim ? 64 : 34)) : (p.tokenSize ?? 34);
          // FX: 5-я/6-я анимация этого игрока — разовый клип вместо обычной анимации.
          // Пока длится пауза delay (секунда тишины) — фишка живёт обычной анимацией.
          const fxB = fxList.find((f) => f.player === p.id && (f.kind === 'tokenWin' || f.kind === 'tokenLose'));
          const fxBSt = fxB ? fxStartRef.current.get(fxB.id) : undefined;
          const fxBOn = !!fxB && fxBSt !== undefined && t >= fxBSt; // пауза прошла?
          const fxBClip: AnimClip | undefined = fxB && fxBOn
            ? (fxB.kind === 'tokenWin' ? tokDef?.anim?.win : tokDef?.anim?.lose)
            : undefined;
          return {
            x: d.x, y: d.y + lift, color: PLAYER_COLORS[p.color],
            active: act?.id === p.id, alive: p.alive, label: p.name,
            img: p.tokenImg ?? null,
            anim: tokDef?.anim,
            dir,
            mv: movingNow, // покачивание в пути; стоя на ячейке, фишка НЕ «плавает»
            phase: pi * 0.53,
            size: tokSize,
            override: fxBClip?.frames.length ? fxBClip : undefined,
            overrideStart: fxBClip?.frames.length ? fxBSt : undefined,
          };
        });

        /* RUBG: чужие фишки в СТЕЛСЕ не рисуются; HP-бары считаются для всех
           (скрытые оверлей сам не рисует). Своя фишка в стелсе видна только мне. */
        const tokens = isRubg
          ? tokensAll.filter((_, i) => sess.players[i].id === me || !(sess.rubg?.stealth ?? []).includes(sess.players[i].id))
          : tokensAll;
        const rubgBars = isRubg
          ? sess.players.map((p, i) => ({
              x: tokensAll[i].x, y: tokensAll[i].y,
              hp: p.hp ?? 100,
              playing: !!(sess.rubg?.jobs ?? {})[p.id],
              hidden: p.id !== me && (sess.rubg?.stealth ?? []).includes(p.id),
            }))
          : [];

        // камера: в режиме мира — общий план (с ручным зумом), иначе — слежение за фишкой
        let goal;
        if (viewMode === 'world' || peekMap) {
          const fv = fitView(m, w, h);
          goal = { x: fv.x + worldPanRef.current.x, y: fv.y + worldPanRef.current.y, zoom: fv.zoom * worldZoom };
        } else {
          /* TRIATHLON: в свободном режиме каждый следит за СВОЕЙ фишкой (ходят одновременно);
             пока идёт задание — камера у всех на игроке задания (трансляция, как всегда) */
          const followId = journeyMode && journeyFree ? me : act?.id;
          const followP = followId ? dispRef.current[followId] : undefined;
          const baseZx = Math.min(2.1, Math.max(0.7, Math.min(w, h) / (CELL * 7.2)));
          const focus = anyoneMoving ? 1.5 : 1.0; // приближаемся, пока фишку передвигают
          const zx = Math.min(2.6, baseZx * focus);
          const msz = mapSize(m);
          let gx = (followP?.x ?? msz.w / 2) + lookPanRef.current.x;
          let gy = (followP?.y ?? msz.h / 2) + lookPanRef.current.y;
          /* ПЛИТОЧНЫЙ РЕЖИМ КАРТ: камера НЕ показывает соседние карты-локации —
             центр кадра зажат в прямоугольник карты-плитки, ЗА КОТОРОЙ следует
             наблюдаемый (своя фишка в свободном режиме / игрок задания) */
          const tgC = m.tileGrid;
          if (tgC && followP) {
            const ft = tileAt(tgC, followP.x, followP.y);
            if (ft) {
              const fr = tileRectOf(tgC, ft);
              const vw = w / (zx * lookZoomRef.current), vh = h / (zx * lookZoomRef.current);
              gx = vw >= fr.w ? fr.x + fr.w / 2 : Math.max(fr.x + vw / 2, Math.min(fr.x + fr.w - vw / 2, gx));
              gy = vh >= fr.h ? fr.y + fr.h / 2 : Math.max(fr.y + vh / 2, Math.min(fr.y + fr.h - vh / 2, gy));
            }
          }
          goal = {
            x: gx,
            y: gy,
            zoom: zx * lookZoomRef.current,
          };
        }
        const v = viewRef.current;
        /* пока фишку передвигают — камера держит фокус ПЛОТНЕЕ (жёстче догоняет цель):
           иначе на быстром ходу фишка уезжала из центра кадра, и слежение «сдвигалось» */
        const camK = anyoneMoving ? 0.2 : 0.07;
        v.x += (goal.x - v.x) * camK;
        v.y += (goal.y - v.y) * camK;
        v.zoom += (goal.zoom - v.zoom) * camK;
        /* ПОРТАЛ: прыжок своей фишки — камера переносится мгновенно (не «плывёт» через
           все плитки); в режиме общего плана камеру не трогаем */
        if (snapCamRef.current) {
          if (!(viewMode === 'world' || peekMap)) { v.x = goal.x; v.y = goal.y; }
          snapCamRef.current = false;
        }

        const colorById: Record<string, string> = {};
        sess.players.forEach((p) => { colorById[p.id] = PLAYER_COLORS[p.color]; });

        // FX: разовые реакции боссов — клип играется ОДИН раз от локального старта.
        // Пока длится пауза delay — босс продолжает IDLE (клип ещё не начался);
        // клип доиграл — босс ВОЗВРАЩАЕТСЯ к idle (замирает навсегда только побеждённый,
        // его клип гибели bossDef доигрывает и продолжает статичным последним кадром).
        const bossFx: Record<string, { frames: string[]; fps: number; start: number }> = {};
        for (const fx of fxList) {
          if (fx.kind !== 'bossWin' && fx.kind !== 'bossLose' && fx.kind !== 'bossDef') continue;
          const b = (m.bosses ?? []).find((x) => x.id === fx.bossId);
          if (!b) continue;
          const def = (m.bossLib ?? []).find((x) => x.id === b.bid);
          if (!def) continue;
          const clip = fx.kind === 'bossWin' ? def.win : fx.kind === 'bossDef' ? (def.defeated && def.defeated.frames.length ? def.defeated : def.win) : def.lose;
          const st = fxStartRef.current.get(fx.id);
          if (!clip.frames.length || st === undefined) continue;
          if (t < st) continue; // пауза не прошла — босс ещё играет idle
          const durMs = (clip.frames.length / Math.max(1, Math.min(24, clip.fps || 6))) * 1000;
          if (t - st >= durMs) continue; // реакция доиграла — обратно к idle
          bossFx[b.id] = { frames: clip.frames, fps: clip.fps, start: st };
        }

        // ЛОКАЛЬНЫЕ моменты разбития ячеек — для короткой анимации осколков.
        // Запоминаем первый кадр, когда ячейка увидена разбитой; убрали — чистим.
        const brkNow = sess.broken ?? {};
        for (const k of Object.keys(brkNow)) {
          const idx = Number(k);
          if (!brokenAtRef.current[idx]) brokenAtRef.current[idx] = Date.now();
        }
        for (const k of Object.keys(brokenAtRef.current)) {
          if (!brkNow[Number(k)]) delete brokenAtRef.current[Number(k)];
        }

        drawBoard(ctx, m, {
          view: v, width: w, height: h,
          tileById: tileMapRef.current,
          captured: sess.captured, colorById,
          currentCell: sess.phase === 'playing' && act && !(journeyMode && journeyFree) ? act.pos : null,
          showNumbers: options.showCellNumbers,
          tokens, time: t, hoverCell: null,
          mystery: mysteryRef.current,
          broken: sess.broken,
          brokenAt: brokenAtRef.current,
          bossDown: sess.bossDown,
          bossFx,
        });

        /* RUBG: оверлей поверх поля — безопасная зона, самолёт, HP-бары */
        if (isRubg) {
          drawRubgOverlay(ctx, {
            view: v, width: w, height: h, time: t,
            mapW: m.mw ?? m.cols * CELL, mapH: m.mh ?? m.rows * CELL,
            zone: sess.rubg?.zone ?? null,
            plane: sess.rubg?.plane ?? null,
            bars: rubgBars,
          });
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [viewMode, peekMap, worldZoom, me, options.showCellNumbers]);

  const tileMapRef = useRef(new Map<string, never>());
  useEffect(() => {
    tileMapRef.current = new Map(useApp.getState().tiles.map((t) => [t.id, t])) as never;
  }, [st.tiles]);

  /* ---------- БЕЗ КАРТЫ: автопилот хоста ----------
     Победа в матче → окно «играть дальше» подтверждается само; все матчи сыграны →
     после анимаций партия завершается победой (maplessFinish). */
  const maplessAutoRef = useRef('');
  const maplessFxGate = !!(s?.fxs ?? []).some((f) => f.gate);
  useEffect(() => {
    if (!isMapless || !room?.isHost || !s || !me || s.phase !== 'playing') return;
    if (s.awaitPost && !maplessFxGate) {
      dispatch({ t: 'postChoice', id: me, choice: 'continue' });
      return;
    }
    if (s.mapless?.over && !s.challenge && !s.pendingCard && !s.quiz && !s.awaitPost && !maplessFxGate) {
      const key = `over-${s.mapless.done}`;
      if (maplessAutoRef.current !== key) {
        maplessAutoRef.current = key;
        dispatch({ t: 'maplessFinish', id: me });
      }
    }
  }, [isMapless, room?.isHost, s, me, maplessFxGate]);

  /* ---------- RUBG: тик хоста (~1 с) — фазы зоны, урон, форс-высадка ---------- */
  useEffect(() => {
    if (!isRubg || !room?.isHost || !s) return;
    if (s.phase !== 'playing' && s.phase !== 'rollOff') return;
    const t = setInterval(() => dispatch({ t: 'rubgTick', id: me }), 1000);
    return () => clearInterval(t);
  }, [isRubg, room?.isHost, me, s?.phase, s]);

  /* ---------- RUBG: локальный таймер мини-игры «карман» — время вышло → провал ---------- */
  useEffect(() => {
    if (!myStealing || !s) return;
    const msLeft = myStealing.startedAt + myStealing.dur * 1000 - Date.now();
    if (msLeft <= 0) {
      dispatch({ t: 'rubgStealFail', id: me, victimId: myStealing.victim });
      return;
    }
    const t = setTimeout(() => dispatch({ t: 'rubgStealFail', id: me, victimId: myStealing.victim }), msLeft + 150);
    return () => clearTimeout(t);
  }, [myStealing?.victim, myStealing?.startedAt, myStealing?.dur, myStealing, me]);

  /* ---------- RUBG: движение руки в кармане (WASD/стрелки) ---------- */
  const [pocketCur, setPocketCur] = useState(0);
  const pocketLen = (() => {
    if (!myStealing || !s) return 0;
    const v = s.players.find((x) => x.id === myStealing.victim);
    return v?.items?.length ?? 0;
  })();
  useEffect(() => {
    if (!myStealing) return;
    setPocketCur(0);
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (['arrowup', 'w'].includes(k)) setPocketCur((c) => Math.max(0, c - 1));
      else if (['arrowdown', 's'].includes(k)) setPocketCur((c) => Math.min(Math.max(0, pocketLen - 1), c + 1));
      else if (['enter', ' ', 'e'].includes(k)) {
        e.preventDefault();
        const v = useApp.getState().session?.players.find((x) => x.id === myStealing.victim);
        const item = v?.items?.[pocketCurRef.current];
        if (item) dispatch({ t: 'rubgStealPick', id: me, victimId: myStealing.victim, itemId: item.id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!myStealing, myStealing?.victim, pocketLen, me]);
  const pocketCurRef = useRef(0);
  useEffect(() => { pocketCurRef.current = pocketCur; }, [pocketCur]);

  /* ---------- RUBG: зажатие кнопки кражи (чем дольше держишь — тем больше время) ---------- */
  const stealHoldRef = useRef(0);
  const stealHoldOn = () => {
    if (stealHoldRef.current) return;
    stealHoldRef.current = Date.now();
  };
  const stealHoldOff = () => {
    if (!stealHoldRef.current) return;
    const holdMs = Date.now() - stealHoldRef.current;
    stealHoldRef.current = 0;
    // ближайший играющий в радиусе кражи
    const sNow = useApp.getState().session;
    const mNow = useApp.getState().sessionMap;
    if (!sNow || !mNow || !me) return;
    const mp = sNow.journeyPos?.[me];
    if (!mp) return;
    const range = RUBG_STEAL_RANGE * CELL;
    let best: string | null = null; let bestD = range;
    for (const [pid, job] of Object.entries(sNow.rubg?.jobs ?? {})) {
      if (pid === me) continue;
      const jp = sNow.journeyPos?.[pid];
      if (!jp) continue;
      const d2 = Math.hypot(jp.x - mp.x, jp.y - mp.y);
      if (d2 <= range && d2 < bestD) { bestD = d2; best = pid; }
    }
    if (!best) {
      useApp.getState().toast('Подойдите ВПЛОТНУЮ к игроку, который играет задание', 'err');
      return;
    }
    dispatch({ t: 'rubgStealStart', id: me, victimId: best, holdMs });
  };

  if (!s || !map || !room) {
    return (
      <div className="h-full crt-grid-bg flex items-center justify-center">
        <div className="text-center">
          <div className="font-pixel text-[10px] text-dim blink-hard mb-4">НЕТ АКТИВНОЙ ПАРТИИ</div>
          <PxBtn onClick={() => st.setScreen('menu')}>В меню</PxBtn>
        </div>
      </div>
    );
  }

  const info = ch ? spentInfo(ch, Date.now()) : null;
  // остаток выбранного ресурса ПРЯМО СЕЙЧАС (с учётом потраченного в этом задании —
  // хранящиеся secLeft/triesLeft списываются только в конце, поэтому считаем сами)
  const remainingNow = !ch ? 0
    : ch.mode === 'time'
      ? Math.max(0, (mePlayer?.secLeft ?? 0) - (info?.ms ?? 0) / 1000)
      : Math.max(0, (mePlayer?.triesLeft ?? 0) - (info?.loads ?? 0));
  // пропуск: обычно после 5 потраченных (при «Штраф ×2» — после 10); при «низком старте» — только на нуле
  const naturalCanSkip = !!ch && !!info && (ch.lowStart ? remainingNow <= 0 : info.units >= skipNeed);
  // «Пропустить · 5» (заплатить ровно 5 авансом) доступен, только пока потрачено МЕНЬШЕ 5.
  // Когда потрачено 5+ — игрок обязан пользоваться кнопкой «Пропустить» (спишет фактическую цену).
  const instantSkipAllowed = !!ch && !!info && (ch.lowStart ? remainingNow <= 0 : info.units < skipNeed);
  // перезапуск требует ресурс: на нуле задание непроходимо — остаётся только «Пропустить»
  const canReload = !!ch && !!info && remainingNow > 0;
  const owner = ch ? s.captured[ch.cellIdx] : undefined;
  // свой ход, фишка стоит, кубики не брошены — можно осматривать карту перетаскиванием
  const canLookAround = !!s && !!mePlayer && myTurn && s.phase === 'playing' && !s.moving && !ch && !s.pendingCard && !s.quiz && !s.awaitPost && viewMode === 'follow' && !peekMap;

  // «закрытые» ячейки: не посещены и не захвачены — скрываем тип и картинку (опция)
  const mystery = useMemo(() => {
    if (!options.hideUnrevealed || !s || !map) return undefined;
    const set = new Set<number>();
    const revealed = Array.isArray(s.revealed) ? s.revealed : [];
    const captured = s.captured ?? {};
    map.cells.forEach((_, i) => {
      if (!revealed.includes(i) && !captured[i]) set.add(i);
    });
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.hideUnrevealed, s?.revealed, s?.captured, map?.id]);
  useEffect(() => { mysteryRef.current = mystery; }, [mystery]);
  const ownerName = owner ? s.players.find((p) => p.id === owner)?.name : undefined;
  const others = s.players.filter((p) => p.alive && p.id !== active?.id);
  const aliveCount = s.players.filter((p) => p.alive).length;
  const votesNeed = aliveCount;

  /* радости-иммунитеты: кнопки бесплатного пропуска в челлендже */
  const openTradeIds = new Set((s.trades ?? []).filter((o) => o.status === 'pending' || o.status === 'countered').map((o) => o.cardId));
  const hasJoyCard = (id: string) => !!mePlayer?.inventory?.some((c) => c.id === id) && !openTradeIds.has(id);
  const immuneBtns = myTurn && !!ch && ch.status !== 'voting' && (
    <>
      {hasJoyCard('joy-joker') && (
        <PxBtn color="teal" className="w-full" onClick={() => { sfx.card(); dispatch({ t: 'immuneSkip', id: me, emu: 'any' }); }}>
          🎫 Джокер: пропустить бесплатно
        </PxBtn>
      )}
      {isSega && hasJoyCard('joy-immuneSega') && (
        <PxBtn color="teal" className="w-full" onClick={() => { sfx.card(); dispatch({ t: 'immuneSkip', id: me, emu: 'sega' }); }}>
          🛡 Иммунитет к SEGA — бесплатно
        </PxBtn>
      )}
      {!isSega && hasJoyCard('joy-immuneNes') && (
        <PxBtn color="teal" className="w-full" onClick={() => { sfx.card(); dispatch({ t: 'immuneSkip', id: me, emu: 'nes' }); }}>
          🛡 Иммунитет к NES — бесплатно
        </PxBtn>
      )}
    </>
  );

  /* holdingRef — надёжный флаг «кнопка нажата» (state мог запаздывать в замыканиях,
     из-за чего повторное нажатие плодило интервалы и кубики тряслись вечно). */
  const holdingRef = useRef(false);
  const fxGateUi = !!(s.fxs ?? []).some((f) => f.gate); // идёт спектакль (анимации победы/поражения)
  const startHold = () => {
    if (!myTurn || s.moving || ch || s.pendingCard || s.awaitPost || s.quiz) return;
    if (fxGateUi) return; // во время анимаций бросать кубики НЕЛЬЗЯ (раньше можно было сорвать спектакль)
    if (rolling || holdingRef.current) return; // защита от повторного нажатия/залипания
    clearInterval(shakeIntRef.current); // глушим возможный «осиротевший» интервал
    holdingRef.current = true;
    holdStartRef.current = Date.now();
    setShake({ holding: true, a: 1, b: 1 });
    shakeIntRef.current = window.setInterval(() => {
      const a = 1 + Math.floor(Math.random() * 6);
      const b = 1 + Math.floor(Math.random() * 6);
      setShake({ holding: true, a, b });
      /* транслируем перемешивание соперникам — у всех кубики трясутся синхронно */
      room?.send('shake', { from: me, a, b });
      sfx.dice();
    }, 75);
  };
  const endHold = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    clearInterval(shakeIntRef.current);
    const holdMs = Date.now() - holdStartRef.current;
    setShake((x) => ({ ...x, holding: false }));
    setRolling(true); // кубики «катятся», пока хост не вернёт результат
    sfx.drop();
    dispatch({ t: 'roll', id: me, holdMs });
  };

  /* пришёл авторитетный результат броска — останавливаем кубики на числах хоста */
  const rollId = s?.dice?.roll ?? 0;
  useEffect(() => {
    if (rollId && rollId !== lastRollRef.current) {
      lastRollRef.current = rollId;
      setRolling(false);
    }
  }, [rollId]);

  /* страховка: если хост не ответил и «катание» зависло — сбрасываем, чтобы не висеть вечно */
  useEffect(() => {
    if (!rolling) return;
    const t = setTimeout(() => setRolling(false), 6000);
    return () => clearTimeout(t);
  }, [rolling]);

  /* жеребьёвка: старт игры — только когда ВСЕ игроки нажали «Старт игры»
     (действие rollOffReady, движок запускает партию сам) */

  /* пока кубики катятся — показываем быструю смену граней */
  useEffect(() => {
    if (!rolling) return;
    const iv = window.setInterval(() => {
      setShake((x) => ({ ...x, a: 1 + Math.floor(Math.random() * 6), b: 1 + Math.floor(Math.random() * 6) }));
    }, 70);
    return () => clearInterval(iv);
  }, [rolling]);

  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.code === 'Space' && myTurn && !e.repeat) { e.preventDefault(); startHold(); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') endHold(); };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); };
  });

  /* ---------- JOURNEY: стрелки/WASD двигают фишку напрямую (пока мой ход) ---------- */
  useEffect(() => {
    if (!isJourney) return;
    const dirOf = (code: string): TokenDir | null => {
      if (code === 'ArrowUp' || code === 'KeyW') return 'up';
      if (code === 'ArrowDown' || code === 'KeyS') return 'down';
      if (code === 'ArrowLeft' || code === 'KeyA') return 'left';
      if (code === 'ArrowRight' || code === 'KeyD') return 'right';
      return null;
    };
    const dn = (e: KeyboardEvent) => {
      const d = dirOf(e.code);
      if (!d || e.repeat) return;
      e.preventDefault(); // стрелки не крутят страницу — они ведут фишку
      journeyKeys.current.add(d);
    };
    const up = (e: KeyboardEvent) => { const d = dirOf(e.code); if (d) journeyKeys.current.delete(d); };
    const blur = () => journeyKeys.current.clear();
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', dn);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      journeyKeys.current.clear();
    };
  }, [isJourney]);

  /* ---------- JOURNEY: СТРЕЛКИ ДЖОЙСТИКА (геймпад) двигают фишку ----------
     Крестовина (кнопки 12..15), ЛЕВЫЙ СТИК и пользовательская раскладка из
     «Управления» (если направление переназначено на другую кнопку). Опрос
     ~15 раз/с; направления складываются с клавиатурой и экранным D-pad. */
  useEffect(() => {
    if (!isJourney) return;
    const iv = window.setInterval(() => {
      const prefs = loadEmuPrefs();
      const dirs = new Set<TokenDir>();
      if (prefs.gamepad !== false) {
        const pads = listGamepads();
        const addBtn = (gp: Gamepad, idx: number | undefined, d: TokenDir) => {
          if (idx === undefined || idx < 0 || idx > 17) return;
          if (gp.buttons[idx]?.pressed) dirs.add(d);
        };
        for (const gp of pads) {
          addBtn(gp, 12, 'up'); addBtn(gp, 13, 'down'); addBtn(gp, 14, 'left'); addBtn(gp, 15, 'right');
          addBtn(gp, prefs.gpad?.UP, 'up'); addBtn(gp, prefs.gpad?.DOWN, 'down');
          addBtn(gp, prefs.gpad?.LEFT, 'left'); addBtn(gp, prefs.gpad?.RIGHT, 'right');
          addBtn(gp, prefs.segaPad?.UP, 'up'); addBtn(gp, prefs.segaPad?.DOWN, 'down');
          addBtn(gp, prefs.segaPad?.LEFT, 'left'); addBtn(gp, prefs.segaPad?.RIGHT, 'right');
          const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0; // левый стик
          if (ax < -0.45) dirs.add('left');
          if (ax > 0.45) dirs.add('right');
          if (ay < -0.45) dirs.add('up');
          if (ay > 0.45) dirs.add('down');
        }
      }
      journeyPadRef.current = dirs;
    }, 66);
    return () => { clearInterval(iv); journeyPadRef.current.clear(); };
  }, [isJourney]);

  /* ---------- JOURNEY: авто-передача хода УДАЛЕНА ----------
     В новом JOURNEY очередь ходов отсутствует: все фишки ходят одновременно,
     передавать ход никому не нужно. Кто первый пересечёт ячейку задания —
     у того оно откроется, остальные фишки встанут и будут смотреть. */

  const winner = s.winner ? s.players.find((p) => p.id === s.winner) : null;
  /* трансляция: показываем последний кадр до 4 секунд, а пока идёт задание —
     НЕ прячем окно вовсе (кадры пропали — красный квадратик, без затемнений и надписей).
     Пометка LIVE не нужна: внизу только «ТРАНСЛЯЦИЯ» + квадрат (зелёный — кадры идут, красный — ждём). */
  const streamAge = stream ? Date.now() - stream.ts : Infinity;
  const streamLive = !!stream && streamAge < 1200;
  const chRunning = !!ch && ch.started && (ch.status === 'playing' || ch.status === 'voting');
  const streamShow = !!stream && (streamAge < 4000 || chRunning);

  /* Грани кубиков. У бросающего — своё перемешивание, затем результат приходит от
     хоста (с небольшой задержкой, зато игрок влияет на бросок временем удержания).
     У зрителей — синхронное перемешивание из сети. */
  const dShake = st.diceShake;
  const shakeFresh = !!dShake && !!active && dShake.from === active.id && !s.moving && Date.now() - dShake.ts < 700;
  const dieA = (shake.holding || rolling) && myTurn ? shake.a
    : !myTurn && shakeFresh ? dShake!.a
    : s.dice?.a ?? 6;
  const dieB = (shake.holding || rolling) && myTurn ? shake.b
    : !myTurn && shakeFresh ? dShake!.b
    : s.dice?.b ?? 6;
  const dieRolling = ((rolling || shake.holding) && myTurn) || (!myTurn && shakeFresh);
  // сколько кубиков показывать: во время перемешивания — предпросмотр (по активным карточкам),
  // после броска — столько, сколько выпало (1/2/3; при «Кубиках-0» — пустые грани)
  const diceShown = dieRolling || (shake.holding && myTurn)
    ? (myTurn ? (mePlayer?.oneDie ? 1 : mePlayer?.dicePlus ? 3 : 2) : 2)
    : (s.dice?.count ?? 2);

  return (
    <div className="h-full crt-grid-bg flex flex-col overflow-hidden">
      {/* ---------- HUD ---------- */}
      <div className="shrink-0 border-b-[3px] border-edge bg-[rgba(7,9,18,0.82)] px-3 py-2 flex items-center gap-2 flex-wrap z-20">
        <span className="font-pixel text-[9px] text-gold hidden sm:block">RETRO CHALLENGE GENERATOR</span>
        {/* код комнаты: с включённым «скрывать код» — точки вместо кода; глазик рядом
            показывает/прячет код, выбор запоминается (общая опция с экраном лобби) */}
        <span className="hud-chip pixel-corners px-2.5 py-1 font-pixel text-[9px] text-sky" title={options.hideRoomCode ? 'Код скрыт' : 'Код комнаты'}>{options.hideRoomCode ? '••••' : s.code}</span>
        <button
          onClick={() => { st.setOptions({ hideRoomCode: !options.hideRoomCode }); sfx.hover(); }}
          title={options.hideRoomCode ? 'Показать код комнаты' : 'Скрыть код комнаты'}
          aria-label={options.hideRoomCode ? 'Показать код комнаты' : 'Скрыть код комнаты'}
          className="text-faint hover:text-gold cursor-pointer transition-colors"
        >
          {options.hideRoomCode ? Ic.eye(12) : Ic.eyeOff(12)}
        </button>
        {isSkill && <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] text-magma">SKILL CHALLENGE</span>}
        {map?.mapless && <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] text-[#ff8b3f]">БЕЗ КАРТЫ</span>}
        {/* RUBG: HP-полоска, стелс и зона */}
        {isRubg && mePlayer && mePlayer.alive && !mePlayer.spect && (
          <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] flex items-center gap-1.5">
            <span className="relative inline-block w-16 h-2.5 bg-[rgba(7,9,18,0.85)] border border-[#313c72] align-middle">
              <span className="absolute inset-y-0 left-0" style={{ width: `${Math.max(0, Math.min(100, mePlayer.hp ?? 100))}%`, background: (mePlayer.hp ?? 100) > 50 ? '#35d46f' : (mePlayer.hp ?? 100) > 25 ? '#ffcf3f' : '#ff5d73' }} />
            </span>
            <span className="text-paper">HP {Math.round(mePlayer.hp ?? 100)}%</span>
          </span>
        )}
        {isRubg && inStealth && <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] text-[#c07aff]">👻 СТЕЛС</span>}
        {isRubg && rubg?.zone && s.phase === 'playing' && (() => {
          const z = rubg.zone;
          const leftMs = Math.max(0, z.phaseEnd - Date.now());
          return (
            <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] text-[#ff8b3f]">
              ⭕ {z.phase === 'shrink' ? 'СЖИМАЕТСЯ' : `СЖАТИЕ ЧЕРЕЗ ${Math.ceil(leftMs / 1000)}с`} · ВНЕ ЗОНЫ −{z.dps}%/с
            </span>
          );
        })()}
        {/* БЕЗ КАРТЫ: счётчик матчей вместо счётчика ходов */}
        {isMapless && s.phase === 'playing' && s.mapless && (
          <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] text-gold" title={isSkill ? 'Сыграно случайных игр из 25' : 'Сыграно матчей челленджа'}>
            МАТЧ {Math.min(s.mapless.done + 1, s.mapless.total)}/{s.mapless.total}
          </span>
        )}
        {map?.mode === 'journey' && <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] text-teal">TRIATHLON</span>}
        {isSoloJourney && <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] text-sky">JOURNEY · ОДИН</span>}
        {(() => {
          /* плиточный режим: номер карты-локации, за которой сейчас камера
             (в свободном хождении — своя фишка, иначе — игрок текущего хода/задания) */
          const tg = map?.tileGrid;
          if (!tg || !tg.tiles.length) return null;
          const jFree = s.phase === 'playing' && !s.moving && !s.challenge && !s.pendingCard && !s.quiz && !s.awaitPost && !(s.fxs ?? []).some((f) => f.gate);
          const followId = (isJourney && jFree ? me : active?.id) ?? '';
          const fp = dispRef.current[followId];
          const ft = fp ? tileAt(tg, fp.x, fp.y) : null;
          if (!ft) return null;
          return <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] text-teal" title="Плиточный режим: каждая плитка — отдельная карта-локация; между ними — порталы">📍 ЛОКАЦИЯ {tileNumOf(tg, ft.id)}/{tg.tiles.length}</span>;
        })()}
        {isSkill && s.phase === 'playing' && !s.mapless && (
          <span className="hud-chip pixel-corners px-2 py-1 font-pixel text-[8px] text-gold" title="Лимит ходов хоста в SKILL CHALLENGE">
            ХОД {Math.min(s.turnNo ?? 1, SKILL_TURNS)}/{SKILL_TURNS}
          </span>
        )}
        <span className={`w-2 h-2 ${st.netInfo.online ? 'bg-teal' : 'bg-gold'}`} />
        <div className="flex items-center gap-1.5 flex-wrap flex-1">
          {s.players.map((p, i) => (
            <div
              key={p.id}
              /* в JOURNEY «золотой» подсветки стоящего игрока нет в свободном режиме —
                 все ходят одновременно; подсветка появляется только у игрока задания */
              className={`hud-chip pixel-corners px-2.5 py-1.5 flex items-center gap-2 transition-all ${active?.id === p.id && s.phase === 'playing' && !(isJourney && !ch && !s.pendingCard && !s.awaitPost && !s.quiz && !(s.fxs ?? []).some((f) => f.gate)) ? 'border-gold shadow-[0_0_14px_rgba(255,207,63,0.35)]' : ''} ${!p.alive ? 'opacity-40 grayscale' : ''} ${p.spect ? 'opacity-70' : ''}`}
            >
              <span className="w-3.5 h-3.5 border border-abyss" style={{ background: PLAYER_COLORS[p.color] }} />
              <div className="leading-none">
                <div className="font-display text-[10px] uppercase tracking-wide text-paper flex items-center gap-1">
                  {p.name}
                  {p.isHost && <span className="font-pixel text-[6px] text-gold">H</span>}
                  {p.spect && <span className="font-pixel text-[6px] text-sky" title="Зритель — ходов не получает">👁 ЗРИТЕЛЬ</span>}
                  {!p.alive && <span className="text-coral">{Ic.skull(10)}</span>}
                </div>
                <div className="tick-label text-faint mt-1 flex items-center gap-1.5">
                  {p.spect ? (
                    <span className="text-sky">смотрит трансляцию</span>
                  ) : (
                    <>
                      <span className="text-sky">{fmtClock(p.secLeft)}</span>
                      <span className="text-gold">{p.triesLeft} поп.</span>
                      {coinsActive && <span className="text-teal" title={`Монеты: ${coinsStr(p.coinsLeft ?? 0)}`}>🪙 {coinsShort(p.coinsLeft ?? 0)}</span>}
                      <span>№{p.pos + 1}</span>
                    </>
                  )}
                </div>
              </div>
              {s.phase === 'rollOff' && s.rollOffValues[p.id] !== undefined && (
                <span className="font-pixel text-[10px] text-teal">{s.rollOffValues[p.id]}</span>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          {myTurn && streaming && <span className="font-pixel text-[7px] text-coral blink-hard">LIVE</span>}
          <GhostBtn small onClick={() => { setInvOpen(true); sfx.click(); }}>
            {Ic.grid(12)} Инвентарь{invCount > 0 ? ` · ${invCount}` : ''}{incomingTrades.length > 0 ? ' 💼' : ''}
          </GhostBtn>
          <GhostBtn small onClick={() => { setPeekMap(false); setWorldZoom(1); worldPanRef.current = { x: 0, y: 0 }; setViewMode((m) => (m === 'world' ? 'follow' : 'world')); }}>
            {Ic.map(12)} {viewMode === 'world' ? 'К игроку' : 'Карта мира'}
          </GhostBtn>
          {room.isHost && (
            <GhostBtn small onClick={() => void saveSessionSnapshot(`${map.name} · ${new Date().toLocaleDateString('ru-RU')}`)}>
              {Ic.save(12)} Сохранить
            </GhostBtn>
          )}
          <GhostBtn small onClick={() => { st.leaveRoom(); st.setScreen('menu'); }}>{Ic.home(12)}</GhostBtn>
        </div>
      </div>

      {/* ---------- поле ---------- */}
      <div className="flex-1 relative min-h-0">
        <canvas
          ref={canvasRef}
          className="w-full h-full block"
          style={{ cursor: viewMode === 'world' || peekMap ? (dragRef.current ? 'grabbing' : 'grab') : canLookAround ? (lookDragRef.current ? 'grabbing' : 'grab') : 'default' }}
          onWheel={(e) => {
            if (viewMode === 'world' || peekMap) {
              setWorldZoom((z) => Math.min(4, Math.max(0.3, z * Math.exp(-e.deltaY * 0.0012))));
            } else if (canLookAround) {
              lookZoomRef.current = Math.min(2.5, Math.max(0.5, lookZoomRef.current * Math.exp(-e.deltaY * 0.0012)));
            }
          }}
          onPointerDown={(e) => {
            (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
            inspectDownRef.current = { x: e.clientX, y: e.clientY };
            if (viewMode === 'world' || peekMap) {
              dragRef.current = { sx: e.clientX, sy: e.clientY, px: worldPanRef.current.x, py: worldPanRef.current.y };
            } else if (canLookAround) {
              lookDragRef.current = { sx: e.clientX, sy: e.clientY, px: lookPanRef.current.x, py: lookPanRef.current.y };
            }
          }}
          onPointerMove={(e) => {
            const z = viewRef.current.zoom || 1;
            if (dragRef.current) {
              worldPanRef.current = {
                x: dragRef.current.px - (e.clientX - dragRef.current.sx) / z,
                y: dragRef.current.py - (e.clientY - dragRef.current.sy) / z,
              };
            } else if (lookDragRef.current) {
              lookPanRef.current = {
                x: lookDragRef.current.px - (e.clientX - lookDragRef.current.sx) / z,
                y: lookDragRef.current.py - (e.clientY - lookDragRef.current.sy) / z,
              };
            }
          }}
          onPointerUp={(e) => {
            // клик без перетаскивания — осмотр ячейки (для всех, включая зрителей)
            const d = inspectDownRef.current;
            inspectDownRef.current = null;
            if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) {
              const cv = e.currentTarget as HTMLCanvasElement;
              const r = cv.getBoundingClientRect();
              const v = viewRef.current;
              const wx = v.x + (e.clientX - r.left - r.width / 2) / v.zoom;
              const wy = v.y + (e.clientY - r.top - r.height / 2) / v.zoom;
              const idx = cellAtPoint(map, wx, wy);
              setInspectIdx(idx >= 0 ? idx : null);
              if (idx >= 0) sfx.hover();
            }
            dragRef.current = null;
            lookDragRef.current = null;
          }}
        />

        {/* ---------- БЕЗ КАРТЫ: матчи-игры вместо поля ----------
            Челленджи без карты и SKILL CHALLENGE: экран карты не показывается —
            вместо него список матчей и рандомайзер «колесо фортуны». Канвас остаётся
            под панелью (не размонтируется), чтобы рендер-цикл и эффекты жили. */}
        {isMapless && s.phase === 'playing' && (() => {
          const hostP = s.players.find((p) => p.isHost);
          const doneCells = s.skillDone ?? [];
          const nextIdx = map.cells.findIndex((c, i) => c.type === 'task' && !doneCells.includes(i) && !s.broken?.[i]);
          /* пул рандомайзера: для безкартового челленджа — вшит в карту; для SKILL —
             уникальные ромы заданий карты */
          const pool: { romId: string; title: string }[] = map.mapless?.random
            ? (map.mapless.pool ?? [])
            : map.mode === 'skill'
              ? Array.from(new Map(map.cells.filter((c) => c.type === 'task' && c.task).map((c) => [c.task!.romId, { romId: c.task!.romId, title: c.task!.title }])).values())
              : [];
          const nextTask = nextIdx >= 0 ? cellTaskOf(s, map, nextIdx) : null;
          const busy = !!(s.challenge || s.moving || s.pendingCard || s.quiz || s.awaitPost || maplessFxGate);
          const ml = s.mapless;
          return (
            <div className={`absolute inset-0 z-[15] bg-[rgba(7,9,18,0.97)] overflow-y-auto ${peekMap ? 'hidden' : ''}`}>
              <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
                {/* шапка челленджа */}
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-display uppercase text-xl text-[#ff8b3f]">{map.name}</span>
                  <span className="font-pixel text-[8px] px-1.5 py-0.5 border-2 border-magma/60 text-magma">{isSkill ? 'SKILL CHALLENGE' : 'ЧЕЛЛЕНДЖ БЕЗ КАРТЫ'}</span>
                  {ml && (
                    <span className="ml-auto font-display uppercase text-lg text-gold">
                      {ml.over ? 'ФИНИШ!' : `МАТЧ ${Math.min(ml.done + 1, ml.total)} / ${ml.total}`}
                    </span>
                  )}
                </div>
                {/* полоса прогресса матчей */}
                {ml && (
                  <div className="flex items-center gap-1">
                    {Array.from({ length: ml.total }).map((_, i) => (
                      <span key={i} className={`h-2 flex-1 min-w-[3px] ${i < ml.done ? 'bg-teal' : i === ml.done && !ml.over ? 'bg-gold pulse-ring' : 'bg-edge'}`} />
                    ))}
                  </div>
                )}
                {/* ресурсы хоста */}
                {hostP && !hostP.spect && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[10px] text-sky">⏱ {fmtClock(hostP.secLeft)}</span>
                    <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[10px] text-gold">🎯 {hostP.triesLeft} ПОП.</span>
                    {coinsActive && <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[10px] text-teal">🪙 {coinsStr(hostP.coinsLeft ?? 0)}</span>}
                    {!hostP.alive && <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[10px] text-coral">РЕСУРСЫ ИСЧЕРПАНЫ</span>}
                  </div>
                )}

                {s.phase === 'playing' && ml && !ml.over && (
                  busy ? (
                    <div className="pixel-panel pixel-corners p-6 text-center">
                      <span className="font-pixel text-[9px] text-dim blink-hard">МАТЧ {(ml.done ?? 0) + 1} ИГРАЕТСЯ — ОКНО ЗАДАНИЯ НА ЭКРАНЕ</span>
                    </div>
                  ) : hostP?.id === me && hostP.alive ? (
                    <div className="pixel-panel pixel-corners p-5 space-y-4">
                      <div className="font-display uppercase text-sm text-paper">
                        {map.mapless?.random || isSkill ? 'Крутаните колесо — выпавшая игра станет матчем' : 'Следующий матч по списку'}
                      </div>
                      {map.mapless?.random || isSkill ? (
                        <Randomizer
                          items={pool}
                          disabled={busy}
                          onPicked={(item) => {
                            if (nextIdx < 0) return;
                            dispatch({ t: 'maplessSpin', id: me, cellIdx: nextIdx, romId: item.romId, title: item.title });
                            dispatch({ t: 'maplessOpen', id: me, cellIdx: nextIdx });
                          }}
                        />
                      ) : (
                        <div className="space-y-3">
                          <div className="border-[3px] border-edge px-4 py-3">
                            <div className="tick-label text-gold mb-1">Игра матча №{(ml.done ?? 0) + 1}</div>
                            <div className="font-display uppercase text-paper text-lg truncate">{nextTask?.title ?? '—'}</div>
                            {nextTask?.desc && <div className="text-[11px] text-dim mt-1">{nextTask.desc}</div>}
                          </div>
                          <PxBtn big color="gold" className="w-full pulse-ring" disabled={!nextTask}
                            onClick={() => { sfx.start(); if (nextIdx >= 0) dispatch({ t: 'maplessOpen', id: me, cellIdx: nextIdx }); }}>
                            {Ic.play(16)} Играть матч {(ml.done ?? 0) + 1}
                          </PxBtn>
                        </div>
                      )}
                      {pool.length === 0 && (map.mapless?.random || isSkill) && (
                        <p className="text-[11px] text-magma">Пул игр пуст — {isSkill ? 'добавьте на карту задания с ромами' : 'в челлендже не выбрана ни одна игра'}.</p>
                      )}
                    </div>
                  ) : (
                    <div className="pixel-panel pixel-corners p-6 text-center">
                      <span className="font-pixel text-[9px] text-dim blink-hard">ХОСТ ГОТОВИТ СЛЕДУЮЩИЙ МАТЧ…</span>
                    </div>
                  )
                )}

                {/* список матчей (безкартовый челлендж по списку) */}
                {map.mapless && !map.mapless.random && (
                  <div className="border-2 border-edge divide-y-2 divide-edge max-h-56 overflow-y-auto">
                    {map.cells.filter((c) => c.type === 'task').map((c) => {
                      const i = map.cells.indexOf(c);
                      const played = doneCells.includes(i);
                      const t = cellTaskOf(s, map, i);
                      return (
                        <div key={i} className={`flex items-center gap-2 px-3 py-1.5 text-[11px] ${played ? 'text-faint' : 'text-paper'}`}>
                          <span className={`font-pixel text-[8px] ${played ? 'text-teal' : 'text-gold'}`}>{played ? '✓' : '·'}</span>
                          <span className="font-pixel text-[8px] text-faint w-8">№{c.n}</span>
                          <span className={`truncate ${played ? 'line-through' : ''}`}>{t?.title ?? '—'}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* лог партии */}
                <div className="space-y-1">
                  {s.log.slice(0, 8).map((l, i) => (
                    <div key={`${l}-${i}`} className={`text-[10.5px] leading-tight px-2.5 py-1.5 bg-[rgba(7,9,18,0.8)] border-l-[3px] ${i === 0 ? 'border-gold text-paper' : 'border-edge text-dim'}`}>
                      {l}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}

        {/* чей ход */}
        {s.phase === 'playing' && active && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 hud-chip pixel-corners px-4 py-1.5 flex items-center gap-2">
            <span className="w-3 h-3" style={{ background: PLAYER_COLORS[active.color] }} />
            <span className="font-display uppercase text-[12px] tracking-wide" style={{ color: PLAYER_COLORS[active.color] }}>
              Ход: {active.name}
            </span>
            {myTurn && <span className="font-pixel text-[7px] text-gold blink-hard">ВЫ</span>}
          </div>
        )}
        {mePlayer && !mePlayer.alive && s.phase === 'playing' && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 hud-chip pixel-corners px-4 py-1.5 border-coral">
            <span className="font-display uppercase text-[11px] text-coral">Вы выбыли — режим наблюдения</span>
          </div>
        )}

        {canLookAround && (
          <div className="absolute top-14 right-3 hud-chip pixel-corners px-3 py-1.5 pointer-events-none">
            <span className="tick-label text-sky">Тяните карту мышью · колесо — зум · клик по ячейке — осмотр · до броска</span>
          </div>
        )}

        {/* заметное уведомление о пустых ячейках (передышках) */}
        {s.notice && Date.now() - s.notice.ts < 5000 && (
          <div className="absolute top-24 left-1/2 -translate-x-1/2 z-40 pop-in pointer-events-none">
            <div className="pixel-corners px-5 py-3 border-[3px] border-magma bg-[rgba(30,16,8,0.92)] shadow-[0_10px_30px_rgba(0,0,0,0.5)] max-w-md">
              <div className="flex items-start gap-3">
                <span className="text-magma shrink-0 mt-0.5">{Ic.bolt(18)}</span>
                <div>
                  <div className="font-display uppercase text-[12px] tracking-wide text-magma">Передышка</div>
                  <div className="text-[12px] text-paper leading-snug mt-1">{s.notice.text}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* лог */}
        <div className="absolute left-3 bottom-3 w-[290px] max-w-[45vw] space-y-1 pointer-events-none">
          {s.log.slice(0, 6).map((l, i) => (
            <div key={`${l}-${i}`} className={`text-[10.5px] leading-tight px-2.5 py-1.5 bg-[rgba(7,9,18,0.8)] border-l-[3px] ${i === 0 ? 'border-gold text-paper slide-up' : 'border-edge text-dim'}`}>
              {l}
            </div>
          ))}
        </div>

        {/* трансляция соперника (миниатюра, видна и поверх инвентаря/торгов).
            Скрываем, когда трансляция открыта в основном окне задания (ch) — НО если
            зритель открыл «карту мира» поверх задания (peekMap) или инвентарь (торги),
            миниатюра остаётся, чтобы трансляция не пропадала. */}
        {streamShow && !myTurn && (!ch || peekMap || invOpen) && !streamBig && (
          <div className="fixed right-3 bottom-3 w-[240px] pop-in z-[97]">
            <div className="hud-chip pixel-corners p-1.5">
              <div className="flex items-center gap-2 px-1 pb-1">
                <span className={`w-2 h-2 shrink-0 ${streamLive ? 'bg-teal' : 'bg-coral'}`} title={streamLive ? 'Кадры идут' : 'Ждём кадры'} />
                <span className="font-pixel text-[7px] text-paper">ТРАНСЛЯЦИЯ · {stream!.name}</span>
                <button
                  onClick={() => setStreamBig(true)}
                  title="Увеличить трансляцию"
                  className="ml-auto font-pixel text-[9px] text-sky hover:text-paper cursor-pointer"
                >⤢</button>
              </div>
              <img
                src={stream!.data}
                alt="Трансляция"
                onClick={() => setStreamBig(true)}
                className="w-full border-2 border-edge cursor-zoom-in"
                style={{ imageRendering: 'auto' }}
              />
            </div>
          </div>
        )}

        {/* увеличенная трансляция: всё внимание — игре соперника */}
        {streamBig && streamShow && !myTurn && (
          <div className="fixed inset-0 z-[98] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-[rgba(4,6,14,0.72)]" onClick={() => setStreamBig(false)} />
            <div className="relative pixel-panel pixel-corners pop-in p-2 w-[600px] max-w-[94vw]">
              <div className="flex items-center gap-2 px-1 pb-1.5">
                <span className={`w-2 h-2 shrink-0 ${streamLive ? 'bg-teal' : 'bg-coral'}`} title={streamLive ? 'Кадры идут' : 'Ждём кадры'} />
                <span className="font-pixel text-[8px] text-paper">ТРАНСЛЯЦИЯ · {stream!.name}</span>
                <GhostBtn small className="ml-auto" onClick={() => setStreamBig(false)}>{Ic.cross(12)} Свернуть</GhostBtn>
              </div>
              <img src={stream!.data} alt="Трансляция" className="w-full border-2 border-edge" />
              <p className="text-[10px] text-dim text-center mt-1.5">Карта и торги никуда не делись — сверните трансляцию, чтобы вернуться</p>
            </div>
          </div>
        )}

        {/* ---------- кубики (в JOURNEY их нет — фишка ходит напрямую) ---------- */}
        {s.phase === 'playing' && !isJourney && !ch && !s.pendingCard && !s.awaitPost && !s.quiz && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
            <div className="flex gap-3">
              <DieFace v={dieA} dropping={!!s.dice && !dieRolling && !s.moving} rolling={dieRolling} />
              {diceShown >= 2 && (
                <DieFace v={dieB} dropping={!!s.dice && !dieRolling && !s.moving} rolling={dieRolling} delay />
              )}
              {diceShown >= 3 && (
                <DieFace v={s.dice?.c ?? dieB} dropping={!!s.dice && !dieRolling && !s.moving} rolling={dieRolling} delay />
              )}
            </div>
            {myTurn ? (
              !s.moving ? (
                rolling ? (
                  <div className="hud-chip pixel-corners px-4 py-2 font-pixel text-[8px] text-gold blink-hard">КУБИКИ КАТЯТСЯ…</div>
                ) : fxGateUi ? (
                  /* спектакль идёт: бросок НЕДОСТУПЕН (раньше можно было нажать и сорвать тайминги) */
                  <div className="hud-chip pixel-corners px-4 py-2 font-pixel text-[8px] text-dim">🎬 АНИМАЦИЯ ИДЁТ…</div>
                ) : (
                  <button
                    onPointerDown={startHold}
                    onPointerUp={endHold}
                    onPointerLeave={() => { if (shake.holding) endHold(); }}
                    className={`btn-px pixel-corners btn-gold px-7 py-3 text-sm select-none touch-none ${shake.holding ? 'shake-hard' : ''}`}
                  >
                    {Ic.dice(16)} {shake.holding ? 'ОТПУСТИТЕ — БРОСОК!' : 'ДЕРЖИТЕ, ЧТОБЫ СМЕШАТЬ'}
                  </button>
                )
              ) : (
                <div className="hud-chip pixel-corners px-4 py-2 font-pixel text-[8px] text-gold blink-hard">ФИШКА ДВИЖЕТСЯ…</div>
              )
            ) : (
              active && !s.moving && (
                <div className="hud-chip pixel-corners px-4 py-2 text-[11px] text-dim">
                  {active.name} готовится к броску{active.id === me ? '' : ' — ждём'}
                </div>
              )
            )}
            {s.dice && !s.moving && !myTurn && (
              <div className="tick-label text-teal">
                {s.dice.zero
                  ? '0 — застрял на ячейке (кубики-0)'
                  : s.dice.count === 1
                    ? `${s.dice.a} — один кубик`
                    : s.dice.count === 3
                      ? `${s.dice.a} + ${s.dice.b} + ${s.dice.c} = ${(s.dice.a ?? 0) + (s.dice.b ?? 0) + (s.dice.c ?? 0)}`
                      : `${s.dice.a} + ${s.dice.b} = ${s.dice.a + s.dice.b}`}
              </div>
            )}
            {myTurn && !s.moving && !rolling && !shake.holding && (() => {
              // предупреждения о пакостях, действующих на бросок
              const myCellTask = active ? cellTaskOf(s, map, active.pos) : null;
              if (myCellTask?.chaos === 'dice0' && s.captured[active!.pos] !== me) {
                return (
                  <div className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[8px] text-magma blink-hard text-center">
                    😈 КУБИКИ-0: пройди задание — иначе бросок всегда 0!
                  </div>
                );
              }
              if (mePlayer?.oneDie) {
                return <div className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[8px] text-magma blink-hard">😈 ОДИН КУБИК: бросишь только одним</div>;
              }
              if (mePlayer?.dicePlus) {
                return <div className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[8px] text-teal">🎲 +1 КУБИК: бросаешь тремя!</div>;
              }
              return null;
            })()}
          </div>
        )}

        {/* ---------- JOURNEY: прямое управление фишкой — У КАЖДОГО СВОЯ, ОДНОВРЕМЕННО ---------- */}
        {s.phase === 'playing' && isJourney && !ch && !s.pendingCard && !s.awaitPost && !s.quiz && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-10">
            {mePlayer && !mePlayer.spect && mePlayer.alive ? (
              <div className="flex items-center gap-4">
                <div className="grid grid-cols-3 gap-1 select-none touch-none">
                  <span />
                  <button
                    className="w-11 h-11 border-2 border-edge bg-panel text-paper font-pixel text-xs cursor-pointer select-none touch-none active:border-gold active:text-gold hover:border-edge2"
                    onPointerDown={(e) => { e.preventDefault(); journeyPress('up', true); }}
                    onPointerUp={() => journeyPress('up', false)}
                    onPointerLeave={() => journeyPress('up', false)}
                    onPointerCancel={() => journeyPress('up', false)}
                  >▲</button>
                  <span />
                  <button
                    className="w-11 h-11 border-2 border-edge bg-panel text-paper font-pixel text-xs cursor-pointer select-none touch-none active:border-gold active:text-gold hover:border-edge2"
                    onPointerDown={(e) => { e.preventDefault(); journeyPress('left', true); }}
                    onPointerUp={() => journeyPress('left', false)}
                    onPointerLeave={() => journeyPress('left', false)}
                    onPointerCancel={() => journeyPress('left', false)}
                  >◀</button>
                  <span />
                  <button
                    className="w-11 h-11 border-2 border-edge bg-panel text-paper font-pixel text-xs cursor-pointer select-none touch-none active:border-gold active:text-gold hover:border-edge2"
                    onPointerDown={(e) => { e.preventDefault(); journeyPress('right', true); }}
                    onPointerUp={() => journeyPress('right', false)}
                    onPointerLeave={() => journeyPress('right', false)}
                    onPointerCancel={() => journeyPress('right', false)}
                  >▶</button>
                  <span />
                  <button
                    className="w-11 h-11 border-2 border-edge bg-panel text-paper font-pixel text-xs cursor-pointer select-none touch-none active:border-gold active:text-gold hover:border-edge2"
                    onPointerDown={(e) => { e.preventDefault(); journeyPress('down', true); }}
                    onPointerUp={() => journeyPress('down', false)}
                    onPointerLeave={() => journeyPress('down', false)}
                    onPointerCancel={() => journeyPress('down', false)}
                  >▼</button>
                  <span />
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <div className="tick-label text-faint text-center max-w-72">Все фишки ходят ОДНОВРЕМЕННО: стрелки/WASD, ДЖОЙСТИК или кнопки — веди свою. Кто ПЕРВЫМ пересечёт ячейку задания — у того оно откроется, остальные фишки встанут и будут смотреть. Передавать ход не нужно.</div>
                </div>
              </div>
            ) : (
              <div className="hud-chip pixel-corners px-4 py-2 text-[11px] text-dim">
                Все фишки идут по карте — кто первый пересечёт ячейку задания, тот и играет
              </div>
            )}
          </div>
        )}

        {/* ---------- RUBG: самолёт — каждый выпрыгивает, где хочет ---------- */}
        {isRubg && s.phase === 'rollOff' && rubg?.plane && (() => {
          const pl = rubg.plane;
          const now = Date.now();
          const len = Math.hypot(pl.x1 - pl.x0, pl.y1 - pl.y0) || 1;
          const dd = Math.min(len, Math.max(0, ((now - pl.startAt) / 1000) * pl.speed));
          const pxx = pl.x0 + (pl.x1 - pl.x0) * (dd / len);
          const pyy = pl.y0 + (pl.y1 - pl.y0) * (dd / len);
          const jumped = pl.jumped ?? [];
          const iJumped = jumped.includes(me);
          const rosterR = s.players.filter((q) => !q.spect);
          const inside = pxx >= 0 && pxx <= (map.mw ?? 0) && pyy >= 0 && pyy <= (map.mh ?? 0);
          return (
            <div className="absolute inset-0 flex items-center justify-center bg-[rgba(4,6,14,0.5)] z-10">
              <div className="pixel-panel pixel-corners pop-in p-6 max-w-md w-full mx-4 text-center">
                <div className="font-display uppercase tracking-wider text-gold text-lg">🪂 САМОЛЁТ НА ЛИНИИ</div>
                <p className="text-[11px] text-dim mt-1">Выпрыгивай, ГДЕ ХОЧЕШЬ — прыжок приземлит тебя под самолётом. Ищи задания и лутбоксы, следи за зоной!</p>
                <div className="font-pixel text-[10px] text-paper my-3">Пройдено маршрута: {Math.round((dd / len) * 100)}%{inside ? '' : ' · самолёт ВНЕ карты'}</div>
                {iJumped ? (
                  <div className="font-pixel text-[9px] text-teal blink-hard">ПРЫЖОК СОВЕРШЁН — ждём остальных ({jumped.length}/{rosterR.length})</div>
                ) : (
                  <PxBtn big color="gold" disabled={!inside} onClick={() => { sfx.start(); dispatch({ t: 'rubgJump', id: me, x: Math.round(pxx), y: Math.round(pyy) }); }}>
                    🪂 ПРЫГНУТЬ
                  </PxBtn>
                )}
                <div className="mt-3 flex justify-center gap-1.5 flex-wrap">
                  {rosterR.map((p) => (
                    <span key={p.id} className={`font-pixel text-[8px] px-1.5 py-0.5 border-2 ${jumped.includes(p.id) ? 'border-teal text-teal' : 'border-edge text-dim'}`}>
                      {p.name}{jumped.includes(p.id) ? ' ✔' : ''}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}

        {/* ---------- жеребьёвка: все кубики видны сразу, бросают по очереди (зрители — в стороне) ---------- */}
        {s.phase === 'rollOff' && !s.rollOffWinner && !isRubg && (() => {
          const roster = s.players.filter((p) => !p.spect);
          return (
          <div className="absolute inset-0 flex items-center justify-center bg-[rgba(4,6,14,0.55)] z-10">
            <div className="pixel-panel pixel-corners pop-in p-6 max-w-lg w-full mx-4 text-center">
              <div className="font-display uppercase tracking-wider text-gold text-lg">Кто ходит первым?</div>
              <p className="text-[12px] text-dim mt-1 mb-1">Бросайте по очереди — у кого больше, тот и начинает. При равенстве — переброс.</p>
              <div className="flex justify-center gap-5 mt-4 mb-5 flex-wrap">
                {roster.map((p, i) => {
                  const val = s.rollOffValues[p.id];
                  const isRoller = i === s.rollOffIdx;
                  const mine = isRoller && p.id === me;
                  const theirs = isRoller && p.id !== me;
                  /* тряска показывается ТОЛЬКО когда она реально идёт: у себя — пока
                     держим кнопку или докручиваем; у соперника — пока приходят свежие
                     кадры shake. До нажатия кнопки все видят пустой кубик. */
                  const shaking = mine ? roShake || roWaiting : theirs && roRemoteShake;
                  const face = mine
                    ? (roShake || roWaiting ? roFace : val ?? roFace)
                    : theirs && roRemoteShake && st.diceShake
                      ? st.diceShake.a
                      : val ?? 0;
                  const color = PLAYER_COLORS[p.color];
                  return (
                    <div key={p.id} className="flex flex-col items-center gap-1.5">
                      {val !== undefined && !shaking ? (
                        <DieFace key={`${p.id}-${val}`} v={val} frame={color} dropping />
                      ) : shaking ? (
                        <DieFace v={face} frame={color} rolling />
                      ) : (
                        <DieFace v={0} frame={color} blank />
                      )}
                      <div className="font-display text-[10px] uppercase tracking-wide" style={{ color }}>{p.name}</div>
                      <div className="tick-label text-faint">
                        {val !== undefined ? `выпало ${val}` : isRoller ? (p.id === me ? 'ваш бросок' : 'бросает…') : 'ждёт очереди'}
                      </div>
                    </div>
                  );
                })}
              </div>
              {roster[s.rollOffIdx]?.id === me ? (
                <button
                  onPointerDown={startRoShake}
                  onPointerUp={endRoShake}
                  onPointerLeave={() => { if (roShake) endRoShake(); }}
                  disabled={roWaiting}
                  className={`btn-px pixel-corners btn-gold px-7 py-3 text-sm select-none touch-none ${roShake ? 'shake-hard' : ''}`}
                >
                  {Ic.dice(16)} {roShake ? 'ОТПУСТИТЕ — БРОСОК!' : roWaiting ? 'КУБИК КРУТИТСЯ…' : 'ДЕРЖИТЕ, ЧТОБЫ СМЕШАТЬ'}
                </button>
              ) : (
                <div className="font-pixel text-[9px] text-dim blink-hard">БРОСАЕТ {roster[s.rollOffIdx]?.name}…</div>
              )}
            </div>
          </div>
          );
        })()}

        {/* ---------- победитель жеребьёвки: каждый подтверждает старт (и берёт фишку) ---------- */}
        {s.phase === 'rollOff' && s.rollOffWinner && (() => {
          const readyList = s.rollOffReady ?? [];
          const roster = s.players.filter((p) => !p.spect);
          const winnerP = s.players.find((p) => p.id === s.rollOffWinner);
          const allReady = roster.every((p) => readyList.includes(p.id));
          const mapToks = map.mapTokens ?? [];
          const needToken = mapToks.length > 0 && !mePlayer?.spect; // фишки заданы картой — выбор обязателен (зрителям — нет)
          const myTokenKey = s.players.find((p) => p.id === me)?.tokenKey;
          const tokenTakenBy = (tid: string) => s.players.find((p) => p.id !== me && p.tokenKey === tid);
          return (
            <div className="absolute inset-0 flex items-center justify-center bg-[rgba(4,6,14,0.6)] z-10">
              <div className="pixel-panel pixel-corners pop-in p-7 max-w-lg w-full mx-4 text-center">
                <span className="text-gold inline-block floaty">{isJourney ? Ic.pawn(40) : Ic.dice(40)}</span>
                <div className="font-pixel text-gold text-[11px] mt-3">{isJourney ? (isSoloJourney ? 'ОДИНОКОЕ ПРИКЛЮЧЕНИЕ' : 'ВСЕ СТАРТУЮТ ОДНОВРЕМЕННО') : 'ПЕРВЫМ ХОДИТ'}</div>
                {isJourney ? (
                  <p className="text-[11px] text-dim mt-2">{isSoloJourney ? 'Играет ТОЛЬКО ХОСТ — все подключившиеся смотрят трансляцию. Жеребьёвки нет: фишка хоста идёт свободно от старта.' : 'Жеребьёвки нет — каждый ведёт СВОЮ фишку со старта. Кто ПЕРВЫМ пересечёт ячейку задания — у того оно и откроется, остальные будут смотреть.'}</p>
                ) : (
                  <div
                    className="font-display uppercase text-3xl mt-2"
                    style={{ color: winnerP ? PLAYER_COLORS[winnerP.color] : undefined }}
                  >
                    {winnerP?.name ?? '—'}
                  </div>
                )}
                {isSkill && <p className="text-[11px] text-magma mt-2">SKILL CHALLENGE: играть будет только хост — вы зритель{mePlayer?.spect ? ' (и вы тоже)' : ''}.</p>}
                {isSoloJourney && mePlayer?.spect && <p className="text-[11px] text-sky mt-2">JOURNEY: играет хост — вы зритель трансляции.</p>}
                {!isJourney && (
                  <div className="flex justify-center gap-4 mt-5 flex-wrap">
                    {roster.map((p) => (
                      <div key={p.id} className="flex flex-col items-center gap-1">
                        <DieFace v={s.rollOffValues[p.id] ?? 1} frame={PLAYER_COLORS[p.color]} dropping={p.id === s.rollOffWinner} />
                        <span className="font-display text-[9px] uppercase" style={{ color: PLAYER_COLORS[p.color] }}>{p.name}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-5 space-y-2 text-left">
                  {roster.map((p) => {
                    const isReady = readyList.includes(p.id);
                    const pTok = needToken && p.tokenKey ? mapToks.find((t) => t.id === p.tokenKey) : null;
                    return (
                      <div key={p.id} className={`flex items-center justify-between gap-2 hud-chip pixel-corners px-3 py-2 ${p.id === me && !isReady ? 'border-gold pulse-ring' : ''}`}>
                        <span className="font-display text-[11px] uppercase tracking-wide truncate" style={{ color: PLAYER_COLORS[p.color] }}>{p.name}</span>
                        {isReady ? (
                          <span className="font-pixel text-[8px] text-teal shrink-0 text-right">ГОТОВ ✓{pTok ? <span className="text-dim"> · {pTok.name}</span> : ''}</span>
                        ) : p.id === me ? (
                          <PxBtn small color="teal" disabled={needToken && !myTokenKey} onClick={() => { sfx.start(); dispatch({ t: 'rollOffReady', id: me }); }}>{Ic.play(12)} Старт игры</PxBtn>
                        ) : (
                          <span className="font-pixel text-[8px] text-faint">ЖДЁМ…</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {needToken && !readyList.includes(me) && (
                  <div className="mt-4 text-left">
                    <div className="font-display uppercase text-[11px] tracking-wider text-sky mb-2 flex items-center gap-1.5">
                      <span>{Ic.pawn(13)}</span> Выберите свою фишку
                    </div>
                    <div className="flex gap-2 flex-wrap justify-center">
                      {mapToks.map((t) => {
                        const takenBy = tokenTakenBy(t.id);
                        const mine = myTokenKey === t.id;
                        const off = !!takenBy;
                        return (
                          <button
                            key={t.id}
                            disabled={off}
                            onClick={() => { sfx.click(); dispatch({ t: 'token', id: me, tokenImg: t.dataUrl, tokenId: t.id }); }}
                            title={takenBy ? `${t.name} — уже у ${takenBy.name}` : t.name}
                            className={`relative w-14 h-14 border-[3px] p-1 transition-all ${off ? 'border-edge opacity-35 cursor-not-allowed' : mine ? 'border-gold shadow-[0_0_14px_rgba(255,207,63,0.35)] cursor-pointer' : 'border-edge hover:border-edge2 cursor-pointer'}`}
                            style={{ background: 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 12px 12px' }}
                          >
                            {t.anim?.idle?.frames?.length
                              ? <AnimPreview frames={t.anim.idle.frames} fps={t.anim.idle.fps} size={44} className="w-full h-full" style={{ width: '100%', height: '100%' }} />
                              : <img src={t.dataUrl} alt={t.name} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />}
                            {takenBy && <span className="absolute inset-x-0 bottom-0 bg-coral text-abyss font-pixel text-[6px] truncate px-0.5">{takenBy.name}</span>}
                          </button>
                        );
                      })}
                    </div>
                    {!myTokenKey && <p className="font-pixel text-[8px] text-gold mt-2">СНАЧАЛА ФИШКА — ПОТОМ «СТАРТ ИГРЫ»</p>}
                    {mapToks.length < s.players.length && <p className="font-pixel text-[8px] text-coral mt-1">ФИШЕК ({mapToks.length}) МЕНЬШЕ, ЧЕМ ИГРОКОВ ({s.players.length}) — ХОСТУ НУЖНО ДОБАВИТЬ В РЕДАКТОРЕ!</p>}
                  </div>
                )}

                <div className={`font-pixel text-[9px] mt-4 ${allReady ? 'text-teal' : 'text-dim blink-hard'}`}>
                  {allReady ? 'СТАРТ!' : `ГОТОВЫ ${readyList.length} ИЗ ${roster.length}`}
                </div>
              </div>
            </div>
          );
        })()}

        {/* ---------- победитель ---------- */}
        {s.phase === 'over' && (
          <div className="absolute inset-0 flex items-center justify-center bg-[rgba(4,6,14,0.78)] z-30 overflow-hidden">
            {[...Array(36)].map((_, i) => (
              <span
                key={i}
                className="confetti-bit w-2.5 h-2.5"
                style={{
                  left: `${(i * 137) % 100}%`,
                  background: PLAYER_COLORS[i % 4],
                  animationDuration: `${2.2 + (i % 5) * 0.5}s`,
                  animationDelay: `${(i % 8) * 0.3}s`,
                }}
              />
            ))}
            <div className="pixel-panel pixel-corners pop-in p-8 text-center max-w-md mx-4 relative">
              <span className="text-gold inline-block floaty">{Ic.trophy(48)}</span>
              {isSkill ? (
                <>
                  <div className={`font-pixel text-sm mt-3 title-glow ${winner ? 'text-teal' : 'text-coral'}`}>
                    {winner ? 'SKILL CHALLENGE ПРОЙДЕН' : 'SKILL CHALLENGE ПРОВАЛЕН'}
                  </div>
                  <div className="font-display uppercase text-2xl text-paper mt-2" style={{ color: winner ? PLAYER_COLORS[winner.color] : undefined }}>
                    {winner?.name ?? 'РЕСУРСЫ ИСЧЕРПАНЫ'}
                  </div>
                  <p className="text-[12px] text-dim mt-2">
                    {winner
                      ? `${winner.name} сыграл ${s.mapless?.total ?? SKILL_TURNS} случайных игр — ресурсы на месте! Финальный капитал: ${coinsStr(winner.coinsLeft ?? 0)}`
                      : `Ресурсы исчерпаны раньше, чем сыграны все ${s.mapless?.total ?? SKILL_TURNS} игр.`}
                  </p>
                </>
              ) : isMapless ? (
                <>
                  <div className={`font-pixel text-sm mt-3 title-glow ${winner ? 'text-teal' : 'text-coral'}`}>
                    {winner ? 'ЧЕЛЛЕНДЖ ПРОЙДЕН!' : 'ЧЕЛЛЕНДЖ ПРОВАЛЕН'}
                  </div>
                  <div className="font-display uppercase text-2xl text-paper mt-2" style={{ color: winner ? PLAYER_COLORS[winner.color] : undefined }}>
                    {winner?.name ?? 'РЕСУРСЫ ИСЧЕРПАНЫ'}
                  </div>
                  <p className="text-[12px] text-dim mt-2">
                    {winner
                      ? `Все ${s.mapless?.total ?? '?'} матчей сыграны! Финальный капитал: ${coinsStr(winner.coinsLeft ?? 0)}`
                      : 'Ресурсы исчерпаны раньше, чем сыграны все матчи.'}
                  </p>
                </>
              ) : (
                <>
                  <div className="font-pixel text-gold text-sm mt-3 title-glow">ПОБЕДА</div>
                  <div className="font-display uppercase text-2xl text-paper mt-2" style={{ color: winner ? PLAYER_COLORS[winner.color] : undefined }}>
                    {winner?.name ?? 'НИЧЬЯ'}
                  </div>
                  <p className="text-[12px] text-dim mt-2">
                    {winner ? 'Соперники остались без ресурсов. Поле покорено!' : 'Ресурсы исчерпали все — партия annullée.'}
                  </p>
                </>
              )}
              <div className="flex gap-3 justify-center mt-6">
                {room.isHost && <GhostBtn onClick={() => void saveSessionSnapshot(`${map.name} · итог`)}>{Ic.save(13)} В архив</GhostBtn>}
                <PxBtn onClick={() => { st.leaveRoom(); st.setScreen('menu'); }}>{Ic.home(14)} В меню</PxBtn>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ---------- карточка бонуса/ловушки ---------- */}
      {s.pendingCard && !peekMap && (
        <Modal title={s.pendingCard.card.kind === 'bonus' ? 'Карточка бонуса' : 'Карточка ловушки'} icon={s.pendingCard.card.kind === 'bonus' ? Ic.star(16) : Ic.skull(16)} w="max-w-md" locked>
          <div className="text-center">
            <img
              src={cardImg ?? cardArt(s.pendingCard.card.kind === 'joy' ? 'bonus' : s.pendingCard.card.kind, s.pendingCard.card.name, s.pendingCard.card.id.length)}
              alt={s.pendingCard.card.name}
              className="mx-auto border-[3px] border-edge max-h-44 object-contain pop-in"
            />
            <div className="font-display uppercase text-xl mt-3" style={{ color: s.pendingCard.card.kind === 'bonus' ? '#2ee6a8' : '#ff5d73' }}>
              {s.pendingCard.card.name}
            </div>
            <p className="text-[13px] text-dim mt-1.5">{s.pendingCard.card.desc}</p>
            <div className="hud-chip pixel-corners inline-block px-3 py-1.5 mt-3">
              <span className="font-display text-[11px] uppercase text-gold">{effectLabel(s.pendingCard.card.effect)}</span>
            </div>
            <div className="mt-5">
              {s.pendingCard.player === me ? (
                <PxBtn color={s.pendingCard.card.kind === 'bonus' ? 'teal' : 'coral'} onClick={() => dispatch({ t: 'cardAck', id: me })}>{Ic.check(14)} Принять судьбу</PxBtn>
              ) : (
                <span className="font-pixel text-[8px] text-dim blink-hard">
                  {s.players.find((p) => p.id === s.pendingCard!.player)?.name} читает карточку…
                </span>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* ---------- челлендж: не размонтируется под картой мира, чтобы эмулятор не сбрасывался ---------- */}
      {ch && task && (
        <div className={peekMap ? 'hidden' : undefined}>
        <Modal
          title={isMapless && s.mapless ? `Матч ${Math.min(s.mapless.done + 1, s.mapless.total)} · ${task.title}` : `Ячейка №${ch.cellIdx + 1} · ${task.title}`}
          icon={Ic.cart(16)}
          w="max-w-4xl"
          locked
        >
          <div className="grid md:grid-cols-[220px_1fr] gap-4">
            <div className="space-y-3">
              <img
                src={taskImg ?? cartridgeArt(task.title, romName, ch.cellIdx)}
                alt={task.title}
                className="w-full border-[3px] border-edge object-cover"
              />
              <div className="text-[12px] text-dim leading-relaxed">
                <div className="tick-label text-gold mb-1">Задание</div>
                {task.desc}
              </div>
              <div className="tick-label text-faint">Ром: {romName} · {taskRom?.ext === 'nes' ? 'NES' : 'SEGA'}</div>
              {ownerName && owner !== active?.id && (
                <div className="hud-chip pixel-corners px-3 py-2 text-[11px] text-magma border-magma">
                  Хозяин ячейки: {ownerName} — потраченные ресурсы уйдут ему
                </div>
              )}
              <GhostBtn small onClick={() => setPeekMap(true)}>{Ic.map(12)} Глянуть карту мира</GhostBtn>
              {myTurn && ch.status !== 'choose' && !controlsLocked && (
                <GhostBtn small onClick={() => setControlsOpen(true)}>{Ic.gear(12)} Управление</GhostBtn>
              )}
              {/* звук эмулятора — всегда под кнопкой «Управление»: и при запуске, и во время задания */}
              {myTurn && ch.status !== 'choose' && <EmuVolumeChip />}
              {controlsLocked && (
                <div className="hud-chip pixel-corners px-3 py-2 text-[10px] text-magma border-magma">
                  😈 Реверс крестовины: смена кнопок ЗАПРЕЩЕНА
                </div>
              )}
            </div>

            <div className="min-w-0">
              {ch.status === 'choose' && (
                <div>
                  {myTurn ? (
                    <div>
                      <div className="font-display uppercase text-sm text-paper mb-3">Чем платите за задание?</div>
                      <div className={`grid ${coinsActive ? 'sm:grid-cols-3' : 'grid-cols-2'} gap-3`}>
                        {!coinsOnly && (
                          <button
                            onClick={() => { sfx.coin(); dispatch({ t: 'chooseMode', id: me, mode: 'time' }); }}
                            disabled={(mePlayer?.secLeft ?? 0) <= 0}
                            className="pixel-panel pixel-corners p-4 text-left hover:border-sky hover:-translate-y-0.5 transition-all cursor-pointer group disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:border-edge"
                          >
                            <span className="text-sky">{Ic.clock(22)}</span>
                            <div className="font-display uppercase text-paper group-hover:text-sky mt-2">Время</div>
                            <div className="font-pixel text-[10px] text-sky mt-1">{fmtClock(mePlayer?.secLeft ?? 0)}</div>
                            <div className="text-[10px] text-dim mt-1.5">{(mePlayer?.secLeft ?? 0) <= 0 ? 'Время исчерпано — ресурс недоступен' : 'Таймер стартует по кнопке «Запуск задания».'}</div>
                          </button>
                        )}
                        {!coinsOnly && (
                          <button
                            onClick={() => { sfx.coin(); dispatch({ t: 'chooseMode', id: me, mode: 'tries' }); }}
                            disabled={(mePlayer?.triesLeft ?? 0) <= 0}
                            className="pixel-panel pixel-corners p-4 text-left hover:border-gold hover:-translate-y-0.5 transition-all cursor-pointer group disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:border-edge"
                          >
                            <span className="text-gold">{Ic.target(22)}</span>
                            <div className="font-display uppercase text-paper group-hover:text-gold mt-2">Попытки</div>
                            <div className="font-pixel text-[10px] text-gold mt-1">{mePlayer?.triesLeft ?? 0} ПОП.</div>
                            <div className="text-[10px] text-dim mt-1.5">{(mePlayer?.triesLeft ?? 0) <= 0 ? 'Попытки исчерпаны — ресурс недоступен' : 'Запуск = 1 попытка, каждый перезапуск — ещё одна.'}</div>
                          </button>
                        )}
                        {coinsActive && (
                          <button
                            onClick={() => { sfx.coin(); dispatch({ t: 'chooseMode', id: me, mode: 'coins' }); }}
                            className="pixel-panel pixel-corners p-4 text-left hover:border-teal hover:-translate-y-0.5 transition-all cursor-pointer group"
                          >
                            <span className="text-teal">🪙</span>
                            <div className="font-display uppercase text-paper group-hover:text-teal mt-2">Монеты</div>
                            <div className="font-pixel text-[10px] text-teal mt-1">{coinsShort(mePlayer?.coinsLeft ?? 0)}</div>
                            <div className="text-[10px] text-dim mt-1.5">Во время игры ничего не тратится: победа +{map.taskWinCoins ?? 0} бр · пропуск {map.skipCoins ?? 5} бр.</div>
                          </button>
                        )}
                      </div>
                      <div className="mt-3 flex justify-end gap-2 flex-wrap">
                        {coinsActive && (
                          <GhostBtn onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: 'coins', spentMs: 0, loads: 0 })} disabled={(mePlayer?.coinsLeft ?? 0) > 0 && (mePlayer?.coinsLeft ?? 0) < skipCoinsNeed}>
                            {Ic.bolt(12)} Сразу пропустить · {skipCoinsNeed} бр
                          </GhostBtn>
                        )}
                        {!coinsOnly && (
                          <>
                            <GhostBtn onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: 'time', spentMs: 0, loads: 0 })} disabled={(mePlayer?.secLeft ?? 0) < 60}>
                              {Ic.bolt(12)} Сразу пропустить · {skipNeed} мин
                            </GhostBtn>
                            <GhostBtn onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: 'tries', spentMs: 0, loads: 0 })} disabled={(mePlayer?.triesLeft ?? 0) <= 0}>
                              {Ic.bolt(12)} Сразу пропустить · {skipNeed} поп.
                            </GhostBtn>
                          </>
                        )}
                      </div>
                      <div className="mt-2 space-y-2">
                        {immuneBtns}
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-10">
                      <span className="font-pixel text-[9px] text-dim blink-hard">{active?.name} ВЫБИРАЕТ РЕСУРС…</span>
                    </div>
                  )}
                </div>
              )}

              {ch.status !== 'choose' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`hud-chip pixel-corners px-3 py-1.5 font-display text-[11px] uppercase flex items-center gap-1.5 ${ch.mode === 'time' ? 'text-sky' : ch.mode === 'coins' ? 'text-teal' : 'text-gold'}`}>
                      {ch.mode === 'time' ? Ic.clock(13) : ch.mode === 'coins' ? <span>🪙</span> : Ic.target(13)} {ch.mode === 'time' ? 'Режим времени' : ch.mode === 'coins' ? 'Монетная игра' : 'Режим попыток'}
                    </span>
                    {ch.mode === 'coins' && (
                      <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[10px] text-teal" title="Монеты платятся по итогам: победа — награда, пропуск — цена">
                        🪙 {coinsShort(mePlayer?.coinsLeft ?? 0)} · победа +{map.taskWinCoins ?? 0} бр · пропуск {map.skipCoins ?? 5} бр · перезапуски бесплатны
                      </span>
                    )}
                    {info && ch.mode === 'time' && (
                      <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[10px] text-sky">
                        {fmtClock(Math.max(0, (mePlayer?.secLeft ?? 0) - info.ms / 1000))} · потрачено {info.min} мин
                      </span>
                    )}
                    {info && ch.mode === 'tries' && (
                      <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[10px] text-gold">
                        ОСТАЛОСЬ: {Math.max(0, (mePlayer?.triesLeft ?? 0) - info.loads)} ПОП. · ЗАГРУЗОК {info.loads}
                      </span>
                    )}
                    {ch.status === 'voting' && (
                      <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[9px] text-teal blink-hard">
                        ГОЛОСА: {ch.approvals.length}/{votesNeed}
                      </span>
                    )}
                    {task?.chaos && (
                      <span
                        className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[9px] text-magma"
                        title={CHAOS_LIST.find((c) => c.kind === task.chaos)?.desc}
                      >
                        😈 {chaosLabel(task.chaos)}
                      </span>
                    )}
                    {task?.joy && (() => {
                      const jm = JOY_LIST.find((j) => j.id === task.joy);
                      return jm ? (
                        <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[9px] text-teal" title={jm.desc}>
                          🎉 {jm.name}
                        </span>
                      ) : null;
                    })()}
                  </div>

                  <div className="grid lg:grid-cols-[1fr_190px] gap-3 items-start">
                    <div className="min-w-0">
                      {myTurn ? (
                        <>
                          <div className="flex items-center justify-between mb-1.5 gap-2">
                            <span className="tick-label text-faint">
                              {isFs ? 'ESC — выход из полного экрана' : ch.paused ? 'эмулятор на паузе' : ''}
                            </span>
                            <GhostBtn small onClick={toggleFs}>
                              {isFs ? Ic.cross(12) : Ic.map(12)} {isFs ? 'Свернуть' : 'Во весь экран'}
                            </GhostBtn>
                          </div>
                          <div ref={emuWrapRef} className={isFs ? 'bg-[#05070f] h-full w-full flex items-center justify-center p-4' : ''}>
                            <div style={isFs ? { width: isSega ? 'min(92vw, calc(88vh * 1.3333))' : 'min(92vw, calc(88vh * 1.0667))' } : undefined}>
                        {romBuf ? (
                          <SegaBox
                            key={emuKey}
                            romData={romBuf}
                            ext={segExt}
                            core={isSega ? undefined : 'nes'}
                            remapSpec={remapSpec}
                            chaos={activeChaos}
                            initialState={(saveState as string | null) ?? null}
                            paused={ch.status === 'ready' || ch.status === 'voting' || ch.paused}
                            pausedHint={ch.status === 'ready' ? 'Нажмите «Запуск задания»' : undefined}
                            onApi={(a) => { ejsApiRef.current = a; }}
                            onSettingsFail={() =>
                              useApp.getState().toast('Меню не открылось само — наведите курсор на экран эмулятора и нажмите шестерёнку на панели внизу', 'err')
                            }
                          />
                        ) : (
                          <div className="aspect-[256/240] bg-black border-[3px] border-edge flex items-center justify-center">
                            <span className="font-pixel text-[8px] text-faint blink-hard">ЗАГРУЗКА РОМА…</span>
                          </div>
                        )}
                            </div>
                          </div>
                        </>
                      ) : streamShow ? (
                        <div className="border-[3px] border-edge bg-black">
                          <img src={stream!.data} alt="Трансляция" className="w-full" />
                          <div className="px-2 py-1 flex items-center gap-2 bg-[rgba(7,9,18,0.9)]">
                            <span className={`w-2 h-2 shrink-0 ${streamLive ? 'bg-teal' : 'bg-coral'}`} title={streamLive ? 'Кадры идут' : 'Ждём кадры'} />
                            <span className="font-pixel text-[7px] text-paper">ТРАНСЛЯЦИЯ · {stream!.name}</span>
                          </div>
                        </div>
                      ) : (
                        <div className="aspect-[256/240] bg-black border-[3px] border-edge flex flex-col items-center justify-center gap-2">
                          <span className="text-dim">{Ic.eye(28)}</span>
                          <span className="font-pixel text-[8px] text-faint text-center px-4">
                            {options.broadcast
                              ? 'ОЖИДАНИЕ ТРАНСЛЯЦИИ…'
                              : 'ТРАНСЛЯЦИЯ ВЫКЛЮЧЕНА В ОПЦИЯХ'}
                          </span>
                        </div>
                      )}
                      {myTurn && (
                        <div className="mt-1.5 tick-label text-faint">
                          {isSega
                            ? 'SEGA · Стрелки · Z=A · X=B · C=C · A=X · S=Y · D=Z · Enter=Start'
                            : 'NES · Стрелки · Z=B · X=A · Enter=Start · Shift=Select'}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      {myTurn && ch.status === 'ready' && (
                        <>
                          <PxBtn big color="gold" className="w-full pulse-ring" onClick={() => { sfx.start(); dispatch({ t: 'startTask', id: me }); }}>
                            {Ic.play(16)} Запуск задания
                          </PxBtn>
                          {ch.mode === 'coins' ? (
                            <p className="text-[10px] text-dim leading-tight">
                              Эмулятор загружен и ждёт. Монетная игра: во время задания ничего не списывается — победа принесёт {map.taskWinCoins ?? 0} бр, пропуск обойдётся в {map.skipCoins ?? 5} бр. Перезапуски бесплатны и бесконечны.
                            </p>
                          ) : (
                            <p className="text-[10px] text-dim leading-tight">
                              Эмулятор загружен и ждёт. {ch.mode === 'time' ? 'Таймер пойдёт' : 'Попытка спишется'} только после запуска — можно спокойно подготовиться.
                            </p>
                          )}
                          {ch.mode === 'coins' ? (
                            <GhostBtn
                              className="w-full"
                              disabled={(mePlayer?.coinsLeft ?? 0) > 0 && (mePlayer?.coinsLeft ?? 0) < skipCoinsNeed}
                              title={(mePlayer?.coinsLeft ?? 0) > 0 && (mePlayer?.coinsLeft ?? 0) < skipCoinsNeed ? 'Монет не хватает на плату за пропуск — играйте и побеждайте' : undefined}
                              onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: 'coins', spentMs: 0, loads: 0 })}
                            >
                              {Ic.bolt(13)} Пропустить · {skipCoinsNeed} бр
                            </GhostBtn>
                          ) : (
                            <GhostBtn
                              className="w-full"
                              disabled={ch.lowStart === true}
                              title={ch.lowStart ? 'Ресурса меньше цены пропуска — авансом заплатить нельзя. Запускайте и тратьте ресурс: «Пропустить» разблокируется на нуле' : undefined}
                              onClick={() => dispatch({ t: 'skip', id: me, instant: true, spentMs: 0, loads: 0 })}
                            >
                              {Ic.bolt(13)} Заплатить {skipNeed} и пропустить
                            </GhostBtn>
                          )}
                          {immuneBtns}
                        </>
                      )}
                      {myTurn && (ch.status === 'playing' || ch.status === 'voting') && (
                        <>
                          <GhostBtn
                            className="w-full"
                            disabled={!canReload}
                            title={!canReload ? 'Ресурс закончился — перезапускать нечем. Пропустите задание (кнопка «Пропустить»)' : undefined}
                            onClick={() => dispatch({ t: 'reloadSave', id: me })}
                          >
                            {Ic.rotate(13)} Перезапуск задания
                          </GhostBtn>
                          <GhostBtn
                            className="w-full"
                            disabled={ch.status === 'voting'}
                            onClick={() => dispatch({ t: 'togglePause', id: me })}
                          >
                            {ch.paused ? Ic.play(13) : Ic.pause(13)} {ch.paused ? 'Продолжить' : 'Пауза'}
                          </GhostBtn>
                          {ch.paused && ch.status === 'playing' && !controlsLocked && (
                            <GhostBtn className="w-full border-magma/60 text-magma" onClick={() => setControlsOpen(true)}>
                              {Ic.gear(13)} Сменить управление
                            </GhostBtn>
                          )}
                          <PxBtn color="teal" className="w-full" onClick={() => dispatch({ t: 'declareDone', id: me })}>{Ic.check(14)} Прошёл задание</PxBtn>
                          {ch.mode === 'coins' ? (
                            <GhostBtn
                              className="w-full"
                              disabled={(mePlayer?.coinsLeft ?? 0) > 0 && (mePlayer?.coinsLeft ?? 0) < skipCoinsNeed}
                              title={(mePlayer?.coinsLeft ?? 0) > 0 && (mePlayer?.coinsLeft ?? 0) < skipCoinsNeed ? 'Монет не хватает на плату за пропуск — играйте и побеждайте' : undefined}
                              onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: 'coins', spentMs: 0, loads: 0 })}
                            >
                              {Ic.bolt(13)} Пропустить · {skipCoinsNeed} бр
                            </GhostBtn>
                          ) : (
                            <>
                              <GhostBtn
                                className="w-full"
                                disabled={!naturalCanSkip}
                                title={!naturalCanSkip ? (ch.lowStart ? 'Ресурса было меньше цены пропуска — кнопка разблокируется, когда ресурс закончится' : 'Сначала потратьте ресурсы — или платите сразу') : undefined}
                                onClick={() => info && dispatch({ t: 'skip', id: me, instant: false, spentMs: info.ms, loads: info.loads })}
                              >
                                {Ic.bolt(13)} Пропустить · потратить {ch.mode === 'time'
                                  ? `${naturalCanSkip && remainingNow <= 0 ? Math.max(1, Math.ceil((info?.ms ?? 0) / 60000)) : Math.max(info?.min ?? 0, skipNeed)} мин`
                                  : `${naturalCanSkip && remainingNow <= 0 ? Math.max(1, mePlayer?.triesLeft ?? 0) : Math.max(info?.loads ?? 0, skipNeed)} поп.`}
                              </GhostBtn>
                              <GhostBtn
                                className="w-full"
                                disabled={!instantSkipAllowed}
                                title={!instantSkipAllowed ? (ch.lowStart ? 'Ресурса было меньше цены пропуска — кнопка разблокируется, когда ресурс закончится' : 'Вы уже потратили достаточно ресурсов — используйте кнопку «Пропустить», она спишет фактическую цену') : undefined}
                                onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: ch.mode === 'time' ? 'time' : 'tries', spentMs: 0, loads: 0 })}
                              >
                                {Ic.bolt(13)} Заплатить {skipNeed} {ch.mode === 'time' ? 'мин' : 'поп.'} и пропустить
                              </GhostBtn>
                            </>
                          )}
                          {immuneBtns}
                        </>
                      )}
                      {!myTurn && others.some((p) => p.id === me) && (
                        <>
                          <GhostBtn className="w-full" onClick={() => { setInvOpen(true); sfx.click(); }}>
                            {Ic.grid(13)} Инвентарь{invCount > 0 ? ` · ${invCount}` : ''}{incomingTrades.length > 0 ? ' 💼' : ''}
                          </GhostBtn>
                          {ch.status === 'voting' ? (
                            <>
                              {!ch.approvals.includes(me) && (
                                <PxBtn color="teal" className="w-full" onClick={() => dispatch({ t: 'approve', id: me })}>{Ic.check(14)} Согласен</PxBtn>
                              )}
                              {!ch.violations.includes(me) && (
                                <PxBtn color="coral" className="w-full" onClick={() => dispatch({ t: 'violate', id: me })}>{Ic.cross(14)} Нарушил задание</PxBtn>
                              )}
                              <p className="text-[10px] text-dim leading-tight">Следите за экраном: если условия задания нарушены — жмите «Нарушил». Единогласно — сохранение перезагрузится.</p>
                            </>
                          ) : (
                            <PxBtn color="coral" className="w-full" onClick={() => dispatch({ t: 'violate', id: me })}>{Ic.cross(14)} Нарушил задание</PxBtn>
                          )}
                        </>
                      )}
                      {ch.status === 'voting' && myTurn && (
                        <p className="font-pixel text-[8px] text-gold blink-hard text-center py-2">ЖДЁМ ПОДТВЕРЖДЕНИЯ ИГРОКОВ…</p>
                      )}
                      {mePlayer && !mePlayer.alive && (
                        <p className="font-pixel text-[8px] text-faint text-center py-2">НАБЛЮДЕНИЕ</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Modal>
        </div>
      )}

      {/* ---------- пик карты поверх модалок ---------- */}
      {peekMap && (
        <div className="fixed inset-0 z-[85] flex flex-col pointer-events-none">
          <div className="flex items-center gap-3 px-4 py-2 pointer-events-auto bg-[rgba(7,9,18,0.85)] border-b-2 border-edge">
            <span className="font-display uppercase text-gold text-sm flex items-center gap-2">{Ic.map(15)} Карта мира — игра продолжается</span>
            <PxBtn small className="ml-auto" onClick={() => setPeekMap(false)}>{Ic.cross(12)} Вернуться</PxBtn>
          </div>
          <div className="text-center text-faint tick-label pt-2">Эмулятор поставлен на паузу — вернитесь и нажмите «Продолжить»</div>
        </div>
      )}

      {/* ---------- инвентарь карточек (виден и зрителям) ---------- */}
      {invOpen && <InventoryModal onClose={() => setInvOpen(false)} />}

      {/* ---------- наш редактор управления (клавиатура + геймпад) ---------- */}
      {controlsOpen && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[rgba(4,6,14,0.88)]" onClick={() => setControlsOpen(false)} />
          <div className="relative pixel-panel pixel-corners pop-in w-full max-w-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-magma">{Ic.gear(18)}</span>
              <span className="font-display uppercase tracking-wider text-paper text-sm">
                Управление · {isSega ? 'SEGA Genesis' : 'NES'}
              </span>
              <span className="tick-label text-gold ml-2">применяется сразу</span>
              <GhostBtn small className="ml-auto" onClick={() => setControlsOpen(false)}>{Ic.cross(12)} Закрыть</GhostBtn>
            </div>
            <KeyBinder compact mode={isSega ? 'sega' : 'nes'} />
          </div>
        </div>
      )}

      {/* ---------- выбор после захвата (окно открывается ПОСЛЕ анимации победы) ---------- */}
      {s.awaitPost && myTurn && !ch && !(s.fxs ?? []).some((f) => f.gate) && (() => {
        const postTask = active ? cellTaskOf(s, map, active.pos) : null;
        const dice0Hint = postTask?.chaos === 'dice0';
        return (
          <Modal title={dice0Hint ? 'Задание пройдено!' : 'Ячейка захвачена!'} icon={Ic.trophy(16)} w="max-w-lg" locked>
            <p className="text-[13px] text-dim mb-4">
              {isSkill
                ? 'Челлендж пройден — вы сражались только с собой и победили. Ячейка разбита и пока пуста: она восстановится через 2 хода.'
                : dice0Hint
                  ? 'Задание с «Кубиками-0» пройдено. Пока вы не замените его, все, кто встанет на ячейку, будут бросать 0 и застревать. Вы — хозяин, вас проклятие не держит.'
                  : 'Победа! Фишка разбила ячейку: пока она пуста (восстановится через 2 хода), хозяин — вы. Что дальше?'}
            </p>
            {isSkill ? (
              <div className="space-y-3">
                <p className="text-[11px] text-magma border-2 border-magma/40 px-2 py-1.5">Создать задание нельзя: в SKILL CHALLENGE вы играете ОДИН и сражаетесь только с собой — заменять некому.</p>
                <button onClick={() => { sfx.coin(); dispatch({ t: 'postChoice', id: me, choice: 'continue' }); }} className="pixel-panel pixel-corners p-4 text-left hover:border-gold hover:-translate-y-0.5 transition-all cursor-pointer group w-full">
                  <span className="text-gold">{Ic.dice(22)}</span>
                  <div className="font-display uppercase text-paper group-hover:text-gold mt-2 text-sm">Играть дальше</div>
                  <div className="text-[10px] text-dim mt-1">Сохраняется право броска — продолжите ход</div>
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => { sfx.coin(); dispatch({ t: 'postChoice', id: me, choice: 'continue' }); }} className="pixel-panel pixel-corners p-4 text-left hover:border-gold hover:-translate-y-0.5 transition-all cursor-pointer group">
                  <span className="text-gold">{Ic.dice(22)}</span>
                  <div className="font-display uppercase text-paper group-hover:text-gold mt-2 text-sm">Играть дальше</div>
                  <div className="text-[10px] text-dim mt-1">Сохраняется право броска — продолжите ход</div>
                </button>
                <button onClick={() => { sfx.click(); setTplOpen(true); }} className="pixel-panel pixel-corners p-4 text-left hover:border-magma hover:-translate-y-0.5 transition-all cursor-pointer group">
                  <span className="text-magma">{Ic.cart(22)}</span>
                  <div className="font-display uppercase text-paper group-hover:text-magma mt-2 text-sm">Новое задание</div>
                  <div className="text-[10px] text-dim mt-1">{dice0Hint ? 'Замените задание — снимете проклятие с ячейки' : 'Задание вступит в силу через 3 хода, ячейка до этого — разбита и пуста (доп. ход сгорит)'}</div>
                </button>
              </div>
            )}
          </Modal>
        );
      })()}

      {/* ---------- осмотр ячейки на карте ---------- */}
      {inspectIdx !== null && <CellInspectModal idx={inspectIdx} onClose={() => setInspectIdx(null)} />}

      {/* ==================== RUBG: интерфейс режима ==================== */}
      {isRubg && s.phase === 'playing' && mePlayer && mePlayer.alive && !mePlayer.spect && (
        <>
          {/* ---------- ЛИЧНОЕ ЗАДАНИЕ: играешь только ты, другие не ждут ---------- */}
          {myJob !== undefined && myRubgTask && !peekMap && (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(4,6,14,0.78)] p-3">
              <div className="pixel-panel pixel-corners p-4 max-w-3xl w-full max-h-[93vh] overflow-y-auto">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="font-display uppercase text-lg text-gold">🎮 ЛИЧНОЕ ЗАДАНИЕ · {myRubgTask.title}</div>
                  <span className="font-pixel text-[8px] text-faint">Задание №{myJob.cellIdx + 1} · играешь ТОЛЬКО ты</span>
                </div>
                <p className="text-[12px] text-dim mt-1 leading-relaxed">{myRubgTask.desc}</p>
                <p className="text-[10px] text-faint mt-1">Никаких подтверждений — режим доверия. Победа: +{RUBG_WIN_HP}% HP + трофей, ячейка твоя. Поражение: −{RUBG_LOSE_HP}% HP. Остальные игроки продолжают бегать — на тебя никто не ждёт.</p>
                <div className="mt-3">
                  {rRomBuf ? (
                    <SegaBox
                      key={rEmuKey}
                      romData={rRomBuf}
                      ext={(rRomDef?.fileName.split('.').pop() ?? 'md').toLowerCase()}
                      core={rRomDef?.ext === 'nes' ? 'nes' : undefined}
                      remapSpec={remapSpec}
                      chaos={[]}
                      initialState={(rSaveState as string | null) ?? null}
                      paused={false}
                      onApi={(a) => { ejsApiRef.current = a; }}
                    />
                  ) : (
                    <div className="aspect-[256/240] max-h-[46vh] bg-black border-[3px] border-edge flex items-center justify-center">
                      <span className="font-pixel text-[8px] text-faint blink-hard">ЗАГРУЗКА РОМА…</span>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <PxBtn color="teal" onClick={() => { sfx.success(); dispatch({ t: 'rubgJobDone', id: me, cellIdx: myJob.cellIdx, win: true }); }}>
                    🏆 ПОБЕДА +{RUBG_WIN_HP}%
                  </PxBtn>
                  <PxBtn color="coral" onClick={() => { sfx.fail(); dispatch({ t: 'rubgJobDone', id: me, cellIdx: myJob.cellIdx, win: false }); }}>
                    💀 ПОРАЖЕНИЕ −{RUBG_LOSE_HP}%
                  </PxBtn>
                  <GhostBtn onClick={() => { dispatch({ t: 'rubgJobLeave', id: me, cellIdx: myJob.cellIdx }); }}>🚶 Уйти</GhostBtn>
                </div>
                <div className="mt-2 text-center">
                  <GhostBtn small onClick={() => setPeekMap(true)}>{Ic.map(12)} Глянуть карту мира</GhostBtn>
                </div>
              </div>
            </div>
          )}

          {/* ---------- КАРМАН: мини-игра вора ---------- */}
          {myStealing && (() => {
            const victim = s.players.find((x) => x.id === myStealing.victim);
            const items = victim?.items ?? [];
            const leftS = Math.max(0, (myStealing.startedAt + myStealing.dur * 1000 - Date.now()) / 1000);
            return (
              <div className="fixed inset-0 z-[62] flex items-center justify-center bg-[rgba(4,6,14,0.82)] p-4">
                <div className="pixel-panel pixel-corners p-5 max-w-sm w-full">
                  <div className="tick-label text-coral">🤏 РУКА В КАРМАНЕ · {victim?.name ?? '?'}</div>
                  <p className="text-[10px] text-faint mt-1">WASD/стрелки — двигай руку, ENTER/клик — укради. У хозяина уже рябит в глазах — торопись!</p>
                  <div className={`font-display text-3xl my-2 ${leftS < 2 ? 'text-coral blink-hard' : 'text-paper'}`}>{leftS.toFixed(1)} с</div>
                  <div className="space-y-1.5">
                    {items.length === 0 && <div className="text-[11px] text-dim">Карман пуст…</div>}
                    {items.map((it: RubgItem, i: number) => (
                      <button
                        key={it.id}
                        onClick={() => { setPocketCur(i); dispatch({ t: 'rubgStealPick', id: me, victimId: myStealing.victim, itemId: it.id }); }}
                        className={`w-full text-left px-3 py-2 border-2 cursor-pointer font-display text-[11px] ${i === pocketCur ? 'border-coral bg-coral/10 text-paper' : 'border-edge text-dim hover:border-edge2'}`}
                      >
                        {RUBG_ITEMS[it.kind].icon} {RUBG_ITEMS[it.kind].name}{it.kind === 'steal' && it.uses !== undefined ? ` (${it.uses} исп.)` : ''}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => dispatch({ t: 'rubgStealFail', id: me, victimId: myStealing.victim })} className="mt-3 text-[10px] text-faint underline cursor-pointer">Убрать руку (раскроешь себя)</button>
                </div>
              </div>
            );
})()}

          {/* ---------- ЖЕРТВА: помехи + кнопка «Остановить вора» ---------- */}
          {mySteal && !myStealing && (() => {
            const elapsed = Math.min(1, (Date.now() - mySteal.startedAt) / (mySteal.dur * 1000));
            const thiefP = s.players.find((x) => x.id === mySteal.thief);
            const cdLeft = Math.max(0, RUBG_STOP_CD * 1000 - (Date.now() - (rubg?.stopCd?.[me] ?? 0)));
            return (
              <>
                <div
                  className="fixed inset-0 z-[55] pointer-events-none"
                  style={{
                    opacity: 0.2 + elapsed * 0.65,
                    background: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.10) 0 2px, transparent 2px 5px), repeating-linear-gradient(90deg, rgba(255,93,115,0.12) 0 3px, transparent 3px 7px)',
                    mixBlendMode: 'screen',
                  }}
                />
                <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[56] text-center">
                  <div className="font-pixel text-[9px] text-coral blink-hard mb-1.5">🤏 {thiefP?.name ?? 'КТО-ТО'} РЫЕТСЯ В ТВОЁМ КАРМАНЕ!</div>
                  <PxBtn
                    color="coral"
                    disabled={cdLeft > 0}
                    onClick={() => dispatch({ t: 'rubgStopThief', id: me })}
                  >
                    {cdLeft > 0 ? `🚨 ОСТАНОВИТЬ ВОРа (${Math.ceil(cdLeft / 1000)}с)` : '🚨 ОСТАНОВИТЬ ВОРа!'}
                  </PxBtn>
                  <div className="text-[9px] text-faint mt-1">Кулдаун {RUBG_STOP_CD} с — не спамь зря</div>
                </div>
              </>
            );
          })()}

          {/* ---------- ИНВЕНТАРЬ RUBG ---------- */}
          {mySteal === undefined && (
            <div className="fixed bottom-3 right-3 z-30 w-60 pixel-panel pixel-corners p-2.5 space-y-1.5 max-h-[52vh] overflow-y-auto">
              <div className="tick-label">🎒 ИНВЕНТАРЬ · HP {Math.round(mePlayer.hp ?? 100)}%</div>
              {(mePlayer.items ?? []).length === 0 && <div className="text-[10px] text-faint">Пусто — ищи ЛУТБОКСЫ 📦</div>}
              {(mePlayer.items ?? []).map((it: RubgItem) => {
                const meta = RUBG_ITEMS[it.kind];
                const heal = meta.hp > 0 && meta.radius === 0;
                const weapon = meta.radius > 0;
                const isStealCard = it.kind === 'steal';
                const isStealthCard = it.kind === 'stealth';
                /* рядом есть играющий в радиусе кражи? */
                const mp = s.journeyPos?.[me];
                const stealTarget = isStealCard && mp
                  ? Object.entries(rubg?.jobs ?? {}).find(([pid]) => {
                      if (pid === me) return false;
                      const jp = s.journeyPos?.[pid];
                      return !!jp && Math.hypot(jp.x - mp.x, jp.y - mp.y) <= RUBG_STEAL_RANGE * CELL;
                    })
                  : undefined;
                return (
                  <div key={it.id} className="border-2 border-edge px-2 py-1.5">
                    <div className="font-display text-[11px] text-paper flex items-center gap-1.5">
                      <span>{meta.icon}</span>
                      <span className="min-w-0 truncate">{meta.name}</span>
                      {isStealCard && it.uses !== undefined && <span className="ml-auto font-pixel text-[8px] text-teal">×{it.uses}</span>}
                      {heal && <span className="ml-auto font-pixel text-[8px] text-teal">+{meta.hp}%</span>}
                      {weapon && <span className="ml-auto font-pixel text-[8px] text-coral">−{meta.hp}% · {meta.radius} кл</span>}
                    </div>
                    {heal && (
                      <button
                        onClick={() => dispatch({ t: 'rubgUseItem', id: me, itemId: it.id })}
                        disabled={(mePlayer.hp ?? 100) >= RUBG_HP_MAX}
                        className="mt-1 w-full py-1 border-2 border-teal text-teal font-pixel text-[8px] cursor-pointer hover:bg-teal/10 disabled:opacity-35 disabled:cursor-not-allowed"
                      >{(mePlayer.hp ?? 100) >= RUBG_HP_MAX ? 'HP ПОЛНОЕ' : 'ИСПОЛЬЗОВАТЬ'}</button>
                    )}
                    {isStealCard && (
                      <button
                        onPointerDown={stealHoldOn}
                        onPointerUp={stealHoldOff}
                        onPointerLeave={() => { if (stealHoldRef.current) stealHoldOff(); }}
                        disabled={!stealTarget}
                        className={`mt-1 w-full py-1.5 border-2 font-pixel text-[8px] select-none touch-none ${stealTarget ? 'border-coral text-coral cursor-pointer hover:bg-coral/10' : 'border-edge text-faint cursor-not-allowed'}`}
                      >{stealTarget ? '🤏 ДЕРЖИ — УКРАСТЬ' : 'подойди к играющему'}</button>
                    )}
                    {isStealthCard && (
                      <button
                        onClick={() => dispatch({ t: 'rubgStealth', id: me })}
                        className="mt-1 w-full py-1 border-2 border-[#c07aff] text-[#c07aff] font-pixel text-[8px] cursor-pointer hover:bg-[#c07aff]/10"
                      >👻 АКТИВИРОВАТЬ СТЕЛС</button>
                    )}
                    {weapon && (
                      <button
                        onClick={() => setAimItemId(aimItemId === it.id ? null : it.id)}
                        className="mt-1 w-full py-1 border-2 border-magma text-magma font-pixel text-[8px] cursor-pointer hover:bg-magma/10"
                      >{aimItemId === it.id ? 'ВЫБЕРИ ЦЕЛЬ ↓' : 'АТАКА →'}</button>
                    )}
                    {weapon && aimItemId === it.id && (() => {
                      const mp2 = s.journeyPos?.[me];
                      const range = meta.radius * CELL;
                      const targets = mp2
                        ? s.players.filter((q) => {
                            if (q.id === me || !q.alive || q.spect) return false;
                            if ((rubg?.stealth ?? []).includes(q.id)) return false; // в стелсе не видно
                            const jp = s.journeyPos?.[q.id];
                            return !!jp && Math.hypot(jp.x - mp2.x, jp.y - mp2.y) <= range;
                          })
                        : [];
                      return (
                        <div className="mt-1 space-y-1">
                          {targets.length === 0 && <div className="text-[9px] text-faint">Никого в радиусе {meta.radius} кл</div>}
                          {targets.map((q) => {
                            const jp = s.journeyPos?.[q.id]!;
                            const d2 = Math.hypot(jp.x - mp2!.x, jp.y - mp2!.y);
                            const busy = !!(rubg?.jobs ?? {})[q.id];
                            const chance = busy ? 100 : Math.round(Math.max(15, 1 - d2 / range) * 100);
                            return (
                              <button
                                key={q.id}
                                onClick={() => { dispatch({ t: 'rubgShoot', id: me, itemId: it.id, targetId: q.id }); setAimItemId(null); }}
                                className="w-full text-left px-2 py-1 border-2 border-edge font-pixel text-[8px] text-paper cursor-pointer hover:border-magma"
                              >
                                {busy ? '🎯' : '👟'} {q.name} · {Math.round(d2 / CELL)}кл · {chance}%{busy ? ' (играет)' : ''}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
              <p className="text-[8px] text-faint leading-tight">Своё задание на побеждённой ячейке создать нельзя — только лут и HP.</p>
            </div>
          )}
        </>
      )}

      {tplOpen && <TemplateModal cellIdx={active?.pos ?? 0} onClose={() => setTplOpen(false)} />}

      {/* ---------- квиз (видят все живые игроки) ---------- */}
      <QuizOverlay />
    </div>
  );
}

/* ---------- кубик ---------- */

function DieFace({ v, dropping, delay, rolling, blank, frame }: { v: number; dropping?: boolean; delay?: boolean; rolling?: boolean; blank?: boolean; frame?: string }) {
  const pips: Record<number, [number, number][]> = {
    0: [], // «Кубики-0»: пустая грань
    1: [[1, 1]],
    2: [[0, 0], [2, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [0, 2], [2, 0], [2, 2]],
    5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
    6: [[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2]],
  };
  if (blank) {
    return (
      <div
        className="w-16 h-16 border-[3px] border-dashed border-edge2 shadow-[0_6px_0_rgba(0,0,0,0.35)] flex items-center justify-center"
        style={frame ? { borderColor: frame, boxShadow: `0 6px 0 rgba(0,0,0,0.35), 0 0 10px ${frame}33` } : undefined}
      >
        <span className="font-pixel text-[12px] text-faint">?</span>
      </div>
    );
  }
  return (
    <div
      className={`w-16 h-16 bg-paper border-[3px] border-abyss shadow-[0_6px_0_rgba(0,0,0,0.5)] grid grid-cols-3 grid-rows-3 p-2 ${dropping ? 'dice-drop' : ''} ${rolling ? 'shake-hard' : ''}`}
      style={{
        ...(dropping && delay ? { animationDelay: '0.07s' } : {}),
        ...(frame ? { borderColor: frame, boxShadow: `0 6px 0 rgba(0,0,0,0.5), 0 0 14px ${frame}44` } : {}),
      }}
    >
      {[...Array(9)].map((_, i) => {
        const r = Math.floor(i / 3), c = i % 3;
        const on = (pips[v] ?? pips[1]).some(([pr, pc]) => pr === r && pc === c);
        return <span key={i} className={`rounded-[2px] ${on ? 'bg-abyss' : ''}`} />;
      })}
    </div>
  );
}

/* ---------- шаблон нового задания ---------- */

function TemplateModal({ cellIdx, onClose }: { cellIdx: number; onClose: () => void }) {
  const { roms, saves, session, selfId } = useApp();
  const [romId, setRomId] = useState('');
  const [saveId, setSaveId] = useState('');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [chaosCardId, setChaosCardId] = useState('');
  const [joyId, setJoyId] = useState('');
  const romSaves = saves.filter((x) => x.romId === romId);
  /* в игре выбираются ТОЛЬКО уровни/боссы/моё задание — частные живут в редакторе заданий */
  const pickableSaves = romSaves.filter((x) => saveKindOf(x) !== 'private');
  /* ромы группируются по папкам — как в «Запуске эмулятора» и редакторе заданий */
  const romFolders = [...new Set(roms.map((r) => r.folder ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const looseRoms = roms.filter((r) => !r.folder);
  const mePlayer = session?.players.find((p) => p.id === selfId);
  const chaosCards = (mePlayer?.inventory ?? []).filter((c) => !!c.chaos);

  const apply = () => {
    const romIsNes = roms.find((r) => r.id === romId)?.ext === 'nes';
    if (!romId || (romIsNes && !saveId)) {
      useApp.getState().toast(romIsNes ? 'Выберите ром и сохранение' : 'Выберите ром', 'err');
      return;
    }
    const task: TaskDef = {
      romId, saveId: saveId || undefined,
      title: title.trim() || (roms.find((r) => r.id === romId)?.name ?? 'Задание'),
      desc: desc.trim() || 'Задание, придуманное игроком на этой сессии.',
      joy: (joyId || undefined) as TaskDef['joy'],
    };
    dispatch({ t: 'setCellTask', id: useApp.getState().selfId, cellIdx, task, cardId: chaosCardId || undefined });
    sfx.success();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[rgba(4,6,14,0.85)]" onClick={onClose} />
      <div className="relative pixel-panel pixel-corners pop-in w-full max-w-md p-5">
        <div className="font-display uppercase tracking-wide text-magma text-sm mb-3 flex items-center gap-2">
          {Ic.cart(16)} Шаблон задания · ячейка №{cellIdx + 1}
        </div>
        <p className="text-[11px] text-dim mb-3">Ром и сохранение из библиотеки — как в папках с шаблонами. Задание действует до конца этой сессии.</p>
        <div className="space-y-3">
          <Field label="Ром (по папкам)">
            <select className="field-in w-full px-2 py-2 text-sm" value={romId} onChange={(e) => { setRomId(e.target.value); setSaveId(''); }}>
              <option value="">— выбрать —</option>
              {romFolders.map((f) => (
                <optgroup key={`f-${f}`} label={`📁 ${f}`}>
                  {roms.filter((r) => r.folder === f).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </optgroup>
              ))}
              {looseRoms.length > 0 && (
                romFolders.length
                  ? <optgroup label="Без папки">{looseRoms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</optgroup>
                  : looseRoms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)
              )}
            </select>
          </Field>
          <Field label="Сохранение (уровни / боссы / моё задание)">
            <select className="field-in w-full px-2 py-2 text-sm" value={saveId} onChange={(e) => setSaveId(e.target.value)}>
              <option value="">— без сохранения (старт с начала) —</option>
              {(['level', 'boss', 'mytask'] as const).map((k) => {
                const list = pickableSaves.filter((x) => saveKindOf(x) === k);
                if (!list.length) return null;
                return (
                  <optgroup key={k} label={SAVE_KIND_LABEL[k]}>
                    {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </optgroup>
                );
              })}
            </select>
            <p className="text-[10px] text-faint mt-1">Частные сохранения в игре не выбираются — они доступны только в редакторе заданий.</p>
          </Field>
          <Field label="Название">
            <input className="field-in w-full px-3 py-2 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chip'n'Dale 2 — босс" />
          </Field>
          <Field label="Описание">
            <textarea className="field-in w-full px-3 py-2 text-sm h-16 resize-none" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Пройти босса с одной полоской здоровья…" />
          </Field>
          <Field label="Пакость из инвентаря (необязательно, максимум одна)">
            {chaosCards.length === 0 ? (
              <p className="text-[11px] text-dim">В инвентаре нет пакостных карточек — они выпадают на ячейках-шансах.</p>
            ) : (
              <div className="grid gap-1 max-h-[150px] overflow-y-auto pr-1">
                <button
                  onClick={() => setChaosCardId('')}
                  className={`text-left px-2.5 py-1.5 border-2 text-[11px] cursor-pointer transition-colors ${chaosCardId === '' ? 'border-edge2 text-paper' : 'border-edge text-dim hover:border-edge2'}`}
                >
                  {chaosCardId === '' ? '●' : '○'} Без пакости
                </button>
                {chaosCards.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setChaosCardId(c.id); sfx.hover(); }}
                    className={`text-left px-2.5 py-1.5 border-2 text-[11px] cursor-pointer transition-colors ${chaosCardId === c.id ? 'border-magma bg-magma/10 text-paper' : 'border-edge text-dim hover:border-edge2'}`}
                    title={c.desc}
                  >
                    {chaosCardId === c.id ? '●' : '○'} 😈 {c.name}
                  </button>
                ))}
              </div>
            )}
            {chaosCardId && <p className="text-[10.5px] text-magma mt-1">Карточка будет потрачена — следующий играющий здесь получит пакость.</p>}
          </Field>
          <Field label="Радость за прохождение (награда прошедшему, максимум одна)">
            <select className="field-in w-full px-2 py-2 text-sm" value={joyId} onChange={(e) => { setJoyId(e.target.value); sfx.hover(); }}>
              <option value="">— без радости —</option>
              {JOY_LIST.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
            {joyId && (
              <p className="text-[10.5px] text-teal mt-1">🎉 {JOY_LIST.find((j) => j.id === joyId)?.desc}</p>
            )}
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <GhostBtn onClick={onClose}>Отмена</GhostBtn>
            <PxBtn color="magma" onClick={apply}>{Ic.check(14)} Заменить задание</PxBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

void idbGet;

/* ---------- инвентарь: монопольные карточки, торги карточками и ячейками ---------- */

const fmtPrice = (m: number, t: number): string =>
  m > 0 && t > 0 ? `${m} мин + ${t} поп.` : m > 0 ? `${m} мин` : `${t} поп.`;

/* Цвета карточек «как в монополии»: цветная обводка + цветная шапка с названием */
function cardColors(c: CardDef): { band: string; ink: string } {
  if (c.chaos) return { band: '#ff5d73', ink: '#2a0810' };
  if (c.kind === 'joy') return { band: '#2ee6a8', ink: '#06281c' };
  if (c.kind === 'trap') return { band: '#ff8b3f', ink: '#2b1204' };
  return { band: '#ffcf3f', ink: '#2b2004' };
}

const cardBadge = (c: CardDef): string => {
  if (c.chaos) return '😈 ПАКОСТЬ';
  if (c.kind === 'joy') {
    if (c.effect.type === 'immuneSega' || c.effect.type === 'immuneNes') return '🛡 ИММУНИТЕТ';
    return '🎉 РАДОСТЬ';
  }
  return c.kind === 'trap' ? '☠ ЛОВУШКА' : '🌟 БОНУС';
};

function InventoryModal({ onClose }: { onClose: () => void }) {
  const st = useApp();
  const s = st.session;
  const map = st.sessionMap;
  const me = st.selfId;
  const [sellSel, setSellSel] = useState<{ kind: 'card' | 'cell'; id: string; name: string } | null>(null);
  const [sellTo, setSellTo] = useState('');
  const [sellMin, setSellMin] = useState(5);
  const [sellTries, setSellTries] = useState(0);
  const [counterOfferId, setCounterOfferId] = useState('');
  const [cMin, setCMin] = useState(3);
  const [cTries, setCTries] = useState(3);
  if (!s) return null;
  const mePlayer = s.players.find((p) => p.id === me);
  const active = s.players[s.turn % s.players.length];
  const myTurn = !!active && active.id === me;
  const inv = mePlayer?.inventory ?? [];
  const trades = s.trades ?? [];
  const isOpen = (o: { status: string }) => o.status === 'pending' || o.status === 'countered';
  const reservedIds = new Set(trades.filter(isOpen).map((o) => o.cardId));
  const reservedCells = new Set(trades.filter(isOpen).map((o) => o.cellIdx));
  const busy = !!(s.moving || s.challenge || s.pendingCard || s.quiz || s.awaitPost);
  const joyUsedThisTurn = (mePlayer?.joyTurn ?? -1) === (s.turnNo ?? 1);
  const findCard = (id: string): { card: CardDef; ownerName: string } | null => {
    for (const p of s.players) {
      const c = (p.inventory ?? []).find((x) => x.id === id);
      if (c) return { card: c, ownerName: p.name };
    }
    return null;
  };
  const cellTitle = (idx: number): string => {
    const cell = map?.cells[idx];
    if (!cell) return `Ячейка №${idx + 1}`;
    const t = cell.task?.title ? ` · ${cell.task.title}` : '';
    return `Ячейка ${cell.nonumber || cell.n === 0 ? 'без номера' : '№' + cell.n}${cell.label ? ` «${cell.label}»` : ''}${t}`;
  };
  const sellTargets = s.players.filter((p) => p.alive && p.id !== me && (p.id !== active?.id || !busy));
  const incoming = trades.filter((o) => o.to === me && isOpen(o));
  const outgoing = trades.filter((o) => o.from === me && isOpen(o));
  const myCells = Object.entries(s.captured ?? {})
    .map(([k, v]) => ({ idx: Number(k), owner: v as string }))
    .filter((x) => x.owner === me && map?.cells[x.idx])
    .sort((a, b) => a.idx - b.idx);
  const canSell = !myTurn || !busy; // текущий игрок тоже может торговать — пока не бросил кубики
  const joyAppliable = (c: CardDef) =>
    !c.chaos && c.effect.type !== 'immuneSega' && c.effect.type !== 'immuneNes';

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[rgba(4,6,14,0.88)]" onClick={onClose} />
      <div className="relative pixel-panel pixel-corners pop-in w-full max-w-3xl max-h-[92vh] overflow-y-auto p-5">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-teal">{Ic.grid(18)}</span>
          <span className="font-display uppercase tracking-wider text-paper text-sm">Инвентарь</span>
          <span className="tick-label text-gold">{fmtClock(mePlayer?.secLeft ?? 0)} · {mePlayer?.triesLeft ?? 0} поп.</span>
          {myTurn && (busy
            ? <span className="tick-label text-magma">ваш ход — торги недоступны</span>
            : <span className="tick-label text-teal">ваш ход — торги открыты до броска кубиков</span>)}
          <GhostBtn small className="ml-auto" onClick={onClose}>{Ic.cross(12)} Закрыть</GhostBtn>
        </div>

        {/* входящие предложения */}
        {incoming.length > 0 && (
          <div className="space-y-2 mb-4">
            <div className="tick-label text-gold">💼 Предложения вам</div>
            {incoming.map((o) => {
              const info = findCard(o.cardId ?? '');
              const item = o.cellIdx !== undefined ? cellTitle(o.cellIdx) : info?.card.name ?? '—';
              const isCell = o.cellIdx !== undefined;
              const afford = (mePlayer?.secLeft ?? 0) >= o.priceMin * 60 && (mePlayer?.triesLeft ?? 0) >= o.priceTries;
              const counterSent = o.status === 'countered';
              return (
                <div key={o.id} className="border-2 border-gold bg-gold/10 px-3 py-2.5 space-y-2">
                  <div className="text-[12px] text-paper">
                    <span className="font-display uppercase">{info?.ownerName ?? s.players.find((p) => p.id === o.from)?.name ?? 'Игрок'}</span>{' '}
                    предлагает {isCell ? 'ЯЧЕЙКУ' : 'карточку'} «{item}» за {fmtPrice(o.priceMin, o.priceTries)}
                  </div>
                  {isCell && <div className="text-[10.5px] text-dim">Покупка ячейки: хозяином становитесь вы, задание остаётся прежним — создавать новое не нужно.</div>}
                  {counterSent ? (
                    <>
                      <div className="text-[11px] text-dim">Вы предложили встречную цену: {fmtPrice(o.counterMin ?? 0, o.counterTries ?? 0)} — ждём ответа владельца…</div>
                      <GhostBtn small onClick={() => dispatch({ t: 'tradeReply', id: me, offerId: o.id, kind: 'decline' })}>Отменить встречное</GhostBtn>
                    </>
                  ) : (
                    <>
                      <div className="flex gap-2 flex-wrap">
                        <PxBtn
                          small
                          color="teal"
                          disabled={!afford}
                          title={!afford ? 'Не хватает минут/попыток на оплату' : undefined}
                          onClick={() => dispatch({ t: 'tradeReply', id: me, offerId: o.id, kind: 'accept' })}
                        >
                          {Ic.check(12)} Купить
                        </PxBtn>
                        <GhostBtn small onClick={() => { setCounterOfferId(counterOfferId === o.id ? '' : o.id); setCMin(Math.max(1, o.priceMin)); setCTries(o.priceTries); sfx.click(); }}>
                          Своя цена
                        </GhostBtn>
                        <GhostBtn small onClick={() => dispatch({ t: 'tradeReply', id: me, offerId: o.id, kind: 'decline' })}>Отказаться</GhostBtn>
                      </div>
                      {counterOfferId === o.id && (
                        <div className="border-2 border-edge p-2 space-y-2 bg-[rgba(0,0,0,0.25)]">
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <span className="text-[11px] text-dim">Минуты</span>
                            <Stepper value={cMin} onChange={setCMin} min={0} max={90} suffix=" мин" />
                          </div>
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <span className="text-[11px] text-dim">Попытки</span>
                            <Stepper value={cTries} onChange={setCTries} min={0} max={90} suffix=" поп." />
                          </div>
                          <PxBtn
                            small
                            color="gold"
                            disabled={cMin + cTries <= 0}
                            onClick={() => { dispatch({ t: 'tradeReply', id: me, offerId: o.id, kind: 'counter', counterMin: cMin, counterTries: cTries }); setCounterOfferId(''); }}
                          >
                            Отправить встречное предложение
                          </PxBtn>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* исходящие предложения */}
        {outgoing.length > 0 && (
          <div className="space-y-2 mb-4">
            <div className="tick-label text-sky">📤 Ваши предложения</div>
            {outgoing.map((o) => {
              const buyer = s.players.find((p) => p.id === o.to);
              const item = o.cellIdx !== undefined ? cellTitle(o.cellIdx) : findCard(o.cardId ?? '')?.card.name ?? '—';
              return (
                <div key={o.id} className="border-2 border-edge bg-panel px-3 py-2.5 space-y-1.5">
                  {o.status === 'pending' ? (
                    <div className="text-[12px] text-paper">«{item}» → {buyer?.name ?? '—'}: ждём ответа…</div>
                  ) : (
                    <div className="text-[12px] text-paper">
                      {buyer?.name ?? '—'} предлагает встречную цену: {fmtPrice(o.counterMin ?? 0, o.counterTries ?? 0)}
                    </div>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    {o.status === 'countered' && (
                      <PxBtn small color="teal" onClick={() => dispatch({ t: 'tradeResolve', id: me, offerId: o.id, accept: true })}>
                        {Ic.check(12)} Согласиться на встречную
                      </PxBtn>
                    )}
                    <GhostBtn small onClick={() => dispatch({ t: 'tradeResolve', id: me, offerId: o.id, accept: false })}>
                      {o.status === 'countered' ? 'Отказаться' : 'Отменить предложение'}
                    </GhostBtn>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* форма продажи карточки или ячейки */}
        {sellSel && (
          <div className="border-2 border-gold/60 bg-gold/5 p-3 mb-4 space-y-2">
            <div className="font-display text-[12px] uppercase text-gold">
              Продажа: {sellSel.kind === 'cell' ? 'ячейка' : 'карточка'} «{sellSel.name}»
            </div>
            {sellSel.kind === 'cell' && (
              <p className="text-[10.5px] text-dim">Покупатель станет хозяином ячейки; задание останется прежним — новое создавать не нужно.</p>
            )}
            <Field label="Покупатель (играющего сейчас предложить нельзя)">
              <select className="field-in w-full px-2 py-2 text-sm" value={sellTo} onChange={(e) => setSellTo(e.target.value)}>
                <option value="">— выбрать игрока —</option>
                {sellTargets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {fmtClock(p.secLeft)} · {p.triesLeft} поп.</option>
                ))}
              </select>
            </Field>
            {sellTargets.length === 0 && <p className="text-[10.5px] text-magma">Живых покупателей нет (или все, кроме играющего, выбыли).</p>}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[11px] text-dim">Цена: минуты</span>
              <Stepper value={sellMin} onChange={setSellMin} min={0} max={90} suffix=" мин" />
            </div>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[11px] text-dim">Цена: попытки</span>
              <Stepper value={sellTries} onChange={setSellTries} min={0} max={90} suffix=" поп." />
            </div>
            <div className="flex gap-2">
              <PxBtn
                color="gold"
                disabled={!sellTo || sellMin + sellTries <= 0}
                onClick={() => {
                  dispatch({
                    t: 'tradeOffer', id: me, to: sellTo, priceMin: sellMin, priceTries: sellTries,
                    ...(sellSel.kind === 'cell' ? { cellIdx: Number(sellSel.id) } : { cardId: sellSel.id }),
                  });
                  setSellSel(null);
                  setSellTo('');
                }}
              >
                {Ic.check(14)} Предложить за {fmtPrice(sellMin, sellTries)}
              </PxBtn>
              <GhostBtn onClick={() => setSellSel(null)}>Отмена</GhostBtn>
            </div>
          </div>
        )}

        {/* мои карточки — «как в монополии»: вертикальные карточки с цветной шапкой */}
        <div className="space-y-2">
          <div className="tick-label text-faint">Мои карточки · {inv.length}</div>
          {inv.length === 0 ? (
            <div className="text-center py-6 text-dim text-[12px]">
              Инвентарь пуст. Пакости выпадают на ячейках-шансах (если создатель карты их добавил),
              радости — за прохождение заданий с наградой. Карточку можно применить, продать или обменять.
            </div>
          ) : (
            <div className="flex flex-wrap gap-3 pt-1">
              {inv.map((c, i) => {
                const col = cardColors(c);
                const reserved = reservedIds.has(c.id);
                return (
                  <div key={`${c.id}-${i}`} className="flex flex-col gap-1.5" style={{ width: 124 }}>
                    {/* карточка «как в монополии»: вертикаль 1:2, обводка цветом, название в шапке */}
                    <div
                      className="flex flex-col border-[3px] bg-[#f6f2e3] text-[#23263a] shadow-[0_5px_0_rgba(0,0,0,0.4)]"
                      style={{ borderColor: col.band, height: 186 }}
                      title={c.desc}
                    >
                      <div
                        className="text-center font-display uppercase text-[10px] leading-[1.15] px-1 py-1.5 border-b-[3px] break-words"
                        style={{ borderColor: col.band, background: col.band, color: col.ink }}
                      >
                        {c.name}
                      </div>
                      <div className="flex-1 px-1.5 py-1 text-[9px] leading-[1.25] overflow-hidden">{c.desc}</div>
                      <div className="px-1.5 py-1 text-center font-pixel text-[7px] border-t-[3px]" style={{ borderColor: col.band, color: col.ink }}>
                        {cardBadge(c)}
                      </div>
                    </div>
                    {reserved && <span className="font-pixel text-[7px] text-gold text-center">💼 В СДЕЛКЕ</span>}
                    <div className="flex gap-1">
                      {joyAppliable(c) && (
                        <button
                          className="flex-1 font-pixel text-[7px] py-1 border-2 border-teal text-teal hover:bg-teal/15 cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
                          disabled={!myTurn || busy || reserved || joyUsedThisTurn}
                          title={
                            reserved ? 'Карточка зарезервирована сделкой'
                            : !myTurn || busy ? 'Применять — только в свой ход до броска, когда стол пуст'
                            : joyUsedThisTurn ? 'Одна радость на ход уже использована'
                            : undefined
                          }
                          onClick={() => { dispatch({ t: 'useCard', id: me, cardId: c.id }); sfx.card(); }}
                        >
                          ▶ ПРИМЕНИТЬ
                        </button>
                      )}
                      <button
                        className="flex-1 font-pixel text-[7px] py-1 border-2 border-edge text-dim hover:border-gold hover:text-gold cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
                        disabled={!canSell || reserved}
                        title={
                          reserved ? 'Карточка уже участвует в сделке'
                          : !canSell ? 'Ход уже начался — торговать можно только до броска кубиков'
                          : undefined
                        }
                        onClick={() => { setSellSel({ kind: 'card', id: c.id, name: c.name }); setSellTo(''); setSellMin(5); setSellTries(0); sfx.click(); }}
                      >
                        ПРОДАТЬ
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* мои ячейки — можно продать/обменять */}
        <div className="space-y-2 mt-5">
          <div className="tick-label text-faint">Мои ячейки · {myCells.length}</div>
          {myCells.length === 0 ? (
            <div className="text-center py-4 text-dim text-[12px]">
              Захваченных ячеек пока нет. Пройдите задание на чужой или свободной ячейке — и сможете продавать её соперникам.
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-2">
              {myCells.map(({ idx }) => {
                const cell = map!.cells[idx];
                const underChallenge = s.challenge?.cellIdx === idx;
                const reserved = reservedCells.has(idx);
                return (
                  <div key={idx} className="border-2 px-3 py-2.5 flex items-center gap-2 bg-panel" style={{ borderColor: cell.color || 'var(--color-edge)' }}>
                    <span className="w-3.5 h-3.5 border border-abyss shrink-0" style={{ background: cell.color ?? '#5aa9ff' }} />
                    <div className="min-w-0 flex-1">
                      <div className="font-display text-[11px] uppercase text-paper truncate">{cellTitle(idx)}</div>
                      <div className="text-[10px] text-dim truncate">{cell.task ? `Ром: ${cell.task.title}` : 'без задания'}</div>
                    </div>
                    <GhostBtn
                      small
                      disabled={!canSell || reserved || underChallenge}
                      title={
                        reserved ? 'Ячейка уже участвует в сделке'
                        : underChallenge ? 'На ячейке сейчас идёт задание'
                        : !canSell ? 'Ход уже начался — торговать можно только до броска кубиков'
                        : undefined
                      }
                      onClick={() => { setSellSel({ kind: 'cell', id: String(idx), name: cellTitle(idx) }); setSellTo(''); setSellMin(5); setSellTries(0); sfx.click(); }}
                    >
                      Продать
                    </GhostBtn>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-faint leading-tight">
            Торговать могут только игроки, которые сейчас НЕ играют: играющий видит трансляцию, но купить/продать не может.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------- осмотр ячейки на карте (для всех, включая зрителей) ---------- */

function CellInspectModal({ idx, onClose }: { idx: number; onClose: () => void }) {
  const st = useApp();
  const s = st.session;
  const map = st.sessionMap;
  const cell = map?.cells[idx];
  const task = s && map ? cellTaskOf(s, map, idx) : null;
  const taskImg = useBlobImage(task?.imageId);
  const cellImg = useBlobImage(cell?.imageId);
  if (!s || !map || !cell) return null;
  const ownerId = s.captured?.[idx];
  const owner = ownerId ? s.players.find((p) => p.id === ownerId) : null;
  const revealed = (s.revealed ?? []).includes(idx) || !!ownerId;
  const hidden = !!st.options.hideUnrevealed && !revealed;
  const rom = task ? st.roms.find((r) => r.id === task.romId) : undefined;
  const typeLabel = cell.type === 'task' ? 'Задание' : cell.type === 'rest' ? 'Передышка' : cell.type === 'bonus' ? 'Бонус (шанс)' : cell.type === 'trap' ? 'Ловушка' : 'Квиз';
  const typeColor = cell.type === 'task' ? 'text-gold' : cell.type === 'rest' ? 'text-dim' : cell.type === 'bonus' ? 'text-teal' : cell.type === 'trap' ? 'text-coral' : 'text-sky';
  const joyMeta = task?.joy ? JOY_LIST.find((j) => j.id === task.joy) : null;
  return (
    <Modal title={`${cell.nonumber || cell.n === 0 ? 'Ячейка без номера' : `Ячейка №${cell.n}`}${cell.label ? ` · ${cell.label}` : ''}`} icon={Ic.target(16)} w="max-w-md" onClose={onClose}>
      {hidden ? (
        <p className="text-[12px] text-dim text-center py-6">
          Ячейка ещё не открывалась в партии — содержимое скрыто опцией «скрывать непосещённые ячейки».
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`hud-chip pixel-corners px-3 py-1.5 font-display text-[11px] uppercase ${typeColor}`}>{typeLabel}</span>
            {cell.color && <span className="w-4 h-4 border border-abyss" style={{ background: cell.color }} />}
            {owner ? (
              <span className="hud-chip pixel-corners px-3 py-1.5 text-[10.5px]" style={{ color: PLAYER_COLORS[owner.color] }}>
                Хозяин: {owner.name}
              </span>
            ) : (
              <span className="hud-chip pixel-corners px-3 py-1.5 text-[10.5px] text-dim">Хозяина нет</span>
            )}
          </div>
          {(cellImg || taskImg) && (
            <img src={(taskImg ?? cellImg)!} alt="" className="w-full border-[3px] border-edge object-cover max-h-44" />
          )}
          {cell.type === 'task' && task && (
            <>
              <div>
                <div className="tick-label text-gold mb-1">Задание</div>
                <div className="font-display uppercase text-[13px] text-paper">{task.title}</div>
                <p className="text-[12px] text-dim leading-relaxed mt-1">{task.desc}</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[9px] text-faint">
                  {rom ? (rom.ext === 'nes' ? 'NES' : 'SEGA') : 'РОМ'} · {rom?.name ?? task.romId}
                </span>
                {task.chaos && (
                  <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[9px] text-magma" title={CHAOS_LIST.find((c) => c.kind === task.chaos)?.desc}>
                    😈 {chaosLabel(task.chaos)}
                  </span>
                )}
                {joyMeta && (
                  <span className="hud-chip pixel-corners px-3 py-1.5 font-pixel text-[9px] text-teal" title={joyMeta.desc}>
                    🎉 {joyMeta.name}
                  </span>
                )}
              </div>
            </>
          )}
          {cell.type === 'task' && !task && (
            <p className="text-[12px] text-dim">Задания на этой ячейке нет — передышка (пока игрок не создаст своё).</p>
          )}
          {cell.type === 'rest' && (
            <p className="text-[12px] text-dim">Пустая клетка-передышка: здесь ничего не происходит — фишка просто отдыхает, ход переходит дальше.</p>
          )}
          {cell.type === 'bonus' && (
            <p className="text-[12px] text-dim">Ячейка-шанс: выпадает случайная карточка из колоды бонусов ({map.bonusCards.length} шт., включая пакости).</p>
          )}
          {cell.type === 'trap' && (
            <p className="text-[12px] text-dim">Ячейка-ловушка: выпадает случайная карточка из колоды ловушек ({map.trapCards.length} шт.).</p>
          )}
          {cell.type === 'quiz' && (
            <p className="text-[12px] text-dim">Ячейка-квиз: прозвучит случайный вопрос из колоды ({(map.quizzes ?? []).length} шт.).</p>
          )}
        </div>
      )}
    </Modal>
  );
}
