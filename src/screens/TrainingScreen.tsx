import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { GhostBtn, Ic, PxBtn } from '../ui';
import { sfx } from '../sound';
import { TRAINING, type TSection, type TSlide, type TAnn } from '../trainingData';

/* v0.78 ОБУЧЕНИЕ — слайды-снимки с автопереключением и СГЕНЕРИРОВАННОЙ озвучкой.
   Озвучка — mp3-файлы (нейроголос «Дмитрий», edge-tts), лежат в
   src/assets/training/voice/<раздел>-<номер>.mp3 и раздаются Vite как ассеты.
   Слайд переключается по окончании озвучки (ended); без mp3 — по таймеру.
   Никакого speechSynthesis и никакой музыки. Указатели (anns) рисуются
   поверх снимка: стрелки и рамки показывают, куда нажимать. */

/* URL снимков: Vite собирает всё из src/assets/training (webp), ключ — имя файла */
const IMGS = import.meta.glob('../assets/training/*.webp', { eager: true, import: 'default', query: '?url' }) as Record<string, string>;
const imgOf = (key: string): string | null => {
  const url = IMGS[`../assets/training/${key}.webp`];
  return typeof url === 'string' ? url : null;
};

/* mp3-озвучка: имя файла = `${section.id}-${индексСлайда}.mp3` */
const VOICES = import.meta.glob('../assets/training/voice/*.mp3', { eager: true, import: 'default', query: '?url' }) as Record<string, string>;
const voiceOf = (secId: string, idx: number): string | null => {
  const url = VOICES[`../assets/training/voice/${secId}-${idx}.mp3`];
  return typeof url === 'string' ? url : null;
};

interface PlayItem { slide: TSlide; sec: TSection; si: number }
interface PlayState { title: string; color: string; items: PlayItem[]; idx: number }

/* длительность слайда без озвучки: читаемая скорость ~12 знаков/сек */
const slideDur = (s: TSlide): number => Math.max(7000, Math.min(17000, 4500 + (s.narr ?? s.x).length * 62));

/* ---------- слой указателей (стрелки и рамки поверх снимка) ---------- */
function Anns({ anns }: { anns?: TAnn[] }) {
  if (!anns || !anns.length) return null;
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
      {anns.map((a, i) => {
        const gold = '#ffcf3f';
        const teal = '#3fe0d0';
        const c = i % 2 === 0 ? gold : teal;
        if (a.k === 'box') {
          const w = a.w ?? 12, h = a.h ?? 8;
          return (
            <g key={i}>
              <rect x={a.x} y={a.y} width={w} height={h} fill="none" stroke={c} strokeWidth="0.5" vectorEffect="non-scaling-stroke" className="drop-shadow" />
              <rect x={a.x} y={a.y} width={w} height={h} fill={c} opacity="0.12" />
              {a.label && (
                <text x={a.x + 0.6} y={a.y - 1} fontSize="2.6" fill={c} style={{ paintOrder: 'stroke' }} stroke="#060a16" strokeWidth="0.7">
                  {a.label}
                </text>
              )}
            </g>
          );
        }
        /* стрелка: приходит с направления d и указывает остриём в точку (x,y) */
        const L = 6;
        const tip = { x: a.x, y: a.y };
        const tail = a.d === 'left' ? { x: tip.x + L, y: tip.y }
          : a.d === 'right' ? { x: tip.x - L, y: tip.y }
          : a.d === 'up' ? { x: tip.x, y: tip.y + L }
          : { x: tip.x, y: tip.y - L };
        const hx = a.d === 'left' ? 2.2 : a.d === 'right' ? -2.2 : 0;
        const hy = a.d === 'up' ? 2.2 : a.d === 'down' ? -2.2 : 0;
        return (
          <g key={i}>
            <line x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y} stroke={c} strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
            <polygon
              points={`${tip.x},${tip.y} ${tip.x + hx - (a.d === 'up' || a.d === 'down' ? 1.4 : 0)},${tip.y + hy - (a.d === 'left' || a.d === 'right' ? 1.4 : 0)} ${tip.x + hx + (a.d === 'up' || a.d === 'down' ? 1.4 : 0)},${tip.y + hy + (a.d === 'left' || a.d === 'right' ? 1.4 : 0)}`}
              fill={c}
            />
            {a.label && (
              <text x={(tip.x + tail.x) / 2} y={(tip.y + tail.y) / 2 - 1.4} fontSize="2.6" fill={c} textAnchor="middle" style={{ paintOrder: 'stroke' }} stroke="#060a16" strokeWidth="0.7">
                {a.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function TrainingScreen() {
  const { setScreen } = useApp();

  const [play, setPlay] = useState<PlayState | null>(null);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [fade, setFade] = useState(false); // плавная смена слайда
  const [voiceOk, setVoiceOk] = useState(true); // есть ли mp3 у текущего слайда
  const epoch = useRef(0); // инвалидация устаревших колбэков озвучки/таймера
  const timer = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopAudio = useCallback(() => {
    try { audioRef.current?.pause(); } catch { /* noop */ }
    audioRef.current = null;
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
  }, []);

  /* озвучка слайда + планирование следующего. next() срабатывает РОВНО один раз
     на слайд (сторож onended + таймер могли бы удвоить ход) */
  const narrate = useCallback((it: PlayItem, myEpoch: number) => {
    stopAudio();
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
    const src = !muted ? voiceOf(it.sec.id, it.si) : null;
    setVoiceOk(!!src);
    if (!src) {
      /* mp3 нет (сбой генерации/новый слайд) — листаем по таймеру, подписи остаются */
      timer.current = window.setTimeout(next, slideDur(it.slide));
      return;
    }
    try {
      const a = new Audio(src);
      audioRef.current = a;
      a.onended = next;
      a.onerror = next;
      a.play().catch(() => next());
      /* сторож: если вкладка в фоне тормозит события — ходим по таймеру с запасом */
      timer.current = window.setTimeout(next, Math.max(slideDur(it.slide), 12000) + 30000);
      /* предзагрузка следующего клипа — без пауз при переходе */
      const nx = play?.items[it.si + 1] ?? null;
      void nx;
    } catch { timer.current = window.setTimeout(next, slideDur(it.slide)); }
  }, [muted, stopAudio, play]);

  /* реакция на смену слайда/раздела/паузы/звука */
  useEffect(() => {
    if (!play) { stopAudio(); return; }
    if (paused) return;
    const it = play.items[play.idx];
    if (!it) { stopAudio(); return; }
    narrate(it, epoch.current);
    return stopAudio; // cleanup при смене зависимости
  }, [play, paused, narrate, stopAudio]);

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
    stopAudio();
    setPaused(false);
    setFade(false);
    epoch.current += 1;
    const items: PlayItem[] = sec === 'all'
      ? TRAINING.flatMap((s) => s.slides.map((sl, i) => ({ slide: sl, sec: s, si: i })))
      : sec.slides.map((sl, i) => ({ slide: sl, sec, si: i }));
    const title = sec === 'all' ? 'Пройти всё подряд' : sec.title;
    const color = sec === 'all' ? '#ffcf3f' : sec.color;
    setPlay({ title, color, items, idx: 0 });
  }, [stopAudio]);

  const close = useCallback(() => {
    epoch.current += 1;
    stopAudio();
    setPlay(null);
    setPaused(false);
  }, [stopAudio]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      const np = !p;
      try { if (np) audioRef.current?.pause(); else void audioRef.current?.play(); } catch { /* noop */ }
      return np;
    });
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const nm = !m;
      try { if (nm) audioRef.current?.pause(); } catch { /* noop */ }
      return nm;
    });
    /* смена звука перезапускает слайд: новая эпоха */
    epoch.current += 1;
    setPlay((p) => (p ? { ...p } : p));
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

  /* уйти с экрана обучения — остановить озвучку */
  useEffect(() => () => { try { audioRef.current?.pause(); } catch { /* noop */ } }, []);

  const cur = play ? play.items[play.idx] : null;
  const curImg = cur ? imgOf(cur.slide.img) : null;
  const pct = play ? Math.round(((play.idx + 1) / play.items.length) * 100) : 0;
  const totalSlides = useMemo(() => TRAINING.reduce((n, s) => n + s.slides.length, 0), []);

  const voiceNote = !voiceOk ? 'Этот слайд без mp3 — таймер' : 'Озвучка: нейроголос Дмитрий (mp3)';

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
          слайды по каждому режиму и редактору — с озвучкой нейроголосом
        </p>

        {/* пройти всё подряд */}
        <div className="mt-4">
          <PxBtn big color="gold" className="w-full" onClick={() => start('all')}>
            {Ic.play(18)} ПРОЙТИ ВСЁ ПОДРЯД · {totalSlides} слайдов
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
            <button title={muted ? 'Включить озвучку' : 'Выключить озвучку'} onClick={toggleMute}
              className={`px-2 py-1 border-2 font-pixel text-[10px] ${muted ? 'text-faint border-edge' : 'text-gold border-gold'}`}>
              {muted ? '🔇' : '🔊'}
            </button>
            <button title="Закрыть (Esc)" onClick={close} className="px-2 py-1 border-2 border-edge text-dim font-pixel text-[10px] hover:text-paper hover:border-edge2">✕</button>
          </div>

          {/* снимок + подпись */}
          <div className="flex-1 min-h-0 overflow-y-auto flex items-start justify-center px-4 py-4">
            <div className={`w-full max-w-3xl flex flex-col gap-3 transition-opacity duration-300 ${fade ? 'opacity-0' : 'opacity-100'}`}>
              <div className="pixel-panel pixel-corners overflow-hidden bg-[rgba(0,0,0,0.5)] relative">
                {curImg
                  ? <img src={curImg} alt={cur.slide.t} className="w-full h-auto block" draggable={false} />
                  : <div className="h-56 flex flex-col items-center justify-center gap-2 text-faint">
                      <span className="font-pixel text-[12px]">СНИМОК: {cur.slide.img}</span>
                      <span className="text-[10px]">нет файла src/assets/training/{cur.slide.img}.webp</span>
                    </div>}
                {curImg && <Anns anns={cur.slide.anns} />}
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
                <span className="font-pixel text-[8px] text-faint">{paused ? 'ПАУЗА' : voiceNote.toUpperCase()}</span>
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
