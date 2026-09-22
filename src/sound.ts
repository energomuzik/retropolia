let ctx: AudioContext | null = null;
let volume = 0.6;

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v));
}

function ac(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, dur: number, type: OscillatorType = 'square', gain = 0.12, delay = 0, slide = 0) {
  const a = ac();
  if (!a || volume <= 0) return;
  const t0 = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(gain * volume, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

/* ШУМ (белый) для выстрелов/треска: буфер создаётся один раз и кэшируется */
let noiseBuf: AudioBuffer | null = null;
function noise(dur: number, gain = 0.2, delay = 0, freq = 1200, type: BiquadFilterType = 'lowpass', q = 0.8) {
  const a = ac();
  if (!a || volume <= 0) return;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, Math.floor(a.sampleRate * 0.6), a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = a.currentTime + delay;
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = a.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(gain * volume, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(a.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

export const sfx = {
  click() { tone(660, 0.06, 'square', 0.1); },
  hover() { tone(440, 0.035, 'square', 0.05); },
  coin() { tone(988, 0.08, 'square', 0.12); tone(1319, 0.22, 'square', 0.12, 0.07); },
  dice() { tone(220 + Math.random() * 500, 0.05, 'square', 0.07); },
  drop() { tone(180, 0.2, 'square', 0.14, 0, -120); tone(520, 0.1, 'square', 0.1, 0.12); },
  step() { tone(520, 0.05, 'triangle', 0.12); },
  success() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.14, 'square', 0.12, i * 0.09)); },
  fail() { [392, 311, 233].forEach((f, i) => tone(f, 0.2, 'sawtooth', 0.1, i * 0.13)); },
  alarm() { [880, 622, 880, 622].forEach((f, i) => tone(f, 0.1, 'square', 0.1, i * 0.11)); },
  card() { tone(392, 0.1, 'triangle', 0.12); tone(587, 0.16, 'triangle', 0.12, 0.08); },
  whoosh() { tone(140, 0.25, 'sawtooth', 0.08, 0, 320); },
  portal() { tone(220, 0.28, 'sine', 0.14, 0, 1200); tone(1200, 0.3, 'sine', 0.1, 0.12, -900); }, // взлёт и спад — «телепорт» через портал
  start() { [262, 330, 392, 523, 659, 784].forEach((f, i) => tone(f, 0.12, 'square', 0.1, i * 0.07)); },
  /* ---------- ВЫСТРЕЛЫ RUBG: у каждого оружия свой характер ----------
     пистолет — короткий сухой хлопок; ПП — очередь из трёх; снайперка — мощный
     длинный бас с «хвостом»-эхом. Шум + низкий тон = правдоподобный выстрел. */
  shotPistol() { noise(0.09, 0.32, 0, 1500); tone(190, 0.09, 'square', 0.15, 0, -120); },
  shotSmg() { for (let i = 0; i < 3; i++) { noise(0.06, 0.26, i * 0.07, 1700); tone(215, 0.06, 'square', 0.12, i * 0.07, -130); } },
  shotSniper() { noise(0.24, 0.36, 0, 950); tone(115, 0.32, 'sawtooth', 0.2, 0, -70); noise(0.5, 0.11, 0.06, 520); },
  /* ---------- мини-игра «взлом замка» ---------- */
  pinBump() { tone(700 + Math.random() * 250, 0.045, 'square', 0.07); }, // боек подпрыгнул
  pinFix() { tone(1180, 0.06, 'square', 0.12); tone(1560, 0.11, 'square', 0.1, 0.05); }, // боек зафиксирован
  pinBreak() { noise(0.13, 0.26, 0, 2600, 'highpass'); tone(300, 0.16, 'sawtooth', 0.12, 0, -190); }, // отмычка сломана
  boxOpen() { [392, 523, 659, 784].forEach((f, i) => tone(f, 0.12, 'square', 0.11, i * 0.07)); }, // ящик открыт
};
