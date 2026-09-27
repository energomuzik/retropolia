import { uid } from './db';
import type { DialogNode, GameMap, NpcDialog, PlacedNpc } from './types';

/* АВТО-ВЕТКИ ДИАЛОГА NPC (v0.51.0) — торговля и квесты ЖИВУТ В ДИАЛОГЕ.
   Когда создатель добавляет NPC ТОРГОВЛЮ — в дерево диалога выращивается ветка
   «Можно ли поторговать с тобой?» (вариант на СТАРТОВОМ узле → узел-хаб с маркером
   showShop: в игре на нём появляется кнопка «Торговать»). Когда добавляется КВЕСТ —
   ветка «Есть ли для меня работа?» (узел-хаб с маркером showQuests: список квестов
   со сдачей). Тексты веток и узлов-хабов — ОБЫЧНЫЕ элементы дерева: их можно
   свободно менять, переносить, отсоединять — маркеры остаются при узлах.

   СОВМЕСТИМОСТЬ СО СТАРЫМИ КАРТАМИ: если в дереве НЕТ ни одного маркера, блоки
   торговли/квестов показываются на КАЖДОМ узле — как в v0.50 и раньше (см.
   nodeShowsShop / nodeShowsQuests). Как только автор ставит хоть один маркер —
   показ только на помеченных узлах. */

export const SHOP_ASK = 'Можно ли поторговать с тобой?';
export const QUEST_ASK = 'Есть ли для меня работа?';

const hasMarker = (npc: PlacedNpc, key: 'showShop' | 'showQuests'): boolean =>
  (npc.dialog?.nodes ?? []).some((n) => n[key]);

/** Гарантирует диалог и добавляет ветку «Можно ли поторговать с тобой?» → узел-хаб showShop.
    Если ветка уже есть — NPC возвращается как был. */
export function ensureShopDialog(npc: PlacedNpc): PlacedNpc {
  if (hasMarker(npc, 'showShop')) return npc;
  const dialog: NpcDialog = npc.dialog ?? (() => {
    const rid = uid('dn');
    return { root: rid, nodes: [{ id: rid, text: 'Приветствую, путник…', opts: [] }] };
  })();
  const hubId = uid('dn');
  const rootId = dialog.nodes.some((n) => n.id === dialog.root) ? dialog.root : dialog.nodes[0]?.id;
  if (!rootId) return npc;
  const hub: DialogNode = { id: hubId, text: 'Конечно! Смотри, что у меня есть:', opts: [], showShop: true };
  return {
    ...npc,
    dialog: {
      root: dialog.root,
      nodes: dialog.nodes
        .map((n) => (n.id === rootId ? { ...n, opts: [...(n.opts ?? []), { text: SHOP_ASK, next: hubId }] } : n))
        .concat([hub]),
    },
  };
}

/** Гарантирует диалог и добавляет ветку «Есть ли для меня работа?» → узел-хаб showQuests.
    Если ветка уже есть — NPC возвращается как был. */
export function ensureQuestDialog(npc: PlacedNpc): PlacedNpc {
  if (hasMarker(npc, 'showQuests')) return npc;
  const dialog: NpcDialog = npc.dialog ?? (() => {
    const rid = uid('dn');
    return { root: rid, nodes: [{ id: rid, text: 'Приветствую, путник…', opts: [] }] };
  })();
  const hubId = uid('dn');
  const rootId = dialog.nodes.some((n) => n.id === dialog.root) ? dialog.root : dialog.nodes[0]?.id;
  if (!rootId) return npc;
  const hub: DialogNode = { id: hubId, text: 'Для тебя всегда найдётся работа:', opts: [], showQuests: true };
  return {
    ...npc,
    dialog: {
      root: dialog.root,
      nodes: dialog.nodes
        .map((n) => (n.id === rootId ? { ...n, opts: [...(n.opts ?? []), { text: QUEST_ASK, next: hubId }] } : n))
        .concat([hub]),
    },
  };
}

/** В дереве есть хоть один маркер торговли/квестов? (режим «показ только на помеченных узлах») */
export const dialogHasMarkers = (npc?: PlacedNpc): boolean =>
  !!(npc?.dialog?.nodes ?? []).some((n) => n.showShop || n.showQuests);

/** Показывать блок ТОРГОВЛИ на этом узле в игре: маркер узла или (для старых карт без маркеров) всегда. */
export const nodeShowsShop = (npc: PlacedNpc, node: DialogNode): boolean =>
  !!node.showShop || (!dialogHasMarkers(npc) && (npc.shop?.length ?? 0) > 0);

/** Показывать блок КВЕСТОВ на этом узле в игре: маркер узла или (для старых карт без маркеров) всегда. */
export const nodeShowsQuests = (npc: PlacedNpc, node: DialogNode): boolean =>
  !!node.showQuests || (!dialogHasMarkers(npc) && (npc.quests?.length ?? 0) > 0);

/* v0.52: все имена ФЛАГОВ, уже использованные в диалогах карты, — подсказка в полях
   «ставит флаг / показывать только при флаге / скрыть при флаге» редактора дерева. */
export const allDlgFlags = (map: Pick<GameMap, 'npcs'>): string[] => {
  const set = new Set<string>();
  for (const n of map.npcs ?? []) {
    for (const nd of n.dialog?.nodes ?? []) {
      for (const o of nd.opts ?? []) {
        if (o.setFlag) set.add(o.setFlag);
        if (o.reqFlag) set.add(o.reqFlag);
        if (o.reqNotFlag) set.add(o.reqNotFlag);
      }
    }
  }
  return [...set].sort();
};
