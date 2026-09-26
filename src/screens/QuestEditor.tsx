import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { AnimPreview, GhostBtn, Ic, PxBtn, Stepper } from '../ui';
import { idbPut, uid } from '../db';
import type { DialogNode, DialogOption, GameMap, MapEnding, NpcLibEntry, NpcQuest, NpcShopOffer, PlacedNpc, QuestGoalKind, RubgItemKind } from '../types';
import { isQuestMode, questGoalText, RUBG_ITEMS } from '../types';
import { HoldDeleteButton } from '../delGuard';
import { sfx } from '../sound';

/* РЕДАКТОР КВЕСТОВ И ДИАЛОГОВ (v0.45.0) — отдельный экран «Все редакторы»:
   дерево диалогов, квесты и ТОРГОВЛЯ любого NPC карты + концовки карты — без
   редактора карт (создание дерева диалогов при размещении NPC ОСТАВЛЕНО как было).
   Правки пишутся в карту (IndexedDB «maps») — та же карта, что редактирует MapEditor. */
export default function QuestEditor() {
  const { maps, refresh, toast, setScreen } = useApp();
  const [map, setMap] = useState<GameMap | null>(null);
  const mapRef = useRef<GameMap | null>(null);
  mapRef.current = map;
  const dirtyRef = useRef(false);
  const [tab, setTab] = useState<'npc' | 'ends'>('npc');
  const [selId, setSelId] = useState<string | null>(null);

  /* Автосохранение при уходе с экрана: правки квест-контента не теряются */
  useEffect(() => () => {
    const mm = mapRef.current;
    if (mm && dirtyRef.current) {
      void (async () => {
        await idbPut('maps', mm.id, { ...mm, updatedAt: Date.now() });
        await useApp.getState().refresh();
      })();
    }
  }, []);

  const updMap = (patch: Partial<GameMap>) => {
    dirtyRef.current = true;
    setMap((m) => (m ? { ...m, ...patch } : m));
  };
  const updNpc = (idx: number, patch: Partial<PlacedNpc>) => {
    dirtyRef.current = true;
    setMap((m) => (m ? { ...m, npcs: (m.npcs ?? []).map((n, i) => (i === idx ? { ...n, ...patch } : n)) } : m));
  };
  const updDialog = (idx: number, patch: Partial<NonNullable<PlacedNpc['dialog']>>) =>
    updNpc(idx, { dialog: { ...(map?.npcs?.[idx].dialog ?? { root: '', nodes: [] }), ...patch } });
  const updNode = (idx: number, nid: string, patch: Partial<DialogNode>) => {
    const d = map?.npcs?.[idx].dialog;
    if (!d) return;
    updNpc(idx, { dialog: { ...d, nodes: d.nodes.map((n) => (n.id === nid ? { ...n, ...patch } : n)) } });
  };
  const updOpt = (idx: number, nid: string, oi: number, patch: Partial<DialogOption>) => {
    const d = map?.npcs?.[idx].dialog;
    if (!d) return;
    updNpc(idx, { dialog: { ...d, nodes: d.nodes.map((n) => (n.id === nid ? { ...n, opts: (n.opts ?? []).map((o, k) => (k === oi ? { ...o, ...patch } : o)) } : n)) } });
  };
  const updQuest = (idx: number, qid: string, patch: Partial<NpcQuest>) => {
    const n = map?.npcs?.[idx];
    if (!n) return;
    updNpc(idx, { quests: (n.quests ?? []).map((q) => (q.id === qid ? { ...q, ...patch } : q)) });
  };
  const updShopOffer = (idx: number, oid: string, patch: Partial<NpcShopOffer>) => {
    const n = map?.npcs?.[idx];
    if (!n) return;
    updNpc(idx, { shop: (n.shop ?? []).map((o) => (o.id === oid ? { ...o, ...patch } : o)) });
  };

  const persist = async (silent = false) => {
    const mm = mapRef.current;
    if (!mm) return;
    const next = { ...mm, updatedAt: Date.now() };
    setMap(next);
    mapRef.current = next;
    await idbPut('maps', next.id, next);
    dirtyRef.current = false;
    await refresh();
    if (!silent) { sfx.success(); toast(`Карта «${next.name}» сохранена`, 'ok'); }
  };

  const openMap = (m: GameMap) => {
    const clone: GameMap = JSON.parse(JSON.stringify(m));
    setMap(clone);
    setTab('npc');
    setSelId((clone.npcs ?? [])[0]?.id ?? null);
    dirtyRef.current = false;
    sfx.coin();
  };

  /* ---------- выбор карты ---------- */
  if (!map) {
    return (
      <div className="h-full crt-grid-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="flex items-center gap-4 mb-6">
            <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
            <h1 className="font-display text-2xl uppercase tracking-wider text-gold flex items-center gap-3">
              <span className="text-gold">{Ic.users(22)}</span> Редактор квестов и диалогов
            </h1>
          </div>
          <p className="text-[13px] text-dim mb-5 max-w-2xl">
            Выберите карту: редактируйте ДЕРЕВЬЯ ДИАЛОГОВ, КВЕСТЫ и ТОРГОВЛЮ размещённых NPC, а также КОНЦОВКИ карты —
            отдельным редактором, не открывая редактор карт. NPC размещаются в редакторе карт (панель «🧑 NPC»),
            создаются в «Редакторе анимаций и фишек» (вкладка «NPC»). Диалоги и квесты работают в режиме QUEST.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {maps.map((m) => {
              const nq = (m.npcs ?? []).reduce((a, n) => a + (n.quests ?? []).length, 0);
              const nsh = (m.npcs ?? []).reduce((a, n) => a + (n.shop ?? []).length, 0);
              return (
                <button key={m.id} onClick={() => openMap(m)} className="text-left pixel-panel pixel-corners p-4 transition-transform hover:-translate-y-1 hover:border-edge2 cursor-pointer group">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display uppercase text-paper group-hover:text-gold transition-colors truncate">{m.name}</span>
                    {m.ready ? <span className="tick-label text-teal shrink-0">Готова</span> : <span className="tick-label text-gold shrink-0">В работе</span>}
                  </div>
                  <div className="tick-label text-faint mt-2">
                    🧑 NPC {(m.npcs ?? []).length} · 💬 узлов {(m.npcs ?? []).reduce((a, n) => a + (n.dialog?.nodes.length ?? 0), 0)}
                  </div>
                  <div className="tick-label text-faint mt-1">
                    📜 квестов {nq} · 🛒 товаров {nsh} · 🎬 концовок {(m.endings ?? []).length}
                  </div>
                  <div className="tick-label mt-1" style={{ color: m.mode && isQuestMode(m.mode) ? '#2ee6a8' : '#ff8b3f' }}>
                    {m.mode && isQuestMode(m.mode) ? 'Режим QUEST' : 'Не QUEST — диалоги в игре не работают'}
                  </div>
                </button>
              );
            })}
            {maps.length === 0 && (
              <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-sm col-span-full">
                Сначала создайте карту в редакторе карт.
                <div className="mt-3"><PxBtn color="teal" onClick={() => setScreen('mapEditor')}>{Ic.map(14)} В редактор карт</PxBtn></div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ---------- редактор карты ---------- */
  const npcs = map.npcs ?? [];
  const selIdx = npcs.findIndex((n) => n.id === selId);
  const selNpc = selIdx >= 0 ? npcs[selIdx] : null;
  const libOf = (n: PlacedNpc): NpcLibEntry | undefined => (map.npcLib ?? []).find((x) => x.id === n.nid);
  const questMode = !!map.mode && isQuestMode(map.mode);

  const removeNpc = (nid: string) => {
    updMap({ npcs: (map.npcs ?? []).filter((x) => x.id !== nid) });
    if (selId === nid) setSelId((map.npcs ?? []).find((x) => x.id !== nid)?.id ?? null);
    sfx.fail();
    toast('NPC удалён с карты (Ctrl+Z не вернёт контент диалога)', 'info');
  };

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <GhostBtn onClick={() => { void persist(true); setScreen('menu'); }}>{Ic.back(14)} Меню</GhostBtn>
          <GhostBtn onClick={() => { void persist(true); setScreen('mapEditor'); }}>{Ic.map(14)} В редактор карт</GhostBtn>
          <h1 className="font-display text-lg uppercase tracking-wider text-gold truncate">{map.name}</h1>
          {dirtyRef.current && <span className="tick-label text-gold" title="Есть несохранённые правки">● не сохранено</span>}
          <PxBtn small color="teal" className="ml-auto" onClick={() => void persist()}>{Ic.save(14)} Сохранить</PxBtn>
        </div>

        {!questMode && (
          <p className="text-[11px] text-magma mb-3 border-2 border-magma/40 px-2 py-1.5">
            Карта не в режиме QUEST: диалоги, квесты и концовки работают только в QUEST (переключите режим в верхней панели редактора карт).
          </p>
        )}

        {/* вкладки */}
        <div className="flex items-center gap-2 mb-4">
          {([['npc', `🧑 NPC и диалоги (${npcs.length})`], ['ends', `🎬 Концовки (${(map.endings ?? []).length})`]] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => { setTab(k); sfx.hover(); }}
              className={`px-3 py-1.5 font-display text-[11px] uppercase tracking-wide border-2 cursor-pointer transition-colors ${tab === k ? 'border-gold text-gold bg-gold/10' : 'border-edge text-dim hover:text-paper'}`}
            >{label}</button>
          ))}
        </div>

        {/* ============ ВКЛАДКА NPC: список + диалоги/квесты/торговля ============ */}
        {tab === 'npc' && (
          <div className="flex gap-4 items-start flex-wrap lg:flex-nowrap">
            {/* список NPC */}
            <div className="w-full lg:w-56 shrink-0 space-y-2">
              {npcs.length === 0 && (
                <div className="pixel-corners border-[3px] border-dashed border-edge p-4 text-center text-dim text-[12px]">
                  На карте нет NPC. Разместите их в редакторе карт — левая панель «🧑 NPC», кнопка «Разместить».
                </div>
              )}
              {npcs.map((n, i) => {
                const def = libOf(n);
                const active = n.id === selId;
                return (
                  <button
                    key={n.id}
                    onClick={() => { setSelId(n.id); sfx.hover(); }}
                    className={`w-full text-left pixel-panel pixel-corners px-2.5 py-2 flex items-center gap-2 cursor-pointer transition-colors ${active ? 'border-gold' : 'hover:border-edge2'}`}
                  >
                    <span className="w-9 h-9 shrink-0 flex items-center justify-center border-2 border-edge" style={{ background: 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 8px 8px' }}>
                      <AnimPreview frames={def?.idle.frames ?? []} fps={def?.idle.fps} size={28} />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-display text-[11px] uppercase text-paper truncate">{def?.name ?? `NPC ${i + 1}`}</span>
                      <span className="block tick-label text-faint">💬 {n.dialog?.nodes.length ?? 0} · 📜 {(n.quests ?? []).length} · 🛒 {(n.shop ?? []).length}</span>
                    </span>
                  </button>
                );
              })}
              <p className="text-[10px] text-faint leading-tight px-1">💬 узлов диалога · 📜 квестов · 🛒 товаров</p>
            </div>

            {/* редактор выбранного NPC */}
            {selNpc && selIdx >= 0 && (
              <div className="flex-1 min-w-[300px] space-y-4">
                <div className="pixel-panel pixel-corners p-3.5 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display uppercase text-[13px] text-teal truncate">🧑 {libOf(selNpc)?.name ?? 'NPC'}</span>
                    <HoldDeleteButton
                      onFire={() => removeNpc(selNpc.id)}
                      label={`NPC «${libOf(selNpc)?.name ?? '?'}» с карты`}
                      ariaLabel="Удалить NPC с карты"
                      title="Удалить NPC с карты"
                      className="py-1 px-2 border-2 border-coral/60 text-coral font-display text-[10px] uppercase hover:bg-coral/10 transition-colors cursor-pointer shrink-0"
                    >Удалить</HoldDeleteButton>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-12 h-12 shrink-0 flex items-center justify-center border-2 border-edge" style={{ background: 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 10px 10px' }}>
                      <AnimPreview frames={libOf(selNpc)?.idle.frames ?? []} fps={libOf(selNpc)?.idle.fps} size={40} />
                    </div>
                    <div className="text-[10px] text-dim">
                      Радиус звука и диалога: {Math.round(selNpc.r ?? 0)} px · размер {Math.round(selNpc.w)}×{Math.round(selNpc.h)} px
                      <div className="text-faint">Геометрию и радиус меняйте в редакторе карт (клик по NPC).</div>
                    </div>
                  </div>

                  {/* ---------- ДЕРЕВО ДИАЛОГОВ ---------- */}
                  <div className="border-2 border-edge px-2 py-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="tick-label text-gold">💬 Дерево диалогов</span>
                      {selNpc.dialog && (
                        <button
                          onClick={() => { updNpc(selIdx, { dialog: undefined }); sfx.fail(); }}
                          title="Удалить диалог целиком"
                          className="text-[10px] text-faint hover:text-coral cursor-pointer px-1"
                        >удалить</button>
                      )}
                    </div>
                    {!selNpc.dialog ? (
                      <button
                        onClick={() => { const nid = uid('dn'); updNpc(selIdx, { dialog: { root: nid, nodes: [{ id: nid, text: 'Приветствую, путник…', opts: [] }] } }); sfx.coin(); }}
                        className="w-full py-1.5 border-2 border-dashed border-edge text-faint font-display text-[10px] uppercase hover:text-paper cursor-pointer"
                      >+ Создать диалог</button>
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5">
                          <span className="tick-label text-faint shrink-0">Старт:</span>
                          <select
                            className="field-in flex-1 min-w-0 px-1.5 py-1 text-[10px]"
                            value={selNpc.dialog.root}
                            onChange={(ev) => updDialog(selIdx, { root: ev.target.value })}
                          >
                            {selNpc.dialog.nodes.map((n) => (
                              <option key={n.id} value={n.id}>{(n.text || '(пусто)').slice(0, 30)}</option>
                            ))}
                          </select>
                        </div>
                        {selNpc.dialog.nodes.map((nd) => (
                          <div key={nd.id} className="border-2 border-edge px-2 py-1.5 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="tick-label text-faint">Узел {nd.id.slice(-4)}{selNpc.dialog!.root === nd.id ? ' · СТАРТ' : ''}</span>
                              {selNpc.dialog!.nodes.length > 1 && (
                                <button
                                  onClick={() => { const d = selNpc.dialog!; const nodes = d.nodes.filter((x) => x.id !== nd.id); updNpc(selIdx, { dialog: { root: d.root === nd.id ? nodes[0].id : d.root, nodes } }); sfx.fail(); }}
                                  className="text-[10px] text-faint hover:text-coral cursor-pointer"
                                >удалить</button>
                              )}
                            </div>
                            <textarea
                              className="field-in w-full px-2 py-1 text-[11px] min-h-[42px]"
                              maxLength={280}
                              placeholder="Реплика NPC…"
                              value={nd.text}
                              onChange={(ev) => updNode(selIdx, nd.id, { text: ev.target.value })}
                            />
                            {(nd.opts ?? []).map((o, oi) => (
                              <div key={oi} className="border-2 border-edge px-1.5 py-1.5 space-y-1 bg-[rgba(7,9,18,0.5)]">
                                <div className="flex items-center gap-1">
                                  <span className="tick-label text-faint shrink-0">{oi + 1}.</span>
                                  <input className="field-in flex-1 min-w-0 px-1.5 py-1 text-[11px]" maxLength={80} placeholder="Ответ игрока…" value={o.text} onChange={(ev) => updOpt(selIdx, nd.id, oi, { text: ev.target.value })} />
                                  <button onClick={() => { updNode(selIdx, nd.id, { opts: (nd.opts ?? []).filter((_, k) => k !== oi) }); sfx.fail(); }} className="text-faint hover:text-coral cursor-pointer px-0.5 text-[10px]">✕</button>
                                </div>
                                <div className="flex items-center gap-1 flex-wrap">
                                  <span className="tick-label text-faint shrink-0">Далее:</span>
                                  <select className="field-in px-1 py-1 text-[10px] flex-1 min-w-[120px]" value={o.next ?? ''} onChange={(ev) => updOpt(selIdx, nd.id, oi, { next: ev.target.value || undefined })}>
                                    <option value="">— конец диалога —</option>
                                    {selNpc.dialog!.nodes.filter((x) => x.id !== nd.id).map((x) => (
                                      <option key={x.id} value={x.id}>{(x.text || '(пусто)').slice(0, 24)}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="flex items-center gap-1 flex-wrap">
                                  <span className="tick-label text-faint shrink-0">Концовка:</span>
                                  <select className="field-in px-1 py-1 text-[10px] flex-1 min-w-[120px]" value={o.ending ?? ''} onChange={(ev) => updOpt(selIdx, nd.id, oi, { ending: ev.target.value || undefined })}>
                                    <option value="">— нет —</option>
                                    {(map.endings ?? []).map((e) => <option key={e.id} value={e.id}>{e.name || '(без названия)'}</option>)}
                                  </select>
                                </div>
                                <div className="grid grid-cols-3 gap-1">
                                  <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда: бронза (монетный режим)">🪙<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={o.give?.coins ?? 0} onChange={(ev) => updOpt(selIdx, nd.id, oi, { give: { ...o.give, coins: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} /></label>
                                  <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда: минуты">⏱<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={o.give?.min ?? 0} onChange={(ev) => updOpt(selIdx, nd.id, oi, { give: { ...o.give, min: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} /></label>
                                  <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда: попытки">🎯<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={o.give?.tries ?? 0} onChange={(ev) => updOpt(selIdx, nd.id, oi, { give: { ...o.give, tries: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} /></label>
                                </div>
                                <div className="flex items-center gap-1 flex-wrap">
                                  <input className="field-in w-[86px] px-1 py-0.5 text-[9px]" placeholder="ставит флаг" value={o.setFlag ?? ''} onChange={(ev) => updOpt(selIdx, nd.id, oi, { setFlag: ev.target.value.trim() || undefined })} title="Флаг ставится игроку при выборе (влияет на другие ветки)" />
                                  <input className="field-in w-[86px] px-1 py-0.5 text-[9px]" placeholder="нужен флаг" value={o.reqFlag ?? ''} onChange={(ev) => updOpt(selIdx, nd.id, oi, { reqFlag: ev.target.value.trim() || undefined })} title="Вариант виден ТОЛЬКО если флаг стоит" />
                                  <input className="field-in w-[86px] px-1 py-0.5 text-[9px]" placeholder="без флага" value={o.reqNotFlag ?? ''} onChange={(ev) => updOpt(selIdx, nd.id, oi, { reqNotFlag: ev.target.value.trim() || undefined })} title="Вариант виден ТОЛЬКО если флага НЕТ" />
                                </div>
                              </div>
                            ))}
                            <button
                              onClick={() => { updNode(selIdx, nd.id, { opts: [...(nd.opts ?? []), { text: '' }] }); sfx.coin(); }}
                              className="w-full py-1 border-2 border-dashed border-edge text-faint font-pixel text-[8px] uppercase hover:text-paper cursor-pointer"
                            >+ вариант ответа</button>
                          </div>
                        ))}
                        <button
                          onClick={() => { const nid = uid('dn'); updDialog(selIdx, { nodes: [...selNpc.dialog!.nodes, { id: nid, text: '', opts: [] }] }); sfx.coin(); }}
                          className="w-full py-1 border-2 border-dashed border-edge text-faint font-display text-[10px] uppercase hover:text-paper cursor-pointer"
                        >+ узел диалога</button>
                      </>
                    )}
                  </div>

                  {/* ---------- КВЕСТЫ NPC ---------- */}
                  <div className="border-2 border-edge px-2 py-2 space-y-2">
                    <span className="tick-label text-gold">📜 Квесты NPC ({(selNpc.quests ?? []).length})</span>
                    {(selNpc.quests ?? []).map((q) => (
                      <div key={q.id} className="border-2 border-edge px-2 py-1.5 space-y-1.5">
                        <div className="flex items-center gap-1">
                          <input className="field-in flex-1 min-w-0 px-1.5 py-1 text-[11px]" maxLength={40} placeholder="Название квеста" value={q.title} onChange={(ev) => updQuest(selIdx, q.id, { title: ev.target.value })} />
                          <button onClick={() => { updNpc(selIdx, { quests: (selNpc.quests ?? []).filter((x) => x.id !== q.id) }); sfx.fail(); }} className="text-faint hover:text-coral cursor-pointer px-0.5 text-[10px]">✕</button>
                        </div>
                        <textarea className="field-in w-full px-2 py-1 text-[11px] min-h-[36px]" maxLength={200} placeholder="Описание квеста (что нужно сделать)" value={q.desc} onChange={(ev) => updQuest(selIdx, q.id, { desc: ev.target.value })} />
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="tick-label text-faint shrink-0">Условие:</span>
                          <select
                            className="field-in px-1 py-1 text-[10px]"
                            value={q.goal.kind}
                            onChange={(ev) => { const k = ev.target.value as QuestGoalKind; updQuest(selIdx, q.id, { goal: k === 'deliver' ? { kind: k, res: 'coins', count: 500 } : { kind: k, count: k === 'tasks' ? 3 : k === 'coins' ? 500 : k === 'hp' ? 100 : k === 'time' ? 900 : 10, bossId: (map.bosses ?? [])[0]?.id } }); }}
                          >
                            <option value="none">без условия</option>
                            <option value="boss">победить босса</option>
                            <option value="tasks">победить N заданий</option>
                            <option value="coins">собрать монет</option>
                            <option value="hp">иметь HP %</option>
                            <option value="time">запас времени, сек</option>
                            <option value="tries">запас попыток</option>
                            <option value="deliver">принести/отдать ресурсы</option>
                          </select>
                          {q.goal.kind === 'boss' && (
                            <select className="field-in px-1 py-1 text-[10px]" value={q.goal.bossId ?? ''} onChange={(ev) => updQuest(selIdx, q.id, { goal: { ...q.goal, bossId: ev.target.value } })}>
                              {(map.bosses ?? []).length === 0 && <option value="">нет боссов</option>}
                              {(map.bosses ?? []).map((b) => {
                                const bd = (map.bossLib ?? []).find((x) => x.id === b.bid);
                                return <option key={b.id} value={b.id}>{bd?.name ?? b.id}</option>;
                              })}
                            </select>
                          )}
                          {q.goal.kind === 'deliver' && (
                            <select className="field-in px-1 py-1 text-[10px]" value={q.goal.res ?? 'coins'} onChange={(ev) => updQuest(selIdx, q.id, { goal: { ...q.goal, res: ev.target.value as 'coins' | 'time' | 'tries' | 'hp' } })}>
                              <option value="coins">монеты, бронза</option>
                              <option value="time">время, сек</option>
                              <option value="tries">попытки</option>
                              <option value="hp">HP %</option>
                            </select>
                          )}
                          {q.goal.kind !== 'boss' && q.goal.kind !== 'none' && (
                            <Stepper value={q.goal.count ?? 1} onChange={(v) => updQuest(selIdx, q.id, { goal: { ...q.goal, count: v } })} min={1} max={99999} step={q.goal.kind === 'coins' || (q.goal.kind === 'deliver' && (q.goal.res ?? 'coins') === 'coins') ? 25 : 1} />
                          )}
                        </div>
                        <p className="text-[9px] text-teal leading-tight">{questGoalText(q.goal, map)}{q.goal.kind === 'deliver' ? ' — при сдаче ресурс УЙДЁТ NPC из капитала игрока' : ''}</p>
                        <div className="grid grid-cols-3 gap-1">
                          <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда: бронза">🪙<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={q.reward.coins ?? 0} onChange={(ev) => updQuest(selIdx, q.id, { reward: { ...q.reward, coins: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} /></label>
                          <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда: минуты">⏱<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={q.reward.min ?? 0} onChange={(ev) => updQuest(selIdx, q.id, { reward: { ...q.reward, min: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} /></label>
                          <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда: попытки">🎯<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={q.reward.tries ?? 0} onChange={(ev) => updQuest(selIdx, q.id, { reward: { ...q.reward, tries: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} /></label>
                        </div>
                        {(map.walls ?? []).filter((w) => w.id).length > 0 && (
                          <div className="space-y-1">
                            <span className="tick-label text-faint">Снять стены при выполнении:</span>
                            {(map.walls ?? []).map((w, wi) => w.id && (
                              <label key={w.id} className="flex items-center gap-1.5 text-[10px] text-dim cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={(q.removeWalls ?? []).includes(w.id!)}
                                  onChange={(ev) => updQuest(selIdx, q.id, { removeWalls: ev.target.checked ? [...(q.removeWalls ?? []), w.id!] : (q.removeWalls ?? []).filter((x) => x !== w.id) })}
                                />
                                стена №{wi + 1} ({Math.round(w.w)}×{Math.round(w.h)})
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    <button
                      onClick={() => { updNpc(selIdx, { quests: [...(selNpc.quests ?? []), { id: uid('qst'), title: 'НОВЫЙ КВЕСТ', desc: '', goal: { kind: 'tasks', count: 3 }, reward: {} }] }); sfx.coin(); }}
                      className="w-full py-1.5 border-2 border-dashed border-edge text-faint font-display text-[10px] uppercase hover:text-paper cursor-pointer"
                    >+ добавить квест</button>
                    <p className="text-[10px] text-faint leading-tight">Выполнив условие, игрок приходит к NPC и сдаёт квест в диалоге: получает награду; назначенные стены ИСЧЕЗАЮТ с карты для всех.</p>
                  </div>

                  {/* ---------- ТОРГОВЛЯ NPC ---------- */}
                  <div className="border-2 border-[#ffcf3f]/40 px-2 py-2 space-y-2">
                    <span className="tick-label text-gold">🛒 Торговля ({(selNpc.shop ?? []).length})</span>
                    {(selNpc.shop ?? []).map((off) => (
                      <div key={off.id} className="border-2 border-edge px-2 py-1.5 space-y-1.5">
                        <div className="flex items-center gap-1">
                          <select
                            className="field-in flex-1 min-w-0 px-1 py-1 text-[10px]"
                            value={off.kind}
                            onChange={(ev) => {
                              const k = ev.target.value as NpcShopOffer['kind'];
                              updShopOffer(selIdx, off.id, k === 'item' ? { kind: k, item: off.item ?? 'medkit' } : { kind: k, res: off.res ?? 'time', amount: off.amount ?? 5 });
                            }}
                          >
                            <option value="item">вещь (каталог предметов)</option>
                            <option value="res">ресурс</option>
                          </select>
                          <button onClick={() => { updNpc(selIdx, { shop: (selNpc.shop ?? []).filter((x) => x.id !== off.id) }); sfx.fail(); }} className="text-faint hover:text-coral cursor-pointer px-0.5 text-[10px]">✕</button>
                        </div>
                        {off.kind === 'item' ? (
                          <select className="field-in w-full px-1 py-1 text-[10px]" value={off.item ?? 'medkit'} onChange={(ev) => updShopOffer(selIdx, off.id, { item: ev.target.value as RubgItemKind })}>
                            {Object.entries(RUBG_ITEMS).map(([k, m]) => <option key={k} value={k}>{m.icon} {m.name}</option>)}
                          </select>
                        ) : (
                          <div className="flex items-center gap-1 flex-wrap">
                            <select className="field-in px-1 py-1 text-[10px]" value={off.res ?? 'time'} onChange={(ev) => updShopOffer(selIdx, off.id, { res: ev.target.value as 'time' | 'tries' | 'hp' })}>
                              <option value="time">время, мин</option>
                              <option value="tries">попытки</option>
                              <option value="hp">HP %</option>
                            </select>
                            <Stepper value={off.amount ?? 5} onChange={(v) => updShopOffer(selIdx, off.id, { amount: v })} min={1} max={99999} step={(off.res ?? 'time') === 'hp' ? 5 : 1} />
                          </div>
                        )}
                        <input className="field-in w-full px-1.5 py-1 text-[10px]" maxLength={40} placeholder="Своё название (необязательно)" value={off.title ?? ''} onChange={(ev) => updShopOffer(selIdx, off.id, { title: ev.target.value || undefined })} />
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[9px] text-dim shrink-0">Цена:</span>
                          <Stepper value={off.price ?? 0} onChange={(v) => updShopOffer(selIdx, off.id, { price: v })} min={0} max={99999} step={5} suffix=" бр" />
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => { updNpc(selIdx, { shop: [...(selNpc.shop ?? []), { id: uid('shp'), kind: 'item', item: 'medkit', price: 50 }] }); sfx.coin(); }}
                      className="w-full py-1.5 border-2 border-dashed border-edge text-faint font-display text-[10px] uppercase hover:text-paper cursor-pointer"
                    >+ добавить товар</button>
                    <p className="text-[9px] text-faint leading-tight">Игроки покупают за монеты в диалоге NPC. Работает, когда на карте включён ресурс «монеты» (Ресурс игроков → Монеты). Вещи падают в инвентарь (рюкзак), ресурс — сразу в капитал.</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============ ВКЛАДКА КОНЦОВКИ ============ */}
        {tab === 'ends' && (
          <div className="max-w-xl space-y-2">
            <p className="text-[11px] text-faint leading-tight">Финальные условия победы в QUEST: кто ПЕРВЫЙ выполнит условие любой концовки — тот победил (его концовка и показывается). Концовка БЕЗ условия достигается только ВЫБОРОМ игрока в диалоге NPC (вариант ответа → «Концовка»). Условие поражения по умолчанию — истощение ресурсов; можно добавить лимит провалов.</p>
            {(map.endings ?? []).map((e, ei) => (
              <div key={e.id} className="border-2 border-edge px-2 py-2 space-y-1.5 pixel-panel pixel-corners">
                <div className="flex items-center gap-1.5">
                  <span className="font-display text-[10px] text-gold shrink-0">#{ei + 1}</span>
                  <input className="field-in flex-1 min-w-0 px-2 py-1 text-[11px]" maxLength={28} value={e.name} placeholder="НАЗВАНИЕ КОНЦОВКИ" onChange={(ev) => { const ends = [...(map.endings ?? [])]; ends[ei] = { ...e, name: ev.target.value.toUpperCase() }; updMap({ endings: ends }); }} />
                  <button onClick={() => { updMap({ endings: (map.endings ?? []).filter((x) => x.id !== e.id) }); sfx.fail(); }} title="Удалить концовку" className="text-faint hover:text-coral cursor-pointer px-1">✕</button>
                </div>
                <input className="field-in w-full px-2 py-1 text-[11px]" maxLength={140} value={e.desc} placeholder="Описание концовки (покажется на экране победы)" onChange={(ev) => { const ends = [...(map.endings ?? [])]; ends[ei] = { ...e, desc: ev.target.value }; updMap({ endings: ends }); }} />
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="tick-label text-faint shrink-0">Условие:</span>
                  <select
                    className="field-in px-1.5 py-1 text-[10px]"
                    value={e.goal?.kind ?? 'none'}
                    onChange={(ev) => { const ends = [...(map.endings ?? [])]; const k = ev.target.value as QuestGoalKind; ends[ei] = { ...e, goal: k === 'none' ? undefined : { kind: k, count: k === 'tasks' ? 3 : k === 'coins' ? 500 : k === 'hp' ? 100 : k === 'time' ? 900 : 10, bossId: (map.bosses ?? [])[0]?.id } }; updMap({ endings: ends }); }}
                  >
                    <option value="none">только через диалог NPC</option>
                    <option value="boss">победить босса</option>
                    <option value="tasks">победить N заданий</option>
                    <option value="coins">собрать монет</option>
                    <option value="hp">иметь HP %</option>
                    <option value="time">запас времени, сек</option>
                    <option value="tries">запас попыток</option>
                  </select>
                  {e.goal && e.goal.kind === 'boss' && (
                    <select
                      className="field-in px-1.5 py-1 text-[10px]"
                      value={e.goal.bossId ?? ''}
                      onChange={(ev) => { const ends = [...(map.endings ?? [])]; ends[ei] = { ...e, goal: { ...e.goal!, bossId: ev.target.value } }; updMap({ endings: ends }); }}
                    >
                      {(map.bosses ?? []).length === 0 && <option value="">нет боссов на карте</option>}
                      {(map.bosses ?? []).map((b) => {
                        const bd = (map.bossLib ?? []).find((x) => x.id === b.bid);
                        return <option key={b.id} value={b.id}>{bd?.name ?? b.id}</option>;
                      })}
                    </select>
                  )}
                  {e.goal && e.goal.kind !== 'boss' && (
                    <Stepper value={e.goal.count ?? 1} onChange={(v) => { const ends = [...(map.endings ?? [])]; ends[ei] = { ...e, goal: { ...e.goal!, count: v } }; updMap({ endings: ends }); }} min={1} max={99999} step={e.goal.kind === 'coins' ? 25 : 1} />
                  )}
                </div>
                <p className="text-[9px] text-faint leading-tight">{questGoalText(e.goal, map)}</p>
              </div>
            ))}
            <button
              onClick={() => { updMap({ endings: [...(map.endings ?? []), { id: uid('end'), name: `КОНЦОВКА ${(map.endings ?? []).length + 1}`, desc: '' }] }); sfx.coin(); }}
              className="w-full py-1.5 border-2 border-dashed border-edge text-faint font-display text-[10px] uppercase hover:text-paper cursor-pointer"
            >+ Добавить концовку</button>
            <div className="flex items-center justify-between border-2 border-edge px-2 py-1.5 pixel-panel pixel-corners">
              <span className="text-[10px] text-dim">Поражение при N провалах заданий</span>
              <Stepper value={map.questDefeatFails ?? 0} onChange={(v) => updMap({ questDefeatFails: v })} min={0} max={99} />
            </div>
            <p className="text-[9px] text-faint leading-tight">0 — только истощение ресурсов. Иначе игрок вылетает, когда провалит (или проиграет) столько заданий.</p>
          </div>
        )}
      </div>
    </div>
  );
}
