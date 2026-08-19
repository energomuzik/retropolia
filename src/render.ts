import type { GameMap, TileDef } from './types';
import { getImage } from './assets';

export const CELL = 64;

export const boardSize = (map: GameMap) => ({ w: map.cols * CELL, h: map.rows * CELL });

export const cellCenter = (map: GameMap, idx: number) => {
  const c = map.cells[idx];
  if (!c) return { x: 0, y: 0 };
  return { x: (c.x + 0.5) * CELL, y: (c.y + 0.5) * CELL };
};

export function fitView(map: GameMap, w: number, h: number) {
  const b = boardSize(map);
  const zoom = Math.min(w / (b.w + 120), h / (b.h + 120));
  return { x: b.w / 2, y: b.h / 2, zoom: Math.max(0.2, zoom) };
}

export interface TokenDraw {
  x: number; y: number;
  color: string;
  active: boolean;
  alive: boolean;
  label: string;
  img?: string | null; // dataUrl кастомной фишки (PNG с прозрачностью)
}

export interface BoardDrawOpts {
  view: { x: number; y: number; zoom: number };
  width: number; height: number;
  tileById: Map<string, TileDef>;
  captured: Record<number, string>;
  colorById: Record<string, string>;
  currentCell: number | null;
  showNumbers: boolean;
  tokens: TokenDraw[];
  time: number;
  hoverCell: number | null;
  mystery?: Set<number>; // ячейки, которые ещё не «открыты» — рисуем как «?»
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, pattern: string[], color: string) {
  ctx.fillStyle = color;
  for (let r = 0; r < pattern.length; r++) {
    for (let c = 0; c < pattern[r].length; c++) {
      if (pattern[r][c] === '1') ctx.fillRect(x + c * s, y + r * s, s, s);
    }
  }
}

const STAR = ['..1..', '.111.', '11111', '.111.', '1.1.1'];
const SKULL = ['.111.', '11111', '10101', '11111', '.1.1.'];
const PAD = ['.111.', '11111', '11111', '.111.'];

export function drawBoard(ctx: CanvasRenderingContext2D, map: GameMap, o: BoardDrawOpts) {
  const { view, width, height } = o;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0e1c';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(-view.x, -view.y);

  const b = boardSize(map);
  // подложка карты
  ctx.fillStyle = '#10142a';
  ctx.fillRect(-24, -24, b.w + 48, b.h + 48);
  ctx.strokeStyle = '#313c72';
  ctx.lineWidth = 6;
  ctx.strokeRect(-24, -24, b.w + 48, b.h + 48);
  ctx.strokeStyle = 'rgba(74,88,168,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(-12, -12, b.w + 24, b.h + 24);

  // тайлы
  for (const pt of map.tiles) {
    const tile = o.tileById.get(pt.tileId);
    if (!tile) continue;
    const img = getImage(tile.dataUrl);
    const cx = (pt.x + tile.gw / 2) * CELL;
    const cy = (pt.y + tile.gh / 2) * CELL;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((pt.rot * Math.PI) / 2);
    const w = tile.gw * CELL;
    const h = tile.gh * CELL;
    if (img) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      ctx.fillStyle = '#1a2244';
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  // сетка
  ctx.strokeStyle = 'rgba(49,60,114,0.28)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= map.cols; x++) {
    ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, b.h); ctx.stroke();
  }
  for (let y = 0; y <= map.rows; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(b.w, y * CELL); ctx.stroke();
  }

  const N = map.cells.length;
  if (N > 1) {
    // стрелки трека
    for (let i = 0; i < N; i++) {
      const a = cellCenter(map, i);
      const c = cellCenter(map, (i + 1) % N);
      const dx = c.x - a.x, dy = c.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const sx = a.x + ux * 26, sy = a.y + uy * 26;
      const ex = c.x - ux * 26, ey = c.y - uy * 26;
      ctx.strokeStyle = 'rgba(233,236,255,0.4)';
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 7]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      const ax = ex, ay = ey;
      ctx.fillStyle = 'rgba(233,236,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - ux * 10 - uy * 6, ay - uy * 10 + ux * 6);
      ctx.lineTo(ax - ux * 10 + uy * 6, ay - uy * 10 - ux * 6);
      ctx.fill();
    }
  }

  // ячейки
  for (let i = 0; i < N; i++) {
    const cell = map.cells[i];
    const { x: cx, y: cy } = cellCenter(map, i);
    const owner = o.captured[i];
    const isCur = o.currentCell === i;
    const isMystery = !!o.mystery?.has(i);
    const pulse = isCur ? 1 + Math.sin(o.time / 160) * 0.06 : 1;
    const size = 44 * pulse;

    ctx.save();
    ctx.translate(cx, cy);

    if (isCur) {
      ctx.strokeStyle = '#ffcf3f';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -o.time / 40;
      ctx.strokeRect(-30, -30, 60, 60);
      ctx.setLineDash([]);
    }

    if (isMystery) {
      // закрытая ячейка: тёмный фон, знак «?», без подсказок о типе
      ctx.fillStyle = '#141833';
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.strokeStyle = '#313c72';
      ctx.lineWidth = 3;
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      ctx.fillStyle = '#5a628f';
      ctx.font = '15px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('?', 0, 6);
      if (o.showNumbers) {
        ctx.fillStyle = '#8f97c9';
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.fillText(String(cell.n), 0, 18);
      }
      ctx.restore();
      continue;
    }

    const base = cell.type === 'bonus' ? '#0d3f2e' : cell.type === 'trap' ? '#43101c' : '#232741';
    const edge = cell.type === 'bonus' ? '#2ee6a8' : cell.type === 'trap' ? '#ff5d73' : '#8f97c9';
    ctx.fillStyle = base;
    ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 3;
    ctx.strokeRect(-size / 2, -size / 2, size, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-size / 2 + 3, -size / 2 + 3, size - 6, size - 6);

    const icon = cell.type === 'bonus' ? STAR : cell.type === 'trap' ? SKULL : PAD;
    const iconColor = cell.type === 'task' ? '#ffcf3f' : edge;
    px(ctx, -icon[0].length * 2, -14, 4, icon, iconColor);

    if (o.showNumbers) {
      ctx.fillStyle = '#e9ecff';
      ctx.font = '9px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(cell.n), 0, 17);
    }

    if (owner && o.colorById[owner]) {
      ctx.fillStyle = o.colorById[owner];
      ctx.beginPath();
      ctx.moveTo(-size / 2, -size / 2);
      ctx.lineTo(-size / 2 + 18, -size / 2);
      ctx.lineTo(-size / 2, -size / 2 + 18);
      ctx.fill();
      ctx.strokeStyle = o.colorById[owner];
      ctx.lineWidth = 3;
      ctx.strokeRect(-size / 2 - 3, -size / 2 - 3, size + 6, size + 6);
    }
    if (o.hoverCell === i) {
      ctx.strokeStyle = '#ffcf3f';
      ctx.lineWidth = 2;
      ctx.strokeRect(-size / 2 - 6, -size / 2 - 6, size + 12, size + 12);
    }
    ctx.restore();
  }

  // стартовый флаг на ячейке №1
  if (N > 0) {
    const c0 = cellCenter(map, 0);
    ctx.save();
    ctx.translate(c0.x + 20, c0.y - 34);
    ctx.fillStyle = '#e9ecff';
    ctx.fillRect(0, 0, 3, 26);
    ctx.fillStyle = '#ffcf3f';
    ctx.beginPath(); ctx.moveTo(3, 0); ctx.lineTo(22, 5); ctx.lineTo(3, 11); ctx.fill();
    ctx.restore();
  }

  // токены
  for (let i = 0; i < o.tokens.length; i++) {
    const t = o.tokens[i];
    ctx.save();
    ctx.translate(t.x, t.y);
    const bob = t.active ? Math.sin(o.time / 140 + i) * 2.5 : 0;
    ctx.translate(0, bob - 6);
    const s = t.active ? 1.12 : 1;
    ctx.scale(s, s);
    ctx.globalAlpha = t.alive ? 1 : 0.35;
    // тень
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(0, 16 - bob / s, 11, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();

    const custom = t.img ? getImage(t.img) : null;
    if (custom) {
      // кастомная фишка-картинка (PNG, прозрачность сохраняется)
      ctx.imageSmoothingEnabled = false;
      const sz = 34;
      ctx.drawImage(custom, -sz / 2, -sz / 2 - 4, sz, sz);
      if (t.active) {
        ctx.strokeStyle = '#ffcf3f';
        ctx.lineWidth = 2;
        ctx.strokeRect(-sz / 2 - 3, -sz / 2 - 7, sz + 6, sz + 6);
      }
    } else {
      // стандартный робот
      const body = t.alive ? t.color : '#5a628f';
      ctx.fillStyle = body;
      ctx.fillRect(-9, -12, 18, 22);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(-9, -12, 18, 5);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-9, 5, 18, 5);
      ctx.fillStyle = '#0a0c18';
      ctx.fillRect(-6, -6, 4, 6);
      ctx.fillRect(2, -6, 4, 6);
      ctx.fillStyle = '#e9ecff';
      ctx.fillRect(-6, -6, 2, 2);
      ctx.fillRect(2, -6, 2, 2);
      ctx.fillStyle = body;
      ctx.fillRect(-1, -18, 2, 6);
      ctx.fillRect(-3, -21, 6, 4);
      if (t.active) {
        ctx.strokeStyle = '#ffcf3f';
        ctx.lineWidth = 2;
        ctx.strokeRect(-13, -24, 26, 36);
      }
    }
    ctx.restore();
  }

  ctx.restore();
}
