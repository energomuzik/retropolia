import { useMemo, useState } from 'react';
import type { Action } from '../engine';
import type { GameMap, GameSession, NpcLibEntry, NpcShopOffer, PlacedNpc, RubgItem, RubgItemKind } from '../types';
import { RUBG_ITEMS, STEAL_USES, coinsStr } from '../types';
import { CoinRow, GhostBtn, Ic, PxBtn } from '../ui';
import { sfx } from '../sound';

/* ИГРОВОЕ ОКНО ТОРГОВЛИ (v0.52.0) — ВСЁ КАРТИНКАМИ, как товары из лутбоксов
   или карточки «Монополии». Три окна, как в классических RPG:
   ┌ Товары торговца ┐  ┌ СДЕЛКА (стол) ┐  ┌ Ваш рюкзак ┐
   • предмет = КАРТОЧКА: крупный рисунок БЕЗ подписи, ЦЕНА под картинкой, запас — уголком;
   • клик по карточке — название и описание предмета пишутся ВНИЗУ окна;
   • перетащили на СТОЛ — предмет показывается картинкой (без подписи),
     а ПОД СТОЛОМ считается итог: сколько стоит вся покупка / вся продажа;
   • товары и вещи перетаскиваются мышью в СДЕЛКУ (или добавляются «＋»), после чего
     обмениваются ПАЧКОЙ кнопкой «Обменять»; для одной вещи — быстрые «Купить»/«Продать».
   Цены — с учётом скидок за сданные квесты; у торговца конечные витрина (шт) и касса. */

type Deal = { buys: { offerId: string; qty: number }[]; sells: string[] };
type Sel = { k: 'buy' | 'sell'; id: string } | null;

/* Крупный «рисунок» предмета: emoji-иконка каталога с тенью — без всяких подписей. */
const resIcon = (res: 'time' | 'tries' | 'hp' | undefined): string => (res === 'tries' ? '🎯' : res === 'hp' ? '❤️' : '⏱');
const artOf = (off: NpcShopOffer): string => (off.kind === 'item' && off.item ? RUBG_ITEMS[off.item].icon : resIcon(off.res));

/* Человекочитаемое описание предмета/ресурса — для строки ВНИЗУ окна (что это вообще). */
function itemDesc(kind: RubgItemKind): string {
  const d = RUBG_ITEMS[kind];
  if (d.radius > 0) return `оружие: выстрел снимает ${d.hp}% HP, радиус ${d.radius} кл.`;
  if (d.hp > 0) return `лечение +${d.hp}% HP — пьётся из инвентаря/пояса`;
  if (kind === 'steal') return `карта кражи: украсть предмет из кармана игрока (${STEAL_USES} применения)`;
  if (kind === 'stealth') return 'карта стелса: вас труднее найти и нельзя обокрасть';
  if (kind === 'lockpick') return 'вскрывает ящики с лутом (мини-игра «замок»), ломается при промахе';
  return 'предмет из каталога';
}
const resDesc = (off: NpcShopOffer): string => {
  const amt = Math.max(1, Math.floor(off.amount ?? 0));
  return off.res === 'tries' ? `ресурс: +${amt} попыток` : off.res === 'hp' ? `ресурс: +${amt}% HP` : `ресурс: +${amt} минут времени`;
};

/* Карточка-«монополия»: рисунок, цена под ним, запас уголком, кнопки. */
function TradeCard({ sel, soldOut, onSel, draggable, onDragStart, children, buttons }: {
  sel: boolean;
  soldOut?: boolean;
  onSel: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  children: React.ReactNode;
  buttons?: React.ReactNode;
}) {
  return (
    <div
      draggable={draggable && !soldOut}
      onDragStart={onDragStart}
      onClick={onSel}
      className={`trade-card ${sel ? 'trade-card-sel' : ''} ${soldOut ? 'trade-card-off' : ''}`}
      title={soldOut ? 'Товар разобрали' : 'Клик — что это за предмет (внизу окна) · тяните на стол СДЕЛКИ'}
    >
      {children}
      {buttons && <div className="flex items-center gap-1 justify-center pt-0.5">{buttons}</div>}
    </div>
  );
}

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
  const [sel, setSel] = useState<Sel>(null);

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

  /* подпись ВНИЗУ окна: что за предмет выбран (название + описание) */
  const selInfo = (() => {
    if (!sel) return null;
    if (sel.k === 'buy') {
      const off = offerOf(sel.id);
      if (!off) return null;
      const name = off.kind === 'item' && off.item ? (off.title?.trim() || RUBG_ITEMS[off.item].name) : (off.title?.trim() || resWhat(off));
      const desc = off.kind === 'item' && off.item ? itemDesc(off.item) : resDesc(off);
      return { icon: artOf(off), name, desc, price: unitPrice(off), priceLabel: 'цена', extra: stockOf(off) !== undefined ? ` · на витрине: ${stockOf(off)} шт` : ' · на витрине: ∞' };
    }
    const it = itemOf(sel.id);
    if (!it) return null;
    const d = RUBG_ITEMS[it.kind];
    return { icon: d.icon, name: d.name, desc: itemDesc(it.kind), price: sellPrice(it), priceLabel: 'выкуп', extra: `${it.uses !== undefined ? ` · заряды ${it.uses}` : ''}${it.belt ? ' · на поясе' : ''}` };
  })();

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

        <div className="grid md:grid-cols-[1fr_240px_1fr] gap-2.5 items-start">
          {/* ---------- ОКНО 1: ТОВАРЫ ТОРГОВЦА — КАРТОЧКАМИ ---------- */}
          <div className="border-2 border-[#ffcf3f]/40 px-2 py-2 space-y-1.5 min-w-0">
            <div className="tick-label text-gold">🏪 Товары торговца <span className="text-faint normal-case">· клик — что это · тяните на стол</span></div>
            {(npc.shop ?? []).length === 0 && <p className="text-[10px] text-faint">Витрина пуста.</p>}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {(npc.shop ?? []).map((off) => {
                const price = unitPrice(off);
                const st = stockOf(off);
                const afford = balance >= price;
                const offSale = st !== undefined && st <= 0;
                return (
                  <TradeCard
                    key={off.id}
                    sel={sel?.k === 'buy' && sel.id === off.id}
                    soldOut={offSale}
                    onSel={() => { setSel({ k: 'buy', id: off.id }); sfx.hover(); }}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify({ k: 'buy', offerId: off.id }))}
                    buttons={!offSale && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); addBuy(off.id); }}
                          className="px-1.5 border-2 border-edge text-faint hover:text-teal text-[11px] cursor-pointer"
                          title="Положить на стол СДЕЛКИ"
                        >＋</button>
                        <PxBtn small color="gold" disabled={!afford} className={!afford ? 'opacity-40' : ''} onClick={(e) => { e.stopPropagation(); quickBuy(off); }} title={afford ? 'Купить сразу за монеты' : 'Не хватает монет'}>Купить</PxBtn>
                      </>
                    )}
                  >
                    {/* запас уголком */}
                    <span className="trade-badge">{st !== undefined ? `×${Math.max(0, st)}` : '∞'}</span>
                    {/* КРУПНЫЙ РИСУНОК — без подписи */}
                    <div className="trade-art">{artOf(off)}</div>
                    {/* ЦЕНА ПОД КАРТИНКОЙ */}
                    <div className="text-center leading-none">
                      {disc > 0 && off.price > price && <span className="line-through opacity-50 mr-1"><CoinRow value={off.price} size={8} /></span>}
                      <CoinRow value={price} size={10} />
                    </div>
                  </TradeCard>
                );
              })}
            </div>
          </div>

          {/* ---------- ОКНО 2: СДЕЛКА — СТОЛ С КАРТИНКАМИ, ИТОГ ПОД СТОЛОМ ---------- */}
          <div className="border-2 border-teal/50 px-2 py-2 space-y-2 min-w-0">
            <div className="tick-label text-teal">⚖ СДЕЛКА</div>
            {/* получаете (купленное) */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver('buys'); }}
              onDragLeave={() => setDragOver((v) => (v === 'buys' ? null : v))}
              onDrop={onDrop('buys')}
              className={`border-2 border-dashed px-1.5 py-1.5 space-y-1 min-h-[64px] transition-colors ${dragOver === 'buys' ? 'border-teal bg-teal/10' : 'border-edge'}`}
            >
              <div className="tick-label text-faint">↓ со стола торговца</div>
              {buysOf.length === 0 && <p className="text-[9px] text-faint">Бросьте сюда товар — он ляжет картинкой</p>}
              {buysOf.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {buysOf.map(({ b, off }) => (
                    <div key={b.offerId} className="relative trade-mini" title="убрать со стола — ✕">
                      <span className="trade-art" style={{ fontSize: 20 }}>{artOf(off)}</span>
                      {b.qty > 1 && <span className="trade-badge">×{b.qty}</span>}
                      <button
                        onClick={() => setDeal((d) => ({ ...d, buys: d.buys.filter((x) => x.offerId !== b.offerId) }))}
                        className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 leading-none text-[8px] border border-coral/60 bg-[#0b0e1c] text-coral cursor-pointer"
                        title="Убрать из сделки"
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* ИТОГ ПОКУПКИ — под столом (без подписей на самом столе) */}
            <div className="flex justify-between text-[10px] text-dim px-0.5">
              <span>покупка</span>
              <span className={pay > 0 ? 'text-gold' : 'text-faint'}>{pay > 0 ? <>−<CoinRow value={pay} size={10} /></> : '—'}</span>
            </div>
            {/* отдаёте (продажа) */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver('sells'); }}
              onDragLeave={() => setDragOver((v) => (v === 'sells' ? null : v))}
              onDrop={onDrop('sells')}
              className={`border-2 border-dashed px-1.5 py-1.5 space-y-1 min-h-[64px] transition-colors ${dragOver === 'sells' ? 'border-gold bg-gold/10' : 'border-edge'}`}
            >
              <div className="tick-label text-faint">↑ со своего стола</div>
              {sellsOf.length === 0 && <p className="text-[9px] text-faint">Бросьте сюда вещь из рюкзака</p>}
              {sellsOf.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {sellsOf.map((it) => (
                    <div key={it.id} className="relative trade-mini" title={RUBG_ITEMS[it.kind].name}>
                      <span className="trade-art" style={{ fontSize: 20 }}>{RUBG_ITEMS[it.kind].icon}</span>
                      <button
                        onClick={() => setDeal((d) => ({ ...d, sells: d.sells.filter((x) => x !== it.id) }))}
                        className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 leading-none text-[8px] border border-coral/60 bg-[#0b0e1c] text-coral cursor-pointer"
                        title="Убрать из сделки"
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* ИТОГ ВЫРУЧИ — под вашим столом */}
            <div className="flex justify-between text-[10px] text-dim px-0.5">
              <span>выручка</span>
              <span className={gain > 0 ? 'text-teal' : 'text-faint'}>{gain > 0 ? <>+<CoinRow value={gain} size={10} /></> : '—'}</span>
            </div>
            {/* общий итог обмена */}
            <div className="border-2 border-edge px-1.5 py-1 space-y-0.5 text-[10px]">
              <div className="flex justify-between text-paper"><span>итого</span><span className={net < 0 ? 'text-gold' : net > 0 ? 'text-teal' : ''}>{net === 0 ? 'без денег' : <><CoinRow value={Math.abs(net)} size={11} /> {net < 0 ? 'из кармана' : 'в карман'}</>}</span></div>
            </div>
            <div className="flex items-center gap-1.5">
              <PxBtn color="teal" className="flex-1" disabled={!canExchange} onClick={exchange} title={canExchange ? 'Совершить обмен' : !stockOk ? 'На витрине не хватает товара' : !coinsOk ? 'Не хватает монет' : !poolOk ? 'У торговца не хватает монет на выкуп' : 'Положите что-нибудь на столы'}>🤝 Обменять</PxBtn>
              <GhostBtn small onClick={clearDeal} title="Очистить оба стола">Очистить</GhostBtn>
            </div>
          </div>

          {/* ---------- ОКНО 3: РЮКЗАК — КАРТОЧКАМИ ---------- */}
          <div className="border-2 border-edge px-2 py-2 space-y-1.5 min-w-0">
            <div className="tick-label text-teal">🎒 Ваш рюкзак {pool === undefined && <span className="text-faint normal-case">· торговец ничего не выкупает</span>}</div>
            {inv.length === 0 && <p className="text-[10px] text-faint">Рюкзак пуст: вещи падают из ящиков и покупаются у торговцев.</p>}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {inv.map((it) => (
                <TradeCard
                  key={it.id}
                  sel={sel?.k === 'sell' && sel.id === it.id}
                  onSel={() => { setSel({ k: 'sell', id: it.id }); sfx.hover(); }}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify({ k: 'sell', itemId: it.id }))}
                  buttons={pool !== undefined && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); addSell(it.id); }}
                        disabled={pool === undefined}
                        className={`px-1.5 border-2 border-edge text-faint hover:text-teal text-[11px] cursor-pointer ${pool === undefined ? 'opacity-30 cursor-not-allowed' : ''}`}
                        title="Положить на свой стол СДЕЛКИ"
                      >＋</button>
                      <PxBtn small color="gold" disabled={pool < sellPrice(it)} className={pool >= sellPrice(it) ? '' : 'opacity-40'} onClick={(e) => { e.stopPropagation(); quickSell(it); }} title={pool < sellPrice(it) ? 'В кассе торговца не хватает монет' : 'Продать сразу'}>Продать</PxBtn>
                    </>
                  )}
                >
                  {(it.uses !== undefined || it.belt) && <span className="trade-badge">{it.belt ? 'пояс' : `×${it.uses}`}</span>}
                  <div className="trade-art">{RUBG_ITEMS[it.kind].icon}</div>
                  <div className="text-center leading-none"><CoinRow value={sellPrice(it)} size={10} /></div>
                </TradeCard>
              ))}
            </div>
          </div>
        </div>

        {/* ---------- ПОДПИСЬ ВНИЗУ ОКНА: что за предмет выбран ---------- */}
        <div className="border-2 border-edge bg-[rgba(7,9,18,0.6)] px-2 py-1.5 min-h-[34px] flex items-center gap-2">
          {selInfo ? (
            <>
              <span className="trade-art shrink-0" style={{ fontSize: 22 }}>{selInfo.icon}</span>
              <span className="text-[11px] text-paper leading-tight">
                <b className="font-display uppercase text-gold">{selInfo.name}</b>
                <span className="text-dim"> — {selInfo.desc}</span>
                <span className="text-faint"> · {selInfo.priceLabel}: {selInfo.priceLabel === 'цена' ? <><CoinRow value={selInfo.price} size={9} /></> : <CoinRow value={selInfo.price} size={9} />}{selInfo.extra}</span>
              </span>
            </>
          ) : (
            <span className="text-[10px] text-faint leading-tight">Кликните по предмету — здесь напишется, что это такое. Перетаскивайте товары и вещи на столы СДЕЛКИ (на телефоне — кнопками «＋»), затем «🤝 Обменять». Скидка {disc} % учтена в ценах{pool !== undefined ? `, касса торговца: ${coinsStr(pool)}` : ''}.</span>
          )}
        </div>
      </div>
    </div>
  );
}
