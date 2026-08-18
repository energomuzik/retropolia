import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Field, GhostBtn, Ic, Panel, PxBtn } from '../ui';
import { openRoom, dispatch } from '../useGame';
import { genRoomCode } from '../net';
import { newSession } from '../engine';
import { idbDel, idbGet, idbPut, uid } from '../db';
import type { GameMap, SessionSnapshot } from '../types';
import { PLAYER_COLORS, PLAYER_NAMES } from '../types';
import { sfx } from '../sound';

/* ---------- создание игры ---------- */

export function CreateScreen() {
  const { maps, setScreen, toast } = useApp();
  const ready = maps.filter((m) => m.ready);
  const [sel, setSel] = useState<string | null>(null);

  const create = () => {
    const st = useApp.getState();
    const map = ready.find((m) => m.id === sel);
    if (!map) return;
    const code = genRoomCode();
    const session = newSession(code, map.id, st.selfId, st.options.name);
    openRoom(code, true, { session, map });
    sfx.start();
    toast(`Комната ${code} открыта`, 'ok');
  };

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-2">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-gold flex items-center gap-3">
            <span className="text-gold">{Ic.dice(22)}</span> Создание игры
          </h1>
        </div>
        <p className="text-[13px] text-dim mb-6">Выберите готовую карту — комната получит её автоматически, все игроки будут на одном поле.</p>
        <div className="grid sm:grid-cols-2 gap-4">
          {ready.map((m: GameMap) => (
            <button
              key={m.id}
              onClick={() => { setSel(m.id); sfx.hover(); }}
              className={`text-left pixel-panel pixel-corners p-4 transition-all cursor-pointer hover:-translate-y-0.5 ${sel === m.id ? 'border-gold shadow-[0_0_24px_rgba(255,207,63,0.25)]' : 'hover:border-edge2'}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-display uppercase text-paper text-lg">{m.name}</span>
                {sel === m.id && <span className="text-gold">{Ic.check(16)}</span>}
              </div>
              <div className="tick-label text-faint mt-2">
                {m.cells.length} ячеек · бонусы {m.bonusCards.length} · ловушки {m.trapCards.length}
              </div>
            </button>
          ))}
          {ready.length === 0 && (
            <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-sm sm:col-span-2">
              Готовых карт нет. Соберите карту и наполните её заданиями.
              <div className="mt-3 flex gap-3 justify-center">
                <PxBtn color="teal" onClick={() => setScreen('mapEditor')}>{Ic.map(14)} Редактор карт</PxBtn>
                <PxBtn color="magma" onClick={() => setScreen('taskEditor')}>{Ic.cart(14)} Редактор заданий</PxBtn>
              </div>
            </div>
          )}
        </div>
        {ready.length > 0 && (
          <div className="mt-6 flex justify-end">
            <PxBtn big color="gold" disabled={!sel} onClick={create}>{Ic.dice(18)} Открыть комнату</PxBtn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- подключение ---------- */

export function JoinScreen() {
  const { setScreen, toast, options } = useApp();
  const [code, setCode] = useState('');

  const join = () => {
    const c = code.trim().toUpperCase();
    if (c.length < 4) { toast('Введите код из 4 символов', 'err'); return; }
    const st = useApp.getState();
    const room = openRoom(c, false, { session: null, map: null });
    room.send('action', { t: 'hello', id: st.selfId, name: options.name });
    sfx.coin();
    toast(`Стучимся в комнату ${c}…`, 'info');
  };

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-md mx-auto px-6 py-10">
        <div className="flex items-center gap-4 mb-6">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-sky flex items-center gap-3">
            <span className="text-sky">{Ic.globe(22)}</span> Подключение
          </h1>
        </div>
        <Panel title="Код комнаты" icon={Ic.users(16)} accent="var(--color-sky)" className="pop-in">
          <div className="p-5 space-y-4">
            <Field label="Код у создателя партии">
              <input
                autoFocus
                className="field-in w-full px-4 py-3 font-pixel text-xl tracking-[0.35em] text-center uppercase"
                maxLength={4}
                placeholder="XXXX"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') join(); }}
              />
            </Field>
            <p className="text-[12px] text-dim leading-relaxed">
              Вы играете как <span className="text-paper font-display uppercase">{options.name}</span> — имя меняется в опциях.
              Соединение: P2P (PeerJS), резерв — вкладочный канал того же браузера.
            </p>
            <PxBtn color="sky" className="w-full" big onClick={join}>{Ic.play(16)} Войти в игру</PxBtn>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ---------- загруженные партии ---------- */

export function LoadScreen() {
  const { maps, setScreen, toast, refresh } = useApp();
  const [snaps, setSnaps] = useState<SessionSnapshot[]>([]);

  useEffect(() => {
    void (async () => {
      const { idbAll } = await import('../db');
      const all = await idbAll<SessionSnapshot>('sessions');
      setSnaps(all.map((e) => e.value).sort((a, b) => b.createdAt - a.createdAt));
    })();
  }, []);

  const resume = (s: SessionSnapshot) => {
    const map = maps.find((m) => m.id === s.state.mapId);
    if (!map) { toast('Карта этой партии не найдена в библиотеке', 'err'); return; }
    const st = useApp.getState();
    // восстанавливаем хостом с тем же кодом комнаты; онлайн-игроки смогут переподключиться по коду
    const session = { ...s.state, players: s.state.players.map((p, i) => (i === 0 ? { ...p, id: st.selfId, isHost: true } : p)) };
    openRoom(s.code, true, { session, map });
    void idbPut('sessions', s.id, { ...s, state: session });
    sfx.start();
    toast('Партия восстановлена — вы хост комнаты', 'ok');
  };

  const del = async (id: string) => {
    await idbDel('sessions', id);
    setSnaps((prev) => prev.filter((s) => s.id !== id));
    void refresh();
    toast('Сохранение удалено', 'err');
  };

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-6">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-dim flex items-center gap-3">
            <span>{Ic.save(22)}</span> Загрузить игру
          </h1>
        </div>
        <div className="space-y-3">
          {snaps.map((s) => (
            <div key={s.id} className="pixel-panel pixel-corners p-4 flex items-center gap-4 flex-wrap">
              <span className="text-gold">{Ic.dice(26)}</span>
              <div className="flex-1 min-w-[180px]">
                <div className="font-display uppercase text-paper">{s.name}</div>
                <div className="tick-label text-faint mt-1">
                  Карта «{s.mapName}» · комната {s.code} · {new Date(s.createdAt).toLocaleString('ru-RU')}
                </div>
                <div className="tick-label mt-1 text-dim">
                  Игроки: {s.state.players.map((p) => p.name).join(', ')} · фаза: {s.state.phase === 'playing' ? 'идёт игра' : s.state.phase === 'over' ? 'завершена' : s.state.phase}
                </div>
              </div>
              <div className="flex gap-2">
                <PxBtn color="teal" onClick={() => resume(s)}>{Ic.play(13)} Продолжить</PxBtn>
                <GhostBtn onClick={() => void del(s.id)}>{Ic.trash(13)}</GhostBtn>
              </div>
            </div>
          ))}
          {snaps.length === 0 && (
            <div className="pixel-corners border-[3px] border-dashed border-edge p-8 text-center text-dim text-sm">
              Сохранённых партий нет. Кнопка «Сохранить партию» появится во время игры (у хоста).
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- лобби комнаты ---------- */

export function LobbyScreen() {
  const { session, room, netInfo, setScreen, leaveRoom, selfId, options } = useApp();

  useEffect(() => {
    if (!room) setScreen('menu');
  }, [room, setScreen]);

  if (!room || !session) {
    return (
      <div className="h-full crt-grid-bg flex items-center justify-center">
        <div className="font-pixel text-[10px] text-dim blink-hard">ПОДКЛЮЧЕНИЕ…</div>
      </div>
    );
  }

  const me = session.players.find((p) => p.id === selfId);
  const isHost = room.isHost;

  const copyCode = () => {
    navigator.clipboard?.writeText(session.code).then(
      () => useApp.getState().toast('Код скопирован', 'ok'),
      () => useApp.getState().toast(session.code, 'info'),
    );
  };

  return (
    <div className="h-full crt-grid-bg overflow-y-auto relative">
      <div className="absolute inset-0 starfield opacity-50 pointer-events-none" />
      <div className="relative z-10 max-w-3xl mx-auto px-6 py-10">
        <div className="text-center">
          <div className="tick-label text-teal mb-2">{netInfo.online ? 'P2P-канал активен' : netInfo.local ? 'Tab-канал активен (вкладки браузера)' : 'Переподключение…'} · пиров: {netInfo.links}</div>
          <div className="font-pixel text-gold title-glow text-lg">КОМНАТА</div>
          <button onClick={copyCode} className="mt-3 inline-flex items-center gap-4 hud-chip pixel-corners px-8 py-4 cursor-pointer hover:border-gold transition-colors group">
            <span className="font-pixel text-4xl tracking-[0.3em] text-paper group-hover:text-gold transition-colors">{session.code}</span>
            <span className="tick-label text-faint group-hover:text-gold">копировать</span>
          </button>
          <p className="text-[12px] text-dim mt-3">Передайте код соперникам — раздел «Подключиться». Ресурсы у всех: 60 минут + 60 попыток.</p>
        </div>

        <div className="mt-8 grid sm:grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => {
            const p = session.players[i];
            return (
              <div
                key={i}
                className={`pixel-panel pixel-corners p-4 flex items-center gap-3 transition-all ${p ? 'pop-in' : 'opacity-40'} ${p && session.players[session.turn]?.id === p.id ? '' : ''}`}
                style={p ? { borderColor: PLAYER_COLORS[p.color] } : undefined}
              >
                <span
                  className="w-9 h-9 shrink-0 border-[3px] border-abyss shadow-[0_0_14px_rgba(0,0,0,0.5)]"
                  style={{ background: p ? PLAYER_COLORS[p.color] : 'repeating-linear-gradient(45deg,#1a2244 0 6px,#131a33 6px 12px)' }}
                />
                {p ? (
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-display uppercase text-paper truncate">{p.name}</span>
                      {p.isHost && <span className="font-pixel text-[7px] bg-gold text-abyss px-1 py-0.5">HOST</span>}
                    </div>
                    <div className="tick-label mt-0.5" style={{ color: p.ready ? '#2ee6a8' : '#8f97c9' }}>
                      {p.ready ? 'ГОТОВ' : 'НЕ ГОТОВ'} · {PLAYER_NAMES[p.color]}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1">
                    <div className="font-display uppercase text-faint text-sm">Слот {i + 1}</div>
                    <div className="tick-label text-faint">ожидание игрока…</div>
                  </div>
                )}
                {p && isHost && !p.isHost && (
                  <button onClick={() => { dispatch({ t: 'kick', id: p.id }); }} className="text-faint hover:text-coral cursor-pointer" aria-label="Выгнать">
                    {Ic.cross(14)}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-8 flex items-center justify-center gap-3 flex-wrap">
          <GhostBtn onClick={() => { leaveRoom(); setScreen('menu'); }}>{Ic.back(14)} Покинуть</GhostBtn>
          {me && !me.isHost && (
            <PxBtn color="teal" onClick={() => dispatch({ t: 'ready', id: selfId, ready: !me.ready })}>
              {Ic.check(14)} {me.ready ? 'Отменить готовность' : 'Я готов'}
            </PxBtn>
          )}
          {isHost && (
            <PxBtn
              big
              color="gold"
              onClick={() => dispatch({ t: 'start' })}
              disabled={session.players.some((p) => !p.ready)}
              title={session.players.some((p) => !p.ready) ? 'Все игроки должны быть готовы' : undefined}
            >
              {Ic.dice(18)} {session.players.length === 1 ? 'Тестовая партия (1 игрок)' : 'Начать игру'}
            </PxBtn>
          )}
        </div>
        {isHost && session.players.length === 1 && (
          <p className="text-center text-[11px] text-faint mt-3">Один игрок — запустится тестовая партия: подтверждения заданий автоматические.</p>
        )}
        <div className="text-center tick-label text-faint mt-6">
          Имя: {options.name} · версия протокола v3 · карта синхронизируется хостом
        </div>
      </div>
    </div>
  );
}

export async function saveSessionSnapshot(name: string) {
  const st = useApp.getState();
  if (!st.session || !st.sessionMap) return;
  const snap: SessionSnapshot = {
    id: uid('snap'), name, mapName: st.sessionMap.name, code: st.session.code,
    state: st.session, createdAt: Date.now(),
  };
  await idbPut('sessions', snap.id, snap);
  void idbGet; // сохраняем ссылку на импорт
  st.toast('Партия сохранена', 'ok');
}
