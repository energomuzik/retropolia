import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DialogNode, GameMap, MapEnding, NpcDialog } from '../types';

/* СХЕМА ДЕРЕВЬЕВ ДИАЛОГОВ (v0.53.0) — ГЛАВНАЯ ПОВЕРХНОСТЬ РЕДАКТИРОВАНИЯ, граф в духе ComfyUI.
   Список узлов-плиток убран — дерево делается ЦЕЛИКОМ на схеме:
   • создать узел: кнопка «＋ Узел» или ДВОЙНОЙ КЛИК по фону (v0.53: нить, брошенная
     на пустое место, БОЛЬШЕ НЕ создаёт узел — она просто отменяется);
   • СОЕДИНИТЬ: потяните нить из круглого сокета варианта и бросьте на другой узел —
     вариант «Далее:» привяжется к нему;
   • РАЗЪЕДИНИТЬ: нажмите ✕ на середине нити — вариант снова ведёт в конец диалога;
     нить, брошенная на золотую плашку КОНЦОВКИ, назначает варианту эту концовку
     (✕ на золотой нити — снять концовку);
   • КОНЦОВКИ (v0.53): внизу схемы — ВСЕ концовки карты; ставятся кнопкой «＋ Концовка»
     прямо из схемы (и в личном дереве, и на общей схеме карты);
   • на узле: «＋ ответ» добавляет вариант, ✕ у строки удаляет вариант, ✕ в шапке
     удаляет узел (ссылки на него очищаются);
   • клик по узлу выбирает его — текст и свойства правятся в панели под холстом;
   • узлы ПЕРЕТАСКИВАЮТСЯ мышью/пальцем — позиции сохраняются в карту (map.dlgPos);
   • холст панорамируется перетаскиванием фона; МАСШТАБ — КОЛЕСОМ МЫШИ (вокруг курсора)
     или кнопками «＋/−/⤢» (v0.54, наоборот к v0.53: колесо СНОВА масштабирует схему,
     но прокрутку СТРАНИЦЫ отменяет нативный непассивный слушатель — окно больше
     не уезжает вверх; прокрутка окна — ползунком, как и просили);
   • «Собрать» раскладывает дерево заново по глубине (BFS от стартового узла);
   • ЦВЕТА НИТЕЙ (v0.53): у каждого варианта ответа — СВОЙ цвет (нить, сокет и подпись
     окрашены одинаково — видно, какая нить куда идёт); золотая — КОНЦОВКА, янтарный
     пунктир — флаг (вариант слева ставит флаг, вариант справа без него скрыт), серая
     точка — конец;
   • QuestMapGraph — ОБЩАЯ схема карты: все NPC, их деревья, КВЕСТЫ и КОНЦОВКИ
     на одном холсте — здесь можно СТАВИТЬ концовки и тянуть нити ответов к ним. */

const NW = 240; // ширина узла-вопроса
const GX = 56;  // горизонтальный зазор между колонками
const GY = 78;  // вертикальный зазор между поколениями
const ROW_H = 18; // высота строки варианта на узле
const C_TEAL = '#2ee6a8';
const C_GOLD = '#ffcf3f';
const C_AMBER = '#ffb347';
const C_EDGE = '#313c72';
const C_FAINT = '#5a6491';

/* v0.53: ЦВЕТ НИТИ ПО НОМЕРУ ВАРИАНТА — нити от одного окошка больше не сливаются:
   у каждого варианта ответа свой цвет (нить, сокет и подпись окрашены одинаково) */
export const VAR_COLORS = ['#2ee6a8', '#5aa9ff', '#ff8b3f', '#c07aff', '#ffcf3f', '#ff5d73', '#4dd0e1', '#9be84d', '#f6a5c0', '#a7f3eb'];
export const varColor = (optIdx: number): string => VAR_COLORS[((optIdx % VAR_COLORS.length) + VAR_COLORS.length) % VAR_COLORS.length];

export type DlgPos = { x: number; y: number };
export type DlgPosMap = { [key: string]: DlgPos };
type BBox = { x0: number; y0: number; x1: number; y1: number };

/* Операции редактирования ОДНОГО дерева (для DialogueGraph). */
export type DlgEditOps = {
  setNext: (nodeId: string, optIdx: number, next: string | undefined) => void;
  setEnding: (nodeId: string, optIdx: number, ending: string | undefined) => void;
  addNode: (at: { x: number; y: number }, linkFrom?: { nodeId: string; optIdx: number }) => void;
  delNode: (nodeId: string) => void;
  addOpt: (nodeId: string) => void;
  delOpt: (nodeId: string, optIdx: number) => void;
  /* v0.52: правка текста ПРЯМО В ОКНЕ УЗЛА на схеме (без панели внизу) */
  setText: (nodeId: string, text: string) => void;
  setOptText: (nodeId: string, optIdx: number, text: string) => void;
  /* v0.53: КОНЦОВКИ ПРЯМО НА СХЕМЕ — ставятся кнопкой «＋ Концовка» над холстом */
  addEnding?: () => void;
  delEnding?: (id: string) => void;
};

/* Операции ОБЩЕЙ схемы (для QuestMapGraph): всё то же, но с указанием NPC. */
export type DlgEditOpsMap = {
  setNext: (npcId: string, nodeId: string, optIdx: number, next: string | undefined) => void;
  setEnding: (npcId: string, nodeId: string, optIdx: number, ending: string | undefined) => void;
  addNode: (npcId: string, at: { x: number; y: number }, linkFrom?: { nodeId: string; optIdx: number }) => void;
  delNode: (npcId: string, nodeId: string) => void;
  addOpt: (npcId: string, nodeId: string) => void;
  delOpt: (npcId: string, nodeId: string, optIdx: number) => void;
  /* v0.52: правка текста прямо на узлах общей схемы */
  setText: (npcId: string, nodeId: string, text: string) => void;
  setOptText: (npcId: string, nodeId: string, optIdx: number, text: string) => void;
  addEnding?: (at?: { x: number; y: number }) => void;
  delEnding?: (id: string) => void;
};

/* высота узла — динамическая: шапка + реплика + строка на каждый вариант (+ «＋ ответ») */
export const nodeH = (n: DialogNode, editable: boolean): number => {
  const lines = wrap(n.text);
  return 26 + (lines.length ? lines.length * 13 + 6 : 16) + (n.opts ?? []).length * ROW_H + (editable ? ROW_H : 0) + 8;
};
/* y центра строки варианта oi на узле в позиции p (для сокетов);
   extra — добавка к высоте блока реплики, пока текст узла правится НА САМОМ УЗЛЕ */
const optRowY = (n: DialogNode, p: DlgPos, oi: number, extra = 0): number =>
  p.y + 26 + extra + (wrap(n.text).length ? wrap(n.text).length * 13 + 6 : 16) + oi * ROW_H + ROW_H / 2;

export const tr = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/* hex → rgba с прозрачностью (заливка сокетов цветом своего варианта) */
const hexA = (hex: string, a: number): string => {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
};
/** Разбивка реплики на строки ≤ w символов, максимум 3 строки (дальше — многоточие). */
export function wrap(s: string, w = 32): string[] {
  const words = (s || '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    if (!cur) { cur = word; continue; }
    if ((cur + ' ' + word).length <= w) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) {
    lines.length = 3;
    lines[2] = tr(lines[2], w);
  }
  return lines;
}

/* ---------- РАСКЛАДКА: BFS от стартового узла по поколениям; недостижимые — внизу ---------- */
export function layoutDialog(dialog: NpcDialog): DlgPosMap {
  const nodes = dialog.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const root = byId.has(dialog.root) ? dialog.root : nodes[0]?.id;
  if (root) {
    depth.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift() as string;
      const d = depth.get(cur) ?? 0;
      for (const o of byId.get(cur)?.opts ?? []) {
        if (o.next && byId.has(o.next) && !depth.has(o.next)) {
          depth.set(o.next, d + 1);
          queue.push(o.next);
        }
      }
    }
  }
  let maxD = 0;
  depth.forEach((d) => { if (d > maxD) maxD = d; });
  let orphanD = maxD + 1; // «⚠ не связан» узлы — отдельными строками ниже
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, orphanD++);
  const layers = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) as number;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(n.id);
  }
  let maxCount = 1;
  layers.forEach((a) => { if (a.length > maxCount) maxCount = a.length; });
  const span = maxCount * (NW + GX);
  const pos: DlgPosMap = {};
  /* слои идут по порядку глубин; каждый следующий — после САМОГО НИЗКОГО узла предыдущего
     (узлы разной высоты: чем больше вариантов, тем выше узел) */
  let layerY = 40;
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const ids = layers.get(d)!;
    let y = layerY;
    ids.forEach((id, i) => {
      pos[id] = { x: 40 + (span - ids.length * (NW + GX)) / 2 + i * (NW + GX), y };
      const n = byId.get(id);
      y += (n ? nodeH(n, false) : 96) + 16;
    });
    layerY = y + GY;
  }
  return pos;
}

/* входящие связи узла (для маркера «⚠ не связан») */
const incoming = (dialog: NpcDialog, id: string): number =>
  dialog.nodes.reduce((a, n) => a + (n.opts ?? []).filter((o) => o.next === id).length, 0);

/* ---------- ОБЩИЙ ХОЛСТ: панорама + зум. Вписывание — только при смене fitKey ---------- */
export type VtRef = { x: number; y: number; z: number; svg: SVGSVGElement | null };

function GraphViewport({ height, bbox, fitKey, zoomRef, vtRef, onBgDblClick, children }: {
  height: number;
  bbox: BBox;
  fitKey: string;
  zoomRef: React.MutableRefObject<number>; // текущий зум для обработчиков перетаскивания узлов
  vtRef: React.MutableRefObject<VtRef>;    // текущая трансформация + svg — для пересчёта координат нитей
  onBgDblClick?: (p: { x: number; y: number }) => void;
  children: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [vt, setVt] = useState<{ x: number; y: number; z: number } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    const w = el?.clientWidth ?? 800;
    const bw = Math.max(1, bbox.x1 - bbox.x0), bh = Math.max(1, bbox.y1 - bbox.y0);
    const z = Math.max(0.25, Math.min(1.25, Math.min((w - 48) / bw, (height - 48) / bh)));
    setVt({ x: (w - bw * z) / 2 - bbox.x0 * z, y: (height - bh * z) / 2 - bbox.y0 * z, z });
  }, [bbox.x0, bbox.y0, bbox.x1, bbox.y1, height]);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  /* вписываем при монтировании и при смене fitKey (другое дерево / «Собрать»);
     перетаскивание узлов bbox меняет, но fitKey нет — вид не «прыгает» */
  useEffect(() => { fitRef.current(); }, [fitKey]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setVt((s) => {
      if (!s) return s;
      const z = Math.max(0.25, Math.min(2.4, s.z * factor));
      const k = z / s.z;
      return { z, x: cx - (cx - s.x) * k, y: cy - (cy - s.y) * k };
    });
  }, []);
  const z = vt?.z ?? 1;
  zoomRef.current = z;
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;
  /* держим актуальную трансформацию снаружи (нити, «＋ Узел» в центре экрана) */
  vtRef.current = { x: vt?.x ?? 0, y: vt?.y ?? 0, z, svg: svgRef.current };

  const toCanvas = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const v = vtRef.current;
    const r = v.svg?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left - v.x) / v.z, y: (clientY - r.top - v.y) / v.z };
  }, [vtRef]);
  const toCanvasRef = useRef(toCanvas);
  toCanvasRef.current = toCanvas;

  /* v0.54 (НАОБОРОТ к v0.53): КОЛЕСО МЫШИ = МАСШТАБ вокруг курсора. Слушатель вешается
     НАТИВНО с passive:false — только так preventDefault() реально отменяет прокрутку
     страницы (React-овский onWheel пассивен, из-за этого в v0.50 окно «уезжало вверх»
     — тогда зум и убрали; теперь колесо зумит, а окно стоит на месте).
     Прокрутка самого окна — обычным ползунком за пределами холста. */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAtRef.current(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="relative select-none" ref={wrapRef}>
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        className="block cursor-grab active:cursor-grabbing"
        style={{ background: 'repeating-conic-gradient(#0a0d1c 0 25%, #0b0e1c 0 50%) 0 0 / 22px 22px', border: '2px solid #23294d' }}
        /* v0.54: зум колесом вешается нативным непассивным слушателем выше — здесь
           onWheel НЕ используется (React-обработчик пассивен и не отменяет прокрутку) */
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-node]')) return; // узлы и нити тянут себя сами
          panRef.current = { sx: e.clientX, sy: e.clientY, vx: vt?.x ?? 0, vy: vt?.y ?? 0 };
          (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = panRef.current;
          if (!p) return;
          setVt((s) => (s ? { ...s, x: p.vx + (e.clientX - p.sx), y: p.vy + (e.clientY - p.sy) } : s));
        }}
        onPointerUp={() => { panRef.current = null; }}
        onPointerLeave={() => { panRef.current = null; }}
        onDoubleClick={(e) => {
          const t = e.target as Element;
          if (t.closest('[data-node]')) return;
          if (!onBgDblClick) return;
          onBgDblClick(toCanvasRef.current(e.clientX, e.clientY));
        }}
      >
        {vt && <g transform={`translate(${vt.x},${vt.y}) scale(${vt.z})`}>{children}</g>}
      </svg>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
        <button onClick={() => zoomAt(1.2, (wrapRef.current?.clientWidth ?? 800) / 2, height / 2)} className="px-2 py-0.5 border-2 border-edge bg-[rgba(7,9,18,0.9)] text-dim font-display text-[11px] cursor-pointer hover:text-paper" title="Приблизить">＋</button>
        <span className="px-1 text-[9px] text-faint font-pixel bg-[rgba(7,9,18,0.9)] border-2 border-edge">{Math.round(z * 100)}%</span>
        <button onClick={() => zoomAt(1 / 1.2, (wrapRef.current?.clientWidth ?? 800) / 2, height / 2)} className="px-2 py-0.5 border-2 border-edge bg-[rgba(7,9,18,0.9)] text-dim font-display text-[11px] cursor-pointer hover:text-paper" title="Отдалить">−</button>
        <button onClick={() => fitRef.current()} className="px-2 py-0.5 border-2 border-edge bg-[rgba(7,9,18,0.9)] text-dim font-display text-[9px] uppercase cursor-pointer hover:text-gold" title="Вписать схему в окно">⤢ Вписать</button>
      </div>
      <div className="absolute left-1.5 bottom-1.5 px-1.5 py-0.5 text-[8px] text-faint font-pixel bg-[rgba(7,9,18,0.85)] border border-[#23294d] pointer-events-none">
        масштаб — колесо мыши или кнопки ＋/− справа вверху · тяните фон — панорама · тяните узел — переместить · нить из сокета — соединить · двойной клик по фону — новый узел
      </div>
    </div>
  );
}

/* ---------- НИТЬ-«КОСТОЧКА» между точками + кнопка ✕ «разъединить» ---------- */
function Edge({ x1, y1, x2, y2, color, dashed, opacity = 1 }: {
  x1: number; y1: number; x2: number; y2: number; color: string; dashed?: boolean; opacity?: number;
}) {
  const my = (y1 + y2) / 2;
  return (
    <path
      d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
      fill="none" stroke={color} strokeWidth={2} strokeDasharray={dashed ? '5 4' : undefined} opacity={opacity}
    />
  );
}

/* подпись на нити (текст варианта ответа) — окрашена ЦВЕТОМ СВОЕЙ нити */
function EdgeLabel({ x, y, text, color }: { x: number; y: number; text: string; color: string }) {
  const w = text.length * 5.3 + 10;
  return (
    <g>
      <rect x={x - w / 2} y={y - 8} width={w} height={15} rx={3} fill="#0b0e1c" stroke={color} strokeWidth={0.8} opacity={0.92} />
      <text x={x} y={y + 3} textAnchor="middle" fontSize={9} className="font-pixel" fill={color}>{text}</text>
    </g>
  );
}

/* ---------- v0.52: ПРАВКА ТЕКСТА ПРЯМО В ОКНЕ УЗЛА ----------
   Реплика — двойной клик по узлу: появляется поле ввода ВНУТРИ узла, текст меняется на лету.
   Вариант ответа — клик по его строке: однострочное поле вместо строки. Панель внизу больше
   не нужна для текста — только для наград, флагов и связей. */
function InlineTextarea({ x, y, w, value, onChange, onClose, onHeight }: {
  x: number; y: number; w: number; value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onHeight: (h: number) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(140, Math.max(16, el.scrollHeight))}px`;
    onHeight(el.scrollHeight);
  }, [onHeight]);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <foreignObject x={x} y={y} width={w} height={26} style={{ overflow: 'visible' }}>
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => { onChange(e.target.value); fit(); }}
          onBlur={onClose}
          onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); onClose(); } }}
          placeholder="Реплика NPC…"
          className="w-full resize-none leading-snug"
          style={{
            background: 'rgba(46,230,168,0.07)', border: '1px dashed rgba(46,230,168,0.7)', outline: 'none',
            color: '#e6ebff', font: '9.5px "Courier New", monospace', padding: '1px 3px', borderRadius: 3, overflow: 'hidden',
          }}
        />
      </div>
    </foreignObject>
  );
}

function InlineInput({ x, y, w, value, onChange, onClose }: {
  x: number; y: number; w: number; value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, []);
  return (
    <foreignObject x={x} y={y} width={w} height={16} style={{ overflow: 'visible' }}>
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <input
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onClose}
          onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); onClose(); } }}
          placeholder="Текст ответа…"
          className="w-full"
          style={{
            background: 'rgba(46,230,168,0.07)', border: '1px dashed rgba(46,230,168,0.7)', outline: 'none',
            color: '#e6ebff', font: '9px "Courier New", monospace', padding: '0 3px', borderRadius: 3, height: 15,
          }}
        />
      </div>
    </foreignObject>
  );
}

/* ✕ на середине нити — РАЗЪЕДИНИТЬ (v0.51) */
function EdgeCut({ x, y, color, onCut, title }: { x: number; y: number; color: string; onCut: () => void; title: string }) {
  return (
    <g data-node="1" className="cursor-pointer" onPointerDown={(e) => { e.stopPropagation(); onCut(); }}>
      <rect x={x - 7} y={y - 7} width={14} height={14} rx={3} fill="#0b0e1c" stroke={color} strokeWidth={1.2} opacity={0.95} />
      <text x={x} y={y + 3.5} textAnchor="middle" fontSize={9} fill={color}>{'✕'}</text>
      <title>{title}</title>
    </g>
  );
}
/* ---------- ОДНО ДЕРЕВО ДИАЛОГОВ NPC (граф-редактор v0.51) ---------- */
export function DialogueGraph({ dialog, endings, selId, onSelect, pos, onPos, ops, height = 300, fitKey }: {
  dialog: NpcDialog;
  endings: MapEnding[];
  selId?: string | null;
  onSelect?: (nodeId: string) => void;
  pos?: DlgPosMap;                 // сохранённые позиции (map.dlgPos) — перекрывают автораскладку
  onPos?: (p: DlgPosMap | null) => void; // сохранить позиции (null — сбросить и разложить заново)
  ops?: DlgEditOps;                // v0.51: операции на схеме (нет — режим «только смотреть»)
  height?: number;
  fitKey?: string;                 // смена ключа = заново вписать схему в окно
}) {
  const zoomRef = useRef(1);
  const vtRef = useRef<VtRef>({ x: 0, y: 0, z: 1, svg: null });
  const layout = useMemo<DlgPosMap>(() => ({ ...layoutDialog(dialog), ...(pos ?? {}) }), [dialog, pos]);
  const dragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const linkRef = useRef<{ nodeId: string; optIdx: number; x: number; y: number } | null>(null);
  const [, bump] = useState(0); // перерисовка при перетаскивании узла/нити
  /* v0.52: правка текста ПРЯМО В ОКНЕ УЗЛА — что правим и текущая высота поля реплики */
  const [edit, setEdit] = useState<{ id: string; kind: 'text' | 'opt'; oi: number } | null>(null);
  const [editH, setEditH] = useState(0);

  const editable = !!ops;
  const nodes = dialog.nodes;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const idxOf = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes]);

  /* добавка к высоте блока реплики у узла, который сейчас правится на схеме */
  const extraOf = (nid: string): number => {
    if (!edit || edit.id !== nid || edit.kind !== 'text') return 0;
    const n = byId.get(nid);
    if (!n) return 0;
    const base = wrap(n.text).length ? wrap(n.text).length * 13 + 6 : 16;
    return Math.max(0, editH - base);
  };
  const closeEdit = () => { setEdit(null); setEditH(0); };

  /* v0.53: внизу схемы — ВСЕ концовки карты (не только уже привязанные):
     в любую можно бросить нить варианта; непривязанные — чуть приглушены.
     usedEndIds — какие концовки уже выбраны вариантами этого дерева */
  const usedEndIds = useMemo(() => {
    const sset = new Set<string>();
    for (const n of nodes) for (const o of n.opts ?? []) if (o.ending) sset.add(o.ending);
    return sset;
  }, [nodes]);
  const endRow = endings;

  const hs = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of nodes) m[n.id] = nodeH(n, editable);
    return m;
  }, [nodes, editable]);

  const ys = Object.values(layout).map((p) => p.y);
  const xs = Object.values(layout).map((p) => p.x);
  const bottomY = (ys.length ? Math.max(...ys) : 0) + Math.max(...Object.values(hs), NH_MIN);
  const endY = bottomY + 78;
  const endRowW = endRow.length ? 40 + endRow.length * 236 : 0;
  const bbox: BBox = {
    x0: Math.min(0, ...(xs.length ? xs : [0])) - 20,
    y0: Math.min(0, ...(ys.length ? ys : [0])) - 20,
    x1: Math.max(NW + 80, endRowW, ...(xs.length ? xs.map((x) => x + NW) : [NW + 80])) + 20,
    y1: endRow.length ? endY + 10 : bottomY + 30,
  };

  const toCanvas = (clientX: number, clientY: number): { x: number; y: number } => {
    const v = vtRef.current;
    const r = v.svg?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left - v.x) / v.z, y: (clientY - r.top - v.y) / v.z };
  };

  const nodeDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    const p = layout[id];
    if (!p) return;
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const nodeMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / zoomRef.current, dy = (e.clientY - d.sy) / zoomRef.current;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    layout[d.id] = { x: d.ox + dx, y: d.oy + dy };
    bump((n) => n + 1);
  };
  const nodeUp = (id: string) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && d.moved && onPos) onPos({ ...(pos ?? {}), [id]: { ...layout[id] } });
    onSelect?.(id);
  };

  /* ---------- нить: тянем из сокета варианта ---------- */
  const linkDown = (nodeId: string, optIdx: number) => (e: React.PointerEvent) => {
    if (!ops) return;
    e.stopPropagation();
    const c = toCanvas(e.clientX, e.clientY);
    linkRef.current = { nodeId, optIdx, x: c.x, y: c.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    bump((n) => n + 1);
  };
  const linkMove = (e: React.PointerEvent) => {
    if (!linkRef.current) return;
    const c = toCanvas(e.clientX, e.clientY);
    linkRef.current = { ...linkRef.current, x: c.x, y: c.y };
    bump((n) => n + 1);
  };
  const hitNode = (pt: { x: number; y: number }): string | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const p = layout[n.id];
      if (!p) continue;
      const h = hs[n.id] ?? nodeH(n, editable);
      if (pt.x >= p.x && pt.x <= p.x + NW && pt.y >= p.y && pt.y <= p.y + h) return n.id;
    }
    return null;
  };
  const hitEnding = (pt: { x: number; y: number }): string | null => {
    for (let i = endRow.length - 1; i >= 0; i--) {
      const ex = 40 + i * 236;
      if (pt.x >= ex && pt.x <= ex + 216 && pt.y >= endY - 44 && pt.y <= endY - 4) return endRow[i].id;
    }
    return null;
  };
  const linkUp = (e: React.PointerEvent) => {
    const lk = linkRef.current;
    linkRef.current = null;
    bump((n) => n + 1);
    if (!lk || !ops) return;
    const src = nodes.find((n) => n.id === lk.nodeId);
    if (!src) return;
    const pt = toCanvas(e.clientX, e.clientY);
    const start = { x: layout[lk.nodeId].x + NW - 12, y: optRowY(src, layout[lk.nodeId], lk.optIdx, extraOf(lk.nodeId)) };
    if (Math.hypot(pt.x - start.x, pt.y - start.y) < 16) return; // вернули в сокет — отмена
    const endId = hitNode(pt);
    if (endId && endId !== lk.nodeId) { ops.setNext(lk.nodeId, lk.optIdx, endId); return; }
    const endE = hitEnding(pt);
    if (endE) { ops.setEnding(lk.nodeId, lk.optIdx, endE); return; }
    /* v0.53: бросили на пустое место — НИЧЕГО НЕ ДЕЛАЕМ (узел больше не создаётся;
       новый узел — двойной клик по фону или кнопка «＋ Узел») */
  };

  const addAtCenter = () => {
    if (!ops) return;
    const v = vtRef.current;
    const r = v.svg?.getBoundingClientRect();
    const cx = r ? (r.width / 2 - v.x) / v.z : 120;
    const cy = r ? (r.height / 2 - v.y) / v.z : 120;
    ops.addNode({ x: cx - NW / 2, y: cy - 20 });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="tick-label text-teal">🌳 Схема дерева</span>
        <span className="tick-label text-faint hidden md:inline">
          <span style={{ color: C_AMBER }}>цвет нити = цвет её варианта</span> · <span style={{ color: C_GOLD }}>— концовка</span> · <span style={{ color: C_AMBER }}>⬚ флаг</span> · тяните нить из ○ · двойной клик по узлу — править реплику · клик по ответу — править его
        </span>
        <span className="ml-auto flex items-center gap-1">
          {ops && (
            <button
              onClick={addAtCenter}
              className="px-2 py-0.5 border-2 border-teal/60 text-teal font-display text-[9px] uppercase hover:bg-teal/10 cursor-pointer"
              title="Создать узел-вопрос в центре холста (ещё можно двойным кликом по фону)"
            >＋ Узел</button>
          )}
          {ops?.addEnding && (
            <button
              onClick={() => ops.addEnding && ops.addEnding()}
              className="px-2 py-0.5 border-2 border-gold/60 text-gold font-display text-[9px] uppercase hover:bg-gold/10 cursor-pointer"
              title="Поставить НОВУЮ концовку карты — она появится золотой плашкой внизу схемы; бросьте на неё нить варианта"
            >＋ Концовка</button>
          )}
          {onPos && (
            <button
              onClick={() => onPos(null)}
              className="px-2 py-0.5 border-2 border-edge text-faint font-display text-[9px] uppercase hover:text-teal cursor-pointer"
              title="Разложить все узлы заново по глубине дерева (сбрасывает перетаскивания)"
            >⌖ Собрать</button>
          )}
        </span>
      </div>
      <GraphViewport
        height={height}
        bbox={bbox}
        fitKey={`${fitKey ?? ''}|${dialog.root}|${dialog.nodes.length}`}
        zoomRef={zoomRef}
        vtRef={vtRef}
        onBgDblClick={ops ? (p) => ops.addNode({ x: p.x - NW / 2, y: p.y - 20 }) : undefined}
      >
        {/* временная нить под курсором — цвета СВОЕГО варианта (v0.53) */}
        {linkRef.current && (() => {
          const lk = linkRef.current;
          const src = nodes.find((n) => n.id === lk.nodeId);
          const p = layout[lk.nodeId];
          if (!src || !p) return null;
          const lkOpt = (src.opts ?? [])[lk.optIdx];
          return <Edge x1={p.x + NW - 12} y1={optRowY(src, p, lk.optIdx)} x2={lk.x} y2={lk.y} color={lkOpt?.ending ? C_GOLD : varColor(lk.optIdx)} dashed opacity={0.9} />;
        })()}
        {/* связи «Далее», концы и концовки — ЦВЕТ НИТИ = ЦВЕТ ВАРИАНТА (v0.53) */}
        {nodes.map((n) => {
          const p = layout[n.id];
          if (!p) return null;
          const opts = n.opts ?? [];
          return opts.map((o, oi) => {
            const sx = p.x + NW - 12;
            const sy = optRowY(n, p, oi, extraOf(n.id));
            const vc = o.ending ? C_GOLD : varColor(oi); // цвет нити этого варианта
            if (o.next && byId.has(o.next)) {
              const tp = layout[o.next];
              if (!tp) return null;
              const mx = (sx + tp.x) / 2, my = (sy + tp.y + 26) / 2;
              return (
                <g key={`${n.id}:${oi}`}>
                  <Edge x1={sx} y1={sy} x2={tp.x} y2={tp.y + 26} color={vc} opacity={0.85} />
                  {ops && <EdgeCut x={mx} y={my} color={vc} onCut={() => ops.setNext(n.id, oi, undefined)} title="Разъединить: вариант снова ведёт в конец диалога" />}
                  <EdgeLabel x={mx} y={my - 11} text={tr(o.text || '(без текста)', 20)} color={vc} />
                </g>
              );
            }
            if (o.ending && endRow.some((u) => u.id === o.ending)) {
              const i = endRow.findIndex((u) => u.id === o.ending);
              const ex = 40 + i * 236 + 108;
              const ey = endY - 44;
              const mx = (sx + ex) / 2, my = (sy + ey) / 2;
              return (
                <g key={`${n.id}:${oi}`}>
                  <Edge x1={sx} y1={sy} x2={ex} y2={ey} color={C_GOLD} opacity={0.9} />
                  {ops && <EdgeCut x={mx} y={my} color={C_GOLD} onCut={() => ops.setEnding(n.id, oi, undefined)} title="Снять концовку с этого варианта" />}
                </g>
              );
            }
            /* конец диалога — короткий хвостик с точкой */
            return (
              <g key={`${n.id}:${oi}`} opacity={0.6}>
                <line x1={sx} y1={sy} x2={sx} y2={sy + 20} stroke={C_FAINT} strokeWidth={1.6} />
                <circle cx={sx} cy={sy + 24} r={3.4} fill={C_FAINT} />
              </g>
            );
          });
        })}
        {/* флаговые связи: вариант, требующий флаг ← вариант, ставящий его */}
        {nodes.map((n) => {
          const p = layout[n.id];
          if (!p) return null;
          return (n.opts ?? []).filter((o) => o.reqFlag).map((o, i) => {
            const src = nodes.find((x) => x.id !== n.id && (x.opts ?? []).some((so) => so.setFlag && so.setFlag === o.reqFlag));
            if (!src) return null;
            const sp = layout[src.id];
            if (!sp) return null;
            return <Edge key={`flag:${n.id}:${i}`} x1={sp.x + NW} y1={sp.y + 26} x2={p.x} y2={p.y + 26} color={C_AMBER} dashed opacity={0.55} />;
          });
        })}
        {/* узлы-вопросы */}
        {nodes.map((n) => {
          const p = layout[n.id];
          if (!p) return null;
          const i = idxOf.get(n.id) ?? 0;
          const orphan = dialog.root !== n.id && incoming(dialog, n.id) === 0 && nodes.length > 1;
          const sel = selId === n.id;
          const lines = wrap(n.text);
          const opts = n.opts ?? [];
          const hasSet = opts.some((o) => o.setFlag);
          const hasReq = opts.some((o) => o.reqFlag || o.reqNotFlag);
          const editingText = editable && edit?.id === n.id && edit.kind === 'text';
          const baseTextH = lines.length ? lines.length * 13 + 6 : 16;
          const textH = editingText ? Math.max(baseTextH, editH) : baseTextH;
          const h = (hs[n.id] ?? nodeH(n, editable)) + (textH - baseTextH);
          const textBottom = p.y + 26 + textH;
          return (
            <g
              key={n.id}
              data-node="1"
              onPointerDown={nodeDown(n.id)}
              onPointerMove={nodeMove}
              onPointerUp={() => nodeUp(n.id)}
              className="cursor-pointer"
            >
              <rect x={p.x} y={p.y} width={NW} height={h} rx={5} fill={sel ? '#101a30' : '#0d1124'} stroke={sel ? C_TEAL : C_EDGE} strokeWidth={sel ? 2.5 : 1.6} />
              {/* вход-приёмник нитей */}
              <circle cx={p.x} cy={p.y + 26} r={3.2} fill={sel ? C_TEAL : C_EDGE} />
              <text x={p.x + 8} y={p.y + 15} fontSize={10} className="font-display" fill={C_FAINT}>№{i + 1}</text>
              {dialog.root === n.id && (
                <>
                  <rect x={p.x + NW - 58} y={p.y + 4} width={44} height={13} rx={3} fill="rgba(255,207,63,0.12)" stroke={C_GOLD} strokeWidth={0.8} />
                  <text x={p.x + NW - 36} y={p.y + 14} textAnchor="middle" fontSize={8} className="font-display" fill={C_GOLD}>СТАРТ</text>
                </>
              )}
              {ops && nodes.length > 1 && (() => {
                const bx = p.x + NW - (dialog.root === n.id ? 64 : 16);
                return (
                  <g className="cursor-pointer" onPointerDown={(e) => { e.stopPropagation(); ops.delNode(n.id); }}>
                    <rect x={bx} y={p.y + 4} width={12} height={12} rx={3} fill="rgba(255,93,115,0.1)" stroke="rgba(255,93,115,0.55)" strokeWidth={0.8} />
                    <text x={bx + 6} y={p.y + 13} textAnchor="middle" fontSize={8} fill="#ff5d73">✕</text>
                    <title>Удалить узел (ссылки на него очистятся)</title>
                  </g>
                );
              })()}
              {/* v0.52: РЕПЛИКА ПРЯМО В ОКНЕ УЗЛА — двойной клик открывает поле ввода внутри узла;
                  пока правим, текст заменяется полем, узел растёт по высоте */}
              {editingText ? (
                <InlineTextarea
                  x={p.x + 6} y={p.y + 30} w={NW - 12} value={n.text}
                  onChange={(v) => ops && ops.setText(n.id, v)}
                  onClose={closeEdit}
                  onHeight={setEditH}
                />
              ) : (
                <>
                  {lines.length === 0 && <text x={p.x + 8} y={p.y + 36} fontSize={9.5} className="font-pixel" fill={C_FAINT}>(пустая реплика)</text>}
                  {lines.map((ln, li) => (
                    <text key={li} x={p.x + 8} y={p.y + 34 + li * 13} fontSize={9.5} className="font-pixel" fill="#c7cdf0">{ln}</text>
                  ))}
                  {editable && (
                    <rect
                      x={p.x} y={p.y + 26} width={NW} height={textH} fill="none" pointerEvents="all" style={{ cursor: 'text' }}
                      onDoubleClick={(e) => { e.stopPropagation(); setEdit({ id: n.id, kind: 'text', oi: -1 }); setEditH(baseTextH); }}
                    >
                      <title>Двойной клик — написать реплику ПРЯМО В ОКНЕ узла</title>
                    </rect>
                  )}
                </>
              )}
              <line x1={p.x + 6} y1={textBottom - 4} x2={p.x + NW - 6} y2={textBottom - 4} stroke={C_EDGE} strokeWidth={1} />
              {opts.map((o, oi) => {
                const ry = textBottom + oi * ROW_H + ROW_H / 2;
                const editingOpt = editable && edit?.id === n.id && edit.kind === 'opt' && edit.oi === oi;
                return (
                  <g key={oi}>
                    {ops && !editingOpt && (
                      <g className="cursor-pointer" onPointerDown={(e) => { e.stopPropagation(); ops.delOpt(n.id, oi); }} onDoubleClick={(e) => e.stopPropagation()}>
                        <text x={p.x + 8} y={ry + 3} fontSize={8} fill="#5a6491">✕</text>
                        <title>Удалить вариант</title>
                      </g>
                    )}
                    {editingOpt ? (
                      <InlineInput
                        x={p.x + 16} y={ry - 8} w={NW - 38} value={o.text}
                        onChange={(v) => ops && ops.setOptText(n.id, oi, v)}
                        onClose={closeEdit}
                      />
                    ) : (
                      <>
                        <text x={p.x + (ops ? 20 : 8)} y={ry + 3} fontSize={8.5} className="font-pixel" fill={o.ending ? C_GOLD : '#9aa3c7'}>
                          {tr(`${o.reqFlag || o.reqNotFlag ? '🔒' : ''}${o.setFlag ? '🚩' : ''}${o.text || '(без текста)'}`, 28)}
                        </text>
                        {editable && (
                          <rect
                            x={p.x + (ops ? 16 : 4)} y={ry - ROW_H / 2} width={NW - (ops ? 40 : 20)} height={ROW_H} fill="none" pointerEvents="all" style={{ cursor: 'text' }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => { setEdit({ id: n.id, kind: 'opt', oi }); }}
                          >
                            <title>Клик — править текст ответа прямо на схеме</title>
                          </rect>
                        )}
                      </>
                    )}
                    {/* сокет: тянуть из него нить — окрашен ЦВЕТОМ СВОЕГО ВАРИАНТА (v0.53) */}
                    <circle
                      cx={p.x + NW - 12} cy={ry} r={5}
                      fill={o.ending ? 'rgba(255,207,63,0.25)' : hexA(varColor(oi), 0.25)}
                      stroke={o.ending ? C_GOLD : varColor(oi)} strokeWidth={1.4}
                      className={ops ? 'cursor-crosshair' : ''}
                      onPointerDown={ops ? linkDown(n.id, oi) : undefined}
                      onPointerMove={ops ? linkMove : undefined}
                      onPointerUp={ops ? linkUp : undefined}
                    />
                    <title>{ops ? 'Тяните нить: бросьте на узел — привязать «Далее», на золотую плашку — назначить концовку; на пустое место — нить отменится' : ''}</title>
                  </g>
                );
              })}
              {ops && (
                <g className="cursor-pointer" onPointerDown={(e) => { e.stopPropagation(); ops.addOpt(n.id); }}>
                  <text x={p.x + 8} y={textBottom + opts.length * ROW_H + 12} fontSize={9} className="font-display" fill={C_TEAL}>＋ ответ</text>
                  <title>Добавить вариант ответа</title>
                </g>
              )}
              <text x={p.x + 8} y={p.y + h - 4} fontSize={8.5} className="font-display" fill={opts.length ? C_TEAL : '#ff5d73'}>{opts.length} отв.</text>
              {/* v0.55: «⚠ не связан» переехал из правого верхнего угла (где перекрывал
                  красный ✕ удаления узла и не давал нажать) В НИЖНЮЮ СТРОКУ, к «N отв.»;
                  pointerEvents="none» — значок никогда не перехватывает клики */}
              {orphan && <text x={p.x + 44} y={p.y + h - 4} fontSize={9} fill="#ff5d73" pointerEvents="none">⚠ не связан</text>}
              {(hasSet || hasReq) && <text x={p.x + NW - 40} y={p.y + h - 4} fontSize={8}>{hasSet ? '🚩' : ''}{hasReq ? '🔒' : ''}</text>}
            </g>
          );
        })}
        {/* концовки — золотые плашки в нижнем ряду: ВСЕ концовки карты (v0.53);
            в них можно бросать нити вариантов; «＋ Концовка» ставит новую прямо здесь */}
        {endRow.map((e, i) => {
          const ex = 40 + i * 236;
          const used = usedEndIds.has(e.id);
          return (
            <g key={e.id} data-node="1" opacity={used ? 1 : 0.55}>
              <rect x={ex} y={endY - 44} width={216} height={40} rx={5} fill="#191204" stroke={C_GOLD} strokeWidth={1.8} />
              <text x={ex + 10} y={endY - 30} fontSize={9} className="font-display" fill={C_GOLD}>🎬 КОНЦОВКА{used ? '' : ' · свободная'}</text>
              <text x={ex + 10} y={endY - 15} fontSize={9.5} className="font-pixel" fill="#ffe9ad">{tr(e.name || '(без названия)', 28)}</text>
              <title>{used ? 'Концовка выбрана вариантом этого дерева' : 'Свободная концовка: бросьте на неё нить варианта ответа'}</title>
              {ops?.delEnding && (
                <g className="cursor-pointer" onPointerDown={(ev) => { ev.stopPropagation(); ops.delEnding && ops.delEnding(e.id); }}>
                  <rect x={ex + 200} y={endY - 40} width={12} height={12} rx={3} fill="rgba(255,93,115,0.12)" stroke="rgba(255,93,115,0.55)" strokeWidth={0.8} />
                  <text x={ex + 206} y={endY - 31} textAnchor="middle" fontSize={8} fill="#ff5d73">✕</text>
                  <title>Удалить концовку (нити и выбор «Концовка:» у вариантов очистятся)</title>
                </g>
              )}
            </g>
          );
        })}
      </GraphViewport>
    </div>
  );
}

const NH_MIN = 96; // минимальная высота узла (для bbox, когда узлы без реплик)
/* ---------- ОБЩАЯ СХЕМА КАРТЫ: все NPC + квесты + концовки (v0.51: концовки СТАВЯТСЯ здесь) ---------- */
export function QuestMapGraph({ map, pos, onPos, onSelectNpc, onSelectEnding, selEndingId, ops, height = 560 }: {
  map: GameMap;
  pos?: DlgPosMap;
  onPos?: (p: DlgPosMap | null) => void;
  onSelectNpc?: (npcId: string) => void;
  onSelectEnding?: (endingId: string) => void; // v0.51: клик по концовке — редактировать в панели под схемой
  selEndingId?: string | null;
  ops?: DlgEditOpsMap;                          // v0.51: editing — соединение нитей, «＋ Концовка», удаление
  height?: number;
}) {
  const zoomRef = useRef(1);
  const vtRef = useRef<VtRef>({ x: 0, y: 0, z: 1, svg: null });
  const dragRef = useRef<{ key: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const linkRef = useRef<{ npcId: string; nodeId: string; optIdx: number; x: number; y: number } | null>(null);
  const [, bump] = useState(0);
  /* v0.52: правка текста прямо на узлах общей схемы */
  const [edit, setEdit] = useState<{ id: string; kind: 'text' | 'opt'; oi: number } | null>(null);
  const [editH, setEditH] = useState(0);
  const npcs = useMemo(() => (map.npcs ?? []).filter((n) => n.dialog && n.dialog.nodes.length > 0), [map]);
  const endings = map.endings ?? [];
  const QW = 190, QH = 40; // плашки NPC и квестов
  const editable = !!ops;

  /* раскладка: каждый NPC — свой кластер-колонка; дерево — его layoutDialog;
     плашки NPC/квестов и концовки можно тащить отдельно (ключи npc:/q:/e:/n:) */
  const { layout, bbox } = useMemo(() => {
    const layout: DlgPosMap = { ...(pos ?? {}) };
    const clusterX: Record<string, number> = {};
    let x = 40;
    let maxBottom = 0;
    const GAP = 70;
    for (const npc of npcs) {
      const dlg = npc.dialog as NpcDialog;
      const auto = layoutDialog(dlg);
      const vals = Object.values(auto);
      const wTree = Math.max(NW, ...vals.map((p) => p.x + NW));
      const maxLocalY = Math.max(0, ...vals.map((p) => p.y));
      clusterX[npc.id] = x;
      for (const [nid, p] of Object.entries(auto)) {
        if (!layout[`n:${nid}`]) layout[`n:${nid}`] = { x: x + p.x, y: 130 + p.y };
      }
      if (!layout[`npc:${npc.id}`]) layout[`npc:${npc.id}`] = { x, y: 24 };
      (npc.quests ?? []).forEach((q, qi) => {
        if (!layout[`q:${q.id}`]) layout[`q:${q.id}`] = { x, y: 70 + qi * (QH + 12) };
      });
      let maxNodeBottom = 0;
      for (const n of dlg.nodes) {
        const p = layout[`n:${n.id}`];
        if (p) maxNodeBottom = Math.max(maxNodeBottom, p.y + nodeH(n, editable));
      }
      maxBottom = Math.max(maxBottom, 130 + maxLocalY + nodeH(dlg.nodes[0] ?? { id: '', text: '', opts: [] }, editable), maxNodeBottom);
      x += wTree + GAP;
    }
    /* концовки — колонкой справа от всех кластеров */
    const endX = x;
    endings.forEach((e, i) => {
      if (!layout[`e:${e.id}`]) layout[`e:${e.id}`] = { x: endX, y: 24 + i * 58 };
    });
    const totalW = Math.max(endX + 240, 780);
    const totalH = Math.max(maxBottom + 50, height);
    return { layout, bbox: { x0: 0, y0: 0, x1: totalW, y1: totalH } as BBox };
  }, [npcs, endings, pos, height, editable]);

  const keyDown = (key: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    const p = layout[key];
    if (!p) return;
    dragRef.current = { key, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const keyMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / zoomRef.current, dy = (e.clientY - d.sy) / zoomRef.current;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    layout[d.key] = { x: d.ox + dx, y: d.oy + dy };
    bump((n) => n + 1);
  };
  const keyUp = (key?: string) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && d.moved && onPos) onPos({ ...(pos ?? {}), [d.key]: { ...layout[d.key] } });
    if (key && onSelectNpc) onSelectNpc(key);
  };

  /* добавка к высоте блока реплики у узла, который сейчас правится на схеме */
  const extraOf = (nid: string): number => {
    if (!edit || edit.id !== nid || edit.kind !== 'text') return 0;
    for (const npc of npcs) {
      const n = (npc.dialog as NpcDialog).nodes.find((x) => x.id === nid);
      if (n) {
        const base = wrap(n.text).length ? wrap(n.text).length * 13 + 6 : 16;
        return Math.max(0, editH - base);
      }
    }
    return 0;
  };
  const closeEdit = () => { setEdit(null); setEditH(0); };

  const toCanvas = (clientX: number, clientY: number): { x: number; y: number } => {
    const v = vtRef.current;
    const r = v.svg?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left - v.x) / v.z, y: (clientY - r.top - v.y) / v.z };
  };
  const nodeOfKey = (nid: string): { npcId: string; node: DialogNode } | null => {
    for (const npc of npcs) {
      const n = (npc.dialog as NpcDialog).nodes.find((x) => x.id === nid);
      if (n) return { npcId: npc.id, node: n };
    }
    return null;
  };
  const hitNodeKey = (pt: { x: number; y: number }): string | null => {
    for (const npc of npcs) {
      const dlg = npc.dialog as NpcDialog;
      for (const n of dlg.nodes) {
        const p = layout[`n:${n.id}`];
        if (!p) continue;
        const h = nodeH(n, editable);
        if (pt.x >= p.x && pt.x <= p.x + NW && pt.y >= p.y && pt.y <= p.y + h) return n.id;
      }
    }
    return null;
  };
  const hitEndingKey = (pt: { x: number; y: number }): string | null => {
    for (const e of endings) {
      const p = layout[`e:${e.id}`];
      if (!p) continue;
      if (pt.x >= p.x && pt.x <= p.x + 216 && pt.y >= p.y && pt.y <= p.y + 44) return e.id;
    }
    return null;
  };
  const linkDown = (npcId: string, nodeId: string, optIdx: number) => (e: React.PointerEvent) => {
    if (!ops) return;
    e.stopPropagation();
    const c = toCanvas(e.clientX, e.clientY);
    linkRef.current = { npcId, nodeId, optIdx, x: c.x, y: c.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    bump((n) => n + 1);
  };
  const linkMove = (e: React.PointerEvent) => {
    if (!linkRef.current) return;
    const c = toCanvas(e.clientX, e.clientY);
    linkRef.current = { ...linkRef.current, x: c.x, y: c.y };
    bump((n) => n + 1);
  };
  const linkUp = (e: React.PointerEvent) => {
    const lk = linkRef.current;
    linkRef.current = null;
    bump((n) => n + 1);
    if (!lk || !ops) return;
    const src = nodeOfKey(lk.nodeId);
    if (!src) return;
    const sp = layout[`n:${lk.nodeId}`];
    if (!sp) return;
    const pt = toCanvas(e.clientX, e.clientY);
    const start = { x: sp.x + NW - 12, y: optRowY(src.node, sp, lk.optIdx, extraOf(lk.nodeId)) };
    if (Math.hypot(pt.x - start.x, pt.y - start.y) < 16) return;
    const endId = hitNodeKey(pt);
    if (endId && endId !== lk.nodeId) {
      const dst = nodeOfKey(endId);
      if (dst && dst.npcId === lk.npcId) { ops.setNext(lk.npcId, lk.nodeId, lk.optIdx, endId); return; }
      return; // чужой NPC: дерево ведётся в его личном редакторе
    }
    const endE = hitEndingKey(pt);
    if (endE) { ops.setEnding(lk.npcId, lk.nodeId, lk.optIdx, endE); return; }
    /* v0.53: бросили на пустое место — нить ОТМЕНЯЕТСЯ (узлы создаёт двойной клик
       по фону личного дерева NPC и кнопка «＋ Узел») */
  };

  if (npcs.length === 0 && endings.length === 0) {
    return (
      <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-[12px]">
        На карте нет NPC с диалогами и нет концовок — схема пуста. Разместите NPC в редакторе карт (панель «🧑 NPC») и создайте им диалоги.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="tick-label text-teal">🗺 Схема карты</span>
        <span className="tick-label text-faint hidden md:inline">
          <span style={{ color: C_AMBER }}>цвет нити = цвет её варианта</span> · <span style={{ color: C_GOLD }}>— к концовке</span> · <span style={{ color: C_AMBER }}>⬚ флаг открывает</span> · клик по узлу — открыть NPC
        </span>
        <span className="ml-auto flex items-center gap-1">
          {ops?.addEnding && (
            <button
              onClick={() => ops.addEnding && ops.addEnding()}
              className="px-2 py-0.5 border-2 border-gold/60 text-gold font-display text-[9px] uppercase hover:bg-gold/10 cursor-pointer"
              title="Поставить концовку на схему — потом бросьте на неё нить варианта ответа"
            >＋ Концовка</button>
          )}
          {onPos && (
            <button onClick={() => onPos(null)} className="px-2 py-0.5 border-2 border-edge text-faint font-display text-[9px] uppercase hover:text-teal cursor-pointer" title="Сбросить сохранённые позиции и разложить заново">⌖ Собрать</button>
          )}
        </span>
      </div>
      <GraphViewport height={height} bbox={bbox} fitKey={`map|${npcs.length}|${endings.length}`} zoomRef={zoomRef} vtRef={vtRef}>
        {/* временная нить — цвета СВОЕГО варианта (v0.53) */}
        {linkRef.current && (() => {
          const lk = linkRef.current;
          const src = nodeOfKey(lk.nodeId);
          const p = layout[`n:${lk.nodeId}`];
          if (!src || !p) return null;
          const lkOpt = (src.node.opts ?? [])[lk.optIdx];
          return <Edge x1={p.x + NW - 12} y1={optRowY(src.node, p, lk.optIdx)} x2={lk.x} y2={lk.y} color={lkOpt?.ending ? C_GOLD : varColor(lk.optIdx)} dashed opacity={0.9} />;
        })()}
        {/* плашки NPC, квестов и связи с корнем дерева */}
        {npcs.map((npc) => {
          const dlg = npc.dialog as NpcDialog;
          const kp = layout[`npc:${npc.id}`];
          if (!kp) return null;
          const rootP = layout[`n:${dlg.root}`];
          const def = (map.npcLib ?? []).find((x) => x.id === npc.nid);
          const quests = npc.quests ?? [];
          return (
            <g key={npc.id}>
              <g data-node="1" className="cursor-pointer" onPointerDown={keyDown(`npc:${npc.id}`)} onPointerMove={keyMove} onPointerUp={() => keyUp(npc.id)}>
                <rect x={kp.x} y={kp.y} width={QW} height={34} rx={5} fill="#0e1a2e" stroke={C_TEAL} strokeWidth={1.8} />
                <text x={kp.x + 9} y={kp.y + 15} fontSize={9} className="font-display" fill={C_TEAL}>🧑 NPC · {(dlg.nodes).length} узл.</text>
                <text x={kp.x + 9} y={kp.y + 29} fontSize={10} className="font-pixel" fill="#c7cdf0">{tr(def?.name || 'NPC', 24)}</text>
              </g>
              {quests.map((q) => {
                const qp = layout[`q:${q.id}`];
                if (!qp) return null;
                return (
                  <g key={q.id}>
                    <g data-node="1" className="cursor-pointer" onPointerDown={keyDown(`q:${q.id}`)} onPointerMove={keyMove} onPointerUp={() => keyUp(npc.id)}>
                      <rect x={qp.x} y={qp.y} width={QW} height={QH} rx={5} fill="#101726" stroke="#4d7cd6" strokeWidth={1.4} />
                      <text x={qp.x + 8} y={qp.y + 16} fontSize={8.5} className="font-display" fill="#7fb1ff">📜 КВЕСТ</text>
                      <text x={qp.x + 8} y={qp.y + 32} fontSize={9.5} className="font-pixel" fill="#c7cdf0">{tr(q.title || '(без названия)', 26)}</text>
                    </g>
                    <Edge x1={kp.x + QW / 2} y1={kp.y + 34} x2={qp.x + QW / 2} y2={qp.y} color="#4d7cd6" opacity={0.5} />
                  </g>
                );
              })}
              {rootP && <Edge x1={kp.x + QW / 2} y1={kp.y + 34} x2={rootP.x + NW / 2} y2={rootP.y} color={C_TEAL} opacity={0.6} />}
            </g>
          );
        })}
        {/* связи деревьев: «Далее», концовки, концы, флаги, подписи — ЦВЕТ НИТИ = ЦВЕТ ВАРИАНТА (v0.53) */}
        {npcs.map((npc) => {
          const dlg = npc.dialog as NpcDialog;
          const byId = new Map(dlg.nodes.map((n) => [n.id, n]));
          const P = (nid: string) => layout[`n:${nid}`];
          return (
            <g key={`edges:${npc.id}`}>
              {dlg.nodes.map((n) => {
                const p = P(n.id);
                if (!p) return null;
                const opts = n.opts ?? [];
                return opts.map((o, oi) => {
                  const sx = p.x + NW - 12;
                  const sy = optRowY(n, p, oi, extraOf(n.id));
                  const vc = o.ending ? C_GOLD : varColor(oi);
                  if (o.next && byId.has(o.next)) {
                    const tp = P(o.next);
                    if (!tp) return null;
                    const mx = (sx + tp.x) / 2, my = (sy + tp.y + 26) / 2;
                    return (
                      <g key={`${n.id}:${oi}`}>
                        <Edge x1={sx} y1={sy} x2={tp.x} y2={tp.y + 26} color={vc} opacity={0.8} />
                        {ops && <EdgeCut x={mx} y={my} color={vc} onCut={() => ops.setNext(npc.id, n.id, oi, undefined)} title="Разъединить" />}
                        <EdgeLabel x={mx} y={my - 11} text={tr(o.text || '(без текста)', 18)} color={vc} />
                      </g>
                    );
                  }
                  if (o.ending && endings.some((e) => e.id === o.ending)) {
                    const tp = layout[`e:${o.ending}`];
                    if (!tp) return null;
                    const mx = (sx + tp.x + 108) / 2, my = (sy + tp.y + 22) / 2;
                    return (
                      <g key={`${n.id}:${oi}:e`}>
                        <Edge x1={sx} y1={sy} x2={tp.x + 108} y2={tp.y + 22} color={C_GOLD} opacity={0.85} />
                        {ops && <EdgeCut x={mx} y={my} color={C_GOLD} onCut={() => ops.setEnding(npc.id, n.id, oi, undefined)} title="Снять концовку" />}
                      </g>
                    );
                  }
                  return (
                    <g key={`${n.id}:${oi}:x`} opacity={0.55}>
                      <line x1={sx} y1={sy} x2={sx} y2={sy + 16} stroke={C_FAINT} strokeWidth={1.5} />
                      <circle cx={sx} cy={sy + 19} r={3} fill={C_FAINT} />
                    </g>
                  );
                });
              })}
              {dlg.nodes.map((n) => {
                const p = P(n.id);
                if (!p) return null;
                return (n.opts ?? []).filter((o) => o.reqFlag).map((o, i) => {
                  const src = dlg.nodes.find((x) => x.id !== n.id && (x.opts ?? []).some((so) => so.setFlag && so.setFlag === o.reqFlag));
                  if (!src) return null;
                  const sp = P(src.id);
                  if (!sp) return null;
                  return <Edge key={`f:${n.id}:${i}`} x1={sp.x + NW} y1={sp.y + 26} x2={p.x} y2={p.y + 26} color={C_AMBER} dashed opacity={0.5} />;
                });
              })}
            </g>
          );
        })}
        {/* узлы деревьев */}
        {npcs.map((npc) => {
          const dlg = npc.dialog as NpcDialog;
          return dlg.nodes.map((n, ni) => {
            const p = layout[`n:${n.id}`];
            if (!p) return null;
            const orphan = dlg.root !== n.id && incoming(dlg, n.id) === 0 && dlg.nodes.length > 1;
            const lines = wrap(n.text);
            const opts = n.opts ?? [];
            const editingText = editable && edit?.id === n.id && edit.kind === 'text';
            const baseTextH = lines.length ? lines.length * 13 + 6 : 16;
            const textH = editingText ? Math.max(baseTextH, editH) : baseTextH;
            const h = nodeH(n, editable) + (textH - baseTextH);
            const textBottom = p.y + 26 + textH;
            return (
              <g key={n.id} data-node="1" className="cursor-pointer" onPointerDown={keyDown(`n:${n.id}`)} onPointerMove={keyMove} onPointerUp={() => keyUp(npc.id)}>
                <rect x={p.x} y={p.y} width={NW} height={h} rx={5} fill="#0d1124" stroke={C_EDGE} strokeWidth={1.5} />
                <circle cx={p.x} cy={p.y + 26} r={3.2} fill={C_EDGE} />
                <text x={p.x + 8} y={p.y + 15} fontSize={9.5} className="font-display" fill={C_FAINT}>№{ni + 1}</text>
                {dlg.root === n.id && <text x={p.x + NW - 44} y={p.y + 15} fontSize={8} className="font-display" fill={C_GOLD}>СТАРТ</text>}
                {editingText ? (
                  <InlineTextarea
                    x={p.x + 6} y={p.y + 30} w={NW - 12} value={n.text}
                    onChange={(v) => ops && ops.setText(npc.id, n.id, v)}
                    onClose={closeEdit}
                    onHeight={setEditH}
                  />
                ) : (
                  <>
                    {lines.length === 0 && <text x={p.x + 8} y={p.y + 36} fontSize={9} className="font-pixel" fill={C_FAINT}>(пустая реплика)</text>}
                    {lines.map((ln, li) => (
                      <text key={li} x={p.x + 8} y={p.y + 34 + li * 13} fontSize={9} className="font-pixel" fill="#c7cdf0">{ln}</text>
                    ))}
                    {editable && (
                      <rect
                        x={p.x} y={p.y + 26} width={NW} height={textH} fill="none" pointerEvents="all" style={{ cursor: 'text' }}
                        onDoubleClick={(e) => { e.stopPropagation(); setEdit({ id: n.id, kind: 'text', oi: -1 }); setEditH(baseTextH); }}
                      >
                        <title>Двойной клик — написать реплику ПРЯМО В ОКНЕ узла</title>
                      </rect>
                    )}
                  </>
                )}
                <line x1={p.x + 6} y1={textBottom - 4} x2={p.x + NW - 6} y2={textBottom - 4} stroke={C_EDGE} strokeWidth={1} />
                {opts.map((o, oi) => {
                  const ry = textBottom + oi * ROW_H + ROW_H / 2;
                  const editingOpt = editable && edit?.id === n.id && edit.kind === 'opt' && edit.oi === oi;
                  return (
                    <g key={oi}>
                      {editingOpt ? (
                        <InlineInput
                          x={p.x + 4} y={ry - 8} w={NW - 26} value={o.text}
                          onChange={(v) => ops && ops.setOptText(npc.id, n.id, oi, v)}
                          onClose={closeEdit}
                        />
                      ) : (
                        <>
                          <text x={p.x + 8} y={ry + 3} fontSize={8} className="font-pixel" fill={o.ending ? C_GOLD : '#9aa3c7'}>
                            {tr(`${o.reqFlag || o.reqNotFlag ? '🔒' : ''}${o.setFlag ? '🚩' : ''}${o.text || '(без текста)'}`, 28)}
                          </text>
                          {editable && (
                            <rect
                              x={p.x + 4} y={ry - ROW_H / 2} width={NW - 26} height={ROW_H} fill="none" pointerEvents="all" style={{ cursor: 'text' }}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() => { setEdit({ id: n.id, kind: 'opt', oi }); }}
                            >
                              <title>Клик — править текст ответа прямо на схеме</title>
                            </rect>
                          )}
                        </>
                      )}
                      <circle
                        cx={p.x + NW - 12} cy={ry} r={5}
                        fill={o.ending ? 'rgba(255,207,63,0.25)' : hexA(varColor(oi), 0.25)}
                        stroke={o.ending ? C_GOLD : varColor(oi)} strokeWidth={1.4}
                        className={ops ? 'cursor-crosshair' : ''}
                        onPointerDown={ops ? linkDown(npc.id, n.id, oi) : undefined}
                        onPointerMove={ops ? linkMove : undefined}
                        onPointerUp={ops ? linkUp : undefined}
                      />
                    </g>
                  );
                })}
                <text x={p.x + 8} y={p.y + h - 4} fontSize={8.5} className="font-display" fill={opts.length ? C_TEAL : '#ff5d73'}>{opts.length} отв.</text>
                {/* v0.55: ⚠ — в нижнюю строку (перекрывал СТАРТ/крестик в шапке) */}
                {orphan && <text x={p.x + 44} y={p.y + h - 4} fontSize={9} fill="#ff5d73" pointerEvents="none">⚠ не связан</text>}
                {opts.some((o) => o.setFlag) && <text x={p.x + NW - 44} y={p.y + h - 4} fontSize={8.5}>🚩</text>}
                {opts.some((o) => o.reqFlag || o.reqNotFlag) && <text x={p.x + NW - 26} y={p.y + h - 4} fontSize={8.5}>🔒</text>}
              </g>
            );
          });
        })}
        {/* концовки — ставятся кнопкой «＋ Концовка», в них бросаются нити вариантов */}
        {endings.map((e) => {
          const p = layout[`e:${e.id}`];
          if (!p) return null;
          const sel = selEndingId === e.id;
          return (
            <g key={e.id} data-node="1" className="cursor-pointer" onPointerDown={keyDown(`e:${e.id}`)} onPointerMove={keyMove} onPointerUp={() => { keyUp(); onSelectEnding?.(e.id); }}>
              <rect x={p.x} y={p.y} width={216} height={44} rx={5} fill="#191204" stroke={C_GOLD} strokeWidth={sel ? 2.6 : 1.8} />
              <text x={p.x + 10} y={p.y + 16} fontSize={9} className="font-display" fill={C_GOLD}>🎬 КОНЦОВКА{e.goal && e.goal.kind !== 'none' ? ' · есть условие' : ''}</text>
              <text x={p.x + 10} y={p.y + 34} fontSize={9.5} className="font-pixel" fill="#ffe9ad">{tr(e.name || '(без названия)', 28)}</text>
              {ops?.delEnding && (
                <g className="cursor-pointer" onPointerDown={(ev) => { ev.stopPropagation(); ops.delEnding && ops.delEnding(e.id); }}>
                  <rect x={p.x + 202} y={p.y + 4} width={12} height={12} rx={3} fill="rgba(255,93,115,0.12)" stroke="rgba(255,93,115,0.55)" strokeWidth={0.8} />
                  <text x={p.x + 208} y={p.y + 13} textAnchor="middle" fontSize={8} fill="#ff5d73">✕</text>
                  <title>Удалить концовку (нити к ней отсоединятся)</title>
                </g>
              )}
            </g>
          );
        })}
      </GraphViewport>
      <p className="text-[9px] text-faint leading-tight">
        Цвет нити = цвет её варианта ответа; золотая стрелка ведёт к КОНЦОВКЕ; синие плашки — КВЕСТЫ NPC; янтарный пунктир — флаг: вариант слева его ставит, вариант справа без него скрыт{ops ? '. Нить из сокета ○ бросьте на КОНЦОВКУ — назначите её варианту. Двойной клик по узлу — править реплику, клик по ответу — править его. Узлы перетаскиваются — схема сохранится в карту.' : ''}
      </p>
    </div>
  );
}
