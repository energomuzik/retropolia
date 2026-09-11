import { useApp } from './store';

/* ---------- ЗАЦИКЛЕННЫЕ ЗВУКИ (анимации со звуком и звук хода фишки) ----------
   Каждый ключ — один HTMLAudioElement (loop). Громкость плавно «едет» к цели:
   • звуки радиуса у анимаций появляются/затухают, когда фишка играющего входит/
     выходит из круга, и приглушаются на время задания (эмулятора);
   • звук хода фишки стартует сразу и гаснет быстро, когда фишка дошла.
   Базовая громкость — ползунок «Громкость эффектов» из Опций (options.volume). */

interface LoopEntry {
  audio: HTMLAudioElement;
  src: string;
  vol: number;   // текущая громкость 0..1 (до множителя базовой)
  target: number; // куда едем
  spd: number;    // скорость фейда за тик
}

const loops = new Map<string, LoopEntry>();
let timer: number | null = null;
let oneShot: HTMLAudioElement | null = null;

const baseVolume = () => Math.max(0, Math.min(1, useApp.getState().options.volume));

const tick = () => {
  if (!loops.size) {
    if (timer !== null) { window.clearInterval(timer); timer = null; }
    return;
  }
  for (const e of loops.values()) {
    if (e.vol === e.target) continue;
    const d = e.spd;
    e.vol = Math.abs(e.target - e.vol) <= d ? e.target : e.vol + Math.sign(e.target - e.vol) * d;
    e.audio.volume = Math.max(0, Math.min(1, e.vol * baseVolume()));
    if (e.target === 0 && e.vol === 0 && !e.audio.paused) e.audio.pause(); // затух — встал на паузу, но остаётся на случай возврата
  }
};
const ensureTimer = () => {
  if (timer === null) timer = window.setInterval(tick, 90);
};

/** Запустить (или продолжить) зацикленный звук под ключом. instant — сразу полной громкостью. */
export function startLoop(key: string, src: string, opts?: { instant?: boolean; spd?: number }) {
  let e = loops.get(key);
  if (!e || e.src !== src) {
    if (e) e.audio.pause();
    const audio = new Audio(src);
    audio.loop = true;
    audio.preload = 'auto';
    e = { audio, src, vol: 0, target: 1, spd: opts?.spd ?? 0.08 };
    loops.set(key, e);
  }
  e.target = 1;
  e.spd = opts?.spd ?? e.spd;
  if (opts?.instant) { e.vol = 1; e.audio.volume = Math.max(0, Math.min(1, baseVolume())); }
  e.audio.play().catch(() => { /* автоплей до первого клика по странице — молча ждём */ });
  ensureTimer();
}

/** Плавно погасить один звук (например, фишка дошла). */
export function stopLoop(key: string, spd?: number) {
  const e = loops.get(key);
  if (!e) return;
  e.target = 0;
  if (spd) e.spd = spd;
  ensureTimer();
}

/** Плавно погасить ВСЕ звуки группы с префиксом (например, 'amb-'). */
export function stopGroup(prefix: string) {
  for (const [key, e] of loops) {
    if (key.startsWith(prefix)) e.target = 0;
  }
  ensureTimer();
}

/** Остановить НАВСЕГДА все звуки группы: пауза + удаление из карты (уход с экрана игры). */
export function killGroup(prefix: string) {
  for (const [key, e] of loops) {
    if (!key.startsWith(prefix)) continue;
    e.audio.pause();
    loops.delete(key);
  }
}

/** Привести группу к желаемому состоянию: ключи из wanted играют (фейд-ин или
    ПРОДОЛЖЕНИЕ после паузы), остальные группы — гаснут. wanted: ключ(без префикса) → src.
    Важно: луп, который уже есть и уже играл (затух и встал на паузу), при повторном
    появлении в wanted ПРОДОЛЖАЕТСЯ с места паузы — так звук радиуса звучит при каждом
    входе в круг и возобновляется, когда в круге передали ход. */
export function syncLoops(prefix: string, wanted: Map<string, string>, spd?: number) {
  for (const [key, e] of loops) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    const src = wanted.get(id);
    // чужие/сменённые источники гасим и убираем из wanted — ниже для них стартует новый луп
    if (!src || e.src !== src) { e.target = 0; wanted.delete(id); }
  }
  // startLoop для ВСЕХ wanted: существующий луп просто вернёт target=1 и снимется с паузы,
  // уже играющий не пострадает (play() у играющего аудио — нет-оп)
  for (const [id, src] of wanted) startLoop(prefix + id, src, { spd });
  ensureTimer();
}

/** Разовое проигрывание звука (превью в редакторе): новое запускается, старое глохнет. */
export function playOneShot(src: string) {
  stopOneShot();
  const a = new Audio(src);
  a.volume = baseVolume();
  oneShot = a;
  a.play().catch(() => { /* автоплей до жеста — молча */ });
}

export function stopOneShot() {
  if (oneShot) { oneShot.pause(); oneShot = null; }
}
