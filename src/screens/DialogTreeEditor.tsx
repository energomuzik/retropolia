import { useState } from 'react';
import { uid } from '../db';
import { sfx } from '../sound';
import type { DialogNode, DialogOption, MapEnding, NpcDialog } from '../types';
import { Coin } from '../ui';
import { DialogueGraph } from './DialogueGraph';
import type { DlgEditOps, DlgPosMap } from './DialogueGraph';

/* ОБЩИЙ РЕДАКТОР ДЕРЕВА ДИАЛОГОВ NPC (v0.51.0) — ВСЁ ДЕЛАЕТСЯ НА СХЕМЕ (граф в духе ComfyUI).
   Один компонент для редактора карт (окно «Редактор диалогов») и для «Редактора квестов
   и диалогов». Список узлов-плиток УБРАН — дерево растит холст:
   • создать узел: «＋ Узел» в шапке схемы, двойной клик по фону или нить из сокета,
     брошенная на пустое место (узел создастся и сразу привяжется);
   • СОЕДИНИТЬ/РАЗЪЕДИНИТЬ: нить из сокета варианта → на узел (привязать «Далее») или
     на золотую плашку КОНЦОВКИ (назначить концовку); ✕ на середине нити — разъединить;
   • на узле: «＋ ответ», ✕ у варианта, ✕ в шапке узла (ссылки очищаются);
   • клик по узлу выбирает его — панель ниже правит текст и свойства выбранного узла:
     реплика, варианты (текст, «Далее», концовка, награды, флаги), маркеры
     «🛒 торговля на этом узле» / «📜 квесты на этом узле» (v0.51 — авто-ветки
     «Можно ли поторговать с тобой?» и «Есть ли для меня работа?» создаются сами
     при добавлении торговли/квеста). */
export function DialogTreeEditor({ dialog, endings, onChange, posStore, onPosStore, height = 380, selId, onSelect }: {
  dialog: NpcDialog;
  endings: MapEnding[];
  onChange: (d: NpcDialog) => void;
  posStore?: DlgPosMap;                 // сохранённые позиции узлов (map.dlgPos)
  onPosStore?: (p: DlgPosMap | null) => void; // записать позиции в карту (null — сброс)
  height?: number;                      // высота холста схемы
  selId?: string | null;                // выбранный узел — снаружи (окно NPC продолжает выбор)
  onSelect?: (id: string) => void;
}) {
  const [selRaw, setSel] = useState<string>('');
  const nodes = dialog.nodes;
  const selFrom = selId !== undefined ? selId : selRaw;
  /* выбранная нода; сбрасывается на стартовую, если удалили текущую */
  const selIdEff = nodes.some((n) => n.id === selFrom) ? selFrom : dialog.root;
  const selIdx = Math.max(0, nodes.findIndex((n) => n.id === selIdEff));
  const selNode = nodes[selIdx];

  const setSelNode = (id: string) => {
    if (selId !== undefined) onSelect?.(id);
    else setSel(id);
    sfx.hover();
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
  const addNode = (at: { x: number; y: number }, linkFrom?: { nodeId: string; optIdx: number }) => {
    const nid = uid('dn');
    onChange({
      ...dialog,
      nodes: nodes
        .map((n) => (linkFrom && n.id === linkFrom.nodeId
          ? { ...n, opts: (n.opts ?? []).map((o, i) => (i === linkFrom.optIdx ? { ...o, next: nid } : o)) }
          : n))
        .concat([{ id: nid, text: '', opts: [] }]),
    });
    /* позиция нового узла сохраняется в карту, чтобы схема запомнила, где его бросили */
    if (onPosStore) onPosStore({ ...(posStore ?? {}), [nid]: { x: Math.max(0, at.x), y: Math.max(0, at.y) } });
    setSelNode(nid);
    sfx.coin();
  };
  const delNode = (nid: string) => {
    const rest = nodes.filter((x) => x.id !== nid);
    if (rest.length === 0) return;
    /* ссылки «Далее:» на удаляемый узел очищаются — висячих ссылок не остаётся */
    const cleaned = rest.map((n) => ({ ...n, opts: (n.opts ?? []).map((o) => (o.next === nid ? { ...o, next: undefined } : o)) }));
    const root = dialog.root === nid ? rest[0].id : dialog.root;
    onChange({ root, nodes: cleaned });
    if (onPosStore && posStore && posStore[nid]) {
      const { [nid]: _drop, ...restPos } = posStore;
      onPosStore(restPos);
    }
    if (selIdEff === nid) setSelNode(root);
    sfx.fail();
  };
  const setRoot = (nid: string) => { onChange({ ...dialog, root: nid }); sfx.hover(); };

  const ops: DlgEditOps = {
    setNext: (nid, oi, next) => { updOpt(nid, oi, { next }); sfx.hover(); },
    setEnding: (nid, oi, ending) => { updOpt(nid, oi, { ending }); sfx.hover(); },
    addNode,
    delNode,
    addOpt,
    delOpt,
  };

  return (
    <div className="space-y-2">
      {/* стартовый узел */}
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
      </div>

      {/* СХЕМА — главная поверхность: создать, соединить, разъединить, удалить */}
      <DialogueGraph
        dialog={dialog}
        endings={endings}
        selId={selIdEff}
        onSelect={setSelNode}
        pos={posStore}
        onPos={onPosStore}
        ops={ops}
        height={height}
        fitKey={dialog.root}
      />

      {/* РЕДАКТИРОВАНИЕ ВЫБРАННОГО УЗЛА (выбор — кликом по узлу на схеме) */}
      {selNode && (
        <div className="border-2 border-teal/50 px-2 py-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="tick-label text-teal">Узел №{selIdx + 1}{dialog.root === selNode.id ? ' · СТАРТ' : ''}</span>
            <div className="flex items-center gap-1">
              {dialog.root !== selNode.id && (
                <button
                  onClick={() => setRoot(selNode.id)}
                  className="text-[10px] text-faint hover:text-gold cursor-pointer px-1"
                  title="Диалог начнётся с этого узла"
                >сделать стартом</button>
              )}
              {nodes.length > 1 && (
                <button
                  onClick={() => delNode(selNode.id)}
                  className="text-[10px] text-faint hover:text-coral cursor-pointer px-1"
                  title="Удалить узел (ссылки на него очистятся автоматически)"
                >удалить узел</button>
              )}
            </div>
          </div>
          <textarea
            className="field-in w-full px-2 py-1 text-[11px] min-h-[42px]"
            maxLength={280}
            placeholder="Реплика NPC (что говорит)…"
            value={selNode.text}
            onChange={(ev) => updNode(selNode.id, { text: ev.target.value })}
          />

          {/* маркеры узла: что показывать игроку, когда диалог дошёл до этого узла */}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1 text-[10px] text-dim cursor-pointer" title="В игре на этом узле появится кнопка «Торговать» (окно торговли). Авто-ветка «Можно ли поторговать с тобой?» ставит маркер сама.">
              <input type="checkbox" checked={!!selNode.showShop} onChange={(ev) => updNode(selNode.id, { showShop: ev.target.checked || undefined })} />
              🛒 торговля на этом узле
            </label>
            <label className="flex items-center gap-1 text-[10px] text-dim cursor-pointer" title="В игре на этом узле появится список квестов NPC со сдачей. Авто-ветка «Есть ли для меня работа?» ставит маркер сама.">
              <input type="checkbox" checked={!!selNode.showQuests} onChange={(ev) => updNode(selNode.id, { showQuests: ev.target.checked || undefined })} />
              📜 квесты на этом узле
            </label>
          </div>

          <div className="flex items-center justify-between gap-1">
            <span className="tick-label text-gold">Варианты ответа ({(selNode.opts ?? []).length})</span>
            <button
              onClick={() => addOpt(selNode.id)}
              className="px-2 py-1 border-2 border-gold/60 text-gold font-display text-[9px] uppercase hover:bg-gold/10 cursor-pointer shrink-0"
            >+ Добавить вариант</button>
          </div>
          {(selNode.opts ?? []).length === 0 && (
            <p className="text-[9px] text-magma leading-tight">Ни одного варианта: диалог закроется сразу после реплики. Добавьте вариант — или прямо на схеме нажмите «＋ ответ» на узле.</p>
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
                    <option key={x.id} value={x.id}>{`№${nodes.findIndex((y) => y.id === x.id) + 1} · ${(x.text || '(пусто)').slice(0, 26)}`}</option>
                  ))}
                </select>
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
