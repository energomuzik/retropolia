import { useEffect, useRef, useState } from 'react';
import { sfx } from './sound';

export type PaintTool = 'pen' | 'eraser' | 'fill' | 'picker';

const PALETTE = [
  '#0a0c18', '#e9ecff', '#ff5d73', '#ff8b3f', '#ffcf3f', '#9be84d',
  '#2ee6a8', '#5aa9ff', '#7a5af5', '#ff7ad9', '#8a5a3a', '#5a628f',
  '#313c72', '#ffffff', '#c0c6e8', '#3a4a2a',
];

export interface PixelPaintProps {
  /** null = прозрачный пиксель */
  grid: (string | null)[];
  w: number;
  h: number;
  onChange: (grid: (string | null)[]) => void;
  /** показывать ли шахматную подложку прозрачности */
  checker?: boolean;
}

/** Компактный пиксельный редактор: карандаш, ластик, заливка, пипетка. */
export default function PixelPaint({ grid, w, h, onChange, checker = true }: PixelPaintProps) {
  const [color, setColor] = useState(PALETTE[4]);
  const [tool, setTool] = useState<PaintTool>('pen');
  const drawingRef = useRef(false);
  const lastCellRef = useRef(-1);

  const idx = (x: number, y: number) => y * w + x;

  const setPx = (x: number, y: number) => {
    const i = idx(x, y);
    if (i < 0 || i >= grid.length) return;
    const next = grid.slice();
    if (tool === 'eraser') next[i] = null;
    else if (tool === 'pen') next[i] = color;
    else return;
    onChange(next);
  };

  const floodFill = (x: number, y: number) => {
    const target = grid[idx(x, y)];
    const rep: string | null = tool === 'eraser' ? null : color;
    if (target === rep) return;
    const next = grid.slice();
    const stack: [number, number][] = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const i = idx(cx, cy);
      if (next[i] !== target) continue;
      next[i] = rep;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    onChange(next);
  };

  const cellFromEvent = (e: React.PointerEvent): [number, number] | null => {
    const el = e.currentTarget as HTMLDivElement;
    const r = el.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * h);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    return [x, y];
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    const c = cellFromEvent(e);
    if (!c) return;
    if (tool === 'fill') { sfx.hover(); floodFill(c[0], c[1]); return; }
    if (tool === 'picker') {
      const v = grid[idx(c[0], c[1])];
      if (v) setColor(v);
      setTool('pen');
      sfx.hover();
      return;
    }
    drawingRef.current = true;
    lastCellRef.current = idx(c[0], c[1]);
    setPx(c[0], c[1]);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    const c = cellFromEvent(e);
    if (!c) return;
    const i = idx(c[0], c[1]);
    if (i === lastCellRef.current) return;
    lastCellRef.current = i;
    setPx(c[0], c[1]);
  };
  const onUp = () => { drawingRef.current = false; lastCellRef.current = -1; };

  useEffect(() => {
    const up = () => { drawingRef.current = false; };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  const cell = Math.max(8, Math.min(26, Math.floor(460 / Math.max(w, h))));

  const tools: { key: PaintTool; label: string; hint: string }[] = [
    { key: 'pen', label: '✏', hint: 'Карандаш' },
    { key: 'eraser', label: '⌫', hint: 'Ластик (прозрачность)' },
    { key: 'fill', label: '▣', hint: 'Заливка области' },
    { key: 'picker', label: '◉', hint: 'Пипетка' },
  ];

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-1.5 flex-wrap justify-center">
        {tools.map((t) => (
          <button
            key={t.key}
            title={t.hint}
            onClick={() => { setTool(t.key); sfx.click(); }}
            className={`w-9 h-9 border-2 font-display text-sm transition-colors cursor-pointer ${tool === t.key ? 'border-gold text-gold bg-gold/10' : 'border-edge text-dim hover:text-paper hover:border-edge2'}`}
          >
            {t.label}
          </button>
        ))}
        <span className="w-px h-7 bg-edge mx-1" />
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => { setColor(c); if (tool === 'eraser' || tool === 'fill') setTool('pen'); sfx.hover(); }}
            title={c}
            className={`w-6 h-6 border-2 cursor-pointer transition-transform hover:scale-110 ${color === c && tool !== 'eraser' ? 'border-paper scale-110' : 'border-abyss'}`}
            style={{ background: c }}
          />
        ))}
      </div>
      <div
        className="relative border-[3px] border-edge2 select-none touch-none cursor-crosshair shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
        style={{ width: cell * w, height: cell * h }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {checker && (
          <div
            className="absolute inset-0"
            style={{
              background: 'conic-gradient(#1a2244 25%, #10142a 0 50%, #1a2244 0 75%, #10142a 0)',
              backgroundSize: '16px 16px',
            }}
          />
        )}
        <svg width={cell * w} height={cell * h} className="absolute inset-0" shapeRendering="crispEdges">
          {grid.map((px, i) =>
            px ? <rect key={i} x={(i % w) * cell} y={Math.floor(i / w) * cell} width={cell} height={cell} fill={px} /> : null,
          )}
          {/* сетка */}
          {[...Array(w + 1)].map((_, x) => (
            <line key={`v${x}`} x1={x * cell} y1={0} x2={x * cell} y2={h * cell} stroke="rgba(7,9,18,0.35)" strokeWidth={1} />
          ))}
          {[...Array(h + 1)].map((_, y) => (
            <line key={`h${y}`} x1={0} y1={y * cell} x2={w * cell} y2={y * cell} stroke="rgba(7,9,18,0.35)" strokeWidth={1} />
          ))}
        </svg>
      </div>
      <div className="tick-label text-faint">
        {w}×{h} px · {tool === 'pen' ? 'карандаш' : tool === 'eraser' ? 'ластик' : tool === 'fill' ? 'заливка' : 'пипетка'} · прозрачные пиксели = шахматная подложка
      </div>
    </div>
  );
}

/* ---------- утилиты: изображение <-> пиксельная сетка ---------- */

export function imageToGrid(img: HTMLImageElement, w: number, h: number): (string | null)[] {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const out: (string | null)[] = [];
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    out.push(a < 128 ? null : `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  }
  return out;
}

export function gridToDataUrl(grid: (string | null)[], w: number, h: number, scale = 1): string {
  const cv = document.createElement('canvas');
  cv.width = w * scale; cv.height = h * scale;
  const ctx = cv.getContext('2d')!;
  grid.forEach((px, i) => {
    if (!px) return;
    ctx.fillStyle = px;
    ctx.fillRect((i % w) * scale, Math.floor(i / w) * scale, scale, scale);
  });
  return cv.toDataURL('image/png');
}

export function emptyGrid(w: number, h: number): (string | null)[] {
  return new Array(w * h).fill(null);
}
