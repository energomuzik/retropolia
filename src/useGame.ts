import { useApp } from './store';
import { createRoom, type Room } from './net';
import { applyAction, type Action } from './engine';
import type { GameMap, GameSession, NetMsg } from './types';
import { APP_VERSION } from './types';

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
        break;
      }
      case 'action': {
        if (!room.isHost) break;
        const h = useApp.getState();
        if (h.session && h.sessionMap) {
          const next = applyAction(h.session, m.p as Action, h.sessionMap, h.options);
          h.setSession(next);
          room.send('map', h.sessionMap);
          room.send('state', next);
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

  room = createRoom(
    code,
    isHost,
    app.selfId,
    onMsg,
    (info) => useApp.getState().setNetInfo(info),
  );

  app.boot(room, isHost, initial.session, initial.map);
  if (initial.session && initial.session.phase !== 'lobby') useApp.getState().setScreen('game');
  if (isHost && initial.session && initial.map) {
    room.send('map', initial.map);
    room.send('state', initial.session);
  }
  return room;
}
