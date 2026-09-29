import { useEffect, useRef, useState, type ReactNode } from 'react';
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

/* v0.62: ЕДИНОЕ выделение названий платформ в подсказках — как у GAME GEAR в v0.61:
   каждая приставка (NES, SEGA Mega Drive, Master System, GAME GEAR, SNES,
   Game Boy/Color, GBA, SEGA 32X, Atari 2600, PC Engine) — в одном золотом
   пиксельном стиле, чтобы все платформы читались одинаково */
export function PlatName({ children }: { children: ReactNode }) {
  return <span className="text-gold font-display uppercase">{children}</span>;
}

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
    /* v0.62: высота фиксирована, ширина — СВОБОДНАЯ (по natural-пропорции):
       вертикальная HuCARD не сплющивается, широкий картридж не обрезается */
    return (
      <img
        src={rom.cover}
        alt={rom.name}
        title={rom.name}
        style={{ height: h, width: 'auto' }}
        className={`border border-[#313c72] bg-[#05070f] shrink-0 ${className}`}
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

/* кнопка ✂ со скрытым input file — ВЫРЕЗАТЬ картридж из картинки (v0.62):
   рядом с 📷 («готовая картинка целиком») — для фото полки/скана/скриншота,
   где картридж нужно ещё ВЫРЕЗАТЬ; пропорции выреза сохраняются честно */
export function CoverCropBtn({ onPick, title, className = '' }: { onPick: (file: File) => void; title?: string; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={`cursor-pointer hover:text-gold ${className}`}
        title={title ?? '✂ Вырезать картридж из картинки'}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); ref.current?.click(); }}
      >
        ✂
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
  rom, size, selected, onPick, onCover, onCropFile, onRemoveCover,
}: {
  rom: RomDef;
  size: number;
  selected?: boolean;
  onPick: () => void;
  onCover: (file: File) => void;
  onCropFile?: (file: File) => void;
  onRemoveCover?: () => void;
}) {
  return (
    <div
      className={`relative border-2 cursor-pointer transition-colors ${selected ? 'border-gold bg-gold/10' : 'border-edge bg-panel hover:border-edge2'}`}
      style={{ width: size }}
      onClick={onPick}
      title={`${rom.name} — выбрать`}
    >
      {/* v0.62: object-contain вместо object-cover — обложка показывается ЦЕЛИКОМ:
          вертикальная HuCARD не сплющивается и не режется сверху/снизу, широкий
          картридж (Famicom, SEGA MD) не обрезается по бокам; пропорции честные */}
      <div className="flex items-center justify-center overflow-hidden bg-[#05070f]" style={{ height: Math.round(size * 0.82) }}>
        {rom.cover ? (
          <img src={rom.cover} alt={rom.name} className="w-full h-full object-contain" />
        ) : (
          <CartridgeBadge rom={rom} h={Math.round(size * 0.5)} />
        )}
      </div>
      <div className="px-1 py-0.5 text-center">
        <div className="font-display text-[9px] uppercase text-paper truncate leading-tight">{rom.name}</div>
      </div>
      <div className="absolute top-0.5 right-0.5 flex items-center gap-0.5 bg-[rgba(4,6,14,0.72)] px-0.5 rounded-sm">
        <CoverPickBtn onPick={onCover} className="text-[9px] leading-none py-0.5" title={rom.cover ? 'Заменить обложку' : 'Загрузить обложку картриджа'} />
        {onCropFile && (
          <CoverCropBtn onPick={onCropFile} className="text-[9px] leading-none py-0.5" title="✂ Вырезать картридж из картинки (фото/скан)" />
        )}
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
  title, roms, selectedId, onClose, onPick, onCover, onCrop, onRemoveCover,
}: {
  title: string;
  roms: RomDef[];
  selectedId?: string | null;
  onClose: () => void;
  onPick: (rom: RomDef) => void;
  onCover: (rom: RomDef, file: File) => void;
  onCrop?: (rom: RomDef, file: File) => void;
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
                onCropFile={onCrop ? (file) => onCrop(r, file) : undefined}
                onRemoveCover={() => onRemoveCover(r)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- v0.62: НОЖНИЦЫ — вырезать картридж из картинки ----------
   Окно открывается кнопкой ✂ (рядом с 📷) и работает с ЛЮБОЙ картинкой —
   фото полки, скан, скриншот: пользователь рамкой выделяет картридж,
   и ВЫРЕЗАННЫЙ ФРАГМЕНТ становится обложкой рома.
   ГЛАВНОЕ — честные пропорции: что вырезали, то и хранится и показывается;
   вертикальная HuCARD остаётся вытянутой по вертикали и НЕ обрезается,
   широкий картридж (Famicom, SEGA MD) НЕ обрезается по бокам.
   Рамку можно двигать (внутри) и тянуть за 4 угла; при желании
   фиксируется соотношение сторон (свободно / 1:1 / 4:3 / 3:4 / …). */

/* вырезанный фрагмент → dataURL обложки: длинная сторона сжимается до 320px,
   JPEG 0.82 — те же правила, что у fileToCover (обложка едет вместе с RomDef) */
export function cropToCover(img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, maxSide = 320): string {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k));
  const h = Math.max(1, Math.round(sh * k));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const cx = cv.getContext('2d');
  if (!cx) throw new Error('нет canvas');
  cx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return cv.toDataURL('image/jpeg', 0.82);
}

type CropRect = { x: number; y: number; w: number; h: number };
type Corner = 'nw' | 'ne' | 'sw' | 'se';

const CROP_RATIOS: { label: string; v: number }[] = [
  { label: 'Свободно', v: 0 },
  { label: '1:1 квадрат', v: 1 },
  { label: '4:3 горизонтально', v: 4 / 3 },
  { label: '3:4 вертикально', v: 3 / 4 },
  { label: '3:2 горизонтально', v: 3 / 2 },
  { label: '2:3 вертикально', v: 2 / 3 },
  { label: '16:9 горизонтально', v: 16 / 9 },
  { label: '9:16 вертикально', v: 9 / 16 },
];

export function CoverCropModal({
  rom, file, onClose, onSave,
}: {
  rom: { name: string };
  file: File;
  onClose: () => void;
  onSave: (dataUrl: string) => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(0); // 0 — свободно
  const [rect, setRect] = useState<CropRect | null>(null);
  const [ready, setReady] = useState(false); // картинка открыта и размер замерен
  const imgRef = useRef<HTMLImageElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null); // контейнер ровно по картинке
  const natRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 }); // натуральный размер
  const boxSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 }); // показанный размер
  const dragRef = useRef<{
    mode: 'new' | 'move' | 'resize';
    corner?: Corner;
    sx: number; sy: number; // точка старта (экранные px внутри картинки)
    r0: CropRect | null;    // рамка на момент старта
  } | null>(null);
  const ratioRef = useRef(0);
  ratioRef.current = ratio;

  const MIN = 12; // минимальная рамка в экранных px

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    setReady(false);
    setRect(null);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /* Esc в окне — просто закрыть (кат-сцены и окна заданий тут не живут) */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', fn, true);
    return () => window.removeEventListener('keydown', fn, true);
  }, [onClose]);

  const measure = () => {
    const im = imgRef.current;
    if (!im || !im.naturalWidth) return;
    natRef.current = { w: im.naturalWidth, h: im.naturalHeight };
    const b = im.getBoundingClientRect();
    boxSizeRef.current = { w: b.width, h: b.height };
    setReady(true);
  };

  /* соотношение сторон: подгоняем w/h так, чтобы w/h = ratio (большая сторона ведёт) */
  const fitRatio = (w: number, h: number): { w: number; h: number } => {
    const r = ratioRef.current;
    if (!r) return { w, h };
    return w / Math.max(h, 1) > r ? { w, h: w / r } : { w: h * r, h };
  };

  const clampRect = (r: CropRect): CropRect => {
    const W = boxSizeRef.current.w, H = boxSizeRef.current.h;
    const w = Math.max(MIN, Math.min(r.w, W));
    const h = Math.max(MIN, Math.min(r.h, H));
    const x = Math.max(0, Math.min(r.x, W - w));
    const y = Math.max(0, Math.min(r.y, H - h));
    return { x, y, w, h };
  };

  const localPt = (e: React.PointerEvent): { x: number; y: number } => {
    const b = boxRef.current?.getBoundingClientRect();
    const bw = b?.width ?? 0, bh = b?.height ?? 0;
    return {
      x: Math.max(0, Math.min(e.clientX - (b?.left ?? 0), bw)),
      y: Math.max(0, Math.min(e.clientY - (b?.top ?? 0), bh)),
    };
  };

  const startDrag = (e: React.PointerEvent, mode: 'new' | 'move' | 'resize', corner?: Corner) => {
    if (!ready) return;
    e.stopPropagation();
    e.preventDefault();
    const p = localPt(e);
    dragRef.current = { mode, corner, sx: p.x, sy: p.y, r0: rect ? { ...rect } : null };
    boxRef.current?.setPointerCapture?.(e.pointerId);
    if (mode === 'new') setRect(clampRect({ x: p.x, y: p.y, w: MIN, h: MIN }));
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = localPt(e);
    if (d.mode === 'new') {
      let w = Math.abs(p.x - d.sx);
      let h = Math.abs(p.y - d.sy);
      ({ w, h } = fitRatio(Math.max(w, MIN), Math.max(h, MIN)));
      setRect(clampRect({ x: p.x >= d.sx ? d.sx : d.sx - w, y: p.y >= d.sy ? d.sy : d.sy - h, w, h }));
      return;
    }
    if (d.mode === 'move' && d.r0) {
      setRect(clampRect({ ...d.r0, x: d.r0.x + (p.x - d.sx), y: d.r0.y + (p.y - d.sy) }));
      return;
    }
    if (d.mode === 'resize' && d.r0 && d.corner) {
      const c = d.corner;
      const ax = c === 'nw' || c === 'sw' ? d.r0.x + d.r0.w : d.r0.x; // якорь — противоположный угол
      const ay = c === 'nw' || c === 'ne' ? d.r0.y + d.r0.h : d.r0.y;
      let w = Math.max(MIN, Math.abs(p.x - ax));
      let h = Math.max(MIN, Math.abs(p.y - ay));
      ({ w, h } = fitRatio(w, h));
      setRect(clampRect({
        x: c === 'nw' || c === 'sw' ? ax - w : ax,
        y: c === 'nw' || c === 'ne' ? ay - h : ay,
        w,
        h,
      }));
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { boxRef.current?.releasePointerCapture?.(e.pointerId); } catch { /* не критично */ }
  };

  /* смена фиксированного соотношения — текущая рамка сразу подгоняется */
  const changeRatio = (v: number) => {
    setRatio(v);
    ratioRef.current = v;
    setRect((r) => (r && v ? clampRect({ ...r, h: r.w / v }) : r));
  };

  const doCrop = () => {
    const im = imgRef.current;
    const r = rect;
    const b = boxSizeRef.current;
    if (!im || !r || !b.w || !natRef.current.w) return;
    const scale = natRef.current.w / b.w; // экранные px → натуральные
    const sx = Math.max(0, Math.round(r.x * scale));
    const sy = Math.max(0, Math.round(r.y * scale));
    const sw = Math.max(1, Math.round(r.w * scale));
    const sh = Math.max(1, Math.round(r.h * scale));
    onSave(cropToCover(im, sx, sy, sw, sh));
  };

  const nw = rect && boxSizeRef.current.w ? Math.max(1, Math.round((rect.w * natRef.current.w) / boxSizeRef.current.w)) : 0;
  const nh = rect && boxSizeRef.current.h ? Math.max(1, Math.round((rect.h * natRef.current.h) / boxSizeRef.current.h)) : 0;

  const cornerBtn = (c: Corner, cls: string) => (
    <span
      onPointerDown={(e) => startDrag(e, 'resize', c)}
      className={`absolute w-3 h-3 bg-gold border border-[#05070f] ${c === 'nw' || c === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'} ${cls}`}
    />
  );

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[rgba(4,6,14,0.9)]" onClick={onClose} />
      <div className="relative pixel-panel pixel-corners pop-in w-full max-w-4xl p-4 flex flex-col max-h-[92vh]">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="font-display uppercase tracking-wider text-paper text-sm">✂ Вырезать картридж · {rom.name}</span>
          <span className="tick-label text-gold">тяните по картинке — выделите картридж; рамка двигается и тянется за углы</span>
          <button type="button" onClick={onClose} className="ml-auto text-faint hover:text-coral cursor-pointer font-display text-[11px] uppercase">✕ Закрыть</button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-[#05070f] border-2 border-edge p-2">
          {failed ? (
            <p className="text-[12px] text-magma p-6 text-center">Не удалось открыть картинку — попробуйте другой файл.</p>
          ) : (
            /* контейнер РОВНО по картинке — координаты рамки считаются от него */
            <div
              ref={boxRef}
              className="relative overflow-hidden select-none"
              style={{ touchAction: 'none', cursor: 'crosshair' }}
              onPointerDown={(e) => startDrag(e, 'new')}
              onPointerMove={onMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <img
                ref={imgRef}
                src={imgUrl ?? ''}
                alt="исходная картинка"
                draggable={false}
                onLoad={measure}
                onError={() => setFailed(true)}
                className="block max-w-full"
                style={{ maxHeight: '56vh' }}
              />
              {rect && ready && (
                <div
                  onPointerDown={(e) => startDrag(e, 'move')}
                  className="absolute border-2 border-gold cursor-move"
                  style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxShadow: '0 0 0 9999px rgba(4,6,14,0.62)' }}
                >
                  {cornerBtn('nw', '-left-1 -top-1')}
                  {cornerBtn('ne', '-right-1 -top-1')}
                  {cornerBtn('sw', '-left-1 -bottom-1')}
                  {cornerBtn('se', '-right-1 -bottom-1')}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span className="tick-label text-faint shrink-0">соотношение сторон</span>
          <select
            className="field-in px-2 py-1.5 text-[11px] cursor-pointer"
            value={ratio}
            onChange={(e) => changeRatio(Number(e.target.value))}
            title="Свободно — рамка любого размера; фиксированное — рамка тянется только по заданной пропорции"
          >
            {CROP_RATIOS.map((r) => <option key={r.label} value={r.v}>{r.label}</option>)}
          </select>
          <span className="tick-label text-dim shrink-0">
            {rect && ready ? `выделено: ${nw}×${nh} px` : 'выделите картридж рамкой'}
          </span>
          <span className="tick-label text-faint shrink-0">вырезанное станет обложкой — пропорции сохранятся честно</span>
          <span className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 border-2 border-edge text-[11px] font-display uppercase text-dim hover:text-paper cursor-pointer">Отмена</button>
            <button
              type="button"
              onClick={doCrop}
              disabled={!rect || !ready}
              className={`px-3 py-1.5 border-2 font-display uppercase text-[11px] cursor-pointer ${rect && ready ? 'border-gold text-gold bg-gold/10 hover:bg-gold/20' : 'border-edge text-faint cursor-not-allowed'}`}
            >
              ✂ Вырезать и поставить
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
