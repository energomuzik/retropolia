import { useState } from 'react';
import { uid } from '../db';
import { sfx } from '../sound';
import type { DialogNode, DialogOption, MapEnding, NpcDialog } from '../types';
import { DOOR_KEYS, doorKeyHex } from '../types';
import { Coin } from '../ui';
import { DialogueGraph, tr } from './DialogueGraph';
import type { DlgEditOps, DlgPosMap } from './DialogueGraph';

/* ОБЩИЙ РЕДАКТОР ДЕРЕВА ДИАЛОГОВ NPC (v0.53.0) — ТЕКСТ ПРАВИТСЯ ПРЯМО НА СХЕМЕ.
   Один компонент для редактора карт (окно «Редактор диалогов») и для «Редактора квестов
   и диалогов». Список узлов-плиток УБРАН ещё в v0.51; в v0.52 и текст — на холсте:
   • создать узел: «＋ Узел» в шапке схемы или ДВОЙНОЙ КЛИК по фону (v0.53: нить,
     брошенная на пустое место, больше НЕ создаёт узел — она отменяется);
   • КОНЦОВКИ (v0.53): кнопка «＋ Концовка» в шапке схемы ставит НОВУЮ концовку карты
     прямо из схемы; внизу холста — ВСЕ концовки карты, в любую можно бросить нить;
   • РЕПЛИКА — двойной клик по узлу: поле ввода открывается ВНУТРИ окна узла;
   • ОТВЕТ — клик по строке варианта: правка на месте, на схеме;
   • СОЕДИНИТЬ/РАЗЪЕДИНИТЬ: нить из сокета варианта → на узел (привязать «Далее») или
     на золотую плашку КОНЦОВКИ (назначить концовку); ✕ на середине нити — разъединить;
   • на узле: «＋ ответ», ✕ у варианта, ✕ в шапке узла (ссылки очищаются);
   • клик по узлу выбирает его — панель ниже правит СВОЙСТВА выбранного узла:
     «Далее», концовка, награды, ФЛАГИ (с подсказками, списком флагов карты и
     ПРИМЕРОМ-объяснением), «🚪 отнести к ячейке» у варианта (v0.54: NPC переносит
     игрока на выбранную ячейку), маркеры «🛒 торговля на этом узле» / «📜 квесты
     на этом узле» и ПИН «📌 скрывать, если игрок это уже слышал» (v0.54, наоборот
     к v0.53: по умолчанию реплики пишутся ВСЕГДА, пин — по желанию автора; СТАРТОВЫЙ
     узел пин игнорирует — приветствие NPC пишется всегда). */
export function DialogTreeEditor({ dialog, endings, onChange, posStore, onPosStore, height = 380, selId, onSelect, allFlags = [], cells = [], cutscenes = [], onAddEnding, onDelEnding }: {
  dialog: NpcDialog;
  endings: MapEnding[];
  onChange: (d: NpcDialog) => void;
  posStore?: DlgPosMap;                 // сохранённые позиции узлов (map.dlgPos)
  onPosStore?: (p: DlgPosMap | null) => void; // записать позиции в карту (null — сброс)
  height?: number;                      // высота холста схемы
  selId?: string | null;                // выбранный узел — снаружи (окно NPC продолжает выбор)
  onSelect?: (id: string) => void;
  allFlags?: string[];                  // v0.52: флаги, уже использованные на карте (подсказка в полях)
  cells?: { idx: number; label: string }[]; // v0.54: ячейки карты для «отнести к ячейке» у вариантов
  cutscenes?: { id: string; name: string }[]; // v0.56: кат-сцены карты — вариант диалога может показывать кат-сцену
  onAddEnding?: () => void;             // v0.53: «＋ Концовка» на схеме — новая концовка карты
  onDelEnding?: (id: string) => void;   // v0.53: ✕ на золотой плашке — удалить концовку
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
    /* v0.52: без звуков — вызываются на каждый нажатый символ при правке на схеме */
    setText: (nid, text) => updNode(nid, { text }),
    setOptText: (nid, oi, text) => updOpt(nid, oi, { text }),
    /* v0.53: КОНЦОВКИ ПРЯМО НА СХЕМЕ */
    addEnding: onAddEnding,
    delEnding: onDelEnding,
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

      {/* РЕДАКТИРОВАНИЕ ВЫБРАННОГО УЗЛА: только СВОЙСТВА — текст реплики и ответов
          правится ПРЯМО НА СХЕМЕ (двойной клик по узлу / клик по варианту) */}
      {selNode && (
        <div className="border-2 border-teal/50 px-2 py-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="tick-label text-teal">Узел №{selIdx + 1}{dialog.root === selNode.id ? ' · СТАРТ' : ''} · <span className="text-faint normal-case">реплика — двойной клик по узлу на схеме</span></span>
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
            {/* v0.54 (НАОБОРОТ к v0.53): ПИН — по умолчанию ВСЕ реплики пишутся всегда;
                пин автора СКРЫВАЕТ виденную реплику. СТАРТОВЫЙ узел пин игнорирует. */}
            {dialog.root !== selNode.id ? (
              <label className="flex items-center gap-1 text-[10px] text-gold cursor-pointer" title="По умолчанию реплика пишется ВСЕГДА. С пином реплика, которую игрок уже слышал, схлопывается в «…вы это уже слышали» (кнопка «показать» возвращает текст) — при включённом тумблере игрока «сказанное скрыто».">
                <input type="checkbox" checked={!!selNode.pinHide} onChange={(ev) => updNode(selNode.id, { pinHide: ev.target.checked || undefined })} />
                📌 скрывать, если игрок это уже слышал
              </label>
            ) : (
              <span className="text-[9px] text-faint" title="Стартовое сообщение NPC считается виденным, но пишется ВСЕГДА — пин на нём не действует.">🌱 стартовая реплика пишется всегда</span>
            )}
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
                <span className="tick-label text-faint shrink-0">{oi + 1}. <span className="text-dim normal-case">{o.text ? `«${tr(o.text, 24)}»` : 'текст — клик по строке на схеме'}</span></span>
                <button
                  onClick={() => moveOpt(selNode.id, oi, -1)}
                  disabled={oi === 0}
                  className={`ml-auto px-0.5 text-[10px] cursor-pointer ${oi === 0 ? 'text-edge' : 'text-faint hover:text-teal'}`}
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
              {/* v0.54: NPC ОТНОСИТ игрока к ячейке при выборе варианта (мгновенный перенос, как портал) */}
              {cells.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="tick-label text-teal shrink-0" title="Выбор варианта перенесёт игрока на эту ячейку — NPC «относит» его туда (мгновенный перенос, как через портал)">🚪 отнести к ячейке:</span>
                  <select
                    className="field-in px-1 py-1 text-[10px] flex-1 min-w-[110px]"
                    value={o.tpCell !== undefined ? String(o.tpCell) : ''}
                    onChange={(ev) => updOpt(selNode.id, oi, { tpCell: ev.target.value === '' ? undefined : Math.floor(Number(ev.target.value)) })}
                  >
                    <option value="">— нет —</option>
                    {cells.map((c) => <option key={c.idx} value={c.idx}>{c.label}</option>)}
                  </select>
                </div>
              )}
              {/* v0.56: NPC ПОКАЗЫВАЕТ КАТ-СЦЕНУ при выборе варианта — камера летит по маршруту, мир замерает */}
              {cutscenes.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="tick-label text-magma shrink-0" title="Выбор варианта запускает КАТ-СЦЕНУ (пролёт камеры по точкам карты, все фишки/NPC/боссы стоят)">🎬 показать кат-сцену:</span>
                  <select
                    className="field-in px-1 py-1 text-[10px] flex-1 min-w-[110px]"
                    value={o.cutscene ?? ''}
                    onChange={(ev) => updOpt(selNode.id, oi, { cutscene: ev.target.value === '' ? undefined : ev.target.value })}
                  >
                    <option value="">— нет —</option>
                    {cutscenes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
              {/* v0.55: ЦВЕТНОЙ КЛЮЧ — NPC выдаёт ключ, открывающий дверь того же цвета */}
              <div className="flex items-center gap-1 flex-wrap">
                <span className="tick-label text-[#ffb347] shrink-0" title="При выборе варианта NPC выдаёт ЦВЕТНОЙ КЛЮЧ — фишка с ним проходит через дверь (стену с замком) того же цвета. Ключ не расходуется">🔑 дать ключ:</span>
                <select
                  className="field-in px-1 py-1 text-[10px] flex-1 min-w-[110px]"
                  value={o.give?.key ?? ''}
                  onChange={(ev) => updOpt(selNode.id, oi, { give: { ...o.give, key: (ev.target.value || undefined) as NonNullable<typeof o.give>['key'] } })}
                >
                  <option value="">— не давать —</option>
                  {DOOR_KEYS.map((k) => <option key={k.id} value={k.id}>🔑 {k.name}</option>)}
                </select>
                {o.give?.key && <span className="inline-block w-3 h-3 border border-abyss shrink-0" style={{ background: doorKeyHex(o.give.key) }} />}
              </div>
              {/* ---------- v0.52: ФЛАГИ — ПОДПИСАННО и С ПОДСКАЗКАМИ ---------- */}
              <div className="space-y-1 border-2 border-[rgba(255,179,71,0.35)] px-1.5 py-1.5">
                <div className="text-[9px] text-dim leading-tight">
                  <b className="text-[#ffb347]">🚩 Флаг</b> — метка, которую игрок получает, выбрав вариант. По меткам другие варианты можно ПОКАЗЫВАТЬ или СКРЫВАТЬ: например, вариант «рассказать пароль» виден только после того, как в другом узле игрок его узнал.
                </div>
                <div className="flex items-center gap-1">
                  <span className="tick-label text-[#ffb347] shrink-0 w-[150px]" title="При выборе ЭТОГО варианта игроку ставится флаг с этим именем">🚩 ставит флаг:</span>
                  <input
                    className="field-in flex-1 min-w-0 px-1.5 py-0.5 text-[9px]"
                    maxLength={24}
                    placeholder="имя флага, напр. знает_пароль"
                    list="dlg-flags-list"
                    value={o.setFlag ?? ''}
                    onChange={(ev) => updOpt(selNode.id, oi, { setFlag: ev.target.value.trim() || undefined })}
                    title="При выборе этого варианта игрок получит флаг с этим именем (пусто — не ставит)"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <span className="tick-label text-teal shrink-0 w-[150px]" title="Вариант виден, ТОЛЬКО если флаг уже стоит (пусто — виден всегда)">🔒 показывать только при флаге:</span>
                  <input
                    className="field-in flex-1 min-w-0 px-1.5 py-0.5 text-[9px]"
                    maxLength={24}
                    placeholder="имя флага или пусто — виден всегда"
                    list="dlg-flags-list"
                    value={o.reqFlag ?? ''}
                    onChange={(ev) => updOpt(selNode.id, oi, { reqFlag: ev.target.value.trim() || undefined })}
                    title="Вариант виден ТОЛЬКО если у игрока стоит этот флаг. Пусто — вариант виден всегда."
                  />
                </div>
                <div className="flex items-center gap-1">
                  <span className="tick-label text-coral shrink-0 w-[150px]" title="Вариант исчезает, когда флаг стоит (пусто — виден всегда)">🚫 скрыть при флаге:</span>
                  <input
                    className="field-in flex-1 min-w-0 px-1.5 py-0.5 text-[9px]"
                    maxLength={24}
                    placeholder="имя флага или пусто — виден всегда"
                    list="dlg-flags-list"
                    value={o.reqNotFlag ?? ''}
                    onChange={(ev) => updOpt(selNode.id, oi, { reqNotFlag: ev.target.value.trim() || undefined })}
                    title="Вариант виден ТОЛЬКО пока у игрока НЕТ этого флага (исчезает, когда флаг поставлен). Пусто — вариант виден всегда."
                  />
                </div>
                <datalist id="dlg-flags-list">
                  {allFlags.map((f) => <option key={f} value={f} />)}
                </datalist>
                <p className="text-[8.5px] text-faint leading-tight">Имена флагов подсказываются из уже использованных на карте. «Показывать только при флаге» и «Скрыть при флаге» работают наоборот друг к другу — достаточно одного из двух.</p>
                {/* v0.53: ГОТОВЫЙ ПРИМЕР — объясняет оба флажковых условия на простом сюжете */}
                <details className="text-[8.5px] text-dim leading-tight">
                  <summary className="cursor-pointer hover:text-paper select-none">📖 Пример: флаги на простом сюжете (босс и обиженный NPC)</summary>
                  <div className="mt-1 space-y-1.5 border-l-2 border-[rgba(255,179,71,0.4)] pl-1.5">
                    <p><b className="text-teal">ОТКРЫТЬ реплику после события.</b> Узел «Стражник» — вариант «Я победил босса!» → <b>🚩 ставит флаг: boss_down</b>. У торговца — вариант «А есть что-то особенное?» → <b>🔒 показывать только при флаге: boss_down</b>. Пока игрок не победил босса, вариант у торговца скрыт; победил — появился (например, открывает особый товар или награду).</p>
                    <p><b className="text-coral">СПРЯТАТЬ реплику после события.</b> Вариант «Нагрубить стражнику» → <b>🚩 ставит флаг: obidelsya</b>. У приветствия NPC вариант «Поговорим о деле?» → <b>🚫 скрыть при флаге: obidelsya</b> — после грубости NPC «обиделся» и этот вариант больше не показывает (остаются нейтральные).</p>
                    <p className="text-faint">Флаг ставит ВЫБОР ИГРОКА (вариант с 🚩). Флаги у каждого игрока СВОИ. Имя — любое слово без пробелов (boss_down); одно и то же имя связывает варианты разных узлов и NPC.</p>
                  </div>
                </details>
                {(o.reqFlag || o.reqNotFlag) && (
                  <p className="text-[9px] text-magma leading-tight">⚠ Вариант скрыт от игроков, пока условие флага не выполнено, — если вариант «пропал», проверьте поля флагов выше.</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
