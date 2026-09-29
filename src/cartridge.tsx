import { useRef, useState } from 'react';
import { idbPut } from './db';
import type { RomDef } from './types';

/* ---------- v0.61: КАРТРИДЖИ ПЛАТФОРМ ----------
   Пиксельный бейдж рома в ФОРМЕ и ЦВЕТЕ картриджа/карты своей платформы
   (вместо прежней плоской надписи «NES/SEGA/PCE»):
   NES — серый с бороздками и тёмной этикеткой; SEGA Mega Drive/Genesis —
   чёрный с красной полосой; Master System — чёрный с белой этикеткой;
   GAME GEAR — маленький чёрный с пурпурной этикеткой; SNES — светлый
   с цветными точками кнопок; Game Boy / Color / GBA — «кирпичики» разной
   высоты и цвета; SEGA 32X — чёрный с красной крышкой; Atari 2600 — чёрный
   с серебристой этикеткой и радугой; PC Engine — плоская HuCARD (кремовая
   с оранжевой полосой, форма кредитной карты).
   У SEGA-ромов точная платформа добирается из расширения имени файла
   (.md/.gen/.bin — Mega Drive, .sms — Master System, .gg — GAME GEAR).
   Если у рома загружена ОБЛОЖКА (RomDef.cover) — вместо рисованного
   картриджа показывается она: можно выбирать ромы по фото реальных
   картриджей. */

export type CartKey = 'nes' | 'md' | 'sms' | 'gg' | 'snes' | 'gb' | 'gbc' | 'gba' | 'sega32' | 'a26' | 'pce' | 'sega';

export function cartKeyOf(ext: string | undefined, fileName?: string): CartKey {
  const e = (ext ?? '').toLowerCase();
  if (e === 'nes') return 'nes';
  if (e === 'snes') return 'snes';
  if (e === 'gb') return 'gb';
  if (e === 'gbc') return 'gbc';
  if (e === 'gba') return 'gba';
  if (e === '32x') return 'sega32';
  if (e === 'a26') return 'a26';
  if (e === 'pce') return 'pce';
  if (e === 'sega') {
    const fe = ((fileName ?? '').split('.').pop() ?? '').toLowerCase();
    if (fe === 'sms') return 'sms';
    if (fe === 'gg') return 'gg';
    return 'md'; // .md/.gen/.bin и старые ромы без расширения — рисуем Mega Drive
  }
  return 'md';
}

const CART_LABELS: Record<CartKey, string> = {
  nes: 'NES',
  md: 'SEGA Mega Drive / Genesis',
  sms: 'SEGA Master System',
  gg: 'SEGA GAME GEAR',
  snes: 'Super Nintendo (SNES)',
  gb: 'Game Boy',
  gbc: 'Game Boy Color',
  gba: 'Game Boy Advance',
  sega32: 'SEGA 32X',
  a26: 'Atari 2600',
  pce: 'PC Engine (HuCARD)',
  sega: 'SEGA',
};

export const cartLabelOf = (rom: { ext: string; fileName: string }): string => CART_LABELS[cartKeyOf(rom.ext, rom.fileName)];

type CartShape = { rows: string[]; pal: Record<string, string> };

/* формы картриджей: каждая — сетка символов + палитра ('.' — прозрачный пиксель) */
const CART_SHAPES: Partial<Record<CartKey, CartShape>> = {
  nes: {
    rows: [
      'KKKKKKKKKKK',
      'KGgGgGgGgGK',
      'KGgGgGgGgGK',
      'KGGGGGGGGGK',
      'KDDDDDDDDDK',
      'KDRRRRRRRDK',
      'KGGGGGGGGGK',
      'KGGGGGGGGGK',
      'KKKKKKKKKKK',
    ],
    pal: { K: '#10101a', G: '#d6d6cc', g: '#9a9a92', D: '#28304e', R: '#d8433a' },
  },
  md: {
    rows: [
      '.KKKKKKKK.',
      'KDDDDDDDDK',
      'KDDDDDDDDK',
      'KRRRRRRRRK',
      'KDDDDDDDDK',
      'KDDDDDDDDK',
      'KDDDDDDDDK',
      'KDDDDDDDDK',
      '.KKKKKKKK.',
    ],
    pal: { K: '#6a6a78', D: '#17171d', R: '#e8383c' },
  },
  sms: {
    rows: [
      '.KKKKKKKK.',
      'KDDDDDDDDK',
      'KWWWWWWWWK',
      'KWWRRRRWWK',
      'KWWWWWWWWK',
      'KDDDDDDDDK',
      'KDDDDDDDDK',
      'KDDDDDDDDK',
      '.KKKKKKKK.',
    ],
    pal: { K: '#6a6a78', D: '#1c1c22', W: '#e8e8e0', R: '#d8433a' },
  },
  gg: {
    rows: [
      'KKKKKKKK',
      'KDDDDDDK',
      'KMMMMMMK',
      'KMMMMMMK',
      'KDDDDDDK',
      'KDDDDDDK',
      'KggggggK',
      'KKKKKKKK',
    ],
    pal: { K: '#6a6a78', D: '#1a1a20', M: '#c048b8', g: '#2c2c34' },
  },
  snes: {
    rows: [
      '.KKKKKKKK.',
      'KGGGGGGGGK',
      'KGgGgGgGgK',
      'KGGGGGGGGK',
      'KGDRYBGDGK',
      'KGGGGGGGGK',
      'KGGGGGGGGK',
      'KGgGgGgGgK',
      '.KKKKKKKK.',
    ],
    pal: { K: '#10101a', G: '#d2cec4', g: '#a09c92', D: '#28304e', R: '#d8433a', Y: '#e8c832', B: '#3a6ad8' },
  },
  gb: {
    rows: [
      'KKKKKKKK',
      'KDDDDDDK',
      'KDDDDDDK',
      'KWWWWWWK',
      'KWWWWWWK',
      'KWWWWWWK',
      'KDDDDDDK',
      'KDDDDDDK',
      'KggggggK',
      'KKKKKKKK',
    ],
    pal: { K: '#10101a', D: '#585860', W: '#9a9aa2', g: '#3c3c44' },
  },
  gbc: {
    rows: [
      'KKKKKKKK',
      'KDDDDDDK',
      'KDDDDDDK',
      'KWWWWWWK',
      'KWWWWWWK',
      'KWWWWWWK',
      'KDDDDDDK',
      'KDDDDDDK',
      'KggggggK',
      'KKKKKKKK',
    ],
    pal: { K: '#10101a', D: '#3a7a68', W: '#6aae9a', g: '#2a5a4e' },
  },
  gba: {
    rows: [
      'KKKKKKKK',
      'KDDDDDDK',
      'KWWWWWWK',
      'KWWWWWWK',
      'KDDDDDDK',
      'KDDDDDDK',
      'KggggggK',
      'KKKKKKKK',
    ],
    pal: { K: '#10101a', D: '#3a3a44', W: '#787884', g: '#282830' },
  },
  sega32: {
    rows: [
      '.KKKKKKK.',
      'KDDDDDDDK',
      'KRRRRRRRK',
      'KRRRRRRRK',
      'KDDDDDDDK',
      'KDDDDDDDK',
      'KDDDDDDDK',
      'KDDDDDDDK',
      'KgggggggK',
      '.KKKKKKK.',
    ],
    pal: { K: '#6a6a78', D: '#17171d', R: '#e8383c', g: '#2c2c34' },
  },
  a26: {
    rows: [
      'KKKKKKKKKK',
      'KDDDDDDDDK',
      'KWWWWWWWWK',
      'KWRRYYBBWK',
      'KWWWWWWWWK',
      'KWWWWWWWWK',
      'KDDDDDDDDK',
      'KDDDDDDDDK',
      'KKKKKKKKKK',
    ],
    pal: { K: '#10101a', D: '#1c1c22', W: '#d8d8d0', R: '#d8433a', Y: '#e8c832', B: '#3a6ad8' },
  },
  pce: {
    rows: [
      'KKKKKKKKKKKK',
      'KOOOOOOOOOOK',
      'KOOOOOOOOOOK',
      'KWWWWWWWWWWK',
      'KWWWWWWWWWWK',
      'KWWWWWWWWWWK',
      'KggggggggggK',
      'KKKKKKKKKKKK',
    ],
    pal: { K: '#10101a', O: '#e8641c', W: '#f2ead8', g: '#c8c0a8' },
  },
};

/* цветной пиксельный SVG-картридж высотой h (ширина — по пропорции формы) */
function CPix({ rows, pal, h, w }: { rows: string[]; pal: Record<string, string>; h: number; w: number }) {
  const H = rows.length;
  const W = rows[0]?.length ?? 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={w} height={h} shapeRendering="crispEdges" aria-hidden className="block">
      {rows.flatMap((row, y) =>
        [...row].map((ch, x) =>
          ch === '.' || ch === ' ' ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={pal[ch] ?? '#888888'} />,
        ),
      )}
    </svg>
  );
}

/* ---------- бейдж рома: обложка (если загружена) или рисованный картридж ---------- */
export function CartridgeBadge({ rom, h = 18, className = '' }: { rom: { cover?: string; ext: string; fileName: string; name: string }; h?: number; className?: string }) {
  if (rom.cover) {
    return (
      <img
        src={rom.cover}
        alt={rom.name}
        title={rom.name}
        style={{ height: h }}
        className={`w-auto object-cover border border-[#313c72] bg-[#05070f] shrink-0 ${className}`}
      />
    );
  }
  const k = cartKeyOf(rom.ext, rom.fileName);
  const sh = CART_SHAPES[k] ?? CART_SHAPES.md!;
  const w = Math.max(1, Math.round((h * sh.rows[0].length) / sh.rows.length));
  return (
    <span className={`inline-block leading-none shrink-0 ${className}`} title={CART_LABELS[k]}>
      <CPix rows={sh.rows} pal={sh.pal} h={h} w={w} />
    </span>
  );
}

/* ---------- обложки картриджей: загрузка, сжатие, запись в IndexedDB ---------- */

/* картинка с диска → dataURL: длинная сторона сжимается до 320px, JPEG 0.82
   (обложка едет вместе с RomDef, поэтому держим её компактной) */
export async function fileToCover(file: File, maxSide = 320): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('не картинка'));
      im.src = url;
    });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext('2d');
    if (!cx) throw new Error('нет canvas');
    cx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* записать обложку рома (null — убрать) */
export async function storeRomCover(rom: RomDef, cover: string | null): Promise<void> {
  const next: RomDef = { ...rom };
  if (cover) next.cover = cover;
  else delete next.cover;
  await idbPut('roms', next.id, next);
}

/* кнопка 📷 со скрытым input file — загрузить/заменить обложку картриджа */
export function CoverPickBtn({ onPick, title, className = '' }: { onPick: (file: File) => void; title?: string; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={`cursor-pointer hover:text-gold ${className}`}
        title={title ?? 'Загрузить/заменить обложку картриджа'}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); ref.current?.click(); }}
      >
        📷
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }}
      />
    </>
  );
}

/* ---------- плитка рома в режиме картинок ---------- */
export function RomTile({
  rom, size, selected, onPick, onCover, onRemoveCover,
}: {
  rom: RomDef;
  size: number;
  selected?: boolean;
  onPick: () => void;
  onCover: (file: File) => void;
  onRemoveCover?: () => void;
}) {
  return (
    <div
      className={`relative border-2 cursor-pointer transition-colors ${selected ? 'border-gold bg-gold/10' : 'border-edge bg-panel hover:border-edge2'}`}
      style={{ width: size }}
      onClick={onPick}
      title={`${rom.name} — выбрать`}
    >
      <div className="flex items-center justify-center overflow-hidden bg-[#05070f]" style={{ height: Math.round(size * 0.82) }}>
        {rom.cover ? (
          <img src={rom.cover} alt={rom.name} className="w-full h-full object-cover" />
        ) : (
          <CartridgeBadge rom={rom} h={Math.round(size * 0.5)} />
        )}
      </div>
      <div className="px-1 py-0.5 text-center">
        <div className="font-display text-[9px] uppercase text-paper truncate leading-tight">{rom.name}</div>
      </div>
      <div className="absolute top-0.5 right-0.5 flex items-center gap-0.5 bg-[rgba(4,6,14,0.72)] px-0.5 rounded-sm">
        <CoverPickBtn onPick={onCover} className="text-[9px] leading-none py-0.5" title={rom.cover ? 'Заменить обложку' : 'Загрузить обложку картриджа'} />
        {rom.cover && onRemoveCover && (
          <button
            type="button"
            className="text-[9px] leading-none py-0.5 text-faint hover:text-coral cursor-pointer"
            title="Убрать обложку"
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onRemoveCover(); }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- «РАЗВЕРНУТЬ СПИСОК КАРТИНОК» — отдельное окно ----------
   Большая сетка картриджей/обложек одной папки: свой размер плиток (слайдер),
   прокрутка колёсиком мыши, клик по плитке выбирает ром. */
export function RomPicsModal({
  title, roms, selectedId, onClose, onPick, onCover, onRemoveCover,
}: {
  title: string;
  roms: RomDef[];
  selectedId?: string | null;
  onClose: () => void;
  onPick: (rom: RomDef) => void;
  onCover: (rom: RomDef, file: File) => void;
  onRemoveCover: (rom: RomDef) => void;
}) {
  const [size, setSize] = useState(120);
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[rgba(4,6,14,0.88)]" onClick={onClose} />
      <div className="relative pixel-panel pixel-corners pop-in w-full max-w-4xl p-4 flex flex-col max-h-[86vh]">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="font-display uppercase tracking-wider text-paper text-sm">
            🖼 {title} · {roms.length}
          </span>
          <span className="tick-label text-gold">колёсико мыши — прокрутка</span>
          <div className="flex items-center gap-2 ml-auto">
            <span className="tick-label text-faint shrink-0">размер плиток</span>
            <input
              type="range"
              min={64}
              max={224}
              step={4}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="w-28 accent-[var(--color-gold)] cursor-pointer"
              title="Размер картинок: больше — виднее, меньше — больше помещается"
            />
            <button
              type="button"
              onClick={onClose}
              className="text-faint hover:text-coral cursor-pointer font-display text-[11px] uppercase"
            >
              ✕ Закрыть
            </button>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto overflow-x-hidden pr-1">
          <div className="flex flex-wrap gap-2">
            {roms.map((r) => (
              <RomTile
                key={r.id}
                rom={r}
                size={size}
                selected={selectedId === r.id}
                onPick={() => onPick(r)}
                onCover={(file) => onCover(r, file)}
                onRemoveCover={() => onRemoveCover(r)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
