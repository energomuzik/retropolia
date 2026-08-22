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
                {m.cells.length} ячеек · бонусы {m.bonusCards.length} · ловушки {m.trapCards.length} · <span className="text-sky">квизы {m.quizzes?.length ?? 0}</span>
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

/* ---------- панель ожидания гостя с диагностикой ---------- */

function GuestWaitPanel({
  isGuest, code, signal, errorType, waited, attempts, onBack, onRetry,
}: {
  isGuest: boolean;
  code: string;
  signal: 'connecting' | 'online' | 'error';
  errorType?: string;
  waited: number;
  attempts: number;
  onBack: () => void;
  onRetry: () => void;
}) {
  // Конкретная причина, а не вечное «подключение…»
  const failed = signal === 'error';
  const roomNotFound = errorType === 'peer-unavailable';
  const tooLong = !failed && waited > 25;

  return (
    <div className="pixel-panel pixel-corners pop-in p-6 text-center">
      {!failed && !tooLong && (
        <>
          <span className="text-sky inline-block floaty">{Ic.globe(44)}</span>
          <div className="font-pixel text-[10px] text-paper mt-4 blink-hard">
            {signal === 'connecting' ? 'ПОДКЛЮЧАЕМСЯ К РЕЛЕ-СЕРВЕРУ…' : `СТУЧИМСЯ В КОМНАТУ ${code}…`}
          </div>
          {attempts > 1 && (
            <div className="tick-label text-gold mt-2">Попытка {attempts} · переподключаемся автоматически…</div>
          )}
          <p className="text-[12px] text-dim mt-3 leading-relaxed">
            {signal === 'connecting'
              ? 'Устанавливаем связь с интернет-ретранслятором PeerJS. Обычно пара секунд.'
              : 'Ретранслятор на связи, ищем хоста с таким кодом. Хост должен держать игру открытой.'}
          </p>
          <p className="tick-label text-faint mt-2">ждём {waited} с</p>
        </>
      )}

      {failed && (
        <>
          <span className="text-coral inline-block">{Ic.cross(44)}</span>
          <div className="font-display uppercase tracking-wider text-coral text-lg mt-4">
            {roomNotFound ? 'Комната не найдена' : 'Нет связи с реле-сервером'}
          </div>
          <div className="text-left text-[12.5px] text-dim mt-4 space-y-2 leading-relaxed">
            {roomNotFound ? (
              <>
                <p>Реле-сервер не знает комнату <span className="text-paper font-pixel text-[10px]">{code}</span>. Проверьте:</p>
                <p>• Хост уже <span className="text-paper">создал игру</span> и держит её открытой (не закрыл вкладку).</p>
                <p>• Код введён без ошибок — 4 символа, один в один.</p>
                <p>• У обоих игроков <span className="text-paper">одна версия игры</span> (версия зашита в код комнаты).</p>
              </>
            ) : (
              <>
                <p>Не удалось достучаться до интернет-ретранслятора PeerJS. Возможные причины:</p>
                <p>• На этом компьютере <span className="text-paper">нет интернета</span> или он закрыт (VPN, корпоративный файрвол, антивирус).</p>
                <p>• Попробуйте раздать мобильный хот-спот и отключить VPN.</p>
                <p>• Для онлайн-игры интернет нужен <span className="text-paper">обоим</span> компьютерам, даже в одной квартире.</p>
                <p>• Если облако недоступно — запустите свой реле (<span className="text-sky font-display">npx peer --port 9000</span>) и укажите его IP в Опциях → «Свой реле-сервер».</p>
              </>
            )}
          </div>
          {attempts > 1 && (
            <p className="tick-label text-faint mt-3">попытка подключения: {attempts}</p>
          )}
          <div className="mt-5 flex items-center justify-center gap-2">
            <GhostBtn onClick={onRetry}>{Ic.rotate(14)} Повторить</GhostBtn>
            <GhostBtn onClick={onBack}>{Ic.back(14)} В меню</GhostBtn>
          </div>
        </>
      )}

      {!failed && tooLong && (
        <>
          <span className="text-gold inline-block">{Ic.clock(44)}</span>
          <div className="font-display uppercase tracking-wider text-gold text-lg mt-4">Стучимся уже {waited} с</div>
          <div className="text-left text-[12.5px] text-dim mt-4 space-y-2 leading-relaxed">
            <p>Реле-сервер на связи, но хост не отвечает. Чаще всего это значит:</p>
            <p>• Хост ещё <span className="text-paper">не нажал «Создать игру»</span> или закрыл вкладку.</p>
            <p>• Вы стучитесь на <span className="text-paper">свой</span> localhost, а игра хоста запущена на другом компьютере — тогда обоим нужно открыть один и тот же сайт (см. README, «Как играть онлайн»).</p>
            <p>• Коды на двух компьютерах должны совпадать.</p>
          </div>
        </>
      )}

      {!failed && (!isGuest || tooLong) && (
        <div className="mt-6">
          <GhostBtn onClick={onBack}>{Ic.back(14)} Вернуться в меню</GhostBtn>
        </div>
      )}
    </div>
  );
}

/* ---------- лобби комнаты ---------- */

export function LobbyScreen() {
  const { session, room, netInfo, setScreen, leaveRoom, selfId, options, tokens } = useApp();
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    if (!room) setScreen('menu');
  }, [room, setScreen]);

  // счётчик ожидания для гостя, пока нет session
  useEffect(() => {
    if (!room || room.isHost || session) return;
    const t = setInterval(() => setWaited((w) => w + 1), 1000);
    return () => clearInterval(t);
  }, [room, session]);

  if (!room || !session) {
    const isGuest = room ? !room.isHost : false;
    return (
      <div className="h-full crt-grid-bg overflow-y-auto relative">
        <div className="absolute inset-0 starfield opacity-50 pointer-events-none" />
        <div className="relative z-10 max-w-xl mx-auto px-6 py-12">
          <GuestWaitPanel
            isGuest={isGuest}
            code={room?.code ?? '????'}
            signal={netInfo.signal}
            errorType={netInfo.errorType}
            waited={waited}
            attempts={netInfo.attempts}
            onBack={() => { leaveRoom(); setScreen('menu'); }}
            onRetry={() => room?.retry()}
          />
        </div>
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
          <div className="flex items-center justify-center gap-2 flex-wrap mb-2">
            <span
              className={`hud-chip pixel-corners px-2.5 py-1 font-pixel text-[8px] ${
                netInfo.signal === 'online' ? 'text-teal' : netInfo.signal === 'error' ? 'text-coral' : 'text-gold'
              }`}
            >
              {netInfo.signal === 'online' ? 'РЕЛЕ: НА СВЯЗИ' : netInfo.signal === 'error' ? 'РЕЛЕ: НЕТ СВЯЗИ' : 'РЕЛЕ: ПОДКЛ…'}
            </span>
            {options.relayHub ? (
              <span className={`hud-chip pixel-corners px-2.5 py-1 font-pixel text-[8px] ${netInfo.online ? 'text-teal' : 'text-gold'}`}>
                {netInfo.online ? 'ХАБ: НА СВЯЗИ' : 'ХАБ: ПОДКЛ…'}
              </span>
            ) : (
              <span className={`hud-chip pixel-corners px-2.5 py-1 font-pixel text-[8px] ${netInfo.online ? 'text-teal' : netInfo.local ? 'text-sky' : 'text-gold'}`}>
                {netInfo.online ? 'P2P-КАНАЛ' : netInfo.local ? 'TAB-КАНАЛ' : 'СОЕДИНЕНИЕ…'}
              </span>
            )}
            <span className="hud-chip pixel-corners px-2.5 py-1 font-pixel text-[8px] text-dim">ИГРОКОВ: {netInfo.links}</span>
          </div>
          {netInfo.signal === 'error' && (
            <div className="mb-2 space-y-2">
              <p className="text-[11px] text-coral leading-relaxed">
                Нет связи с реле-сервером — игроки с других компьютеров не подключатся.
                {netInfo.lastError ? <span className="text-paper"> {netInfo.lastError}.</span> : null}
                {' '}Отключите VPN, проверьте антивирус (сканирование HTTPS) или укажите свой реле в Опциях.
                {netInfo.attempts > 1 ? ` (идёт автопереподключение, попытка ${netInfo.attempts})` : null}
              </p>
              <div className="flex items-center justify-center gap-2">
                <GhostBtn small onClick={() => room?.retry()}>{Ic.rotate(12)} Повторить подключение</GhostBtn>
                <GhostBtn small onClick={() => setScreen('options')}>{Ic.gear(12)} Опции связи</GhostBtn>
              </div>
            </div>
          )}
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

        {/* выбор фишки */}
        <div className="mt-5 pixel-panel pixel-corners p-3.5">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-sky">{Ic.pawn(16)}</span>
            <span className="font-display uppercase text-[12px] tracking-wider text-paper">Ваша фишка на поле</span>
            <GhostBtn small className="ml-auto" onClick={() => setScreen('tokenEditor')}>{Ic.plus(12)} Создать</GhostBtn>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              onClick={() => dispatch({ t: 'token', id: selfId, tokenImg: null })}
              className={`w-14 h-14 border-[3px] flex items-center justify-center transition-all cursor-pointer ${!me?.tokenImg ? 'border-gold shadow-[0_0_14px_rgba(255,207,63,0.35)]' : 'border-edge hover:border-edge2'}`}
              style={{ background: `repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 12px 12px` }}
              title="Стандартный робот"
            >
              <span className="text-dim">{Ic.pawn(22)}</span>
            </button>
            {tokens.map((t) => (
              <button
                key={t.id}
                onClick={() => dispatch({ t: 'token', id: selfId, tokenImg: t.dataUrl })}
                className={`w-14 h-14 border-[3px] p-1 transition-all cursor-pointer ${me?.tokenImg === t.dataUrl ? 'border-gold shadow-[0_0_14px_rgba(255,207,63,0.35)]' : 'border-edge hover:border-edge2'}`}
                style={{ background: `repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 12px 12px` }}
                title={t.name}
              >
                <img src={t.dataUrl} alt={t.name} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
              </button>
            ))}
            {tokens.length === 0 && <span className="text-[11px] text-faint">Своих фишек нет — в «Редакторе фишек» можно нарисовать или загрузить PNG с прозрачностью</span>}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-3 flex-wrap">
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
