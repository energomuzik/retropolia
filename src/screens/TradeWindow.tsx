import { useMemo, useState } from 'react';
import type { Action } from '../engine';
import type { GameMap, GameSession, NpcLibEntry, NpcShopOffer, PlacedNpc, RubgItem } from '../types';
import { RUBG_ITEMS, coinsStr } from '../types';
import { CoinRow, GhostBtn, Ic, PxBtn } from '../ui';
import { sfx } from '../sound';

/* ИГРОВОЕ ОКНО ТОРГОВЛИ (v0.51.0) — ТРИ ОКНА, как в классических RPG:
   ┌ Товары торговца ┐  ┌ СДЕЛКА ┐  ┌ Ваш рюкзак ┐
   Товары и вещи перетаскиваются мышью в СДЕЛКУ (или добавляются «＋»), после чего
   обмениваются ПАЧКОЙ кнопкой «Обменять». Для одной вещи работают быстрые кнопки
   «Купить» / «Продать». Цены показываются С УЧЁТОМ скидок за сданные квесты;
   у торговца конечные витрина (шт) и касса (выкуп вещей игрока по sellPct %). */

type Deal = { buys: { offerId: string; qty: number }[]; sells: string[] };

export default function TradeWindow({ s, map, me, npc, def, dispatch, onClose }: {
  s: GameSession;
  map: GameMap;
  me: string;
  npc: PlacedNpc;
  def: NpcLibEntry | undefined;
  dispatch: (a: Action) => void;
  onClose: () => void;
}) {
  const [deal, setDeal] = useState<Deal>({ buys: [], sells: [] });
  const [dragOver, setDragOver] = useState<'buys' | 'sells' | null>(null);

  const meP = s.players.find((p) => p.id === me);
  const balance = meP?.coinsLeft ?? 0;
  const inv: RubgItem[] = meP?.items ?? [];
  const flags = s.qFlags?.[me] ?? {};

  /* скидка за хорошее отношение: сданные квесты → сумма процентов, потолок 90 */
  const disc = useMemo(() => {
    let d = 0;
    for (const x of npc.discounts ?? []) if (x.questId && flags[`quest:${x.questId}`]) d += Math.max(0, Math.floor(x.pct));
    return Math.min(90, d);
  }, [npc.discounts, flags]);

  const pool = npc.shopCoins !== undefined ? (s.npcShop?.[npc.id]?.coins ?? npc.shopCoins) : undefined;
  const sellPct = npc.sellPct ?? 50;
  const stockOf = (off: NpcShopOffer): number | undefined =>
    off.qty && off.qty > 0 ? (s.npcShop?.[npc.id]?.qty?.[off.id] ?? off.qty) : undefined;
  const unitPrice = (off: NpcShopOffer): number => Math.max(0, Math.floor((off.price || 0) * (100 - disc) / 100));
  const sellPrice = (it: RubgItem): number => Math.max(0, Math.floor(RUBG_ITEMS[it.kind].cost * sellPct / 100));

  const offerOf = (id: string) => (npc.shop ?? []).find((x) => x.id === id);
  const itemOf = (id: string) => inv.find((x) => x.id === id);

  const buysOf = deal.buys.map((b) => ({ b, off: offerOf(b.offerId) })).filter((x): x is { b: { offerId: string; qty: number }; off: NpcShopOffer } => !!x.off);
  const sellsOf = deal.sells.map((id) => itemOf(id)).filter((x): x is RubgItem => !!x);
  const pay = buysOf.reduce((a, x) => a + unitPrice(x.off) * x.b.qty, 0);
  const gain = sellsOf.reduce((a, it) => a + sellPrice(it), 0);
  const net = gain - pay;
  const stockOk = buysOf.every((x) => { const st = stockOf(x.off); return st === undefined || st >= x.b.qty; });
  const coinsOk = balance + net >= 0;
  const poolOk = pool === undefined || pool + pay - gain >= 0;
  const canExchange = deal.buys.length + deal.sells.length > 0 && stockOk && coinsOk && poolOk;

  const addBuy = (offerId: string, qty = 1) => {
    setDeal((d) => {
      const ex = d.buys.find((x) => x.offerId === offerId);
      const off = offerOf(offerId);
      const cap = off?.qty && off.qty > 0 ? off.qty : 999;
      if (ex) return { ...d, buys: d.buys.map((x) => (x.offerId === offerId ? { ...x, qty: Math.min(cap, x.qty + qty) } : x)) };
      return { ...d, buys: [...d.buys, { offerId, qty: Math.min(cap, qty) }] };
    });
    sfx.hover();
  };
  const addSell = (itemId: string) => {
    setDeal((d) => (d.sells.includes(itemId) ? d : { ...d, sells: [...d.sells, itemId] }));
    sfx.hover();
  };
  const clearDeal = () => { setDeal({ buys: [], sells: [] }); sfx.fail(); };
  const exchange = () => {
    if (!canExchange) return;
    sfx.coin();
    dispatch({ t: 'npcTrade', id: me, npcId: npc.id, buys: deal.buys, sells: deal.sells });
    setDeal({ buys: [], sells: [] });
  };
  const quickBuy = (off: NpcShopOffer) => {
    sfx.coin();
    dispatch({ t: 'npcTrade', id: me, npcId: npc.id, buys: [{ offerId: off.id, qty: 1 }], sells: [] });
  };
  const quickSell = (it: RubgItem) => {
    sfx.coin();
    dispatch({ t: 'npcTrade', id: me, npcId: npc.id, buys: [], sells: [it.id] });
  };
  const onDrop = (zone: 'buys' | 'sells') => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain')) as { k?: string; offerId?: string; itemId?: string };
      if (zone === 'buys' && data.k === 'buy' && data.offerId) addBuy(data.offerId);
      if (zone === 'sells' && data.k === 'sell' && data.itemId) addSell(data.itemId);
    } catch { /* не наш груз — игнор */ }
  };
  const resWhat = (off: NpcShopOffer): string => {
    const amt = Math.max(1, Math.floor(off.amount ?? 0));
    return off.res === 'tries' ? `+${amt} попыток` : off.res === 'hp' ? `+${amt}% HP` : `+${amt} мин времени`;
  };

  return (
    <div className="fixed inset-0 z-[78] flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-[rgba(4,6,14,0.8)]" onClick={onClose} />
      <div className="relative pixel-panel pixel-corners pop-in w-full max-w-4xl max-h-[92vh] overflow-y-auto p-3.5 space-y-3">
        {/* шапка */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-display uppercase text-sm text-gold">🛒 Торговля — {def?.name ?? 'NPC'}</span>
          {disc > 0 && <span className="tick-label text-teal" title="Скидки за сданные квесты">🤝 скидка {disc} %</span>}
          {pool !== undefined && <span className="tick-label text-faint">касса: <CoinRow value={pool} size={10} /></span>}
          <span className="ml-auto flex items-center gap-2">
            <span className="tick-label text-teal">капитал: <CoinRow value={balance} size={11} /></span>
            <button onClick={onClose} className="text-dim hover:text-coral cursor-pointer" aria-label="Закрыть">{Ic.cross(14)}</button>
          </span>
        </div>
        {map.startCoins === undefined && (
          <p className="text-[11px] text-magma border-2 border-magma/40 px-2 py-1.5">На карте не включён ресурс «монеты» — торговля недоступна.</p>
        )}

        <div className="grid md:grid-cols-[1fr_250px_1fr] gap-2.5 items-start">
          {/* ---------- ОКНО 1: ТОВАРЫ ТОРГОВЦА ---------- */}
          <div className="border-2 border-[#ffcf3f]/40 px-2 py-2 space-y-1.5 min-w-0">
            <div className="tick-label text-gold">🏪 Товары торговца</div>
            {(npc.shop ?? []).length === 0 && <p className="text-[10px] text-faint">Витрина пуста.</p>}
            {(npc.shop ?? []).map((off) => {
              const price = unitPrice(off);
              const st = stockOf(off);
              const afford = balance >= price;
              const offSale = st !== undefined && st <= 0;
              return (
                <div
                  key={off.id}
                  draggable={!offSale}
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ k: 'buy', offerId: off.id })); }}
                  className={`flex items-center gap-2 justify-between border-2 border-edge px-2 py-1.5 ${offSale ? 'opacity-40' : 'cursor-grab active:cursor-grabbing'}`}
                  title="Перетащите в СДЕЛКУ — или нажмите «Купить»"
                >
                  <div className="min-w-0">
                    <div className="font-display text-[10.5px] uppercase truncate text-paper">{off.kind === 'item' && off.item ? `${RUBG_ITEMS[off.item].icon} ${off.title?.trim() || RUBG_ITEMS[off.item].name}` : `⏱🎯 ${off.title?.trim() || resWhat(off)}`}</div>
                    <div className="tick-label text-faint truncate">
                      {disc > 0 && off.price > price && <span className="line-through mr-1 opacity-60"><CoinRow value={off.price} size={9} /></span>}
                      цена: <CoinRow value={price} size={10} />
                      {st !== undefined && <span className="ml-1">· на витрине: {st} шт</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => addBuy(off.id)} className={`px-1.5 py-1 border-2 border-edge text-faint hover:text-teal text-[11px] cursor-pointer ${offSale ? 'hidden' : ''}`} title="Добавить в сделку">＋</button>
                    <PxBtn small color="gold" disabled={!afford || offSale} className={!afford || offSale ? 'opacity-40' : ''} onClick={() => quickBuy(off)} title={offSale ? 'Товар разобрали' : afford ? 'Купить сразу за монеты' : 'Не хватает монет'}>Купить</PxBtn>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ---------- ОКНО 2: СДЕЛКА ---------- */}
          <div className="border-2 border-teal/50 px-2 py-2 space-y-2 min-w-0">
            <div className="tick-label text-teal">⚖ СДЕЛКА</div>
            {/* получаете */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver('buys'); }}
              onDragLeave={() => setDragOver((v) => (v === 'buys' ? null : v))}
              onDrop={onDrop('buys')}
              className={`border-2 border-dashed px-1.5 py-1.5 space-y-1 min-h-[64px] transition-colors ${dragOver === 'buys' ? 'border-teal bg-teal/10' : 'border-edge'}`}
            >
              <div className="tick-label text-faint">↓ получаете от торговца</div>
              {buysOf.length === 0 && <p className="text-[9px] text-faint">Бросьте сюда товар из окна торговца (или «＋»)</p>}
              {buysOf.map(({ b, off }) => (
                <div key={b.offerId} className="flex items-center gap-1 justify-between">
                  <span className="text-[10px] text-paper truncate min-w-0">{off.kind === 'item' && off.item ? `${RUBG_ITEMS[off.item].icon} ${off.title?.trim() || RUBG_ITEMS[off.item].name}` : off.title?.trim() || resWhat(off)}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    <button onClick={() => addBuy(b.offerId, -1)} className="px-1 text-[10px] text-faint hover:text-coral cursor-pointer" title="Меньше">−</button>
                    <span className="text-[10px] text-dim">×{b.qty}</span>
                    <button onClick={() => addBuy(b.offerId, 1)} className="px-1 text-[10px] text-faint hover:text-teal cursor-pointer" title="Больше">＋</button>
                    <span className="text-[9px] text-gold w-11 text-right"><CoinRow value={unitPrice(off) * b.qty} size={9} /></span>
                    <button onClick={() => setDeal((d) => ({ ...d, buys: d.buys.filter((x) => x.offerId !== b.offerId) }))} className="text-[9px] text-faint hover:text-coral cursor-pointer" title="Убрать из сделки">✕</button>
                  </span>
                </div>
              ))}
            </div>
            {/* отдаёте */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver('sells'); }}
              onDragLeave={() => setDragOver((v) => (v === 'sells' ? null : v))}
              onDrop={onDrop('sells')}
              className={`border-2 border-dashed px-1.5 py-1.5 space-y-1 min-h-[64px] transition-colors ${dragOver === 'sells' ? 'border-gold bg-gold/10' : 'border-edge'}`}
            >
              <div className="tick-label text-faint">↑ отдаёте торговцу</div>
              {sellsOf.length === 0 && <p className="text-[9px] text-faint">Бросьте сюда вещь из рюкзака (или «＋»)</p>}
              {sellsOf.map((it) => (
                <div key={it.id} className="flex items-center gap-1 justify-between">
                  <span className="text-[10px] text-paper truncate min-w-0">{RUBG_ITEMS[it.kind].icon} {RUBG_ITEMS[it.kind].name}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="text-[9px] text-gold"><CoinRow value={sellPrice(it)} size={9} /></span>
                    <button onClick={() => setDeal((d) => ({ ...d, sells: d.sells.filter((x) => x !== it.id) }))} className="text-[9px] text-faint hover:text-coral cursor-pointer" title="Убрать из сделки">✕</button>
                  </span>
                </div>
              ))}
            </div>
            {/* итоги */}
            <div className="border-2 border-edge px-1.5 py-1.5 space-y-0.5 text-[10px]">
              {pay > 0 && <div className="flex justify-between text-dim"><span>платите</span><span className="text-gold">−<CoinRow value={pay} size={10} /></span></div>}
              {gain > 0 && <div className="flex justify-between text-dim"><span>получаете</span><span className="text-teal">+<CoinRow value={gain} size={10} /></span></div>}
              <div className="flex justify-between text-paper"><span>итого</span><span className={net < 0 ? 'text-gold' : net > 0 ? 'text-teal' : ''}>{net === 0 ? 'без денег' : <CoinRow value={Math.abs(net)} size={11} />}{net !== 0 && (net < 0 ? ' из кармана' : ' в карман')}</span></div>
            </div>
            <div className="flex items-center gap-1.5">
              <PxBtn color="teal" className="flex-1" disabled={!canExchange} onClick={exchange} title={canExchange ? 'Совершить обмен' : !stockOk ? 'На витрине не хватает товара' : !coinsOk ? 'Не хватает монет' : !poolOk ? 'У торговца не хватает монет на выкуп' : 'Добавьте товары или вещи'}>🤝 Обменять</PxBtn>
              <GhostBtn small onClick={clearDeal} title="Очистить сделку">Очистить</GhostBtn>
            </div>
          </div>

          {/* ---------- ОКНО 3: РЮКЗАК ИГРОКА ---------- */}
          <div className="border-2 border-edge px-2 py-2 space-y-1.5 min-w-0">
            <div className="tick-label text-teal">🎒 Ваш рюкзак {pool === undefined && <span className="text-faint normal-case">· торговец ничего не выкупает</span>}</div>
            {inv.length === 0 && <p className="text-[10px] text-faint">Рюкзак пуст: вещи падают из ящиков и покупаются у торговцев.</p>}
            {inv.map((it) => (
              <div
                key={it.id}
                draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ k: 'sell', itemId: it.id })); }}
                className="flex items-center gap-2 justify-between border-2 border-edge px-2 py-1.5 cursor-grab active:cursor-grabbing"
                title="Перетащите в СДЕЛКУ — или нажмите «Продать»"
              >
                <div className="min-w-0">
                  <div className="font-display text-[10.5px] uppercase truncate text-paper">{RUBG_ITEMS[it.kind].icon} {RUBG_ITEMS[it.kind].name}{it.uses !== undefined ? ` · заряды ${it.uses}` : ''}{it.belt ? ' · пояс' : ''}</div>
                  <div className="tick-label text-faint">выкуп: <CoinRow value={sellPrice(it)} size={10} /></div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => addSell(it.id)} disabled={pool === undefined} className={`px-1.5 py-1 border-2 border-edge text-faint hover:text-teal text-[11px] cursor-pointer ${pool === undefined ? 'opacity-30 cursor-not-allowed' : ''}`} title="Добавить в сделку">＋</button>
                  <PxBtn small color="gold" disabled={pool === undefined || pool < sellPrice(it)} className={pool !== undefined && pool >= sellPrice(it) ? '' : 'opacity-40'} onClick={() => quickSell(it)} title={pool === undefined ? 'Торговец не выкупает вещи' : pool < sellPrice(it) ? 'В кассе торговца не хватает монет' : 'Продать сразу'}>Продать</PxBtn>
                </div>
              </div>
            ))}
          </div>
        </div>
        <p className="text-[9px] text-faint leading-tight">
          Перетаскивайте товары и вещи мышью в окно СДЕЛКИ (на телефоне — кнопками «＋»), затем «🤝 Обменять». Быстрые «Купить»/«Продать» — для одной позиции.
          Скидка {disc} % уже учтена в ценах{pool !== undefined ? `, касса торговца: ${coinsStr(pool)}` : ''}. Обмен атомарен: если что-то не так — сделка не пройдёт целиком.
        </p>
      </div>
    </div>
  );
}
