import type { PatrolDef } from './types';

/* ПАТРУЛИРОВАНИЕ (v0.52.0) — NPC и боссы ходят по точкам маршрута, как стражники в RPG.
   Движение ПОЛНОСТЬЮ ДЕТЕРМИНИРОВАННОЕ и считается ФОРМУЛОЙ от времени:
   позиция = patrolPos(def, base, now), где base — общий для всех клиентов момент
   старта партии (s.startedAt), now — текущий Date.now(). Никаких сетевых сообщений
   и состояния в GameSession: клиенты с одинаковыми часами видят одинаковую позицию,
   рассинхрон в доли секунды не страшен (тот же подход, что у анимации осколков ячеек).

   Маршрут обходится ПО КРУГУ: точка 1 → 2 → … → N → 1; в каждой точке — пауза
   (def.pause, сек), между точками — равномерное движение со скоростью def.speed (px/с).
   patrolFreeze «замораживает» время (повержённый босс замирает в точке гибели). */

export interface PatrolSeg {
  kind: 'walk' | 'pause';
  x1: number; y1: number; // walk: откуда; pause: точка ожидания
  x2: number; y2: number; // walk: куда
  t0: number;             // начало сегмента внутри цикла, сек
  dur: number;            // длительность, сек
}

/* Разбор маршрута в таймлайн сегментов. Возвращает null, если маршрут «не ходит»
   (меньше 2 точек, скорость ≤ 0, кривые координаты) — персонаж тогда стоит на месте. */
export function patrolTimeline(def: PatrolDef): { segs: PatrolSeg[]; total: number } | null {
  const pts = (def.pts ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  const speed = Math.max(1, Math.floor(def.speed ?? 40));
  const pause = Math.max(0, def.pause ?? 1);
  if (pts.length < 2 || speed <= 0) return null;
  const segs: PatrolSeg[] = [];
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 0.001) {
      const dur = len / speed;
      segs.push({ kind: 'walk', x1: a.x, y1: a.y, x2: b.x, y2: b.y, t0: t, dur });
      t += dur;
    }
    /* пауза в точке прибытия (b) — и в последней точке цикла (возврат в «дом») */
    if (pause > 0) {
      segs.push({ kind: 'pause', x1: b.x, y1: b.y, x2: b.x, y2: b.y, t0: t, dur: pause });
      t += pause;
    }
  }
  if (!segs.length) return null;
  return { segs, total: t };
}

/* Полная длина маршрута в px (для подсказок в редакторе). */
export function patrolLen(def: PatrolDef): number {
  const pts = (def.pts ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    L += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return Math.round(L);
}

/* Позиция патрулирующего в момент now (мс). base — синхронный тик отсчёта (s.startedAt).
   atTs — «заморозка» времени (мс): повержённый босс замирает там, где его настигли. */
export function patrolPos(def: PatrolDef | undefined, base: number, now: number, atTs?: number): { x: number; y: number } | null {
  if (!def || !def.pts?.length) return null;
  const tl = patrolTimeline(def);
  if (!tl) {
    const p0 = def.pts.find((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
    return p0 ? { x: p0.x, y: p0.y } : null;
  }
  let t = ((atTs ?? now) - (base || 0)) / 1000;
  if (!Number.isFinite(t) || t < 0) t = 0;
  t %= tl.total;
  for (const s of tl.segs) {
    if (t < s.t0 + s.dur || s === tl.segs[tl.segs.length - 1]) {
      const k = s.dur > 0 ? Math.max(0, Math.min(1, (t - s.t0) / s.dur)) : 0;
      if (s.kind === 'pause') return { x: s.x1, y: s.y1 };
      return { x: s.x1 + (s.x2 - s.x1) * k, y: s.y1 + (s.y2 - s.y1) * k };
    }
  }
  const p0 = def.pts[0];
  return { x: p0.x, y: p0.y };
}
