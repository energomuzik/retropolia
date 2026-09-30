import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { idbPut } from './db';
import type { RomDef, TileImg } from './types';
import { extractTilesFromImage, type ExtractInfo } from './tilecut';
import { HoldDeleteButton } from './delGuard';
import { GhostBtn, Ic, Modal, PxBtn, Stepper } from './ui';
import { sfx } from './sound';
import { useApp } from './store';

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

/* v0.62: единое выделение названий платформ в подсказках (как GAME GEAR в v0.61);
   v0.65: каждая платформа — в СВОЁМ цвете (PLAT_COLOR ниже) */
/* v0.65: ЦВЕТ ПЛАТФОРМЫ — название приставки в подсказках красится в цвет СВОЕЙ
   платформы (вместо единого золота): SEGA — синий, Game Boy — серый, GAME GEAR —
   пурпур (цвет её этикетки на бейдже), 32X — красный, Atari — оранжевый и т.д.
   Ключи — текст, как он написан в <PlatName>…</PlatName> (регистр не важен). */
const PLAT_COLOR: Record<string, string> = {
  'nes': 'text-dim',
  'sega': 'text-sky',
  'sega mega drive': 'text-sky',
  'mega drive': 'text-sky',
  'master system': 'text-sky',
  'game gear': 'text-[#c048b8]',
  'snes': 'text-paper',
  'game boy/color': 'text-dim',
  'gba': 'text-[#8f7bff]',
  'sega 32x': 'text-coral',
  'atari 2600': 'text-magma',
  'pc engine': 'text-gold',
};

export function PlatName({ children }: { children: ReactNode }) {
  const key = String(children).trim().toLowerCase();
  return <span className={`${PLAT_COLOR[key] ?? 'text-gold'} font-display uppercase`}>{children}</span>;
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
   рядом с 📷 («готовая картинка целиком») — для скана/скриншота/фото с однотонным
   фоном, где картридж нужно ещё ВЫРЕЗАТЬ. v0.63: открывает ТОТ ЖЕ вырезатель,
   что режет тайлы в редакторе карт (CartCutModal), — не рамку-кроппер */
export function CoverCropBtn({ onPick, title, className = '' }: { onPick: (file: File) => void; title?: string; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={`cursor-pointer hover:text-gold ${className}`}
        title={title ?? '✂ Вырезать картридж из картинки (вырезатель тайлов, как в редакторе карт)'}
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

/* ---------- v0.63: ✕ «Убрать обложку» — ПО ТЕМ ЖЕ ПРАВИЛАМ, ЧТО УДАЛЕНИЕ В РЕДАКТОРЕ КАРТ ----------
   Кнопка подчиняется режиму удаления из Опций (options.delMode: мгновенно /
   с подтверждением / удержанием с полоской) — как крестики тайлов и «Удалить все
   сохранения». Само «убирание» запоминается вызывающей стороной через
   rememberDeleted — Ctrl+Z возвращает обложку на место. */
export function CoverRemoveBtn({
  romName, onRemove, className = 'text-[10px] leading-none py-0.5 text-faint hover:text-coral cursor-pointer', as = 'button',
}: {
  romName: string;
  onRemove: () => void;
  className?: string;
  as?: 'button' | 'span'; // span — когда крестик лежит ВНУТРИ кликабельной плитки (нужен stopPropagation)
}) {
  return (
    <HoldDeleteButton
      as={as}
      verb="Убрать"
      confirmTitle="Убрать обложку картриджа"
      hintWord="уберу"
      label={`обложку картриджа «${romName}»`}
      ariaLabel="Убрать обложку картриджа"
      title="Убрать обложку (режим удаления — в Опциях, как в редакторе карт)"
      onFire={onRemove}
      className={className}
    >✕</HoldDeleteButton>
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
      {/* v0.66: кнопки 📷 ✂ ✕ УБРАНЫ С КАРТИНКИ — раньше висели поверх арта в правом
          верхнем углу плитки; теперь они в нижней полосе, на месте надписи названия:
          картинка чистая, кнопки не перекрывают картридж. Название осталось рядом. */}
      <div className="px-1 py-0.5 flex items-center gap-1">
        <span className="flex items-center gap-0.5 shrink-0">
          <CoverPickBtn onPick={onCover} className="text-[9px] leading-none py-0.5" title={rom.cover ? 'Заменить обложку' : 'Загрузить обложку картриджа'} />
          {onCropFile && (
            <CoverCropBtn onPick={onCropFile} className="text-[9px] leading-none py-0.5" title="✂ Вырезать картридж из картинки — вырезатель тайлов, как в редакторе карт" />
          )}
          {/* v0.63: убрать обложку — по правилам удаления из Опций (подтверждение/удержание) */}
          {rom.cover && onRemoveCover && (
            <CoverRemoveBtn
              as="span"
              romName={rom.name}
              onRemove={onRemoveCover}
              className="text-[9px] leading-none py-0.5 text-faint hover:text-coral cursor-pointer"
            />
          )}
        </span>
        <span className="font-display text-[9px] uppercase text-paper truncate leading-tight flex-1 text-left">{rom.name}</span>
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


/* ---------- v0.63: ВЫРЕЗАТЕЛЬ КАРТИКОВ = ВЫРЕЗАТЕЛЬ ТАЙЛОВ ИЗ РЕДАКТОРА КАРТ ----------
   Кнопка ✂ открывает картинку (скан, скриншот, фото с однотонным фоном), и дальше
   работает ТОТ ЖЕ ДВИЖОК НАРЕЗКИ ТАЙЛОВ, что в редакторе карт (tilecut.ts):
   фон АВТО/палитра/пипетка, допуск, мин. размер, склейка частей, мелкий текст —
   нарезка пересчитывается на лету. КЛИК ПО ВЫРЕЗАННОМУ ТАЙЛУ — тайл становится
   обложкой рома: пропорции сохраняются честно (HuCARD остаётся вертикальной,
   широкий картридж — широким), прозрачный фон остаётся прозрачным.
   Режим «Один размер (анимации)» из редактора карт тут НЕ показан: обложке он
   только вредил бы (пустые поля вокруг картриджа) — каждый тайл режется в своём
   собственном размере. */

/* вырезанный тайл (PNG с прозрачным фоном) → обложка: длинная сторона ≤ 320px,
   PNG — прозрачность сохраняется; тайл, который уже влезает, остаётся как есть */
export async function tileToCover(dataUrl: string, maxSide = 320): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('не картинка'));
    im.src = dataUrl;
  });
  const w0 = img.naturalWidth || 1;
  const h0 = img.naturalHeight || 1;
  if (Math.max(w0, h0) <= maxSide) return dataUrl;
  const k = maxSide / Math.max(w0, h0);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w0 * k));
  cv.height = Math.max(1, Math.round(h0 * k));
  const cx = cv.getContext('2d');
  if (!cx) throw new Error('нет canvas');
  cx.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/png');
}

type CutParams = { bgMode: 'auto' | 'custom'; bg: string; thr: number; minSize: number; mergeGap: number; keepText: boolean };

/* те же стартовые параметры нарезки, что у вырезателя тайлов в редакторе карт */
const CUT_START: CutParams = { bgMode: 'auto', bg: '#000000', thr: 25, minSize: 6, mergeGap: 1, keepText: false };

export function CartCutModal({
  rom, file, onClose, onSave,
}: {
  rom: { name: string };
  file: File;
  onClose: () => void;
  onSave: (dataUrl: string) => void;
}) {
  const toast = useApp((s) => s.toast);
  const [src, setSrc] = useState<string | null>(null);
  const [prm, setPrm] = useState<CutParams>(CUT_START);
  const [busy, setBusy] = useState(true);
  const [tiles, setTiles] = useState<TileImg[]>([]);
  const [foundBg, setFoundBg] = useState('');
  const [picked, setPicked] = useState<string | null>(null); // выбранный тайл → станет обложкой
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [saving, setSaving] = useState(false);
  const infoRef = useRef<ExtractInfo | null>(null);
  const runRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  /* превью исходника: objectURL живёт, пока открыто окно */
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const runCut = useCallback(async (p: CutParams) => {
    const run = ++runRef.current;
    setBusy(true);
    try {
      const r = await extractTilesFromImage(file, { ...p, oneSize: false }, infoRef);
      if (runRef.current !== run) return;
      setTiles(r.tiles);
      setFoundBg(r.bg);
      setPicked(null);
      setBusy(false);
      if (r.tiles.length) sfx.coin();
      else toast('Ничего не нашлось: снизьте мин. размер, поменяйте фон или допуск', 'err');
    } catch {
      if (runRef.current !== run) return;
      setBusy(false);
      toast('Не удалось обработать картинку', 'err');
    }
  }, [file, toast]);

  /* смена параметра: цифра меняется сразу, пересчёт — с небольшой задержкой
     (как в редакторе карт); эффект срабатывает и на монтировании — первый прогон */
  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void runCut(prm), 180);
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, [prm, runCut]);

  /* пипетка: клик по превью — взять цвет фона из этой точки (как в редакторе карт) */
  const pipetteBg = (e: { clientX: number; clientY: number; currentTarget: HTMLImageElement }) => {
    const im = e.currentTarget;
    const info = infoRef.current;
    if (!info || !im.naturalWidth) return;
    const r = im.getBoundingClientRect();
    const sc0 = Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight); // object-contain: учитываем поля
    const dw = im.naturalWidth * sc0, dh = im.naturalHeight * sc0;
    const ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
    const fx = (e.clientX - r.left - ox) / dw;
    const fy = (e.clientY - r.top - oy) / dh;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return;
    const x = Math.min(info.W - 1, Math.round(fx * info.W));
    const y = Math.min(info.H - 1, Math.round(fy * info.H));
    const i = (y * info.W + x) * 4;
    const hex = (v: number) => v.toString(16).padStart(2, '0');
    setPrm((p) => ({ ...p, bgMode: 'custom', bg: `#${hex(info.data[i])}${hex(info.data[i + 1])}${hex(info.data[i + 2])}` }));
    sfx.hover();
  };

  const pickedTile = tiles.find((t) => t.id === picked) ?? null;
  const psz = picked ? sizes[picked] : undefined;

  const confirmCut = async () => {
    if (!pickedTile || saving) return;
    setSaving(true);
    try {
      onSave(await tileToCover(pickedTile.dataUrl));
    } catch {
      toast('Не удалось подготовить обложку', 'err');
      setSaving(false);
    }
  };

  return (
    <Modal title={`✂ Вырезать картридж · ${rom.name}`} icon={<span className="text-teal">{Ic.cart(16)}</span>} onClose={onClose} w="max-w-2xl">
      <p className="text-[12px] text-dim mb-3">
        Тот же вырезатель, что у тайлов в редакторе карт. Картинка с картриджами на однотонном фоне (скан, скриншот, фото на простом фоне):
        укажите фон (клик по превью = пипетка, или АВТО/палитра), подберите допуск, минимальный размер и склейку — нарезка пересчитается сама.
        КЛИК ПО ВЫРЕЗАННОМУ ТАЙЛУ — он станет обложкой: пропорции тайла сохраняются честно, прозрачный фон остаётся прозрачным.
      </p>
      <div className="flex gap-3 mb-3">
        <img
          src={src ?? ''}
          alt="исходник"
          onClick={pipetteBg}
          className="w-36 h-36 shrink-0 object-contain border-2 border-edge bg-[repeating-conic-gradient(#141833_0_25%,#0b0e1c_0_50%)_0_0/12px_12px] cursor-crosshair"
          title="Клик — взять цвет фона пипеткой"
        />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-dim shrink-0">Фон:</span>
            <button
              onClick={() => setPrm((p) => ({ ...p, bgMode: 'auto' }))}
              className={`px-2 py-1 text-[9px] font-pixel border-2 cursor-pointer ${prm.bgMode === 'auto' ? 'border-gold text-gold' : 'border-edge text-faint hover:text-dim'}`}
              title="Найти фон автоматически (самый частый цвет картинки)"
            >АВТО</button>
            <input
              type="color"
              value={prm.bg}
              onChange={(e) => setPrm((p) => ({ ...p, bgMode: 'custom', bg: e.target.value }))}
              className="w-8 h-8 border-2 border-edge bg-transparent cursor-pointer p-0"
              title="Выбрать цвет фона палитрой"
            />
            <span className="tick-label text-faint truncate">
              {prm.bgMode === 'custom' ? prm.bg : (foundBg || '…')}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-dim">Допуск фона</span>
            <Stepper value={prm.thr} onChange={(v) => setPrm((p) => ({ ...p, thr: v }))} min={0} max={200} step={5} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-dim">Мин. размер (px)</span>
            <Stepper value={prm.minSize} onChange={(v) => setPrm((p) => ({ ...p, minSize: v }))} min={2} max={120} step={2} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-dim">Склейка частей (px)</span>
            <Stepper value={prm.mergeGap} onChange={(v) => setPrm((p) => ({ ...p, mergeGap: v }))} min={0} max={20} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-dim">Мелкий текст (подписи)</span>
            <button
              onClick={() => setPrm((p) => ({ ...p, keepText: !p.keepText }))}
              className={`px-2 py-1 text-[9px] font-pixel border-2 cursor-pointer ${prm.keepText ? 'border-gold text-gold' : 'border-edge text-faint hover:text-dim'}`}
              title="Мелкий чёрно-белый текст (подписи автора на листе): выбросить или оставить"
            >{prm.keepText ? 'ОСТАВИТЬ' : 'ВЫБРОСИТЬ'}</button>
          </div>
          <p className="text-[10px] text-faint leading-tight">
            ЛИШНЕЕ прилипло к картриджу — уменьшите допуск. Картридж РАЗВАЛИЛСЯ на части — увеличьте склейку.
            Соседние КАРТРИДЖИ СЛИПЛИСЬ — уменьшите склейку (и проверьте фон пипеткой). Мусор в списке — увеличьте мин. размер.
          </p>
          {busy && <div className="text-gold font-display text-[10px] uppercase animate-pulse">Нарезаю…</div>}
        </div>
      </div>
      {tiles.length > 0 && (
        <div className="grid grid-cols-8 gap-1.5 mb-3 max-h-44 overflow-y-auto border-2 border-edge p-1.5 bg-[rgba(11,14,28,0.6)]">
          {tiles.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { setPicked(t.id); sfx.hover(); }}
              className={`aspect-square border-2 overflow-hidden cursor-pointer bg-[repeating-conic-gradient(#141833_0_25%,#0b0e1c_0_50%)_0_0/8px_8px] ${picked === t.id ? 'border-gold' : 'border-edge hover:border-edge2'}`}
              title={`Тайл ${t.name} — вырезать и поставить обложку`}
            >
              <img
                src={t.dataUrl}
                alt={t.name}
                className="w-full h-full object-contain"
                style={{ imageRendering: 'pixelated' }}
                /* v0.64: БАГФИКС КРАША «БЕЛЫЙ ЭКРАН»: e.currentTarget валиден ТОЛЬКО
                   во время события — внутри ленивого апдейтера setSizes он уже null
                   (React вызывает апдейтер позже), и чтение naturalWidth роняло всё
                   дерево. Размеры снимаем СРАЗУ в обработчике, в апдейтер — числа. */
                onLoad={(e) => {
                  const el = e.currentTarget;
                  const w = el.naturalWidth, h = el.naturalHeight;
                  setSizes((m) => (m[t.id] ? m : { ...m, [t.id]: { w, h } }));
                }}
              />
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-3 flex-wrap">
        <span className="tick-label text-dim mr-auto">
          {pickedTile ? (psz ? `вырезано: ${psz.w}×${psz.h} px — станет обложкой` : 'тайл выбран — станет обложкой') : 'клик по тайлу — выбрать обложку'}
        </span>
        <GhostBtn onClick={onClose}>Отмена</GhostBtn>
        <PxBtn color="teal" onClick={() => void confirmCut()} disabled={!pickedTile || busy || saving}>
          ✂ Поставить обложку
        </PxBtn>
      </div>
    </Modal>
  );
}
