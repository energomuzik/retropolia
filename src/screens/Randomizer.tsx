import { useEffect, useRef, useState } from 'react';
import { sfx } from '../sound';

/* ---------- РАНДОМАЙЗЕР «КОЛЕСО ФОРТУНЫ» ----------
   Прокручивающийся список игр: первый клик запускает быструю прокрутку,
   второй — плавно останавливает. Выпавшая игра передаётся наверх (onPicked).
   Используется в безкартовых челленджах и SKILL CHALLENGE (25 случайных игр). */

const ROW = 46; // высота строки в px

export default function Randomizer({
  items,
  onPicked,
  disabled,
}: {
  items: { romId: string; title: string }[];
  onPicked: (item: { romId: string; title: string }) => void;
  disabled?: boolean;
}) {
  const [spinning, setSpinning] = useState(false); // фаза быстрой прокрутки
  const [stopping, setStopping] = useState(false); // фаза плавной остановки
  const [offset, setOffset] = useState(0);
  const offRef = useRef(0);
  const speedRef = useRef(0);
  const rafRef = useRef(0);
  const lastIdxRef = useRef(-1);

  const N = Math.max(1, items.length);
  const total = N * ROW;

  useEffect(() => {
    if (!spinning && !stopping) return;
    if (spinning) speedRef.current = 22; // px за кадр ~1320 px/с — бодрая прокрутка
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const k = dt / 16.7;
      if (stopping) {
        speedRef.current = Math.max(0.35, speedRef.current * Math.pow(0.972, k));
        if (speedRef.current <= 0.55) {
          // дотягиваем до ближайшей строки и останавливаемся
          const pos = ((offRef.current % total) + total) % total;
          const snapped = Math.round(pos / ROW) * ROW;
          offRef.current += (snapped - pos) / 1;
          setOffset(offRef.current);
          const idx = ((Math.round(snapped / ROW) % N) + N) % N;
          setSpinning(false);
          setStopping(false);
          sfx.coin();
          onPicked(items[idx] ?? items[0]);
          return; // не планируем следующий кадр
        }
      }
      offRef.current += speedRef.current * k;
      setOffset(offRef.current);
      // тик на каждую пройденную строку — ощущение механического колеса
      const idx = Math.floor((((offRef.current % total) + total) % total) / ROW);
      if (idx !== lastIdxRef.current) {
        lastIdxRef.current = idx;
        if (spinning) sfx.hover();
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinning, stopping]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const press = () => {
    if (disabled || items.length === 0 || stopping) return;
    sfx.click();
    if (spinning) {
      setSpinning(false);
      setStopping(true); // второй клик — плавная остановка
    } else {
      setSpinning(true); // первый клик — раскрутка
    }
  };

  const pos = ((offset % total) + total) % total;
  const shift = 1.5 * ROW - total - pos; // строка pos второй копии — в центре окна
  const activeIdx = Math.round(pos / ROW) % N;

  return (
    <div className="space-y-2">
      <div className="relative border-[3px] border-edge bg-[rgba(7,9,18,0.9)] overflow-hidden" style={{ height: ROW * 3 }}>
        {/* центр-маркер — золотые стрелки по бокам */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t-2 border-b-2 border-gold/60 pointer-events-none" style={{ height: ROW }} />
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 flex justify-between pointer-events-none px-1 z-10">
          <span className="text-gold font-pixel text-[10px]">▶</span>
          <span className="text-gold font-pixel text-[10px]">◀</span>
        </div>
        {/* лента из 3 копий списка */}
        <div style={{ transform: `translateY(${shift}px)` }}>
          {[0, 1, 2].map((rep) =>
            items.map((it, i) => {
              const active = rep === 1 && i === activeIdx;
              return (
                <div
                  key={`${rep}-${i}`}
                  className={`flex items-center gap-2 px-3 border-b border-edge/40 transition-colors ${active ? 'bg-gold/15 text-gold' : 'text-dim'}`}
                  style={{ height: ROW }}
                >
                  <span className="font-pixel text-[8px] w-5 text-faint shrink-0">{i + 1}</span>
                  <span className="font-display text-[12px] uppercase truncate">{it.title}</span>
                </div>
              );
            }),
          )}
        </div>
      </div>
      <button
        onClick={press}
        disabled={disabled || items.length === 0 || stopping}
        className={`w-full btn-px pixel-corners py-3 font-display uppercase text-[13px] select-none touch-none cursor-pointer ${
          spinning ? 'btn-coral' : 'btn-gold'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {items.length === 0 ? 'ПУСТО — НЕТ ИГР' : spinning ? 'ОСТАНОВИТЬ!' : stopping ? 'ОСТАНАВЛИВАЮСЬ…' : '🎰 КРУТИТЬ РАНДОМАЙЗЕР'}
      </button>
    </div>
  );
}
