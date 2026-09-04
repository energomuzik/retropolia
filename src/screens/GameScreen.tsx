import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, getRomData, useBlobImage } from '../store';
import { dispatch, streamBus, type StreamPacket } from '../useGame';
import { CELL, cellCenter, drawBoard, fitView } from '../render';
import { cellTaskOf, fmtClock, spentInfo } from '../engine';
import { effectLabel } from './TaskEditor';
import { cardArt, cartridgeArt } from '../assets';
import SegaBox, { type SegaApi } from '../SegaBox';
import KeyBinder from '../KeyBinder';
import {
  loadEmuPrefs, PREFS_EVENT, codeToEjsKey,
  PAD_ACTIONS, SEGA_ACTIONS,
  NES_TO_RETRO, SEGA_TO_RETRO,
} from '../input';
import { saveSessionSnapshot } from './Lobby';
import QuizOverlay from './QuizOverlay';
import { Field, GhostBtn, Ic, Modal, PxBtn, Stepper } from '../ui';
import { PLAYER_COLORS, SKIP_COST, CHAOS_LIST, chaosLabel } from '../types';
import type { CardDef, ChaosKind, TaskDef } from '../types';
import { idbGet } from '../db';
import { sfx } from '../sound';

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
  const hopRef = useRef<Record<string, { queue: number[]; last: number }>>({});
  const arrivedRef = useRef(0);
  const holdStartRef = useRef(0);
  const shakeIntRef = useRef(0);

  const mePlayer = s?.players.find((p) => p.id === me);
  const active = s ? s.players[s.turn % s.players.length] : null;
  const myTurn = !!active && active.id === me;
  const ch = s?.challenge ?? null;
  const task = s && map && ch ? cellTaskOf(s, map, ch.cellIdx) : null;
  const activeChaos = task?.chaos ? [task.chaos] : [];
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
    }
  }, [s?.moving?.ts]);

  /* ---------- осмотр карты своим ходом сбрасывается при броске/челлендже ---------- */
  useEffect(() => {
    if (s?.moving || s?.challenge || s?.pendingCard || s?.quiz || s?.awaitPost) {
      lookPanRef.current = { x: 0, y: 0 };
      lookZoomRef.current = 1;
    }
  }, [s?.moving?.ts, s?.challenge, s?.pendingCard, s?.quiz, s?.awaitPost]);

  /* ---------- авто-доезд (страховка хоста) ---------- */
  useEffect(() => {
    if (!room?.isHost) return;
    const t = setInterval(() => {
      const cur = useApp.getState();
      const mv = cur.session?.moving;
      if (mv && Date.now() - mv.ts > 8000) {
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
      // dt в «кадрах по 60fps» — анимация не зависит от производительности ПК
      const dt = lastT ? Math.min(3, (t - lastT) / 16.7) : 1;
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
        let anyoneMoving = false;
        const tokens = sess.players.map((p) => {
          const center = cellCenter(m, p.pos);
          let d = dispRef.current[p.id];
          if (!d) { d = { ...center }; dispRef.current[p.id] = d; }
          const hop = hopRef.current[p.id];
          let lift = 0; // вертикальный «подскок» фишки при движении
          // хост уже завершил это движение (moving null или принадлежит другому ходу) —
          // сбрасываем устаревшую очередь, чтобы фишка сошлась с авторитетной позицией
          const mvActive = !!sess.moving && sess.moving.player === p.id;
          if (hop && hop.queue.length && !mvActive) hop.queue.length = 0;
          if (hop && hop.queue.length) {
            anyoneMoving = true;
            const nextIdx = hop.queue[0];
            const tgt = cellCenter(m, nextIdx);
            const dx = tgt.x - d.x, dy = tgt.y - d.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 3) {
              hop.queue.shift();
              d.x = tgt.x; d.y = tgt.y;
              sfx.step();
              if (hop.queue.length === 0 && sess.moving && sess.moving.player === p.id && p.id === me && arrivedRef.current !== sess.moving.ts) {
                arrivedRef.current = sess.moving.ts;
                dispatch({ t: 'arrived', id: me });
              }
            } else {
              d.x += dx * Math.min(1, 0.085 * dt); // плавный шаг, не зависит от FPS
              d.y += dy * Math.min(1, 0.085 * dt);
              lift = -Math.abs(Math.sin(t / 110)) * 7; // лёгкое подпрыгивание
            }
          } else if (!mvActive) {
            // тянем к авторитетной клетке только когда это движение не «висит» в ожидании
            d.x += (center.x - d.x) * Math.min(1, 0.14 * dt);
            d.y += (center.y - d.y) * Math.min(1, 0.14 * dt);
          }
          // если mvActive, а очередь пуста — стоим на месте (ждём подтверждения хоста),
          // иначе фишка визуально «отскакивала» назад к старой клетке
          return {
            x: d.x, y: d.y + lift, color: PLAYER_COLORS[p.color],
            active: act?.id === p.id, alive: p.alive, label: p.name,
            img: p.tokenImg ?? null,
          };
        });

        // камера: в режиме мира — общий план (с ручным зумом), иначе — слежение за фишкой
        let goal;
        if (viewMode === 'world' || peekMap) {
          const fv = fitView(m, w, h);
          goal = { x: fv.x + worldPanRef.current.x, y: fv.y + worldPanRef.current.y, zoom: fv.zoom * worldZoom };
        } else {
          const followP = act ? dispRef.current[act.id] : undefined;
          const baseZx = Math.min(2.1, Math.max(0.7, Math.min(w, h) / (CELL * 7.2)));
          const focus = anyoneMoving ? 1.5 : 1.0; // приближаемся, пока фишку передвигают
          const zx = Math.min(2.6, baseZx * focus);
          goal = {
            x: (followP?.x ?? m.cols * CELL / 2) + lookPanRef.current.x,
            y: (followP?.y ?? m.rows * CELL / 2) + lookPanRef.current.y,
            zoom: zx * lookZoomRef.current,
          };
        }
        const v = viewRef.current;
        v.x += (goal.x - v.x) * 0.07;
        v.y += (goal.y - v.y) * 0.07;
        v.zoom += (goal.zoom - v.zoom) * 0.07;

        const colorById: Record<string, string> = {};
        sess.players.forEach((p) => { colorById[p.id] = PLAYER_COLORS[p.color]; });

        drawBoard(ctx, m, {
          view: v, width: w, height: h,
          tileById: tileMapRef.current,
          captured: sess.captured, colorById,
          currentCell: sess.phase === 'playing' && act ? act.pos : null,
          showNumbers: options.showCellNumbers,
          tokens, time: t, hoverCell: null,
          mystery: mysteryRef.current,
        });
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
  // остаток выбранного ресурса прямо сейчас
  const remainingNow = ch?.mode === 'time' ? (mePlayer?.secLeft ?? 0) : (mePlayer?.triesLeft ?? 0);
  // пропуск: обычно после 5 потраченных; при «низком старте» — только на нуле
  const naturalCanSkip = !!ch && !!info && (ch.lowStart ? remainingNow <= 0 : info.units >= SKIP_COST);
  // «Пропустить · 5» (заплатить ровно 5 авансом) доступен, только пока потрачено МЕНЬШЕ 5.
  // Когда потрачено 5+ — игрок обязан пользоваться кнопкой «Пропустить» (спишет фактическую цену).
  const instantSkipAllowed = !!ch && !!info && (ch.lowStart ? remainingNow <= 0 : info.units < SKIP_COST);
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

  /* holdingRef — надёжный флаг «кнопка нажата» (state мог запаздывать в замыканиях,
     из-за чего повторное нажатие плодило интервалы и кубики тряслись вечно). */
  const holdingRef = useRef(false);
  const startHold = () => {
    if (!myTurn || s.moving || ch || s.pendingCard || s.awaitPost || s.quiz) return;
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

  const winner = s.winner ? s.players.find((p) => p.id === s.winner) : null;
  /* трансляция: показываем последний кадр до 4 секунд (не «мигаем»),
     а пометку LIVE держим, пока кадры идут чаще 1.2 с */
  const streamAge = stream ? Date.now() - stream.ts : Infinity;
  const streamLive = !!stream && streamAge < 1200;
  const streamShow = !!stream && streamAge < 4000;

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

  return (
    <div className="h-full crt-grid-bg flex flex-col overflow-hidden">
      {/* ---------- HUD ---------- */}
      <div className="shrink-0 border-b-[3px] border-edge bg-[rgba(7,9,18,0.82)] px-3 py-2 flex items-center gap-2 flex-wrap z-20">
        <span className="font-pixel text-[9px] text-gold hidden sm:block">RETROPOLIA</span>
        <span className="hud-chip pixel-corners px-2.5 py-1 font-pixel text-[9px] text-sky">{s.code}</span>
        <span className={`w-2 h-2 ${st.netInfo.online ? 'bg-teal' : 'bg-gold'}`} />
        <div className="flex items-center gap-1.5 flex-wrap flex-1">
          {s.players.map((p, i) => (
            <div
              key={p.id}
              className={`hud-chip pixel-corners px-2.5 py-1.5 flex items-center gap-2 transition-all ${active?.id === p.id && s.phase === 'playing' ? 'border-gold shadow-[0_0_14px_rgba(255,207,63,0.35)]' : ''} ${!p.alive ? 'opacity-40 grayscale' : ''}`}
            >
              <span className="w-3.5 h-3.5 border border-abyss" style={{ background: PLAYER_COLORS[p.color] }} />
              <div className="leading-none">
                <div className="font-display text-[10px] uppercase tracking-wide text-paper flex items-center gap-1">
                  {p.name}
                  {p.isHost && <span className="font-pixel text-[6px] text-gold">H</span>}
                  {!p.alive && <span className="text-coral">{Ic.skull(10)}</span>}
                </div>
                <div className="tick-label text-faint mt-1 flex items-center gap-1.5">
                  <span className="text-sky">{fmtClock(p.secLeft)}</span>
                  <span className="text-gold">{p.triesLeft} поп.</span>
                  <span>№{p.pos + 1}</span>
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
          onPointerUp={() => { dragRef.current = null; lookDragRef.current = null; }}
        />

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
            <span className="tick-label text-sky">Тяните карту мышью · колесо — зум · до броска</span>
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

        {/* трансляция соперника (миниатюра). Скрываем, когда трансляция открыта
            в основном окне задания (ch) — НО если зритель открыл «карту мира» поверх
            задания (peekMap), миниатюра остаётся, чтобы трансляция не пропадала. */}
        {streamShow && !myTurn && (!ch || peekMap) && (
          <div className="absolute right-3 bottom-3 w-[240px] pop-in">
            <div className="hud-chip pixel-corners p-1.5">
              <div className="flex items-center gap-2 px-1 pb-1">
                <span className={`w-2 h-2 ${streamLive ? 'bg-coral blink-hard' : 'bg-gold'}`} />
                <span className={`font-pixel text-[7px] ${streamLive ? 'text-coral' : 'text-gold'}`}>
                  {streamLive ? 'ТРАНСЛЯЦИЯ' : 'ЖДЁМ КАДРЫ'} · {stream!.name}
                </span>
              </div>
              <img src={stream!.data} alt="Трансляция" className={`w-full border-2 border-edge ${streamLive ? '' : 'opacity-60'}`} style={{ imageRendering: 'auto' }} />
            </div>
          </div>
        )}

        {/* ---------- кубики ---------- */}
        {s.phase === 'playing' && !ch && !s.pendingCard && !s.awaitPost && !s.quiz && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
            <div className="flex gap-3">
              <DieFace v={dieA} dropping={!!s.dice && !dieRolling && !s.moving} rolling={dieRolling} />
              <DieFace v={dieB} dropping={!!s.dice && !dieRolling && !s.moving} rolling={dieRolling} delay />
            </div>
            {myTurn ? (
              !s.moving ? (
                rolling ? (
                  <div className="hud-chip pixel-corners px-4 py-2 font-pixel text-[8px] text-gold blink-hard">КУБИКИ КАТЯТСЯ…</div>
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
              <div className="tick-label text-teal">{s.dice.a} + {s.dice.b} = {s.dice.a + s.dice.b}</div>
            )}
          </div>
        )}

        {/* ---------- жеребьёвка: все кубики видны сразу, бросают по очереди ---------- */}
        {s.phase === 'rollOff' && !s.rollOffWinner && (
          <div className="absolute inset-0 flex items-center justify-center bg-[rgba(4,6,14,0.55)] z-10">
            <div className="pixel-panel pixel-corners pop-in p-6 max-w-lg w-full mx-4 text-center">
              <div className="font-display uppercase tracking-wider text-gold text-lg">Кто ходит первым?</div>
              <p className="text-[12px] text-dim mt-1 mb-1">Бросайте по очереди — у кого больше, тот и начинает. При равенстве — переброс.</p>
              <div className="flex justify-center gap-5 mt-4 mb-5 flex-wrap">
                {s.players.map((p, i) => {
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
              {s.players[s.rollOffIdx]?.id === me ? (
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
                <div className="font-pixel text-[9px] text-dim blink-hard">БРОСАЕТ {s.players[s.rollOffIdx]?.name}…</div>
              )}
            </div>
          </div>
        )}

        {/* ---------- победитель жеребьёвки: каждый подтверждает старт ---------- */}
        {s.phase === 'rollOff' && s.rollOffWinner && (() => {
          const readyList = s.rollOffReady ?? [];
          const winnerP = s.players.find((p) => p.id === s.rollOffWinner);
          const allReady = s.players.every((p) => readyList.includes(p.id));
          return (
            <div className="absolute inset-0 flex items-center justify-center bg-[rgba(4,6,14,0.6)] z-10">
              <div className="pixel-panel pixel-corners pop-in p-7 max-w-lg w-full mx-4 text-center">
                <span className="text-gold inline-block floaty">{Ic.dice(40)}</span>
                <div className="font-pixel text-gold text-[11px] mt-3">ПЕРВЫМ ХОДИТ</div>
                <div
                  className="font-display uppercase text-3xl mt-2"
                  style={{ color: winnerP ? PLAYER_COLORS[winnerP.color] : undefined }}
                >
                  {winnerP?.name ?? '—'}
                </div>
                <div className="flex justify-center gap-4 mt-5 flex-wrap">
                  {s.players.map((p) => (
                    <div key={p.id} className="flex flex-col items-center gap-1">
                      <DieFace v={s.rollOffValues[p.id] ?? 1} frame={PLAYER_COLORS[p.color]} dropping={p.id === s.rollOffWinner} />
                      <span className="font-display text-[9px] uppercase" style={{ color: PLAYER_COLORS[p.color] }}>{p.name}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-5 space-y-2 text-left">
                  {s.players.map((p) => {
                    const isReady = readyList.includes(p.id);
                    return (
                      <div key={p.id} className={`flex items-center justify-between hud-chip pixel-corners px-3 py-2 ${p.id === me && !isReady ? 'border-gold pulse-ring' : ''}`}>
                        <span className="font-display text-[11px] uppercase tracking-wide" style={{ color: PLAYER_COLORS[p.color] }}>{p.name}</span>
                        {isReady ? (
                          <span className="font-pixel text-[8px] text-teal">ГОТОВ ✓</span>
                        ) : p.id === me ? (
                          <PxBtn small color="teal" onClick={() => { sfx.start(); dispatch({ t: 'rollOffReady', id: me }); }}>{Ic.play(12)} Старт игры</PxBtn>
                        ) : (
                          <span className="font-pixel text-[8px] text-faint">ЖДЁМ…</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className={`font-pixel text-[9px] mt-4 ${allReady ? 'text-teal' : 'text-dim blink-hard'}`}>
                  {allReady ? 'СТАРТ!' : `ГОТОВЫ ${readyList.length} ИЗ ${s.players.length}`}
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
              <div className="font-pixel text-gold text-sm mt-3 title-glow">ПОБЕДА</div>
              <div className="font-display uppercase text-2xl text-paper mt-2" style={{ color: winner ? PLAYER_COLORS[winner.color] : undefined }}>
                {winner?.name ?? 'НИЧЬЯ'}
              </div>
              <p className="text-[12px] text-dim mt-2">
                {winner ? 'Соперники остались без ресурсов. Поле покорено!' : 'Ресурсы исчерпали все — партия annullée.'}
              </p>
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
              src={cardImg ?? cardArt(s.pendingCard.card.kind, s.pendingCard.card.name, s.pendingCard.card.id.length)}
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
          title={`Ячейка №${ch.cellIdx + 1} · ${task.title}`}
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
              {myTurn && ch.status !== 'choose' && (
                <GhostBtn small onClick={() => setControlsOpen(true)}>{Ic.gear(12)} Управление</GhostBtn>
              )}
            </div>

            <div className="min-w-0">
              {ch.status === 'choose' && (
                <div>
                  {myTurn ? (
                    <div>
                      <div className="font-display uppercase text-sm text-paper mb-3">Чем платите за задание?</div>
                      <div className="grid grid-cols-2 gap-3">
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
                      </div>
                      <div className="mt-3 flex justify-end gap-2 flex-wrap">
                        <GhostBtn onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: 'time', spentMs: 0, loads: 0 })} disabled={(mePlayer?.secLeft ?? 0) < 60}>
                          {Ic.bolt(12)} Сразу пропустить · 5 мин
                        </GhostBtn>
                        <GhostBtn onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: 'tries', spentMs: 0, loads: 0 })} disabled={(mePlayer?.triesLeft ?? 0) <= 0}>
                          {Ic.bolt(12)} Сразу пропустить · 5 поп.
                        </GhostBtn>
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
                    <span className={`hud-chip pixel-corners px-3 py-1.5 font-display text-[11px] uppercase flex items-center gap-1.5 ${ch.mode === 'time' ? 'text-sky' : 'text-gold'}`}>
                      {ch.mode === 'time' ? Ic.clock(13) : Ic.target(13)} {ch.mode === 'time' ? 'Режим времени' : 'Режим попыток'}
                    </span>
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
                          <img src={stream!.data} alt="Трансляция" className={`w-full ${streamLive ? '' : 'opacity-60'}`} />
                          <div className="px-2 py-1 flex items-center gap-2 bg-[rgba(7,9,18,0.9)]">
                            <span className={`w-2 h-2 ${streamLive ? 'bg-coral blink-hard' : 'bg-gold'}`} />
                            <span className={`font-pixel text-[7px] ${streamLive ? 'text-coral' : 'text-gold'}`}>
                              {streamLive ? 'ТРАНСЛЯЦИЯ' : 'ЖДЁМ КАДРЫ'} · {stream!.name}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="aspect-[256/240] bg-black border-[3px] border-edge flex flex-col items-center justify-center gap-2">
                          <span className="text-dim">{Ic.eye(28)}</span>
                          <span className="font-pixel text-[8px] text-faint text-center px-4">
                            {options.broadcast
                              ? 'ЖДЁМ КАДРЫ ТРАНСЛЯЦИИ…'
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
                          <p className="text-[10px] text-dim leading-tight">
                            Эмулятор загружен и ждёт. {ch.mode === 'time' ? 'Таймер пойдёт' : 'Попытка спишется'} только после запуска — можно спокойно подготовиться.
                          </p>
                          <GhostBtn className="w-full" onClick={() => dispatch({ t: 'skip', id: me, instant: true, spentMs: 0, loads: 0 })}>
                            {Ic.bolt(13)} Заплатить {SKIP_COST} и пропустить
                          </GhostBtn>
                        </>
                      )}
                      {myTurn && (ch.status === 'playing' || ch.status === 'voting') && (
                        <>
                          <GhostBtn className="w-full" onClick={() => dispatch({ t: 'reloadSave', id: me })}>
                            {Ic.rotate(13)} Перезапуск задания
                          </GhostBtn>
                          <GhostBtn
                            className="w-full"
                            disabled={ch.status === 'voting'}
                            onClick={() => dispatch({ t: 'togglePause', id: me })}
                          >
                            {ch.paused ? Ic.play(13) : Ic.pause(13)} {ch.paused ? 'Продолжить' : 'Пауза'}
                          </GhostBtn>
                          {ch.paused && ch.status === 'playing' && (
                            <GhostBtn className="w-full border-magma/60 text-magma" onClick={() => setControlsOpen(true)}>
                              {Ic.gear(13)} Сменить управление
                            </GhostBtn>
                          )}
                          <PxBtn color="teal" className="w-full" onClick={() => dispatch({ t: 'declareDone', id: me })}>{Ic.check(14)} Прошёл задание</PxBtn>
                          <GhostBtn
                            className="w-full"
                            disabled={!naturalCanSkip}
                            title={!naturalCanSkip ? (ch.lowStart ? 'Ресурса было меньше 5 — пропуск станет доступен, когда он закончится' : 'Сначала потратьте 5 ресурсов — или платите сразу') : undefined}
                            onClick={() => info && dispatch({ t: 'skip', id: me, instant: false, spentMs: info.ms, loads: info.loads })}
                          >
                            {Ic.bolt(13)} Пропустить · потратить {ch.mode === 'time' ? `${Math.max(info?.min ?? 0, SKIP_COST)} мин` : `${Math.max(info?.loads ?? 0, SKIP_COST)} поп.`}
                          </GhostBtn>
                          <GhostBtn
                            className="w-full"
                            disabled={!instantSkipAllowed}
                            title={!instantSkipAllowed ? (ch.lowStart ? 'Ресурса было меньше 5 — пропуск станет доступен, когда он закончится' : 'Вы уже потратили 5+ ресурсов — используйте кнопку «Пропустить», она спишет фактическую цену') : undefined}
                            onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: ch.mode === 'time' ? 'time' : 'tries', spentMs: 0, loads: 0 })}
                          >
                            {Ic.bolt(13)} Заплатить {SKIP_COST} {ch.mode === 'time' ? 'мин' : 'поп.'} и пропустить
                          </GhostBtn>
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

      {/* ---------- выбор после захвата ---------- */}
      {s.awaitPost && myTurn && !ch && (
        <Modal title="Ячейка захвачена!" icon={Ic.trophy(16)} w="max-w-lg" locked>
          <p className="text-[13px] text-dim mb-4">
            Теперь эта ячейка ваша: соперники, попавшие на неё, отдают потраченные ресурсы вам. Что дальше?
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => { sfx.coin(); dispatch({ t: 'postChoice', id: me, choice: 'continue' }); }} className="pixel-panel pixel-corners p-4 text-left hover:border-gold hover:-translate-y-0.5 transition-all cursor-pointer group">
              <span className="text-gold">{Ic.dice(22)}</span>
              <div className="font-display uppercase text-paper group-hover:text-gold mt-2 text-sm">Играть дальше</div>
              <div className="text-[10px] text-dim mt-1">Сохраняется право броска — продолжите ход</div>
            </button>
            <button onClick={() => { sfx.click(); setTplOpen(true); }} className="pixel-panel pixel-corners p-4 text-left hover:border-magma hover:-translate-y-0.5 transition-all cursor-pointer group">
              <span className="text-magma">{Ic.cart(22)}</span>
              <div className="font-display uppercase text-paper group-hover:text-magma mt-2 text-sm">Новое задание</div>
              <div className="text-[10px] text-dim mt-1">Заменить задание ячейки из шаблонов (доп. ход сгорит)</div>
            </button>
          </div>
        </Modal>
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
  const romSaves = saves.filter((x) => x.romId === romId);
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
          <Field label="Ром">
            <select className="field-in w-full px-2 py-2 text-sm" value={romId} onChange={(e) => { setRomId(e.target.value); setSaveId(''); }}>
              <option value="">— выбрать —</option>
              {roms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Сохранение">
            <select className="field-in w-full px-2 py-2 text-sm" value={saveId} onChange={(e) => setSaveId(e.target.value)}>
              <option value="">— без сохранения (старт с начала) —</option>
              {romSaves.map((x) => <option key={x.id} value={x.id}>Слот {x.slot} · {x.name}</option>)}
            </select>
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

/* ---------- инвентарь карточек: просмотр, применение, продажа/покупка ---------- */

const fmtPrice = (m: number, t: number): string =>
  m > 0 && t > 0 ? `${m} мин + ${t} поп.` : m > 0 ? `${m} мин` : `${t} поп.`;

function InventoryModal({ onClose }: { onClose: () => void }) {
  const st = useApp();
  const s = st.session;
  const me = st.selfId;
  const [sellCardId, setSellCardId] = useState('');
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
  const busy = !!(s.moving || s.challenge || s.pendingCard || s.quiz || s.awaitPost);
  const findCard = (id: string): { card: CardDef; ownerName: string } | null => {
    for (const p of s.players) {
      const c = (p.inventory ?? []).find((x) => x.id === id);
      if (c) return { card: c, ownerName: p.name };
    }
    return null;
  };
  const sellTargets = s.players.filter((p) => p.alive && p.id !== me && p.id !== active?.id);
  const incoming = trades.filter((o) => o.to === me && isOpen(o));
  const outgoing = trades.filter((o) => o.from === me && isOpen(o));
  const sellCard = inv.find((c) => c.id === sellCardId);

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[rgba(4,6,14,0.88)]" onClick={onClose} />
      <div className="relative pixel-panel pixel-corners pop-in w-full max-w-2xl max-h-[92vh] overflow-y-auto p-5">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-teal">{Ic.grid(18)}</span>
          <span className="font-display uppercase tracking-wider text-paper text-sm">Инвентарь</span>
          <span className="tick-label text-gold">{fmtClock(mePlayer?.secLeft ?? 0)} · {mePlayer?.triesLeft ?? 0} поп.</span>
          <GhostBtn small className="ml-auto" onClick={onClose}>{Ic.cross(12)} Закрыть</GhostBtn>
        </div>

        {/* входящие предложения */}
        {incoming.length > 0 && (
          <div className="space-y-2 mb-4">
            <div className="tick-label text-gold">💼 Предложения вам</div>
            {incoming.map((o) => {
              const info = findCard(o.cardId);
              const afford = (mePlayer?.secLeft ?? 0) >= o.priceMin * 60 && (mePlayer?.triesLeft ?? 0) >= o.priceTries;
              const counterSent = o.status === 'countered';
              return (
                <div key={o.id} className="border-2 border-gold bg-gold/10 px-3 py-2.5 space-y-2">
                  <div className="text-[12px] text-paper">
                    <span className="font-display uppercase">{info?.ownerName ?? 'Игрок'}</span> предлагает «{info?.card.name ?? '—'}» за {fmtPrice(o.priceMin, o.priceTries)}
                  </div>
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
              return (
                <div key={o.id} className="border-2 border-edge bg-panel px-3 py-2.5 space-y-1.5">
                  {o.status === 'pending' ? (
                    <div className="text-[12px] text-paper">«{findCard(o.cardId)?.card.name ?? '—'}» → {buyer?.name ?? '—'}: ждём ответа…</div>
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

        {/* форма продажи */}
        {sellCard && (
          <div className="border-2 border-gold/60 bg-gold/5 p-3 mb-4 space-y-2">
            <div className="font-display text-[12px] uppercase text-gold">Продажа: {sellCard.name}</div>
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
                  dispatch({ t: 'tradeOffer', id: me, cardId: sellCard.id, to: sellTo, priceMin: sellMin, priceTries: sellTries });
                  setSellCardId('');
                  setSellTo('');
                }}
              >
                {Ic.check(14)} Предложить за {fmtPrice(sellMin, sellTries)}
              </PxBtn>
              <GhostBtn onClick={() => setSellCardId('')}>Отмена</GhostBtn>
            </div>
          </div>
        )}

        {/* мои карточки */}
        <div className="space-y-2">
          <div className="tick-label text-faint">Мои карточки · {inv.length}</div>
          {inv.map((c) => (
            <div key={c.id} className={`border-2 px-3 py-2.5 ${c.chaos ? 'border-magma/50 bg-magma/5' : 'border-edge bg-panel'}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-display text-[12px] uppercase text-paper truncate">{c.name}</div>
                  <div className="text-[10.5px] text-dim leading-tight mt-0.5">{c.desc}</div>
                  {c.chaos ? (
                    <span className="inline-block mt-1 font-pixel text-[8px] px-1.5 py-0.5 bg-magma/20 text-magma">😈 ПАКОСТЬ · клеится к своему заданию</span>
                  ) : (
                    <span className="inline-block mt-1 font-pixel text-[8px] px-1.5 py-0.5 bg-teal/15 text-teal">ЭФФЕКТ · {effectLabel(c.effect)}</span>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  {!c.chaos && (
                    <PxBtn
                      small
                      color="teal"
                      disabled={!myTurn || busy || reservedIds.has(c.id)}
                      title={!myTurn || busy ? 'Применять — только в свой ход до броска, когда стол пуст' : undefined}
                      onClick={() => { dispatch({ t: 'useCard', id: me, cardId: c.id }); sfx.card(); }}
                    >
                      {Ic.play(12)} Применить
                    </PxBtn>
                  )}
                  <GhostBtn
                    small
                    disabled={reservedIds.has(c.id)}
                    title={reservedIds.has(c.id) ? 'Карточка уже участвует в сделке' : undefined}
                    onClick={() => { setSellCardId(c.id); setSellTo(''); setSellMin(5); setSellTries(0); sfx.click(); }}
                  >
                    Продать
                  </GhostBtn>
                </div>
              </div>
            </div>
          ))}
          {inv.length === 0 && (
            <div className="text-center py-6 text-dim text-[12px]">
              Инвентарь пуст. Пакости выпадают на ячейках-шансах (бонусах) — если создатель карты их добавил,
              а обычные карточки «в инвентарь» — на бонусах и ловушках. Карточку можно применить или продать сопернику.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
