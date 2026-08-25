import { useApp, getRomData } from './store';
import { createRoom, type Room } from './net';
import { createHubRoom } from './hub';
import { applyAction, type Action } from './engine';
import type { GameMap, GameSession, NetMsg, RomDef, SaveDef, SessionSnapshot } from './types';
import { APP_VERSION } from './types';
import { idbGet, idbPut } from './db';

/* base64 <-> ArrayBuffer для передачи ромов по сети */
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}
function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* Гость сообщает прогресс загрузки: и хосту (по сети), и себе (чтобы собственная
   полоска в лобби двигалась, а не стояла на нуле). */
function reportSync(room: Room, pct: number) {
  useApp.getState().setSync(room.selfId, pct);
  room.send('action', { t: 'syncProgress', id: room.selfId, pct });
}

/* Автосейв партии хостом: чтобы при зависании/перезагрузке сессию можно было
   восстановить из «Загрузить игру». Пишем не чаще раза в 8 с и при смене хода. */
/* Автосейв: 5 циклических слотов на комнату, перезаписываются по кругу на каждом
   ходе. Идентификатор слота auto-CODE-0..4, поэтому старых копий не копится. */
const AUTO_SLOTS = 5;
let lastAutosave = 0;
let lastAutosaveTurn = -1;
let autoSlotByCode: Record<string, number> = {};
async function autosaveSession(next: GameSession) {
  if (next.phase === 'lobby') return; // в лобби сохранять нечего
  const st = useApp.getState();
  if (!st.sessionMap) return;
  const now = Date.now();
  const turnChanged = next.turn !== lastAutosaveTurn;
  if (!turnChanged && now - lastAutosave < 8000) return;
  lastAutosave = now;
  lastAutosaveTurn = next.turn;
  const slot = ((autoSlotByCode[next.code] ?? -1) + 1) % AUTO_SLOTS;
  autoSlotByCode[next.code] = slot;
  /* реальный номер хода партии (инкрементируется движком в endTurnNow) */
  const turnNo = next.turnNo ?? 1;
  const snap: SessionSnapshot = {
    id: `auto-${next.code}-${slot}`,
    name: `Автосейв · ход ${turnNo}`,
    mapName: st.sessionMap.name,
    code: next.code,
    state: next,
    createdAt: now,
    auto: true,
    slot,
  };
  try { await idbPut('sessions', snap.id, snap); } catch { /* noop */ }
}

/* Хост собирает ромы и сохранения, на которые ссылается карта, и отдаёт их гостю. */
async function sendLibrary(room: Room, map: GameMap): Promise<void> {
  const romIds = new Set<string>();
  const saveIds = new Set<string>();
  for (const c of map.cells) {
    if (c.task?.romId) romIds.add(c.task.romId);
    if (c.task?.saveId) saveIds.add(c.task.saveId);
  }
  const st = useApp.getState();
  const roms = st.roms.filter((r) => romIds.has(r.id));
  const saves = st.saves.filter((s) => saveIds.has(s.id));
  const blobs: Record<string, string> = {};
  for (const r of roms) {
    const buf = await getRomData(r.id);
    if (buf) blobs[r.id] = bufToB64(buf);
  }
  room.send('library', { roms, saves, blobs });
}

/* мини-шина для кадров трансляции */
export interface StreamPacket { from: string; name: string; data: string; ts: number; }
type StreamCb = (p: StreamPacket) => void;
const streamListeners = new Set<StreamCb>();
export const streamBus = {
  on: (cb: StreamCb) => { streamListeners.add(cb); return () => { streamListeners.delete(cb); }; },
  emit: (p: StreamPacket) => { streamListeners.forEach((cb) => cb(p)); },
};

export function dispatch(a: Action) {
  const st = useApp.getState();
  const room = st.room;
  if (!room) return;
  if (room.isHost) {
    if (!st.session || !st.sessionMap) return;
    const next = applyAction(st.session, a, st.sessionMap, st.options);
    st.setSession(next);
    room.send('state', next);
    void autosaveSession(next);
  } else {
    room.send('action', a);
  }
}

export function openRoom(code: string, isHost: boolean, initial: { session: GameSession | null; map: GameMap | null }): Room {
  const st = useApp.getState();
  st.leaveRoom();
  const app = useApp.getState();

  let room: Room;
  const onMsg = (m: NetMsg) => {
    const cur = useApp.getState();
    switch (m.t) {
      case 'map': {
        useApp.setState({ sessionMap: m.p as GameMap });
        if (!room.isHost) reportSync(room, 40);
        break;
      }
      /* синхронное перемешивание кубиков: все видят грани бросающего */
      case 'shake': {
        const d = m.p as { from: string; a: number; b: number };
        cur.setDiceShake(d);
        break;
      }
      /* восстановление партии: игрок заявляет, кем он играл */
      case 'claim': {
        const c = m.p as { curId: string; savedId: string };
        cur.setResumeClaim(c.curId, c.savedId);
        break;
      }
      /* хост прислал сохранённый ростер — гость видит, кем может заявиться */
      case 'resumeInfo': {
        const info = m.p as { players: GameSession['players']; mapName: string };
        cur.setResumeSnap({
          id: 'remote', name: 'Партия', mapName: info.mapName, code: room.code,
          state: { players: info.players } as GameSession, createdAt: Date.now(),
        });
        break;
      }
      case 'state': {
        const s = m.p as GameSession;
        if (!s || s.v !== APP_VERSION) {
          cur.toast('Версии игры не совпадают — обновление отклонено', 'err');
          return;
        }
        cur.setSession(s);
        if (cur.screen === 'lobby' && s.phase !== 'lobby') cur.setScreen('game');
        // партия восстановлена/идёт — данные сбора команды больше не нужны
        if (s.phase !== 'lobby' && (cur.resumeSnap || Object.keys(cur.resumeClaims).length)) {
          cur.setResumeSnap(null);
          useApp.setState({ resumeClaims: {} });
        }
        break;
      }
      case 'action': {
        if (!room.isHost) break;
        /* прогресс загрузки данных гостя — служебное сообщение, в движок не идёт */
        if ((m.p as { t?: string })?.t === 'syncProgress') {
          const sp = m.p as { id: string; pct: number };
          useApp.getState().setSync(sp.id, sp.pct);
          break;
        }
        const h = useApp.getState();
        if (h.session && h.sessionMap) {
          const act = m.p as Action;
          const next = applyAction(h.session, act, h.sessionMap, h.options);
          h.setSession(next);
          void autosaveSession(next);
          if (h.screen === 'lobby' && next.phase !== 'lobby') h.setScreen('game');
          // карту рассылаем только когда она реально нужна/меняется: новому игроку (hello)
          // или при создании задания на лету (setCellTask). Это резко снижает трафик.
          if (act.t === 'hello' || act.t === 'setCellTask') room.send('map', h.sessionMap);
          // при подключении игрока хост заранее раздаёт ромы и сохранения карты,
          // чтобы в игре задания открывались у всех мгновенно
          if (act.t === 'hello') void sendLibrary(room, h.sessionMap);
          // если идёт сбор команды для восстановления — гостю нужен сохранённый ростер
          if (act.t === 'hello') {
            const rs = useApp.getState().resumeSnap;
            if (rs) room.send('resumeInfo', { players: rs.state.players, mapName: rs.mapName });
          }
          room.send('state', next);
        }
        break;
      }
      /* Гость получил библиотеку ромов/сохранений от хоста — кладёт её в свою базу. */
      case 'library': {
        const lib = m.p as { roms: RomDef[]; saves: SaveDef[]; blobs: Record<string, string> };
        void (async () => {
          for (const r of lib.roms) {
            await idbPut('roms', r.id, r);
            const b = lib.blobs[r.id];
            if (b) await idbPut('blobs', `rom-${r.id}`, b64ToBuf(b));
          }
          for (const sv of lib.saves) await idbPut('saves', sv.id, sv);
          await useApp.getState().refresh();
          if (!room.isHost) reportSync(room, 100);
          useApp.getState().toast('Данные карты загружены от хоста', 'ok');
        })().catch(() => undefined);
        break;
      }
      /* Гость запросил ром/сохранение, которых нет в его IndexedDB — хост отдаёт бинарник. */
      case 'needRom': {
        if (!room.isHost) break;
        const { romId, saveId } = (m.p ?? {}) as { romId?: string; saveId?: string };
        if (!romId) break;
        void (async () => {
          const buf = await getRomData(romId);
          let saveState: unknown = null;
          if (saveId) {
            const sv = await idbGet<unknown>('saves', saveId);
            saveState = (sv as { state?: unknown } | undefined)?.state ?? null;
          }
          room.send('romData', {
            romId,
            saveId: saveId ?? null,
            romB64: buf ? bufToB64(buf) : null,
            saveState,
          });
        })();
        break;
      }
      /* Гость получил ром/сохранение от хоста — кладёт в in-memory кэш и перезапускает загрузку. */
      case 'romData': {
        if (room.isHost) break;
        const { romId, saveId, romB64, saveState } = (m.p ?? {}) as {
          romId?: string; saveId?: string | null; romB64?: string | null; saveState?: unknown;
        };
        if (!romId) break;
        if (romB64) {
          useApp.getState().cacheRomData(romId, b64ToBuf(romB64), saveId ?? undefined, saveState);
        } else {
          // у хоста нет этого рома — сообщим, чтобы не ждать вечно
          useApp.getState().toast('У хоста нет этого рома — задание не запустится', 'err');
        }
        break;
      }
      case 'stream': {
        streamBus.emit(m.p as StreamPacket);
        break;
      }
      default:
        break;
    }
  };

  const hubBase = useApp.getState().options.relayHub?.trim();
  room = hubBase
    ? createHubRoom(hubBase, code, isHost, app.selfId, onMsg, (info) => useApp.getState().setNetInfo(info))
    : createRoom(code, isHost, app.selfId, onMsg, (info) => useApp.getState().setNetInfo(info), useApp.getState().options.relay);

  app.boot(room, isHost, initial.session, initial.map);
  if (initial.session && initial.session.phase !== 'lobby') useApp.getState().setScreen('game');
  if (isHost && initial.session && initial.map) {
    room.send('map', initial.map);
    room.send('state', initial.session);
  }
  return room;
}
