import type { TileDef } from './types';
import { uid } from './db';

const PX = 8; // «пиксель» тайла 64x64

function makeCanvas(size = 64): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return [c, c.getContext('2d')!];
}

function noise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function pattern(
  base: string,
  dots: [string, number][],
  seed: number,
  deco?: (ctx: CanvasRenderingContext2D) => void,
): string {
  const [c, ctx] = makeCanvas();
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const r = noise(x, y, seed);
      let acc = 0;
      for (const [col, p] of dots) {
        acc += p;
        if (r < acc) {
          ctx.fillStyle = col;
          ctx.fillRect(x * PX, y * PX, PX, PX);
          break;
        }
      }
    }
  }
  if (deco) deco(ctx);
  return c.toDataURL('image/png');
}

function roadDeco(vertical: boolean) {
  return (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = '#ffd23f';
    for (let i = 0; i < 4; i++) {
      if (vertical) ctx.fillRect(29, i * 18 + 3, 6, 10);
      else ctx.fillRect(i * 18 + 3, 29, 10, 6);
    }
  };
}

export function builtinTiles(): TileDef[] {
  const t = Date.now();
  const mk = (name: string, dataUrl: string, i: number): TileDef => ({
    id: `tile-builtin-${i}`,
    name,
    gw: 1,
    gh: 1,
    dataUrl,
    builtin: true,
    createdAt: t - i,
  });
  const list: [string, string][] = [
    ['Трава', pattern('#2f7d3b', [['#3f9c4c', 0.3], ['#256b31', 0.5], ['#57b45f', 0.08]], 1)],
    ['Трава тёмная', pattern('#256b31', [['#1d5727', 0.35], ['#2f7d3b', 0.2]], 2)],
    ['Дорога ↔', pattern('#3a3f55', [['#454b66', 0.3], ['#2e3245', 0.35]], 3, roadDeco(false))],
    ['Дорога ↕', pattern('#3a3f55', [['#454b66', 0.3], ['#2e3245', 0.35]], 4, roadDeco(true))],
    ['Песок', pattern('#d9b25f', [['#c69c4a', 0.3], ['#e8c878', 0.25]], 5)],
    ['Вода', pattern('#2456a8', [['#2f6ac4', 0.35], ['#1c448a', 0.3], ['#7fb2ff', 0.06]], 6)],
    ['Кирпич', pattern('#8a4034', [['#6f3129', 0.3]], 7, (ctx) => {
      ctx.fillStyle = '#5c2720';
      for (let y = 0; y < 4; y++) ctx.fillRect(0, y * 16 + 14, 64, 2);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ctx.fillRect(((x + (y % 2) * 0.5) % 4) * 16 + 7, y * 16, 2, 14);
    })],
    ['Старт', pattern('#191c2c', [['#232741', 0.4]], 8, (ctx) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#e9ecff' : '#191c2c';
        ctx.fillRect(x * PX, y * PX, PX, PX);
      }
    })],
    ['Лава', pattern('#a32c1e', [['#ff8b3f', 0.22], ['#7c1d12', 0.3], ['#ffd23f', 0.05]], 9)],
    ['Лес', pattern('#2f7d3b', [['#1d5727', 0.4]], 10, (ctx) => {
      ctx.fillStyle = '#123f1b';
      for (let i = 0; i < 6; i++) {
        const x = (i % 3) * 22 + 4;
        const y = Math.floor(i / 3) * 30 + 6;
        ctx.beginPath();
        ctx.moveTo(x + 8, y);
        ctx.lineTo(x, y + 16);
        ctx.lineTo(x + 16, y + 16);
        ctx.fill();
      }
    })],
  ];
  return list.map(([name, url], i) => mk(name, url, i));
}

/* ---------- кэш изображений ---------- */

const imgCache = new Map<string, HTMLImageElement>();

export function getImage(src: string): HTMLImageElement | null {
  if (!src) return null;
  const hit = imgCache.get(src);
  if (hit) return hit.complete ? hit : null;
  const img = new Image();
  img.src = src;
  imgCache.set(src, img);
  return img.complete ? img : null;
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function fileToImageSize(file: File): Promise<{ w: number; h: number }> {
  return fileToDataUrl(file).then(
    (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = reject;
        img.src = url;
      }),
  );
}

/* ---------- генеративные арты ---------- */

const CART_PALETTES = [
  ['#ff5d73', '#8a1f33'],
  ['#5aa9ff', '#1e4c99'],
  ['#35d46f', '#146b38'],
  ['#ffcf3f', '#996f0e'],
  ['#2ee6a8', '#0d7a55'],
  ['#ff8b3f', '#8f3f0e'],
];

export function cartridgeArt(title: string, subtitle: string, seed = 0): string {
  const c = document.createElement('canvas');
  c.width = 480;
  c.height = 300;
  const ctx = c.getContext('2d')!;
  const [a, b] = CART_PALETTES[seed % CART_PALETTES.length];
  ctx.fillStyle = '#12152a';
  ctx.fillRect(0, 0, 480, 300);
  // корпус картриджа
  ctx.fillStyle = '#232741';
  ctx.fillRect(40, 30, 400, 240);
  ctx.fillStyle = '#191c2c';
  ctx.fillRect(40, 30, 400, 18);
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = '#12152a';
    ctx.fillRect(70 + i * 38, 34, 22, 10);
  }
  // этикетка
  const g = ctx.createLinearGradient(0, 70, 0, 240);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.fillStyle = g;
  ctx.fillRect(64, 66, 352, 178);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = 0; y < 8; y++) ctx.fillRect(64, 78 + y * 22, 352, 6);
  // пиксель-арт «герой»
  const px = 10;
  const sprite = [
    '..1111..',
    '.111111.',
    '.122221.',
    '12222221',
    '12122121',
    '12222221',
    '.122221.',
    '..3333..',
  ];
  const cols: Record<string, string> = { '1': '#e9ecff', '2': '#12152a', '3': '#ffcf3f' };
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const ch = sprite[y][x];
      if (ch !== '.') {
        ctx.fillStyle = cols[ch];
        ctx.fillRect(96 + x * px, 96 + y * px, px, px);
      }
    }
  ctx.fillStyle = '#0a0c18';
  ctx.fillRect(190, 96, 210, 84);
  ctx.fillStyle = '#e9ecff';
  ctx.font = '22px "Russo One", sans-serif';
  ctx.textBaseline = 'middle';
  const t1 = (title || 'RETROPOLIA').slice(0, 14).toUpperCase();
  ctx.fillText(t1, 202, 128);
  ctx.fillStyle = '#ffcf3f';
  ctx.font = '13px "Russo One", sans-serif';
  ctx.fillText((subtitle || 'NES CHALLENGE').slice(0, 26).toUpperCase(), 202, 158);
  ctx.fillStyle = 'rgba(233,236,255,0.85)';
  ctx.font = '11px "Russo One", sans-serif';
  ctx.fillText('RETROPOLIA™  8-BIT', 202, 226);
  return c.toDataURL('image/png');
}

export function cardArt(kind: 'bonus' | 'trap', name: string, seed = 0): string {
  const c = document.createElement('canvas');
  c.width = 360;
  c.height = 240;
  const ctx = c.getContext('2d')!;
  const isBonus = kind === 'bonus';
  const base = isBonus ? '#0d3f2e' : '#43101c';
  const edge = isBonus ? '#2ee6a8' : '#ff5d73';
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 360, 240);
  ctx.strokeStyle = edge;
  ctx.lineWidth = 8;
  ctx.strokeRect(10, 10, 340, 220);
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, 312, 192);
  // пиксельная иконка: звезда или череп
  const px = 9;
  const star = [
    '....1....',
    '...111...',
    '...111...',
    '111111111',
    '.1111111.',
    '..11111..',
    '.1111111.',
    '.11...11.',
    '1.......1',
  ];
  const skull = [
    '.1111111.',
    '111111111',
    '111111111',
    '122112211',
    '111111111',
    '.1112111.',
    '..11111..',
    '..1.1.1..',
    '..11111..',
  ];
  const sprite = isBonus ? star : skull;
  ctx.fillStyle = edge;
  const ox = 135, oy = 46;
  for (let y = 0; y < sprite.length; y++)
    for (let x = 0; x < sprite[y].length; x++) {
      const ch = sprite[y][x];
      if (ch === '1') {
        ctx.fillRect(ox + x * px, oy + y * px, px, px);
      } else if (ch === '2') {
        ctx.fillStyle = base;
        ctx.fillRect(ox + x * px, oy + y * px, px, px);
        ctx.fillStyle = edge;
      }
    }
  ctx.fillStyle = '#e9ecff';
  ctx.font = '20px "Russo One", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText((name || (isBonus ? 'БОНУС' : 'ЛОВУШКА')).slice(0, 20).toUpperCase(), 180, 196);
  ctx.fillStyle = edge;
  ctx.font = '10px "Press Start 2P", monospace';
  ctx.fillText(isBonus ? 'LUCKY CARD' : 'TRAP CARD', 180, 220);
  void seed;
  return c.toDataURL('image/png');
}

export function newId(prefix: string): string {
  return uid(prefix);
}
