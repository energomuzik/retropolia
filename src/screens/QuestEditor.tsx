import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { AnimPreview, GhostBtn, Ic, PxBtn, Stepper, Coin } from '../ui';
import { DialogTreeEditor } from './DialogTreeEditor';
import { QuestMapGraph } from './DialogueGraph';
import type { DlgEditOpsMap } from './DialogueGraph';
import { TradeShopEditor } from './TradeEditor';
import { allDlgFlags, ensureQuestDialog, ensureShopDialog } from '../dialogHubs';
import { idbPut, uid } from '../db';
import type { GameMap, MapEnding, NpcDialog, NpcLibEntry, NpcQuest, PlacedNpc, QuestGoal, QuestGoalKind } from '../types';
import { isQuestMode, questGoalText, DOOR_KEYS } from '../types';
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
  const [tab, setTab] = useState<'npc' | 'ends' | 'map'>('npc');
  const [selId, setSelId] = useState<string | null>(null);
  const [dlgWinOpen, setDlgWinOpen] = useState(false); // v0.51: окно «Редактор диалогов» NPC (всё на схеме)
  const [tradeWinOpen, setTradeWinOpen] = useState(false); // v0.51: окно «Витрина торговца»
  const [selEnding, setSelEnding] = useState<string | null>(null); // v0.51: выбранная концовка на схеме карты

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
  const updQuest = (idx: number, qid: string, patch: Partial<NpcQuest>) => {
    const n = map?.npcs?.[idx];
    if (!n) return;
    updNpc(idx, { quests: (n.quests ?? []).map((q) => (q.id === qid ? { ...q, ...patch } : q)) });
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
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {([['npc', `🧑 NPC и диалоги (${npcs.length})`], ['ends', `🎬 Концовки (${(map.endings ?? []).length})`], ['map', '🗺 Схема карты']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => { setTab(k); sfx.hover(); }}
              className={`px-3 py-1.5 font-display text-[11px] uppercase tracking-wide border-2 cursor-pointer transition-colors ${tab === k ? 'border-gold text-gold bg-gold/10' : 'border-edge text-dim hover:text-paper'}`}
              title={k === 'map' ? 'Общая схема: все NPC, деревья диалогов, квесты и концовки на одном холсте — как влияют ответы' : undefined}
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

                  {/* ---------- ДИАЛОГИ (v0.51): всё на схеме в большом окне ---------- */}
                  <div className="border-2 border-edge px-2 py-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="tick-label text-gold">💬 Диалоги{selNpc.dialog ? ` · ${selNpc.dialog.nodes.length} узл.` : ''}</span>
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
                        onClick={() => { const nid = uid('dn'); updNpc(selIdx, { dialog: { root: nid, nodes: [{ id: nid, text: 'Приветствую, путник…', opts: [] }] } }); sfx.coin(); setDlgWinOpen(true); }}
                        className="w-full py-1.5 border-2 border-dashed border-edge text-faint font-display text-[10px] uppercase hover:text-paper cursor-pointer"
                      >+ Создать диалог</button>
                    ) : (
                      <button
                        onClick={() => { setDlgWinOpen(true); sfx.click(); }}
                        title="Большое окно со схемой дерева диалогов ЭТОГО NPC: создавайте узлы, соединяйте и разъединяйте нити прямо на схеме"
                        className="w-full py-2 border-2 border-teal bg-teal/10 text-teal font-display text-[11px] uppercase tracking-wide hover:bg-teal/20 cursor-pointer"
                      >💬 Редактор диалогов</button>
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
                            onChange={(ev) => { const k = ev.target.value as QuestGoalKind; updQuest(selIdx, q.id, { goal: k === 'deliver' ? { kind: k, res: 'coins', count: 500 } : { kind: k, count: k === 'tasks' ? 3 : k === 'bosses' ? 1 : k === 'coins' ? 500 : k === 'hp' ? 100 : k === 'time' ? 900 : 10, bossId: (map.bosses ?? [])[0]?.id } }); }}
                          >
                            <option value="boss">победить босса (конкретного)</option>
                            <option value="bosses">победить N боссов (любых)</option>
                            <option value="tasks">победить N заданий</option>
                            <option value="coins">собрать монет</option>
                            <option value="hp">иметь HP %</option>
                            <option value="time">запас времени, мин</option>
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
                          {q.goal.kind !== 'boss' && q.goal.kind !== 'none' && ((q.goal.kind === 'time' || (q.goal.kind === 'deliver' && (q.goal.res ?? 'coins') === 'time')) ? (
                            /* ВРЕМЯ — счётчик в МИНУТАХ (в данных по-прежнему секунды) */
                            <Stepper value={Math.max(1, Math.round((q.goal.count ?? 60) / 60))} onChange={(v) => updQuest(selIdx, q.id, { goal: { ...q.goal, count: Math.max(1, v) * 60 } })} min={1} max={180} step={1} suffix=" мин" />
                          ) : (
                            <Stepper value={q.goal.count ?? 1} onChange={(v) => updQuest(selIdx, q.id, { goal: { ...q.goal, count: v } })} min={1} max={99999} step={q.goal.kind === 'coins' || (q.goal.kind === 'deliver' && (q.goal.res ?? 'coins') === 'coins') ? 25 : 1} />
                          ))}
                        </div>
                        <p className="text-[9px] text-teal leading-tight">{questGoalText(q.goal, map)}{q.goal.kind === 'deliver' ? ' — при сдаче ресурс УЙДЁТ NPC из капитала игрока' : ''}</p>
                        {q.goal.kind === 'boss' && (map.bosses ?? []).length === 0 && (
                          <p className="text-[9px] text-magma leading-tight">⚠ На карте нет ни одного босса — цель невыполнима. Добавьте босса в редакторе карт (панель «👹 Боссы») или выберите другую цель.</p>
                        )}
                        {q.goal.kind === 'coins' && map.startCoins === undefined && (
                          <p className="text-[9px] text-magma leading-tight">⚠ Монеты на карте не включены — цель невыполнима. Включите: редактор карт → «Ресурс игроков» → «Монеты».</p>
                        )}
                        {q.goal.kind === 'hp' && map.resMode !== 'hp' && (
                          <p className="text-[9px] text-magma leading-tight">⚠ Ресурс карты — не полоска HP: у игроков всегда 100% HP, цель выполнится сразу. Для осмысленной цели включите ресурс «Полоска HP».</p>
                        )}
                        <div className="grid grid-cols-3 gap-1">
                          <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда: бронза"><Coin size={10} /><input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={q.reward.coins ?? 0} onChange={(ev) => updQuest(selIdx, q.id, { reward: { ...q.reward, coins: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} /></label>
                          <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда: минуты">⏱<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={q.reward.min ?? 0} onChange={(ev) => updQuest(selIdx, q.id, { reward: { ...q.reward, min: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} /></label>
                          <label className="flex items-center gap-1 text-[9px] text-dim" title="Награда: попытки">🎯<input type="number" className="field-in w-full px-1 py-0.5 text-[10px]" min={0} value={q.reward.tries ?? 0} onChange={(ev) => updQuest(selIdx, q.id, { reward: { ...q.reward, tries: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } })} /></label>
                          {/* v0.55: ЦВЕТНОЙ КЛЮЧ в награде квеста */}
                          <select className="field-in px-1 py-0.5 text-[10px]" title="Награда: цветной ключ — открывает дверь того же цвета (не расходуется)" value={q.reward.key ?? ''} onChange={(ev) => updQuest(selIdx, q.id, { reward: { ...q.reward, key: (ev.target.value || undefined) as NonNullable<typeof q.reward>['key'] } })}>
                            <option value="">🔑 нет</option>
                            {DOOR_KEYS.map((k) => <option key={k.id} value={k.id}>🔑 {k.name}</option>)}
                          </select>
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
                      onClick={() => {
                        /* v0.51: квестов — СКОЛЬКО УГОДНО; новый квест растит ветку «Есть ли для меня работа?» */
                        const q: NpcQuest = { id: uid('qst'), title: 'НОВЫЙ КВЕСТ', desc: '', goal: { kind: 'tasks', count: 3 }, reward: {} };
                        const next = ensureQuestDialog({ ...selNpc, quests: [...(selNpc.quests ?? []), q] });
                        updNpc(selIdx, next);
                        sfx.coin();
                      }}
                      className="w-full py-1.5 border-2 border-dashed border-edge text-faint font-display text-[10px] uppercase hover:text-paper cursor-pointer"
                    >+ добавить квест</button>
                    <p className="text-[10px] text-faint leading-tight">Квестов — сколько угодно; добавление выращивает в диалоге ветку «Есть ли для меня работа?». Выполнив условие, игрок приходит к NPC и сдаёт квест: получает награду; назначенные стены ИСЧЕЗАЮТ с карты для всех.</p>
                  </div>

                  {/* ---------- ТОРГОВЛЯ NPC (v0.51): витрина в большом окне ---------- */}
                  <div className="border-2 border-[#ffcf3f]/40 px-2 py-2 space-y-2">
                    <span className="tick-label text-gold">🛒 Торговля{selNpc.shop ? ` · ${(selNpc.shop).length} товар.` : ''}</span>
                    <button
                      onClick={() => {
                        if (!selNpc.shop) {
                          updNpc(selIdx, ensureShopDialog({ ...selNpc, shop: [{ id: uid('shp'), kind: 'item', item: 'medkit', price: 50 }] }));
                        }
                        setTradeWinOpen(true);
                        sfx.click();
                      }}
                      title="Окно витрины: предметы и их количество на полке, касса торговца для выкупа и скидки за выполненные квесты"
                      className="w-full py-2 border-2 border-[#ffcf3f] bg-[#ffcf3f]/10 text-[#ffcf3f] font-display text-[11px] uppercase tracking-wide hover:bg-[#ffcf3f]/20 cursor-pointer"
                    >{selNpc.shop ? '🏪 Витрина торговца' : '+ Добавить торговлю'}</button>
                    <p className="text-[9px] text-faint leading-tight">Витрина: товары с ценой и количеством, КАССА (выкуп вещей игрока) и СКИДКИ за квесты. В игре — окно из трёх окон: товары / сделка / рюкзак. Нужен ресурс «Монеты».</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============ ВКЛАДКА СХЕМА КАРТЫ (v0.51): РЕДАКТИРУЕМЫЙ граф как в ComfyUI ============ */}
        {tab === 'map' && (() => {
          /* операции на общей схеме: нити «Далее», концовки, узлы — всё правится здесь */
          const updNpcById = (npcId: string, patch: Partial<PlacedNpc>) => {
            const idx = (map.npcs ?? []).findIndex((n) => n.id === npcId);
            if (idx >= 0) updNpc(idx, patch);
          };
          const updDlg = (npcId: string, mut: (d: NpcDialog) => NpcDialog) => {
            const npc = (map.npcs ?? []).find((n) => n.id === npcId);
            if (!npc?.dialog) return;
            updNpcById(npcId, { dialog: mut(npc.dialog) });
          };
          const ops: DlgEditOpsMap = {
            setNext: (npcId, nodeId, oi, next) => { updDlg(npcId, (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, opts: (n.opts ?? []).map((o, i) => (i === oi ? { ...o, next } : o)) } : n)) })); sfx.hover(); },
            setEnding: (npcId, nodeId, oi, ending) => { updDlg(npcId, (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, opts: (n.opts ?? []).map((o, i) => (i === oi ? { ...o, ending } : o)) } : n)) })); sfx.hover(); },
            /* v0.52: без звуков — вызываются на каждый нажатый символ при правке на схеме */
            setText: (npcId, nodeId, text) => { updDlg(npcId, (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, text } : n)) })); },
            setOptText: (npcId, nodeId, oi, text) => { updDlg(npcId, (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, opts: (n.opts ?? []).map((o, i) => (i === oi ? { ...o, text } : o)) } : n)) })); },
            addNode: (npcId, at, linkFrom) => {
              const nid = uid('dn');
              updDlg(npcId, (d) => ({
                ...d,
                nodes: d.nodes
                  .map((n) => (linkFrom && n.id === linkFrom.nodeId
                    ? { ...n, opts: (n.opts ?? []).map((o, i) => (i === linkFrom.optIdx ? { ...o, next: nid } : o)) }
                    : n))
                  .concat([{ id: nid, text: '', opts: [] }]),
              }));
              updMap({ dlgPos: { ...(map.dlgPos ?? {}), [`n:${nid}`]: { x: Math.max(0, at.x), y: Math.max(0, at.y) } } });
              sfx.coin();
            },
            delNode: (npcId, nodeId) => {
              updDlg(npcId, (d) => {
                const rest = d.nodes.filter((n) => n.id !== nodeId);
                if (!rest.length) return d;
                const cleaned = rest.map((n) => ({ ...n, opts: (n.opts ?? []).map((o) => (o.next === nodeId ? { ...o, next: undefined } : o)) }));
                return { root: d.root === nodeId ? rest[0].id : d.root, nodes: cleaned };
              });
              sfx.fail();
            },
            addOpt: (npcId, nodeId) => { updDlg(npcId, (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, opts: [...(n.opts ?? []), { text: '' }] } : n)) })); sfx.coin(); },
            delOpt: (npcId, nodeId, oi) => { updDlg(npcId, (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, opts: (n.opts ?? []).filter((_, i) => i !== oi) } : n)) })); sfx.fail(); },
            addEnding: (at) => {
              const eid = uid('end');
              const ends: MapEnding[] = [...(map.endings ?? []), { id: eid, name: `КОНЦОВКА ${(map.endings ?? []).length + 1}`, desc: '' }];
              const pos = at ?? { x: 40 + (map.npcs ?? []).length * 310, y: 24 + (map.endings ?? []).length * 58 };
              updMap({ endings: ends, dlgPos: { ...(map.dlgPos ?? {}), [`e:${eid}`]: { x: Math.max(0, pos.x), y: Math.max(0, pos.y) } } });
              setSelEnding(eid);
              sfx.coin();
            },
            delEnding: (id) => {
              /* удалить концовку и подчистить ссылки «Концовка:» у вариантов всех NPC */
              updMap({
                endings: (map.endings ?? []).filter((x) => x.id !== id),
                npcs: (map.npcs ?? []).map((n) => (n.dialog ? { ...n, dialog: { ...n.dialog, nodes: n.dialog.nodes.map((nd) => ({ ...nd, opts: (nd.opts ?? []).map((o) => (o.ending === id ? { ...o, ending: undefined } : o)) })) } } : n)),
              });
              if (selEnding === id) setSelEnding(null);
              sfx.fail();
            },
          };
          const selEnd = (map.endings ?? []).find((e) => e.id === selEnding) ?? null;
          const updSelEnd = (patch: Partial<MapEnding>) => {
            if (!selEnd) return;
            updMap({ endings: (map.endings ?? []).map((x) => (x.id === selEnd.id ? { ...x, ...patch } : x)) });
          };
          const updSelEndGoal = (g: QuestGoal | undefined) => {
            if (!selEnd) return;
            updMap({ endings: (map.endings ?? []).map((x) => (x.id === selEnd.id ? { ...x, goal: g } : x)) });
          };
          return (
            <div className="space-y-2">
              <p className="text-[11px] text-dim leading-tight">
                ОБЩАЯ КАРТИНА — и её можно ПРАВИТЬ: все NPC с деревьями, КВЕСТЫ и КОНЦОВКИ на одном холсте.
                Нить из сокета варианта бросьте на КОНЦОВКУ — ответ ведёт к ней (✕ на нити — разъединить);
                кнопка «＋ Концовка» ставит новую; клик по концовке — редактирование ниже; клик по узлу — открыть его NPC.
              </p>
              <QuestMapGraph
                map={map}
                pos={map.dlgPos}
                onPos={(p) => updMap({ dlgPos: p ?? undefined })}
                onSelectNpc={(id) => { setSelId(id); setSelEnding(null); setTab('npc'); sfx.hover(); }}
                onSelectEnding={(id) => { setSelEnding((v) => (v === id ? null : id)); sfx.hover(); }}
                selEndingId={selEnding}
                ops={ops}
                height={560}
              />
              {/* ПАНЕЛЬ ВЫБРАННОЙ КОНЦОВКИ (v0.51): правится прямо на вкладке схемы */}
              {selEnd && (
                <div className="border-2 border-gold/60 px-3 py-2.5 space-y-2 pixel-panel pixel-corners">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-[10px] text-gold">🎬 КОНЦОВКА на схеме</span>
                    <button onClick={() => setSelEnding(null)} className="text-[10px] text-faint hover:text-coral cursor-pointer px-1">закрыть</button>
                  </div>
                  <input className="field-in w-full px-2 py-1 text-[11px]" maxLength={28} value={selEnd.name} placeholder="НАЗВАНИЕ КОНЦОВКИ" onChange={(ev) => updSelEnd({ name: ev.target.value.toUpperCase() })} />
                  <input className="field-in w-full px-2 py-1 text-[11px]" maxLength={140} value={selEnd.desc} placeholder="Описание (покажется на экране победы)" onChange={(ev) => updSelEnd({ desc: ev.target.value })} />
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="tick-label text-faint shrink-0">Условие:</span>
                    <select
                      className="field-in px-1.5 py-1 text-[10px]"
                      value={selEnd.goal?.kind ?? 'none'}
                      onChange={(ev) => {
                        const k = ev.target.value as QuestGoalKind;
                        updSelEndGoal(k === 'none' ? undefined : { kind: k, count: k === 'tasks' ? 3 : k === 'bosses' ? 1 : k === 'coins' ? 500 : k === 'hp' ? 100 : k === 'time' ? 900 : 10, bossId: (map.bosses ?? [])[0]?.id });
                      }}
                    >
                      <option value="none">только через диалог NPC</option>
                      <option value="boss">победить босса (конкретного)</option>
                      <option value="bosses">победить N боссов (любых)</option>
                      <option value="tasks">победить N заданий</option>
                      <option value="coins">собрать монет</option>
                      <option value="hp">иметь HP %</option>
                      <option value="time">запас времени, мин</option>
                      <option value="tries">запас попыток</option>
                    </select>
                    {selEnd.goal?.kind === 'boss' && (
                      <select className="field-in px-1.5 py-1 text-[10px]" value={selEnd.goal.bossId ?? ''} onChange={(ev) => updSelEndGoal({ ...selEnd.goal!, bossId: ev.target.value })}>
                        {(map.bosses ?? []).length === 0 && <option value="">нет боссов</option>}
                        {(map.bosses ?? []).map((b) => {
                          const bd = (map.bossLib ?? []).find((x) => x.id === b.bid);
                          return <option key={b.id} value={b.id}>{bd?.name ?? b.id}</option>;
                        })}
                      </select>
                    )}
                    {selEnd.goal && selEnd.goal.kind !== 'boss' && (selEnd.goal.kind === 'time' ? (
                      <Stepper value={Math.max(1, Math.round((selEnd.goal.count ?? 60) / 60))} onChange={(v) => updSelEndGoal({ ...selEnd.goal!, count: Math.max(1, v) * 60 })} min={1} max={180} step={1} suffix=" мин" />
                    ) : (
                      <Stepper value={selEnd.goal.count ?? 1} onChange={(v) => updSelEndGoal({ ...selEnd.goal!, count: v })} min={1} max={99999} step={selEnd.goal.kind === 'coins' ? 25 : 1} />
                    ))}
                  </div>
                  <p className="text-[9px] text-faint leading-tight">{questGoalText(selEnd.goal, map)}</p>
                </div>
              )}
            </div>
          );
        })()}

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
                    onChange={(ev) => { const ends = [...(map.endings ?? [])]; const k = ev.target.value as QuestGoalKind; ends[ei] = { ...e, goal: k === 'none' ? undefined : { kind: k, count: k === 'tasks' ? 3 : k === 'bosses' ? 1 : k === 'coins' ? 500 : k === 'hp' ? 100 : k === 'time' ? 900 : 10, bossId: (map.bosses ?? [])[0]?.id } }; updMap({ endings: ends }); }}
                  >
                    <option value="none">только через диалог NPC</option>
                    <option value="boss">победить босса (конкретного)</option>
                    <option value="bosses">победить N боссов (любых)</option>
                    <option value="tasks">победить N заданий</option>
                    <option value="coins">собрать монет</option>
                    <option value="hp">иметь HP %</option>
                    <option value="time">запас времени, мин</option>
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
                  {e.goal && e.goal.kind !== 'boss' && (e.goal.kind === 'time' ? (
                    /* ВРЕМЯ — счётчик в МИНУТАХ (в данных секунды) */
                    <Stepper value={Math.max(1, Math.round((e.goal.count ?? 60) / 60))} onChange={(v) => { const ends = [...(map.endings ?? [])]; ends[ei] = { ...e, goal: { ...e.goal!, count: Math.max(1, v) * 60 } }; updMap({ endings: ends }); }} min={1} max={180} step={1} suffix=" мин" />
                  ) : (
                    <Stepper value={e.goal.count ?? 1} onChange={(v) => { const ends = [...(map.endings ?? [])]; ends[ei] = { ...e, goal: { ...e.goal!, count: v } }; updMap({ endings: ends }); }} min={1} max={99999} step={e.goal.kind === 'coins' ? 25 : 1} />
                  ))}
                </div>
                <p className="text-[9px] text-faint leading-tight">{questGoalText(e.goal, map)}</p>
              </div>
            ))}
            <button
              onClick={() => { updMap({ endings: [...(map.endings ?? []), { id: uid('end'), name: `КОНЦОВКА ${(map.endings ?? []).length + 1}`, desc: '' }] }); sfx.coin(); }}
              className="w-full py-1.5 border-2 border-dashed border-edge text-faint font-display text-[10px] uppercase hover:text-paper cursor-pointer"
            >+ Добавить концовку</button>
            {/* v0.67: настройка «Поражение при N провалах заданий» УБРАНА — проигрыш
                в квесте ТОЛЬКО на нуле HP (или время/попытки у std-карт); поле
                questDefeatFails в данных старых карт остаётся, но не читается */}
          </div>
        )}

        {/* ---------- ОКНО «РЕДАКТОР ДИАЛОГОВ» NPC (v0.51): всё на схеме ---------- */}
        {dlgWinOpen && map && selNpc && selIdx >= 0 && selNpc.dialog && (
          <div className="fixed inset-0 z-[96] flex items-center justify-center p-3 sm:p-4">
            <div className="absolute inset-0 bg-[rgba(4,6,14,0.9)]" onClick={() => setDlgWinOpen(false)} />
            <div className="relative pixel-panel pixel-corners w-full max-w-5xl max-h-[94vh] overflow-y-auto p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="font-display uppercase tracking-wider text-teal text-sm truncate">
                  💬 Редактор диалогов — {libOf(selNpc)?.name ?? 'NPC'}
                </span>
                <span className="tick-label text-faint hidden sm:inline">узлов: {selNpc.dialog.nodes.length} · создавайте узлы, соединяйте и рвите нити прямо на схеме</span>
                <GhostBtn small className="ml-auto shrink-0" onClick={() => setDlgWinOpen(false)}>{Ic.cross(12)} Закрыть</GhostBtn>
              </div>
              <DialogTreeEditor
                dialog={selNpc.dialog}
                endings={map.endings ?? []}
                height={470}
                allFlags={allDlgFlags(map)}
                cells={(map.cells ?? []).map((c, i) => ({ idx: i, label: `№${c?.n ?? i + 1}${c?.label ? ` · ${c.label}` : c?.task?.title ? ` · ${c.task.title.slice(0, 18)}` : ''}` }))}
                cutscenes={(map.cutscenes ?? []).map((c) => ({ id: c.id, name: c.name }))}
                onChange={(d) => updNpc(selIdx, { dialog: d })}
                posStore={map.dlgPos}
                onPosStore={(p) => updMap({ dlgPos: p ?? undefined })}
                onAddEnding={() => {
                  const eid = uid('end');
                  const ends: MapEnding[] = [...(map.endings ?? []), { id: eid, name: `КОНЦОВКА ${(map.endings ?? []).length + 1}`, desc: '' }];
                  updMap({ endings: ends }); // на общей схеме концовка сама встанет в колонку справа
                  sfx.coin();
                }}
                onDelEnding={(id) => {
                  /* удалить концовку и подчистить ссылки «Концовка:» у вариантов ВСЕХ NPC */
                  updMap({
                    endings: (map.endings ?? []).filter((x) => x.id !== id),
                    npcs: (map.npcs ?? []).map((n) => (n.dialog ? { ...n, dialog: { ...n.dialog, nodes: n.dialog.nodes.map((nd) => ({ ...nd, opts: (nd.opts ?? []).map((o) => (o.ending === id ? { ...o, ending: undefined } : o)) })) } } : n)),
                  });
                  sfx.fail();
                }}
              />
            </div>
          </div>
        )}

        {/* ---------- ОКНО «ВИТРИНА ТОРГОВЦА» (v0.51) ---------- */}
        {tradeWinOpen && map && selNpc && selIdx >= 0 && (
          <TradeShopEditor
            map={map}
            npc={selNpc}
            onChange={(patch) => updNpc(selIdx, patch)}
            onClose={() => setTradeWinOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
