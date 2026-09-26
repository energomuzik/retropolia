import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameMap, MapEnding, NpcDialog } from '../types';

/* СХЕМА ДЕРЕВЬЕВ ДИАЛОГОВ (v0.50.0) — граф в духе ComfyUI: узлы-вопросы на холсте,
   стрелки показывают «что из чего растёт» (вопрос → вариант ответа → следующий вопрос).
   • узлы ПЕРЕТАСКИВАЮТСЯ мышью/пальцем — позиции сохраняются в карту (map.dlgPos);
   • холст панорамируется перетаскиванием фона, зум — колесом мыши и кнопками «+/−»;
   • «Собрать» раскладывает дерево заново по глубине (BFS от стартового узла);
   • цвета связей: бирюзовая — «Далее:», золотая — КОНЦОВКА, янтарная пунктирная —
     флаг (вариант слева ставит флаг, вариант справа без него скрыт), серая точка — конец;
   • QuestMapGraph — ОБЩАЯ схема карты: все NPC, их деревья, КВЕСТЫ и КОНЦОВКИ
     на одном холсте — видно, какие ответы ведут к концовкам и что открывают флаги. */

const NW = 200; // ширина узла-вопроса
const NH = 96;  // высота узла-вопроса
const GX = 56;  // горизонтальный зазор между колонками
const GY = 78;  // вертикальный зазор между поколениями
const C_TEAL = '#2ee6a8';
const C_GOLD = '#ffcf3f';
const C_AMBER = '#ffb347';
const C_EDGE = '#313c72';
const C_FAINT = '#5a6491';

export type DlgPos = { x: number; y: number };
export type DlgPosMap = { [key: string]: DlgPos };
type BBox = { x0: number; y0: number; x1: number; y1: number };

const tr = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Разбивка реплики на строки ≤ w символов, максимум 3 строки (дальше — многоточие). */
const wrap = (s: string, w = 27): string[] => {
  const words = (s || '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    if (!cur.length) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += ` ${word}`;
    else { lines.push(cur); cur = word; }
  }
  if (cur.length) lines.push(cur);
  if (lines.length > 3) {
    lines.length = 3;
    lines[2] = tr(lines[2], w);
  }
  return lines;
};

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
  layers.forEach((ids, d) => {
    ids.forEach((id, i) => {
      pos[id] = { x: 40 + (span - ids.length * (NW + GX)) / 2 + i * (NW + GX), y: 40 + d * (NH + GY) };
    });
  });
  return pos;
}

/* входящие связи узла (для маркера «⚠ не связан») */
const incoming = (dialog: NpcDialog, id: string): number =>
  dialog.nodes.reduce((a, n) => a + (n.opts ?? []).filter((o) => o.next === id).length, 0);

/* ---------- ОБЩИЙ ХОЛСТ: панорама + зум. Вписывание — только при смене fitKey ---------- */
function GraphViewport({ height, bbox, fitKey, zoomRef, children }: {
  height: number;
  bbox: BBox;
  fitKey: string;
  zoomRef: React.MutableRefObject<number>; // текущий зум для обработчиков перетаскивания узлов
  children: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [vt, setVt] = useState<{ x: number; y: number; z: number } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    const w = el?.clientWidth ?? 800;
    const bw = Math.max(1, bbox.x1 - bbox.x0), bh = Math.max(1, bbox.y1 - bbox.y0);
    const z = Math.max(0.3, Math.min(1.25, Math.min((w - 48) / bw, (height - 48) / bh)));
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
      const z = Math.max(0.3, Math.min(2.2, s.z * factor));
      const k = z / s.z;
      return { z, x: cx - (cx - s.x) * k, y: cy - (cy - s.y) * k };
    });
  }, []);
  const z = vt?.z ?? 1;
  zoomRef.current = z;

  return (
    <div className="relative select-none" ref={wrapRef}>
      <svg
        width="100%"
        height={height}
        className="block cursor-grab active:cursor-grabbing"
        style={{ background: 'repeating-conic-gradient(#0a0d1c 0 25%, #0b0e1c 0 50%) 0 0 / 22px 22px', border: '2px solid #23294d' }}
        onWheel={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-node]')) return; // узлы тянут себя сами
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
        колесо — масштаб · тяните фон — панорама · тяните узел — переместить
      </div>
    </div>
  );
}

/* ---------- СТРЕЛКА-«КОСТОЧКА» между точками ---------- */
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

/* подпись на связи (текст варианта ответа) */
function EdgeLabel({ x, y, text, color }: { x: number; y: number; text: string; color: string }) {
  const w = text.length * 5.3 + 10;
  return (
    <g>
      <rect x={x - w / 2} y={y - 8} width={w} height={15} rx={3} fill="#0b0e1c" stroke={color} strokeWidth={0.8} opacity={0.92} />
      <text x={x} y={y + 3} textAnchor="middle" fontSize={9} className="font-pixel" fill={color === C_GOLD ? C_GOLD : '#9aa3c7'}>{text}</text>
    </g>
  );
}

/* ---------- ОДНО ДЕРЕВО ДИАЛОГОВ NPC (граф) ---------- */
export function DialogueGraph({ dialog, endings, selId, onSelect, pos, onPos, height = 300, fitKey }: {
  dialog: NpcDialog;
  endings: MapEnding[];
  selId?: string | null;
  onSelect?: (nodeId: string) => void;
  pos?: DlgPosMap;                 // сохранённые позиции (map.dlgPos) — перекрывают автораскладку
  onPos?: (p: DlgPosMap | null) => void; // сохранить позиции (null — сбросить и разложить заново)
  height?: number;
  fitKey?: string;                 // смена ключа = заново вписать схему в окно
}) {
  const zoomRef = useRef(1);
  const layout = useMemo<DlgPosMap>(() => ({ ...layoutDialog(dialog), ...(pos ?? {}) }), [dialog, pos]);
  const dragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [, bump] = useState(0); // перерисовка при перетаскивании узла

  const nodes = dialog.nodes;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const idxOf = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes]);

  /* концовки, выбранные вариантами этого дерева, — золотые плашки в нижнем ряду */
  const usedEndings = useMemo(() => {
    const ids: string[] = [];
    for (const n of nodes) for (const o of n.opts ?? []) if (o.ending && !ids.includes(o.ending)) ids.push(o.ending);
    return ids.map((id) => ({ id, e: endings.find((x) => x.id === id) })).filter((x): x is { id: string; e: MapEnding } => !!x.e);
  }, [nodes, endings]);

  const ys = Object.values(layout).map((p) => p.y);
  const xs = Object.values(layout).map((p) => p.x);
  const bottomY = (ys.length ? Math.max(...ys) : 0) + NH;
  const endY = bottomY + 78;
  const endRowW = usedEndings.length ? 40 + usedEndings.length * 236 : 0;
  const bbox: BBox = {
    x0: Math.min(0, ...(xs.length ? xs : [0])) - 20,
    y0: Math.min(0, ...(ys.length ? ys : [0])) - 20,
    x1: Math.max(NW + 80, endRowW, ...(xs.length ? xs.map((x) => x + NW) : [NW + 80])) + 20,
    y1: usedEndings.length ? endY + 10 : bottomY + 30,
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

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="tick-label text-teal">🌳 Схема дерева</span>
        <span className="tick-label text-faint">
          <span style={{ color: C_TEAL }}>— далее</span> · <span style={{ color: C_GOLD }}>— концовка</span> · <span style={{ color: C_AMBER }}>⬚ флаг</span> · ·? — конец диалога
        </span>
        {onPos && (
          <button
            onClick={() => onPos(null)}
            className="ml-auto px-2 py-0.5 border-2 border-edge text-faint font-display text-[9px] uppercase hover:text-teal cursor-pointer"
            title="Разложить все узлы заново по глубине дерева (сбрасывает перетаскивания)"
          >⌖ Собрать</button>
        )}
      </div>
      <GraphViewport height={height} bbox={bbox} fitKey={`${fitKey ?? ''}|${dialog.root}|${dialog.nodes.length}`} zoomRef={zoomRef}>
        {/* связи «Далее» и концы */}
        {nodes.map((n) => {
          const p = layout[n.id];
          if (!p) return null;
          const opts = n.opts ?? [];
          return opts.map((o, oi) => {
            const sx = p.x + (NW * (oi + 1)) / (opts.length + 1);
            const sy = p.y + NH;
            if (o.next && byId.has(o.next)) {
              const tp = layout[o.next];
              if (!tp) return null;
              return <Edge key={`${n.id}:${oi}`} x1={sx} y1={sy} x2={tp.x + NW / 2} y2={tp.y} color={o.ending ? C_GOLD : C_TEAL} opacity={0.85} />;
            }
            if (o.ending && usedEndings.some((u) => u.id === o.ending)) {
              const i = usedEndings.findIndex((u) => u.id === o.ending);
              return <Edge key={`${n.id}:${oi}`} x1={sx} y1={sy} x2={40 + i * 236 + 108} y2={endY - 44} color={C_GOLD} opacity={0.9} />;
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
            return <Edge key={`flag:${n.id}:${i}`} x1={sp.x + NW} y1={sp.y + NH / 2} x2={p.x} y2={p.y + NH / 2} color={C_AMBER} dashed opacity={0.55} />;
          });
        })}
        {/* подписи вариантов на связях «Далее» */}
        {nodes.map((n) => {
          const p = layout[n.id];
          if (!p) return null;
          const opts = n.opts ?? [];
          return opts.map((o, oi) => {
            if (!o.next || !byId.has(o.next)) return null;
            const tp = layout[o.next];
            if (!tp) return null;
            const mx = (p.x + (NW * (oi + 1)) / (opts.length + 1) + tp.x + NW / 2) / 2;
            const myc = (p.y + NH + tp.y) / 2;
            return <EdgeLabel key={`lb:${n.id}:${oi}`} x={mx} y={myc} text={tr(o.text || '(без текста)', 20)} color={o.ending ? C_GOLD : C_TEAL} />;
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
          return (
            <g
              key={n.id}
              data-node="1"
              onPointerDown={nodeDown(n.id)}
              onPointerMove={nodeMove}
              onPointerUp={() => nodeUp(n.id)}
              className="cursor-pointer"
            >
              <rect x={p.x} y={p.y} width={NW} height={NH} rx={5} fill={sel ? '#101a30' : '#0d1124'} stroke={sel ? C_TEAL : C_EDGE} strokeWidth={sel ? 2.5 : 1.6} />
              <text x={p.x + 8} y={p.y + 15} fontSize={10} className="font-display" fill={C_FAINT}>№{i + 1}</text>
              {dialog.root === n.id && (
                <>
                  <rect x={p.x + NW - 58} y={p.y + 5} width={52} height={13} rx={3} fill="rgba(255,207,63,0.12)" stroke={C_GOLD} strokeWidth={0.8} />
                  <text x={p.x + NW - 32} y={p.y + 15} textAnchor="middle" fontSize={8} className="font-display" fill={C_GOLD}>СТАРТ</text>
                </>
              )}
              {lines.length === 0 && <text x={p.x + 8} y={p.y + 36} fontSize={9.5} className="font-pixel" fill={C_FAINT}>(пустая реплика)</text>}
              {lines.map((ln, li) => (
                <text key={li} x={p.x + 8} y={p.y + 34 + li * 13} fontSize={9.5} className="font-pixel" fill="#c7cdf0">{ln}</text>
              ))}
              <text x={p.x + 8} y={p.y + NH - 8} fontSize={8.5} className="font-display" fill={opts.length ? C_TEAL : '#ff5d73'}>{opts.length} отв.</text>
              {hasSet && <text x={p.x + NW - 46} y={p.y + NH - 8} fontSize={9}>🚩</text>}
              {hasReq && <text x={p.x + NW - 28} y={p.y + NH - 8} fontSize={9}>🔒</text>}
              {orphan && <text x={p.x + NW - 14} y={p.y + 15} fontSize={9} fill="#ff5d73">⚠</text>}
            </g>
          );
        })}
        {/* концовки — золотые плашки в нижнем ряду */}
        {usedEndings.map((u, i) => {
          const ex = 40 + i * 236;
          return (
            <g key={u.id}>
              <rect x={ex} y={endY - 44} width={216} height={40} rx={5} fill="#191204" stroke={C_GOLD} strokeWidth={1.8} />
              <text x={ex + 10} y={endY - 30} fontSize={9} className="font-display" fill={C_GOLD}>🎬 КОНЦОВКА</text>
              <text x={ex + 10} y={endY - 15} fontSize={9.5} className="font-pixel" fill="#ffe9ad">{tr(u.e.name || '(без названия)', 28)}</text>
            </g>
          );
        })}
      </GraphViewport>
    </div>
  );
}

/* ---------- ОБЩАЯ СХЕМА КАРТЫ: все NPC + квесты + концовки ---------- */
export function QuestMapGraph({ map, pos, onPos, onSelectNpc, height = 560 }: {
  map: GameMap;
  pos?: DlgPosMap;
  onPos?: (p: DlgPosMap | null) => void;
  onSelectNpc?: (npcId: string) => void;
  height?: number;
}) {
  const zoomRef = useRef(1);
  const dragRef = useRef<{ key: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [, bump] = useState(0);
  const npcs = useMemo(() => (map.npcs ?? []).filter((n) => n.dialog && n.dialog.nodes.length > 0), [map]);
  const endings = map.endings ?? [];
  const QW = 190, QH = 40; // плашки NPC и квестов

  /* раскладка: каждый NPC — свой кластер-колонка; дерево — его layoutDialog;
     плашки NPC/квестов и концовки можно тащить отдельно (ключи npc:/q:/e:/n:) */
  const { layout, clusterX, bbox } = useMemo(() => {
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
      maxBottom = Math.max(maxBottom, 130 + maxLocalY + NH + (npc.quests ?? []).length * 0);
      x += wTree + GAP;
    }
    /* концовки — колонкой справа от всех кластеров */
    const endX = x;
    endings.forEach((e, i) => {
      if (!layout[`e:${e.id}`]) layout[`e:${e.id}`] = { x: endX, y: 24 + i * 58 };
    });
    const totalW = Math.max(endX + 240, 780);
    const totalH = Math.max(maxBottom + 50, height);
    return { layout, clusterX, bbox: { x0: 0, y0: 0, x1: totalW, y1: totalH } };
  }, [npcs, endings, pos, height]);

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
  const keyUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && d.moved && onPos) onPos({ ...(pos ?? {}), [d.key]: { ...layout[d.key] } });
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
        <span className="tick-label text-faint">
          <span style={{ color: C_TEAL }}>— далее</span> · <span style={{ color: C_GOLD }}>— к концовке</span> · <span style={{ color: C_AMBER }}>⬚ флаг открывает</span> · клик по узлу — открыть NPC
        </span>
        {onPos && (
          <button onClick={() => onPos(null)} className="ml-auto px-2 py-0.5 border-2 border-edge text-faint font-display text-[9px] uppercase hover:text-teal cursor-pointer" title="Сбросить сохранённые позиции и разложить заново">⌖ Собрать</button>
        )}
      </div>
      <GraphViewport height={height} bbox={bbox} fitKey={`map|${npcs.length}|${endings.length}`} zoomRef={zoomRef}>
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
              <g data-node="1" className="cursor-pointer" onPointerDown={keyDown(`npc:${npc.id}`)} onPointerMove={keyMove} onPointerUp={() => { keyUp(); onSelectNpc?.(npc.id); }}>
                <rect x={kp.x} y={kp.y} width={QW} height={34} rx={5} fill="#0e1a2e" stroke={C_TEAL} strokeWidth={1.8} />
                <text x={kp.x + 9} y={kp.y + 15} fontSize={9} className="font-display" fill={C_TEAL}>🧑 NPC · {(dlg.nodes).length} узл.</text>
                <text x={kp.x + 9} y={kp.y + 29} fontSize={10} className="font-pixel" fill="#c7cdf0">{tr(def?.name || 'NPC', 24)}</text>
              </g>
              {quests.map((q) => {
                const qp = layout[`q:${q.id}`];
                if (!qp) return null;
                return (
                  <g key={q.id}>
                    <g data-node="1" className="cursor-pointer" onPointerDown={keyDown(`q:${q.id}`)} onPointerMove={keyMove} onPointerUp={() => { keyUp(); onSelectNpc?.(npc.id); }}>
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
        {/* связи деревьев: «Далее», концовки, концы, флаги, подписи */}
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
                  const sx = p.x + (NW * (oi + 1)) / (opts.length + 1);
                  const sy = p.y + NH;
                  if (o.next && byId.has(o.next)) {
                    const tp = P(o.next);
                    if (!tp) return null;
                    return <Edge key={`${n.id}:${oi}`} x1={sx} y1={sy} x2={tp.x + NW / 2} y2={tp.y} color={o.ending ? C_GOLD : C_TEAL} opacity={0.8} />;
                  }
                  if (o.ending && endings.some((e) => e.id === o.ending)) {
                    const tp = layout[`e:${o.ending}`];
                    if (!tp) return null;
                    return <Edge key={`${n.id}:${oi}:e`} x1={sx} y1={sy} x2={tp.x + 108} y2={tp.y} color={C_GOLD} opacity={0.85} />;
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
                  return <Edge key={`f:${n.id}:${i}`} x1={sp.x + NW} y1={sp.y + NH / 2} x2={p.x} y2={p.y + NH / 2} color={C_AMBER} dashed opacity={0.5} />;
                });
              })}
              {dlg.nodes.map((n) => {
                const p = P(n.id);
                if (!p) return null;
                const opts = n.opts ?? [];
                return opts.map((o, oi) => {
                  if (!o.next || !byId.has(o.next)) return null;
                  const tp = P(o.next);
                  if (!tp) return null;
                  const mx = (p.x + (NW * (oi + 1)) / (opts.length + 1) + tp.x + NW / 2) / 2;
                  const myc = (p.y + NH + tp.y) / 2;
                  return <EdgeLabel key={`l:${n.id}:${oi}`} x={mx} y={myc} text={tr(o.text || '(без текста)', 18)} color={o.ending ? C_GOLD : C_TEAL} />;
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
            return (
              <g key={n.id} data-node="1" className="cursor-pointer" onPointerDown={keyDown(`n:${n.id}`)} onPointerMove={keyMove} onPointerUp={() => { keyUp(); onSelectNpc?.(npc.id); }}>
                <rect x={p.x} y={p.y} width={NW} height={NH} rx={5} fill="#0d1124" stroke={C_EDGE} strokeWidth={1.5} />
                <text x={p.x + 8} y={p.y + 15} fontSize={9.5} className="font-display" fill={C_FAINT}>№{ni + 1}</text>
                {dlg.root === n.id && <text x={p.x + NW - 44} y={p.y + 15} fontSize={8} className="font-display" fill={C_GOLD}>СТАРТ</text>}
                {lines.length === 0 && <text x={p.x + 8} y={p.y + 36} fontSize={9} className="font-pixel" fill={C_FAINT}>(пустая реплика)</text>}
                {lines.map((ln, li) => (
                  <text key={li} x={p.x + 8} y={p.y + 34 + li * 13} fontSize={9} className="font-pixel" fill="#c7cdf0">{ln}</text>
                ))}
                <text x={p.x + 8} y={p.y + NH - 7} fontSize={8.5} className="font-display" fill={opts.length ? C_TEAL : '#ff5d73'}>{opts.length} отв.</text>
                {opts.some((o) => o.setFlag) && <text x={p.x + NW - 44} y={p.y + NH - 7} fontSize={8.5}>🚩</text>}
                {opts.some((o) => o.reqFlag || o.reqNotFlag) && <text x={p.x + NW - 26} y={p.y + NH - 7} fontSize={8.5}>🔒</text>}
                {orphan && <text x={p.x + NW - 13} y={p.y + 15} fontSize={9} fill="#ff5d73">⚠</text>}
              </g>
            );
          });
        })}
        {/* концовки */}
        {endings.map((e) => {
          const p = layout[`e:${e.id}`];
          if (!p) return null;
          return (
            <g key={e.id} data-node="1" className="cursor-pointer" onPointerDown={keyDown(`e:${e.id}`)} onPointerMove={keyMove} onPointerUp={keyUp}>
              <rect x={p.x} y={p.y} width={216} height={44} rx={5} fill="#191204" stroke={C_GOLD} strokeWidth={1.8} />
              <text x={p.x + 10} y={p.y + 16} fontSize={9} className="font-display" fill={C_GOLD}>🎬 КОНЦОВКА{e.goal && e.goal.kind !== 'none' ? ' · есть условие' : ''}</text>
              <text x={p.x + 10} y={p.y + 34} fontSize={9.5} className="font-pixel" fill="#ffe9ad">{tr(e.name || '(без названия)', 28)}</text>
            </g>
          );
        })}
      </GraphViewport>
      <p className="text-[9px] text-faint leading-tight">
        Золотые стрелки показывают, какой вариант ответа ведёт к КОНЦОВКЕ; синие плашки — КВЕСТЫ NPC (условия и награды — на вкладке «NPC и диалоги»); янтарный пунктир — флаг: вариант слева его ставит, вариант справа без него скрыт. Узлы перетаскиваются — схема сохранится в карту.
      </p>
    </div>
  );
}
