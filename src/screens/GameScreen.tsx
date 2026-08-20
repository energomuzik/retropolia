import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, getRomData, useBlobImage } from '../store';
import { dispatch, streamBus, type StreamPacket } from '../useGame';
import { CELL, cellCenter, drawBoard, fitView } from '../render';
import { cellTaskOf, fmtClock, spentInfo } from '../engine';
import { effectLabel } from './TaskEditor';
import { cardArt, cartridgeArt } from '../assets';
import NesBox, { type NesApi } from '../NesBox';
import SegaBox, { type SegaApi } from '../SegaBox';
import { saveSessionSnapshot } from './Lobby';
import KeyBinder from '../KeyBinder';
import { Field, GhostBtn, Ic, Modal, PxBtn } from '../ui';
import { PLAYER_COLORS, SKIP_COST } from '../types';
import type { TaskDef } from '../types';
import { idbGet } from '../db';
import { sfx } from '../sound';

export default function GameScreen() {
  const st = useApp();
  const { session: s, sessionMap: map, selfId: me, options, room } = st;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const emuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const nesApiRef = useRef<NesApi | null>(null);
  const segaApiRef = useRef<SegaApi | null>(null);

  const [viewMode, setViewMode] = useState<'follow' | 'world'>('follow');
  const [peekMap, setPeekMap] = useState(false);
  const [worldZoom, setWorldZoom] = useState(1);
  const worldPanRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const mysteryRef = useRef<Set<number> | undefined>(undefined);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const emuWrapRef = useRef<HTMLDivElement>(null);
  const prevPeekRef = useRef(false);
  const [shake, setShake] = useState<{ holding: boolean; a: number; b: number }>({ holding: false, a: 1, b: 1 });
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
  const taskRom = task ? st.roms.find((r) => r.id === task.romId) : undefined;
  const isSega = !!taskRom && taskRom.ext !== 'nes';
  const segExt = (taskRom?.fileName.split('.').pop() ?? 'md').toLowerCase();
  const romName = taskRom?.name ?? 'ROM';
  const taskImg = useBlobImage(task?.imageId);
  const cardImg = useBlobImage(s?.pendingCard?.card.imageId);

  /* ---------- загрузка рома и сохранения под челлендж ---------- */
  useEffect(() => {
    let on = true;
    setRomBuf(null);
    setSaveState(null);
    if (!task) return;
    void (async () => {
      const buf = await getRomData(task.romId);
      const sv = st.saves.find((x) => x.id === task.saveId);
      if (!on) return;
      setRomBuf(buf);
      setSaveState(sv?.state ?? null);
      setEmuKey((k) => k + 1);
    })();
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch?.cellIdx, s?.challenge?.status === 'choose' ? 0 : 1]);

  /* ---------- перезагрузка сохранения (попытка / нарушение) ---------- */
  const reloadId = ch?.reloadId ?? 0;
  useEffect(() => {
    if (reloadId > 0) {
      if (isSega) {
        // SEGA: перезапуск ядра с сохранением (или с начала, если слота нет) — надёжно
        segaApiRef.current?.loadSaveReliable((saveState as string | null) ?? null);
      } else {
        nesApiRef.current?.reload(saveState ?? undefined);
      }
      sfx.alarm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadId, isSega]);

  /* ---------- трансляция (NES; SEGA-экран ядро рисует само) ---------- */
  const streaming = options.broadcast && myTurn && ch?.status === 'playing' && !isSega;
  const streamMs = Math.round(1000 / Math.min(30, Math.max(2, options.streamFps || 10)));
  useEffect(() => {
    if (!streaming || !room) return;
    const t = setInterval(() => {
      const c = emuCanvasRef.current;
      if (!c) return;
      try {
        // на высоких FPS сильнее жмём кадр, чтобы не забивать канал
        const q = streamMs <= 50 ? 0.34 : 0.42;
        const data = c.toDataURL('image/jpeg', q);
        room.send('stream', { from: me, name: mePlayer?.name ?? '?', data, ts: Date.now() } satisfies StreamPacket);
      } catch { /* noop */ }
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

  /* ---------- сброс модалок при смене челленджа ---------- */
  useEffect(() => {
    const c = s?.challenge;
    if (!c || c.status === 'choose') {
      setControlsOpen(false);
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
    const loop = (t: number) => {
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
              d.x += dx * 0.085; // медленный плавный шаг
              d.y += dy * 0.085;
              lift = -Math.abs(Math.sin(t / 110)) * 7; // лёгкое подпрыгивание
            }
          } else {
            d.x += (center.x - d.x) * 0.14;
            d.y += (center.y - d.y) * 0.14;
          }
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
          goal = { x: followP?.x ?? m.cols * CELL / 2, y: followP?.y ?? m.rows * CELL / 2, zoom: zx };
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
  const instantSkipAllowed = !!ch && (!ch.lowStart || remainingNow <= 0);
  const owner = ch ? s.captured[ch.cellIdx] : undefined;

  // «закрытые» ячейки: не посещены и не захвачены — скрываем тип и картинку (опция)
  const mystery = useMemo(() => {
    if (!options.hideUnrevealed || !s || !map) return undefined;
    const set = new Set<number>();
    map.cells.forEach((_, i) => {
      if (!s.revealed.includes(i) && !s.captured[i]) set.add(i);
    });
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.hideUnrevealed, s?.revealed, s?.captured, map?.id]);
  useEffect(() => { mysteryRef.current = mystery; }, [mystery]);
  const ownerName = owner ? s.players.find((p) => p.id === owner)?.name : undefined;
  const others = s.players.filter((p) => p.alive && p.id !== active?.id);
  const aliveCount = s.players.filter((p) => p.alive).length;
  const votesNeed = aliveCount;

  const startHold = () => {
    if (!myTurn || s.moving || ch || s.pendingCard || s.awaitPost) return;
    holdStartRef.current = Date.now();
    setShake({ holding: true, a: 1, b: 1 });
    shakeIntRef.current = window.setInterval(() => {
      setShake({ holding: true, a: 1 + Math.floor(Math.random() * 6), b: 1 + Math.floor(Math.random() * 6) });
      sfx.dice();
    }, 75);
  };
  const endHold = () => {
    if (!shake.holding) return;
    clearInterval(shakeIntRef.current);
    const holdMs = Date.now() - holdStartRef.current;
    setShake((x) => ({ ...x, holding: false }));
    sfx.drop();
    dispatch({ t: 'roll', id: me, holdMs });
  };

  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.code === 'Space' && myTurn && !e.repeat) { e.preventDefault(); startHold(); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') endHold(); };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); };
  });

  const winner = s.winner ? s.players.find((p) => p.id === s.winner) : null;
  const streamFresh = stream && Date.now() - stream.ts < 1200;

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
          style={{ cursor: viewMode === 'world' || peekMap ? (dragRef.current ? 'grabbing' : 'grab') : 'default' }}
          onWheel={(e) => {
            if (viewMode === 'world' || peekMap) {
              setWorldZoom((z) => Math.min(4, Math.max(0.3, z * Math.exp(-e.deltaY * 0.0012))));
            }
          }}
          onPointerDown={(e) => {
            if (viewMode !== 'world' && !peekMap) return;
            (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
            dragRef.current = { sx: e.clientX, sy: e.clientY, px: worldPanRef.current.x, py: worldPanRef.current.y };
          }}
          onPointerMove={(e) => {
            if (!dragRef.current) return;
            const z = viewRef.current.zoom || 1;
            worldPanRef.current = {
              x: dragRef.current.px - (e.clientX - dragRef.current.sx) / z,
              y: dragRef.current.py - (e.clientY - dragRef.current.sy) / z,
            };
          }}
          onPointerUp={() => { dragRef.current = null; }}
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
        {aliveCount === 1 && s.phase === 'playing' && (
          <div className="absolute top-3 right-3 hud-chip pixel-corners px-3 py-1.5"><span className="tick-label text-gold">Соло-тест партии</span></div>
        )}

        {/* лог */}
        <div className="absolute left-3 bottom-3 w-[290px] max-w-[45vw] space-y-1 pointer-events-none">
          {s.log.slice(0, 6).map((l, i) => (
            <div key={`${l}-${i}`} className={`text-[10.5px] leading-tight px-2.5 py-1.5 bg-[rgba(7,9,18,0.8)] border-l-[3px] ${i === 0 ? 'border-gold text-paper slide-up' : 'border-edge text-dim'}`}>
              {l}
            </div>
          ))}
        </div>

        {/* трансляция соперника */}
        {streamFresh && !myTurn && (
          <div className="absolute right-3 bottom-3 w-[240px] pop-in">
            <div className="hud-chip pixel-corners p-1.5">
              <div className="flex items-center gap-2 px-1 pb-1">
                <span className="w-2 h-2 bg-coral blink-hard" />
                <span className="font-pixel text-[7px] text-coral">ТРАНСЛЯЦИЯ · {stream!.name}</span>
              </div>
              <img src={stream!.data} alt="Трансляция" className="w-full border-2 border-edge" style={{ imageRendering: 'auto' }} />
            </div>
          </div>
        )}

        {/* ---------- кубики ---------- */}
        {s.phase === 'playing' && !ch && !s.pendingCard && !s.awaitPost && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
            <div className="flex gap-3">
              <DieFace v={s.moving || (!myTurn && s.dice) ? s.dice?.a ?? 1 : shake.holding ? shake.a : s.dice?.a ?? 6} dropping={!!s.dice && !shake.holding && !s.moving} />
              <DieFace v={s.moving || (!myTurn && s.dice) ? s.dice?.b ?? 1 : shake.holding ? shake.b : s.dice?.b ?? 6} dropping={!!s.dice && !shake.holding && !s.moving} delay />
            </div>
            {myTurn ? (
              !s.moving ? (
                <button
                  onPointerDown={startHold}
                  onPointerUp={endHold}
                  onPointerLeave={() => { if (shake.holding) endHold(); }}
                  className={`btn-px pixel-corners btn-gold px-7 py-3 text-sm select-none touch-none ${shake.holding ? 'shake-hard' : ''}`}
                >
                  {Ic.dice(16)} {shake.holding ? 'ОТПУСТИТЕ — БРОСОК!' : 'ДЕРЖИТЕ, ЧТОБЫ СМЕШАТЬ'}
                </button>
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

        {/* ---------- жеребьёвка ---------- */}
        {s.phase === 'rollOff' && (
          <div className="absolute inset-0 flex items-center justify-center bg-[rgba(4,6,14,0.55)] z-10">
            <div className="pixel-panel pixel-corners pop-in p-6 max-w-md w-full mx-4 text-center">
              <div className="font-display uppercase tracking-wider text-gold text-lg">Кто ходит первым?</div>
              <p className="text-[12px] text-dim mt-1 mb-4">Классическая жеребьёвка: у кого больше на кубике — тот и начинает. При равенстве — переброс.</p>
              <div className="flex justify-center gap-2 mb-4 flex-wrap">
                {s.players.map((p) => (
                  <div key={p.id} className={`hud-chip pixel-corners px-3 py-2 ${s.players[s.rollOffIdx]?.id === p.id ? 'border-gold' : ''}`}>
                    <div className="font-display text-[10px] uppercase" style={{ color: PLAYER_COLORS[p.color] }}>{p.name}</div>
                    <div className="font-pixel text-sm mt-1 text-paper">{s.rollOffValues[p.id] ?? '·'}</div>
                  </div>
                ))}
              </div>
              {s.players[s.rollOffIdx]?.id === me ? (
                <PxBtn big onClick={() => dispatch({ t: 'roll', id: me, holdMs: 400 + Math.random() * 800 })}>{Ic.dice(16)} Бросить кубик</PxBtn>
              ) : (
                <div className="font-pixel text-[9px] text-dim blink-hard">БРОСАЕТ {s.players[s.rollOffIdx]?.name}…</div>
              )}
            </div>
          </div>
        )}

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
                          isSega ? (
                            <SegaBox
                              key={emuKey}
                              romData={romBuf}
                              ext={segExt}
                              initialState={(saveState as string | null) ?? null}
                              paused={ch.status === 'ready' || ch.status === 'voting' || ch.paused}
                              onApi={(a) => { segaApiRef.current = a; }}
                            />
                          ) : (
                            <NesBox
                              key={emuKey}
                              romData={romBuf}
                              initialState={saveState ?? undefined}
                              enabled={ch.status === 'playing' && !ch.paused}
                              paused={ch.status === 'ready' || ch.status === 'voting' || ch.paused}
                              onApi={(a) => { nesApiRef.current = a; }}
                              registerCanvas={(c) => { emuCanvasRef.current = c; }}
                            />
                          )
                        ) : (
                          <div className="aspect-[256/240] bg-black border-[3px] border-edge flex items-center justify-center">
                            <span className="font-pixel text-[8px] text-faint blink-hard">ЗАГРУЗКА РОМА…</span>
                          </div>
                        )}
                            </div>
                          </div>
                        </>
                      ) : streamFresh ? (
                        <div className="border-[3px] border-edge bg-black">
                          <img src={stream!.data} alt="Трансляция" className="w-full" />
                          <div className="px-2 py-1 flex items-center gap-2 bg-[rgba(7,9,18,0.9)]">
                            <span className="w-2 h-2 bg-coral blink-hard" />
                            <span className="font-pixel text-[7px] text-coral">ТРАНСЛЯЦИЯ · {stream!.name}</span>
                          </div>
                        </div>
                      ) : (
                        <div className="aspect-[256/240] bg-black border-[3px] border-edge flex flex-col items-center justify-center gap-2">
                          <span className="text-dim">{Ic.eye(28)}</span>
                          <span className="font-pixel text-[8px] text-faint text-center px-4">
                            {isSega
                              ? 'SEGA: ЭКРАН ИГРОКА РИСУЕТ ЯДРО — ТРАНСЛЯЦИЯ НЕДОСТУПНА'
                              : options.broadcast
                                ? 'ЖДЁМ КАДРЫ ТРАНСЛЯЦИИ…'
                                : 'ТРАНСЛЯЦИЯ ВЫКЛЮЧЕНА В ОПЦИЯХ'}
                          </span>
                        </div>
                      )}
                      {myTurn && (
                        <div className="mt-1.5 tick-label text-faint">Стрелки · X=A · Z=B · Enter=Start · Shift=Select</div>
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
                          <GhostBtn className="w-full" onClick={() => setControlsOpen(true)}>{Ic.gear(13)} Управление</GhostBtn>
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
                            {Ic.bolt(13)} Пропустить ({ch.mode === 'time' ? `${info?.min ?? 0} мин` : `${info?.loads ?? 0} поп.`})
                          </GhostBtn>
                          <GhostBtn
                            className="w-full"
                            disabled={!instantSkipAllowed}
                            title={!instantSkipAllowed ? 'Ресурса было меньше 5 — пропуск станет доступен, когда он закончится' : undefined}
                            onClick={() => dispatch({ t: 'skip', id: me, instant: true, resource: ch.mode === 'time' ? 'time' : 'tries', spentMs: 0, loads: 0 })}
                          >
                            {Ic.bolt(13)} Заплатить {SKIP_COST} {ch.mode === 'time' ? 'мин' : 'поп.'} и пропустить
                          </GhostBtn>
                        </>
                      )}
                      {!myTurn && others.some((p) => p.id === me) && (
                        <>
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

      {/* ---------- смена управления (клавиатура + джойстик) во время задания ---------- */}
      {controlsOpen && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[rgba(4,6,14,0.88)]" onClick={() => setControlsOpen(false)} />
          <div className="relative pixel-panel pixel-corners pop-in w-full max-w-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-magma">{Ic.gear(18)}</span>
              <span className="font-display uppercase tracking-wider text-paper text-sm">Управление эмулятором</span>
              <span className="tick-label text-gold ml-2">применяется сразу</span>
              <GhostBtn small className="ml-auto" onClick={() => setControlsOpen(false)}>{Ic.cross(12)} Закрыть</GhostBtn>
            </div>
            <KeyBinder compact />
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
    </div>
  );
}

/* ---------- кубик ---------- */

function DieFace({ v, dropping, delay }: { v: number; dropping?: boolean; delay?: boolean }) {
  const pips: Record<number, [number, number][]> = {
    1: [[1, 1]],
    2: [[0, 0], [2, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [0, 2], [2, 0], [2, 2]],
    5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
    6: [[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2]],
  };
  return (
    <div className={`w-16 h-16 bg-paper border-[3px] border-abyss shadow-[0_6px_0_rgba(0,0,0,0.5)] grid grid-cols-3 grid-rows-3 p-2 ${dropping ? 'dice-drop' : ''}`} style={dropping && delay ? { animationDelay: '0.07s' } : undefined}>
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
  const { roms, saves } = useApp();
  const [romId, setRomId] = useState('');
  const [saveId, setSaveId] = useState('');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const romSaves = saves.filter((x) => x.romId === romId);

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
    dispatch({ t: 'setCellTask', id: useApp.getState().selfId, cellIdx, task });
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
          {romId && roms.find((r) => r.id === romId)?.ext !== 'nes' && (
            <p className="text-[11px] text-magma">SEGA: слоты — как у NES; «без сохранения» стартует с начала рома.</p>
          )}
          <Field label="Название">
            <input className="field-in w-full px-3 py-2 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chip'n'Dale 2 — босс" />
          </Field>
          <Field label="Описание">
            <textarea className="field-in w-full px-3 py-2 text-sm h-16 resize-none" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Пройти босса с одной полоской здоровья…" />
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
