import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { GhostBtn, Ic, Panel, PxBtn } from '../ui';
import { sfx } from '../sound';
import { TRAINING, type TSection, type TSlide } from '../trainingData';

/* v0.77 ОБУЧЕНИЕ — слайды-снимки с автопереключением и озвучкой.
   Озвучка — Web Speech API (speechSynthesis, ru-RU): ноль байт в бандле,
   голос берётся из системы; если русского голоса нет — слайды просто листаются
   по таймеру (и остаётся подпись-текст). Никаких mp3 и чиптюна — только голос. */

/* URL снимков: Vite собирает всё из src/assets/training (webp), ключ — имя файла */
const IMGS = import.meta.glob('../assets/training/*.webp', { eager: true, import: 'default', query: '?url' }) as Record<string, string>;
const imgOf = (key: string): string | null => {
  const url = IMGS[`../assets/training/${key}.webp`];
  return typeof url === 'string' ? url : null;
};

interface PlayItem { slide: TSlide; sec: TSection }
interface PlayState { title: string; color: string; items: PlayItem[]; idx: number }

/* длительность слайда без озвучки: читаемая скорость ~12 знаков/сек */
const slideDur = (s: TSlide): number => Math.max(7000, Math.min(17000, 4500 + s.x.length * 62));

function pickVoice(): SpeechSynthesisVoice | null {
  try {
    const vs = window.speechSynthesis?.getVoices?.() ?? [];
    return vs.find((v) => /^ru/i.test(v.lang) && /google/i.test(v.name))
      ?? vs.find((v) => /^ru/i.test(v.lang))
      ?? null;
  } catch { return null; }
}

export default function TrainingScreen() {
  const { setScreen } = useApp();

  const [play, setPlay] = useState<PlayState | null>(null);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [voicesTick, setVoicesTick] = useState(0);
  const [fade, setFade] = useState(false); // плавная смена слайда
  const epoch = useRef(0); // инвалидация устаревших колбэков озвучки/таймера
  const timer = useRef<number | null>(null);

  const speechOk = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const voice = speechOk ? pickVoice() : null;
  const voiceNote = !speechOk ? 'Озвучка недоступна в этом браузере — слайды с подписями'
    : voice ? 'Озвучка: русский голос браузера' : 'Русский голос не найден — слайды с подписями';

  /* голоса подгружаются асинхронно — обновляемся, когда приедут */
  useEffect(() => {
    if (!speechOk) return;
    const h = () => setVoicesTick((t) => t + 1);
    try { window.speechSynthesis.onvoiceschanged = h; } catch { /* noop */ }
    return () => { try { window.speechSynthesis.onvoiceschanged = null; } catch { /* noop */ } };
  }, [speechOk]);

  const stopSpeech = useCallback(() => {
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
  }, []);

  /* озвучка слайда + планирование следующего. next() срабатывает РОВНО один раз
     на слайд (сторож onend + таймер могли бы удвоить ход) */
  const narrate = useCallback((it: PlayItem, myEpoch: number) => {
    stopSpeech();
    let done = false;
    const next = () => {
      if (done || epoch.current !== myEpoch) return;
      done = true;
      setFade(true);
      window.setTimeout(() => {
        if (epoch.current !== myEpoch) return;
        setPlay((p) => {
          if (!p || epoch.current !== myEpoch) return p;
          if (p.idx + 1 >= p.items.length) return null; // курс закончен → меню
          return { ...p, idx: p.idx + 1 };
        });
        setFade(false);
      }, 420);
    };
    const ruVoice = speechOk ? pickVoice() : null;
    if (muted || !speechOk || !ruVoice) {
      /* голоса нет — листаем по таймеру (подписи остаются) */
      timer.current = window.setTimeout(next, slideDur(it.slide));
      return;
    }
    try {
      const u = new SpeechSynthesisUtterance(it.slide.x);
      u.lang = 'ru-RU';
      u.voice = ruVoice;
      u.rate = 1.04;
      u.pitch = 1;
      u.onend = next;
      u.onerror = next;
      window.speechSynthesis.speak(u);
      /* сторож: если движок молчит и onend не приходит — ходим по таймеру */
      timer.current = window.setTimeout(next, Math.max(slideDur(it.slide), it.slide.x.length * 130));
    } catch { timer.current = window.setTimeout(next, slideDur(it.slide)); }
  }, [muted, speechOk, stopSpeech]);

  /* реакция на смену слайда/раздела/паузы/звука */
  useEffect(() => {
    if (!play || paused) { if (!play) stopSpeech(); return; }
    const it = play.items[play.idx];
    if (!it) { stopSpeech(); return; }
    narrate(it, epoch.current);
    return stopSpeech; // cleanup при смене зависимости
  }, [play, paused, narrate, stopSpeech, voicesTick]);

  /* смена раздела/слайда вручную — новая эпоха */
  const goTo = useCallback((delta: number) => {
    setFade(false);
    setPlay((p) => {
      if (!p) return p;
      const idx = Math.max(0, Math.min(p.items.length - 1, p.idx + delta));
      epoch.current += 1;
      return { ...p, idx };
    });
  }, []);

  const start = useCallback((sec: TSection | 'all') => {
    sfx.coin();
    stopSpeech();
    setPaused(false);
    setFade(false);
    epoch.current += 1;
    const items: PlayItem[] = sec === 'all'
      ? TRAINING.flatMap((s) => s.slides.map((sl) => ({ slide: sl, sec: s })))
      : sec.slides.map((sl) => ({ slide: sl, sec }));
    const title = sec === 'all' ? 'Пройти всё подряд' : sec.title;
    const color = sec === 'all' ? '#ffcf3f' : sec.color;
    setPlay({ title, color, items, idx: 0 });
  }, [stopSpeech]);

  const close = useCallback(() => {
    epoch.current += 1;
    stopSpeech();
    setPlay(null);
    setPaused(false);
  }, [stopSpeech]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      const np = !p;
      if (np) { try { window.speechSynthesis?.pause(); } catch { /* noop */ } }
      else { try { window.speechSynthesis?.resume(); } catch { /* noop */ } }
      return np;
    });
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const nm = !m;
      try { if (nm) window.speechSynthesis?.cancel(); } catch { /* noop */ }
      return nm;
    });
  }, []);

  /* Esc — закрыть окно слайдов; ←/→ — листать */
  useEffect(() => {
    if (!play) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') goTo(-1);
      else if (e.key === 'ArrowRight') goTo(1);
      else if (e.key === ' ') { e.preventDefault(); togglePause(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, close, goTo, togglePause]);

  /* уйти с экрана обучения — остановить речь */
  useEffect(() => () => { try { window.speechSynthesis?.cancel(); } catch { /* noop */ } }, []);

  const cur = play ? play.items[play.idx] : null;
  const curImg = cur ? imgOf(cur.slide.img) : null;
  const pct = play ? Math.round(((play.idx + 1) / play.items.length) * 100) : 0;

  return (
    <div className="h-full crt-grid-bg relative overflow-hidden">
      <div className="absolute inset-0 starfield opacity-60 pointer-events-none" />
      <div className="relative z-10 h-full max-w-4xl mx-auto px-6 py-5 flex flex-col">
        {/* шапка */}
        <div className="flex items-center gap-3 pt-2">
          <GhostBtn onClick={() => { sfx.click(); setScreen('menu'); }}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-pixel text-gold title-glow text-[16px] sm:text-[20px]">ОБУЧЕНИЕ</h1>
        </div>
        <p className="mt-2 text-[11px] text-dim font-display uppercase tracking-wider">
          слайды по каждому режиму и редактору — с озвучкой голосом браузера
        </p>

        {/* пройти всё подряд */}
        <div className="mt-4">
          <PxBtn big color="gold" className="w-full" onClick={() => start('all')}>
            {Ic.play(18)} ПРОЙТИ ВСЁ ПОДРЯД · {TRAINING.reduce((n, s) => n + s.slides.length, 0)} слайдов
          </PxBtn>
        </div>

        {/* разделы — скроллящийся список кнопок */}
        <div className="mt-4 flex-1 min-h-0 overflow-y-auto pb-4 pr-1">
          <div className="grid sm:grid-cols-2 gap-2.5">
            {TRAINING.map((s) => (
              <button
                key={s.id}
                onClick={() => start(s)}
                onMouseEnter={() => sfx.hover()}
                className="menu-row w-full text-left flex items-center gap-4 px-5 py-3 border-2 border-transparent bg-[rgba(19,26,51,0.35)] transition-all hover:bg-panel2"
                style={{ '--rowc': s.color } as React.CSSProperties}
              >
                <span className="shrink-0 font-pixel text-[13px]" style={{ color: s.color }}>{s.slides.length}</span>
                <span className="flex-1 min-w-0">
                  <span className="block font-display uppercase tracking-wide text-[14px] text-dim hover:text-paper transition-colors">{s.title}</span>
                  <span className="block text-[10.5px] text-faint mt-0.5">{s.desc}</span>
                </span>
                <span className="font-pixel text-[9px]" style={{ color: s.color }}>▶</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ======== окно просмотра слайдов ======== */}
      {play && cur && (
        <div className="fixed inset-0 z-[90] bg-[rgba(6,9,20,0.93)] backdrop-blur-sm flex flex-col">
          {/* шапка окна */}
          <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b-2 border-edge bg-[rgba(13,18,38,0.8)]">
            <span className="font-pixel text-[10px]" style={{ color: play.color }}>{play.title.toUpperCase()}</span>
            <span className="ml-auto font-pixel text-[9px] text-faint">{play.idx + 1} / {play.items.length}</span>
            <button title={paused ? 'Продолжить (пробел)' : 'Пауза (пробел)'} onClick={togglePause}
              className={`px-2 py-1 border-2 border-edge font-pixel text-[10px] ${paused ? 'text-gold border-gold' : 'text-dim'}`}>
              {paused ? '▶' : '❚❚'}
            </button>
            <button title={voiceNote} onClick={toggleMute}
              className={`px-2 py-1 border-2 font-pixel text-[10px] ${muted ? 'text-faint border-edge' : 'text-gold border-gold'}`}>
              {muted ? '🔇' : '🔊'}
            </button>
            <button title="Закрыть (Esc)" onClick={close} className="px-2 py-1 border-2 border-edge text-dim font-pixel text-[10px] hover:text-paper hover:border-edge2">✕</button>
          </div>

          {/* снимок + подпись */}
          <div className="flex-1 min-h-0 overflow-y-auto flex items-start justify-center px-4 py-4">
            <div className={`w-full max-w-3xl flex flex-col gap-3 transition-opacity duration-300 ${fade ? 'opacity-0' : 'opacity-100'}`}>
              <div className="pixel-panel pixel-corners overflow-hidden bg-[rgba(0,0,0,0.5)]">
                {curImg
                  ? <img src={curImg} alt={cur.slide.t} className="w-full h-auto block" draggable={false} />
                  : <div className="h-56 flex flex-col items-center justify-center gap-2 text-faint">
                      <span className="font-pixel text-[12px]">СНИМОК: {cur.slide.img}</span>
                      <span className="text-[10px]">нет файла src/assets/training/{cur.slide.img}.webp</span>
                    </div>}
              </div>
              <div className="pixel-panel pixel-corners px-5 py-4">
                <div className="font-display uppercase tracking-wide text-[14px] mb-1.5" style={{ color: play.color }}>{cur.slide.t}</div>
                <p className="text-[12.5px] leading-relaxed text-paper/90">{cur.slide.x}</p>
              </div>
            </div>
          </div>

          {/* низ: прогресс + навигация */}
          <div className="shrink-0 px-4 py-3 border-t-2 border-edge bg-[rgba(13,18,38,0.8)]">
            <div className="max-w-3xl mx-auto">
              <div className="h-1.5 bg-[rgba(255,255,255,0.08)] overflow-hidden">
                <div className="h-full transition-all duration-500" style={{ width: `${pct}%`, background: play.color }} />
              </div>
              <div className="mt-2.5 flex items-center justify-center gap-3">
                <GhostBtn small onClick={() => goTo(-1)}>‹ Назад</GhostBtn>
                <span className="font-pixel text-[8px] text-faint">{voiceNote.toUpperCase()}</span>
                {play.idx + 1 < play.items.length
                  ? <GhostBtn small onClick={() => goTo(1)}>Далее ›</GhostBtn>
                  : <PxBtn small color="gold" onClick={close}>Готово</PxBtn>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
