import { useState } from 'react';
import { uid } from '../db';
import { sfx } from '../sound';
import type { DialogNode, DialogOption, MapEnding, NpcDialog } from '../types';
import { Coin } from '../ui';
import { DialogueGraph } from './DialogueGraph';
import type { DlgPosMap } from './DialogueGraph';

/* ОБЩИЙ РЕДАКТОР ДЕРЕВА ДИАЛОГОВ NPC (v0.46.0) — один компонент для редактора карт
   И для «Редактора квестов и диалогов». Сделан удобным и понятным:
   • слева — СПИСОК УЗЛОВ-вопросов с номерами («№1 · Приветствие») и бейджами
     (СТАРТ, сколько вариантов ответа, «⚠ не связан» — узел, до которого нельзя дойти);
   • редактируется ВЫБРАННЫЙ узел — реплика NPC + его варианты ответа;
   • у узла может СКОЛЬКО УГОДНО вариантов: крупная кнопка «+ Добавить вариант»,
     у каждого варианта — ↑↓ (порядок), ⧉ (дублировать), ✕ (удалить);
   • кнопка «→ новый узел» у варианта: создаёт узел и СРАЗУ привязывает вариант
     к нему — так дерево растёт естественным путём (вопрос → ответ → новый вопрос);
   • «Далее:» и «Старт:» показывают НОМЕР и текст узла, а не безликий «(пусто)»;
   • при удалении узла ссылки на него автоматически очищаются;
   • флаги: вариант может ставить флаг и/или быть видимым только с флагом/без флага
     (пустые поля = вариант виден всем всегда).
   СХЕМА (v0.50.0): кнопка «Схема» раскрывает граф в духе ComfyUI — узлы-вопросы на холсте
   со стрелками «что из чего растёт»; узлы перетаскиваются (позиции сохраняются в карту
   через posStore/onPosStore), зум колесом, панорама, «Собрать» раскладывает заново.
   Клик по узлу графа выбирает его для редактирования ниже. */
export function DialogTreeEditor({ dialog, endings, onChange, posStore, onPosStore, openGraph = false, graphHeight = 300 }: {
  dialog: NpcDialog;
  endings: MapEnding[];
  onChange: (d: NpcDialog) => void;
  posStore?: DlgPosMap;                 // сохранённые позиции узлов (map.dlgPos)
  onPosStore?: (p: DlgPosMap | null) => void; // записать позиции в карту (null — сброс)
  openGraph?: boolean;                  // показать схему сразу (окно дерева NPC)
  graphHeight?: number;                 // высота холста схемы
}) {
  const [selRaw, setSel] = useState<string>('');
  const [graphOpen, setGraphOpen] = useState(openGraph);
  const nodes = dialog.nodes;
  /* выбранная нода; сбрасывается на стартовую, если удалили текущую */
  const selId = nodes.some((n) => n.id === selRaw) ? selRaw : dialog.root;
  const selIdx = Math.max(0, nodes.findIndex((n) => n.id === selId));
  const selNode = nodes[selIdx];

  /* сколько вариантов во ВСЁМ дереве ведут в узел (для «⚠ не связан») */
  const refsOf = (id: string): number =>
    nodes.reduce((a, n) => a + (n.opts ?? []).filter((o) => o.next === id).length, 0);
  const nodeLabel = (n: DialogNode): string => {
    const i = nodes.findIndex((x) => x.id === n.id);
    return `№${i + 1} · ${(n.text || '(пусто)').slice(0, 26)}`;
  };

  /* ---------- операции (все иммутабельные, результат — новый NpcDialog) ---------- */
  const updNode = (nid: string, patch: Partial<DialogNode>) =>
    onChange({ ...dialog, nodes: nodes.map((n) => (n.id === nid ? { ...n, ...patch } : n)) });
  const updOpt = (nid: string, oi: number, patch: Partial<DialogOption>) =>
    onChange({
      ...dialog,
      nodes: nodes.map((n) => (n.id === nid
        ? { ...n, opts: (n.opts ?? []).map((o, i) => (i === oi ? { ...o, ...patch } : o)) }
        : n)),
    });
  const addOpt = (nid: string) => {
    const n = nodes.find((x) => x.id === nid);
    if (!n) return;
    updNode(nid, { opts: [...(n.opts ?? []), { text: '' }] });
    sfx.coin();
  };
  const delOpt = (nid: string, oi: number) => {
    const n = nodes.find((x) => x.id === nid);
    if (!n) return;
    updNode(nid, { opts: (n.opts ?? []).filter((_, i) => i !== oi) });
    sfx.fail();
  };
  const moveOpt = (nid: string, oi: number, dir: -1 | 1) => {
    const n = nodes.find((x) => x.id === nid);
    if (!n) return;
    const arr = [...(n.opts ?? [])];
    const j = oi + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[oi], arr[j]] = [arr[j], arr[oi]];
    updNode(nid, { opts: arr });
    sfx.hover();
  };
  const dupOpt = (nid: string, oi: number) => {
    const n = nodes.find((x) => x.id === nid);
    if (!n) return;
    const arr = [...(n.opts ?? [])];
    const src = arr[oi];
    if (!src) return;
    arr.splice(oi + 1, 0, { ...src, text: `${src.text} (копия)`.trim() });
    updNode(nid, { opts: arr });
    sfx.coin();
  };
  const addNode = () => {
    const nid = uid('dn');
    onChange({ ...dialog, nodes: [...nodes, { id: nid, text: '', opts: [] }] });
    setSel(nid);
    sfx.coin();
  };
  /* создать узел и сразу привязать вариант к нему — главный способ растить дерево */
  const addNodeLinked = (fromNid: string, oi: number) => {
    const nid = uid('dn');
    onChange({
      ...dialog,
      nodes: nodes
        .map((n) => (n.id === fromNid
          ? { ...n, opts: (n.opts ?? []).map((o, i) => (i === oi ? { ...o, next: nid } : o)) }
          : n))
        .concat([{ id: nid, text: '', opts: [] }]),
    });
    setSel(nid);
    sfx.coin();
  };
  const delNode = (nid: string) => {
    const rest = nodes.filter((x) => x.id !== nid);
    if (rest.length === 0) return;
    /* ссылки «Далее:» на удаляемый узел очищаются — висячих ссылок не остаётся */
    const cleaned = rest.map((n) => ({ ...n, opts: (n.opts ?? []).map((o) => (o.next === nid ? { ...o, next: undefined } : o)) }));
    const root = dialog.root === nid ? rest[0].id : dialog.root;
    onChange({ root, nodes: cleaned });
    if (selId === nid) setSel(root);
    sfx.fail();
  };

  return (
    <div className="space-y-2">
      {/* стартовый узел + переключатель схемы */}
      <div className="flex items-center gap-1.5">
        <span className="tick-label text-faint shrink-0">Старт:</span>
        <select
          className="field-in flex-1 min-w-0 px-1.5 py-1 text-[10px]"
          value={dialog.root}
          onChange={(ev) => onChange({ ...dialog, root: ev.target.value })}
        >
          {nodes.map((n, i) => (
            <option key={n.id} value={n.id}>{`№${i + 1} · ${(n.text || '(пусто)').slice(0, 26)}`}</option>
          ))}
        </select>
        <button
          onClick={() => { setGraphOpen((v) => !v); sfx.hover(); }}
          className={`px-2 py-1 border-2 font-display text-[9px] uppercase cursor-pointer transition-colors shrink-0 ${graphOpen ? 'border-teal text-teal bg-teal/10' : 'border-edge text-faint hover:text-teal'}`}
          title="Граф-схема дерева: узлы-вопросы и стрелки «что из чего растёт» — как в ComfyUI"
        >🌳 Схема</button>
      </div>

      {/* ГРАФ-СХЕМА ДЕРЕВА (ComfyUI): узлы перетаскиваются, позиции сохраняются в карту */}
      {graphOpen && (
        <DialogueGraph
          dialog={dialog}
          endings={endings}
          selId={selId}
          onSelect={(id) => { setSel(id); sfx.hover(); }}
          pos={posStore}
          onPos={onPosStore}
          height={graphHeight}
          fitKey={dialog.root}
        />
      )}

      {/* СПИСОК УЗЛОВ-вопросов: клик — выбрать для редактирования */}
      <div className="space-y-1">
        {nodes.map((n, i) => {
          const incoming = refsOf(n.id);
          const orphan = dialog.root !== n.id && incoming === 0 && nodes.length > 1;
          const active = n.id === selId;
          return (
            <div
              key={n.id}
              onClick={() => { setSel(n.id); sfx.hover(); }}
              className={`flex items-center gap-1.5 px-1.5 py-1 border-2 cursor-pointer transition-colors ${active ? 'border-teal bg-teal/5' : 'border-edge hover:border-edge2'}`}
              title={orphan ? '⚠ В этот узел не ведёт ни один вариант — в игре он недостижим (назначьте его стартом или свяжите вариант «Далее:»)' : `В этот узел ведут вариантов: ${incoming}${dialog.root === n.id ? ' · стартовый узел' : ''}`}
            >
              <span className={`font-display text-[10px] shrink-0 ${active ? 'text-teal' : 'text-faint'}`}>№{i + 1}</span>
              <span className={`flex-1 min-w-0 text-[10px] truncate ${n.text ? 'text-dim' : 'text-faint'}`}>{n.text || '(пустая реплика)'}</span>
              {dialog.root === n.id && <span className="tick-label text-gold shrink-0">СТАРТ</span>}
              <span className={`tick-label shrink-0 ${orphan ? 'text-magma' : 'text-faint'}`}>{(n.opts ?? []).length} отв.</span>
              {orphan && <span className="tick-label text-magma shrink-0" title="Узел недостижим из диалога">⚠</span>}
              {nodes.length > 1 && (
                <button
                  onClick={(ev) => { ev.stopPropagation(); delNode(n.id); }}
                  className="text-faint hover:text-coral cursor-pointer px-0.5 text-[10px]"
                  title="Удалить узел (ссылки на него очистятся автоматически)"
                >✕</button>
              )}
            </div>
          );
        })}
        <button
          onClick={addNode}
          className="w-full py-1 border-2 border-dashed border-edge text-faint font-display text-[10px] uppercase hover:text-paper cursor-pointer"
        >+ Новый узел (вопрос NPC)</button>
        <p className="text-[9px] text-faint leading-tight">Кликните по узлу — откроется его редактирование. Узлов и вариантов может быть сколько угодно; «Далее:» ведёт в другой узел, пусто — диалог завершается.</p>
      </div>

      {/* РЕДАКТИРОВАНИЕ ВЫБРАННОГО УЗЛА */}
      {selNode && (
        <div className="border-2 border-teal/50 px-2 py-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="tick-label text-teal">Узел №{selIdx + 1}{dialog.root === selNode.id ? ' · СТАРТ' : ''}</span>
            {dialog.root !== selNode.id && (
              <button
                onClick={() => onChange({ ...dialog, root: selNode.id })}
                className="text-[10px] text-faint hover:text-gold cursor-pointer px-1"
                title="Диалог начнётся с этого узла"
              >сделать стартом</button>
            )}
          </div>
          <textarea
            className="field-in w-full px-2 py-1 text-[11px] min-h-[42px]"
            maxLength={280}
            placeholder="Реплика NPC (что говорит)…"
            value={selNode.text}
            onChange={(ev) => updNode(selNode.id, { text: ev.target.value })}
          />

          <div className="flex items-center justify-between gap-1">
            <span className="tick-label text-gold">Варианты ответа ({(selNode.opts ?? []).length})</span>
            <button
              onClick={() => addOpt(selNode.id)}
              className="px-2 py-1 border-2 border-gold/60 text-gold font-display text-[9px] uppercase hover:bg-gold/10 cursor-pointer shrink-0"
            >+ Добавить вариант</button>
          </div>
          {(selNode.opts ?? []).length === 0 && (
            <p className="text-[9px] text-magma leading-tight">Ни одного варианта: диалог закроется сразу после реплики. Добавьте вариант ответа.</p>
          )}
          {(selNode.opts ?? []).map((o, oi) => (
            <div key={oi} className="border-2 border-edge px-1.5 py-1.5 space-y-1 bg-[rgba(7,9,18,0.5)]">
              <div className="flex items-center gap-1">
                <span className="tick-label text-faint shrink-0">{oi + 1}.</span>
                <input
                  className="field-in flex-1 min-w-0 px-1.5 py-1 text-[11px]"
                  maxLength={80}
                  placeholder="Что отвечает игрок…"
                  value={o.text}
                  onChange={(ev) => updOpt(selNode.id, oi, { text: ev.target.value })}
                />
                <button
                  onClick={() => moveOpt(selNode.id, oi, -1)}
                  disabled={oi === 0}
                  className={`px-0.5 text-[10px] cursor-pointer ${oi === 0 ? 'text-edge' : 'text-faint hover:text-teal'}`}
                  title="Поднять вариант"
                >↑</button>
                <button
                  onClick={() => moveOpt(selNode.id, oi, 1)}
                  disabled={oi === (selNode.opts?.length ?? 0) - 1}
                  className={`px-0.5 text-[10px] cursor-pointer ${oi === (selNode.opts?.length ?? 0) - 1 ? 'text-edge' : 'text-faint hover:text-teal'}`}
                  title="Опустить вариант"
                >↓</button>
                <button onClick={() => dupOpt(selNode.id, oi)} className="text-faint hover:text-teal cursor-pointer px-0.5 text-[10px]" title="Дублировать вариант">⧉</button>
                <button onClick={() => delOpt(selNode.id, oi)} className="text-faint hover:text-coral cursor-pointer px-0.5 text-[10px]" title="Удалить вариант">✕</button>
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                <span className="tick-label text-faint shrink-0">Далее:</span>
                <select
                  className="field-in px-1 py-1 text-[10px] flex-1 min-w-[110px]"
                  value={o.next ?? ''}
                  onChange={(ev) => updOpt(selNode.id, oi, { next: ev.target.value || undefined })}
                >
                  <option value="">— конец диалога —</option>
                  {nodes.filter((x) => x.id !== selNode.id).map((x) => (
                    <option key={x.id} value={x.id}>{nodeLabel(x)}</option>
                  ))}
                </select>
                <button
                  onClick={() => addNodeLinked(selNode.id, oi)}
                  className="px-1.5 py-1 border-2 border-dashed border-teal/60 text-teal font-pixel text-[8px] uppercase hover:bg-teal/10 cursor-pointer shrink-0"
                  title="Создать новый узел-вопрос и сразу привязать этот вариант к нему"
                >→ новый узел</button>
              </div>
              {endings.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="tick-label text-faint shrink-0">Концовка:</span>
                  <select
                    className="field-in px-1 py-1 text-[10px] flex-1 min-w-[110px]"
                    value={o.ending ?? ''}
                    onChange={(ev) => updOpt(selNode.id, oi, { ending: ev.target.value || undefined })}
                  >
                    <option value="">— нет —</option>
                    {endings.map((e) => <option key={e.id} value={e.id}>{e.name || '(без названия)'}</option>)}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-3 gap-1">
                <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда за выбор: бронза (монетный режим)">
                  <Coin size={10} /><input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={o.give?.coins ?? 0} onChange={(ev) => updOpt(selNode.id, oi, { give: { ...o.give, coins: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} />
                </label>
                <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда за выбор: минуты">
                  ⏱<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={o.give?.min ?? 0} onChange={(ev) => updOpt(selNode.id, oi, { give: { ...o.give, min: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} />
                </label>
                <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда за выбор: попытки">
                  🎯<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={o.give?.tries ?? 0} onChange={(ev) => updOpt(selNode.id, oi, { give: { ...o.give, tries: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} />
                </label>
              </div>
              <div className="space-y-1">
                <input
                  className="field-in w-full px-1.5 py-0.5 text-[9px]"
                  maxLength={24}
                  placeholder="Ставит флаг (при выборе варианта)"
                  value={o.setFlag ?? ''}
                  onChange={(ev) => updOpt(selNode.id, oi, { setFlag: ev.target.value.trim() || undefined })}
                  title="Флаг ставится игроку при выборе — открывает другие варианты и ветки"
                />
                <div className="flex items-center gap-1">
                  <input
                    className="field-in flex-1 min-w-0 px-1.5 py-0.5 text-[9px]"
                    maxLength={24}
                    placeholder="Виден только при флаге"
                    value={o.reqFlag ?? ''}
                    onChange={(ev) => updOpt(selNode.id, oi, { reqFlag: ev.target.value.trim() || undefined })}
                    title="Вариант виден ТОЛЬКО если флаг стоит (пусто — виден всегда)"
                  />
                  <input
                    className="field-in flex-1 min-w-0 px-1.5 py-0.5 text-[9px]"
                    maxLength={24}
                    placeholder="Скрыт при флаге"
                    value={o.reqNotFlag ?? ''}
                    onChange={(ev) => updOpt(selNode.id, oi, { reqNotFlag: ev.target.value.trim() || undefined })}
                    title="Вариант виден ТОЛЬКО если флага НЕТ (пусто — виден всегда)"
                  />
                </div>
                {(o.reqFlag || o.reqNotFlag) && (
                  <p className="text-[9px] text-magma leading-tight">⚠ Этот вариант скрыт от игроков, пока условие флага не выполнено, — если вариант «пропал», проверьте поля флагов.</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
