import type { GameMap, NpcDiscount, NpcShopOffer, PlacedNpc, RubgItemKind } from '../types';
import { RUBG_ITEMS, coinsShort } from '../types';
import { Modal, PxBtn, Stepper, Coin } from '../ui';
import { uid } from '../db';
import { sfx } from '../sound';

/* ВИТРИНА ТОРГОВЦА (v0.51.0) — окно редактирования ТОРГОВЛИ NPC.
   Открывается кнопкой «Добавить торговлю» / «Витрина торговца» (в редакторе карт и в
   «Редакторе квестов и диалогов»). Здесь создатель карты:
   • РАЗМЕЩАЕТ ПРЕДМЕТЫ на витрине торговца — сколько угодно товаров из каталога
     вещей и ресурсов, у каждого — ЦЕНА в монетах и КОЛИЧЕСТВО на витрине
     (партия съедает запас; «∞» — без лимита, как раньше);
   • задаёт КАССУ торговца — сколько монет NPC готов потратить на ВЫКУП вещей
     игрока и какой процент от справочной цены он платит (sellPct);
   • назначает СКИДКИ ЗА ХОРОШЕЕ ОТНОШЕНИЕ: игрок сдал выбранный квест — цены
     этого торговца для него ниже на N % (скидки суммируются, потолок 90 %).
   В игре окно торговли открывается кнопкой «Торговать» в диалоге NPC. */

export const shopOfferLabel = (off: NpcShopOffer): string => {
  if (off.kind === 'res') {
    const amt = Math.max(1, Math.floor(off.amount ?? 0));
    if (off.title?.trim()) return off.title.trim();
    return off.res === 'tries' ? `+${amt} попыток` : off.res === 'hp' ? `+${amt}% HP` : `+${amt} мин времени`;
  }
  const meta = off.item ? RUBG_ITEMS[off.item] : undefined;
  return off.title?.trim() || meta?.name || 'вещь';
};

export function TradeShopEditor({ map, npc, onChange, onClose }: {
  map: GameMap;
  npc: PlacedNpc;
  onChange: (patch: Partial<PlacedNpc>) => void;
  onClose: () => void;
}) {
  const shop = npc.shop ?? [];
  const updOffer = (oid: string, patch: Partial<NpcShopOffer>) =>
    onChange({ shop: shop.map((x) => (x.id === oid ? { ...x, ...patch } : x)) });
  const addOffer = () => {
    const off: NpcShopOffer = { id: uid('shp'), kind: 'item', item: 'medkit', price: 50 };
    onChange({ shop: [...shop, off] });
    sfx.coin();
  };
  /* все квесты карты (для скидок — квест ЛЮБОГО NPC) */
  const allQuests = (map.npcs ?? []).flatMap((n) => (n.quests ?? []).map((q) => ({
    qid: q.id,
    label: `${(map.npcLib ?? []).find((x) => x.id === n.nid)?.name ?? 'NPC'}: ${q.title}`,
  })));
  const sellPct = npc.sellPct ?? 50;
  const buyBack = (kind: keyof typeof RUBG_ITEMS) => Math.max(0, Math.floor(RUBG_ITEMS[kind].cost * sellPct / 100));

  return (
    <Modal title={`Витрина торговца${(map.npcLib ?? []).find((x) => x.id === npc.nid) ? ` — ${(map.npcLib ?? []).find((x) => x.id === npc.nid)!.name}` : ''}`} icon="🛒" onClose={onClose} w="max-w-3xl">
      <div className="space-y-3 max-h-[74vh] overflow-y-auto pr-1">
        {/* ---------- ВИТРИНА ---------- */}
        <div className="border-2 border-[#ffcf3f]/50 px-2.5 py-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="tick-label text-gold">🏪 Витрина — товары торговца ({shop.length})</span>
            <PxBtn small color="gold" onClick={addOffer}>+ Разместить товар</PxBtn>
          </div>
          {shop.length === 0 && (
            <p className="text-[10px] text-faint leading-tight">Витрина пуста: нажмите «+ Разместить товар» — предмет встанет на витрину, у него появятся цена и количество.</p>
          )}
          <div className="grid md:grid-cols-2 gap-2">
            {shop.map((off) => (
              <div key={off.id} className="border-2 border-edge px-2 py-1.5 space-y-1.5 bg-[rgba(7,9,18,0.5)]">
                <div className="flex items-center gap-1.5">
                  <span className="text-[15px] shrink-0">{off.kind === 'item' && off.item ? RUBG_ITEMS[off.item].icon : off.res === 'tries' ? '🎯' : off.res === 'hp' ? '❤' : '⏱'}</span>
                  <span className="font-display text-[10px] uppercase text-paper truncate flex-1">{shopOfferLabel(off)}</span>
                  <button onClick={() => { onChange({ shop: shop.filter((x) => x.id !== off.id) }); sfx.fail(); }} className="text-faint hover:text-coral cursor-pointer px-0.5 text-[11px]" title="Снять товар с витрины">✕</button>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  <select
                    className="field-in px-1 py-0.5 text-[10px]"
                    value={off.kind}
                    onChange={(ev) => {
                      const k = ev.target.value as NpcShopOffer['kind'];
                      updOffer(off.id, k === 'item' ? { kind: k, item: off.item ?? 'medkit' } : { kind: k, res: off.res ?? 'time', amount: off.amount ?? 5 });
                    }}
                  >
                    <option value="item">вещь</option>
                    <option value="res">ресурс</option>
                  </select>
                  {off.kind === 'item' ? (
                    <select className="field-in flex-1 min-w-0 px-1 py-0.5 text-[10px]" value={off.item ?? 'medkit'} onChange={(ev) => updOffer(off.id, { item: ev.target.value as RubgItemKind })}>
                      {Object.entries(RUBG_ITEMS).map(([k, m]) => <option key={k} value={k}>{m.icon} {m.name}</option>)}
                    </select>
                  ) : (
                    <>
                      <select className="field-in px-1 py-0.5 text-[10px]" value={off.res ?? 'time'} onChange={(ev) => updOffer(off.id, { res: ev.target.value as 'time' | 'tries' | 'hp' })}>
                        <option value="time">время</option>
                        <option value="tries">попытки</option>
                        <option value="hp">HP</option>
                      </select>
                      <Stepper value={off.amount ?? 5} onChange={(v) => updOffer(off.id, { amount: v })} min={1} max={99999} step={(off.res ?? 'time') === 'hp' ? 5 : 1} />
                    </>
                  )}
                </div>
                <input className="field-in w-full px-1.5 py-0.5 text-[10px]" maxLength={40} placeholder="Своё название (необязательно)" value={off.title ?? ''} onChange={(ev) => updOffer(off.id, { title: ev.target.value || undefined })} />
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[9px] text-dim shrink-0">Цена:</span>
                  <Stepper value={off.price ?? 0} onChange={(v) => updOffer(off.id, { price: v })} min={0} max={99999} step={5} suffix=" бр" />
                  <span className="text-[9px] text-dim shrink-0 ml-1">На витрине:</span>
                  <Stepper value={off.qty ?? 0} onChange={(v) => updOffer(off.id, { qty: v > 0 ? v : undefined })} min={0} max={999} suffix={off.qty ? ' шт' : ' (∞)'} />
                </div>
                <p className="text-[8.5px] text-faint leading-tight">{off.qty ? `Запас партии: игроки разберут ${off.qty} шт — товар кончится.` : 'Без лимита — товар не кончится, сколько бы ни покупали.'}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ---------- КАССА ТОРГОВЦА (ВЫКУП) ---------- */}
        <div className="border-2 border-edge px-2.5 py-2 space-y-1.5">
          <label className="flex items-center gap-2 text-[11px] text-dim cursor-pointer">
            <input
              type="checkbox"
              checked={npc.shopCoins !== undefined}
              onChange={(ev) => onChange(ev.target.checked ? { shopCoins: npc.shopCoins ?? 500, sellPct: npc.sellPct ?? 50 } : { shopCoins: undefined })}
            />
            💰 Касса торговца — ВЫКУПАЕТ вещи игрока (окно «Продать»)
          </label>
          {npc.shopCoins !== undefined && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[9px] text-dim shrink-0">Монет в кассе:</span>
                <Stepper value={npc.shopCoins} onChange={(v) => onChange({ shopCoins: Math.max(0, v) })} min={0} max={999999} step={25} suffix=" бр" />
                <span className="text-[9px] text-dim shrink-0 ml-1">Процент выкупа:</span>
                <Stepper value={sellPct} onChange={(v) => onChange({ sellPct: Math.max(5, Math.min(100, v)) })} min={5} max={100} step={5} suffix=" %" />
              </div>
              <p className="text-[8.5px] text-faint leading-tight">
                За вещь торговец платит {sellPct} % справочной цены: фляжка — {buyBack('flask')} бр, аптечка — {buyBack('medkit')} бр, отмычка — {buyBack('lockpick')} бр, снайперка — {buyBack('sniper')} бр.
                Касса ТРАТИТСЯ на выкуп и ПОПОЛНЯЕТСЯ покупками игроков; пустая касса — выкуп стоит.
              </p>
            </>
          )}
        </div>

        {/* ---------- СКИДКИ ЗА ХОРОШЕЕ ОТНОШЕНИЕ ---------- */}
        <div className="border-2 border-teal/40 px-2.5 py-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="tick-label text-teal">🤝 Скидки за выполненные квесты ({(npc.discounts ?? []).length})</span>
            <button
              onClick={() => { const d: NpcDiscount = { questId: allQuests[0]?.qid ?? '', pct: 10 }; onChange({ discounts: [...(npc.discounts ?? []), d] }); sfx.coin(); }}
              disabled={allQuests.length === 0}
              className={`px-2 py-1 border-2 border-teal/60 text-teal font-display text-[9px] uppercase hover:bg-teal/10 cursor-pointer ${allQuests.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
            >+ Скидка</button>
          </div>
          {allQuests.length === 0 && <p className="text-[9px] text-magma leading-tight">На карте нет ни одного квеста NPC — скидку не к чему привязать. Сначала добавьте квест.</p>}
          {(npc.discounts ?? []).map((d, di) => (
            <div key={di} className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] text-dim shrink-0">сдал квест</span>
              <select
                className="field-in flex-1 min-w-0 px-1 py-0.5 text-[10px]"
                value={d.questId}
                onChange={(ev) => onChange({ discounts: (npc.discounts ?? []).map((x, i) => (i === di ? { ...x, questId: ev.target.value } : x)) })}
              >
                {allQuests.some((q) => q.qid === d.questId) ? null : <option value={d.questId}>(квест удалён)</option>}
                {allQuests.map((q) => <option key={q.qid} value={q.qid}>{q.label}</option>)}
              </select>
              <span className="text-[9px] text-dim shrink-0">— дешевле на</span>
              <Stepper value={d.pct} onChange={(v) => onChange({ discounts: (npc.discounts ?? []).map((x, i) => (i === di ? { ...x, pct: Math.max(1, Math.min(90, v)) } : x)) })} min={1} max={90} step={5} suffix=" %" />
              <button onClick={() => { onChange({ discounts: (npc.discounts ?? []).filter((_, i) => i !== di) }); sfx.fail(); }} className="text-faint hover:text-coral cursor-pointer px-1 text-[11px]" title="Убрать скидку">✕</button>
            </div>
          ))}
          <p className="text-[8.5px] text-faint leading-tight">
            Игрок, СДАВШИЙ выбранный квест, покупает у этого торговца дешевле: цена {coinsShort(100)} → {coinsShort(Math.max(1, Math.floor(100 * (100 - Math.min(90, (npc.discounts ?? []).reduce((a, x) => a + x.pct, 0))) / 100)))} при сумме скидок 100 %. Скидки по нескольким квестам СУММИРУЮТСЯ, потолок — 90 %.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <PxBtn color="teal" onClick={onClose}>Готово</PxBtn>
        </div>
      </div>
    </Modal>
  );
}

/* маленькая монетка для подписи цены в окне (повторяет CoinRow) */
export function PriceTag({ value, size = 10 }: { value: number; size?: number }) {
  return <span className="inline-flex items-center gap-0.5"><Coin size={size} />{value}</span>;
}
