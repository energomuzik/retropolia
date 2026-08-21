import Peer, { type DataConnection } from 'peerjs';
import type { NetMsg } from './types';
import { APP_VERSION } from './types';

export interface NetInfo {
  online: boolean; // есть ли peer-соединение через интернет (PeerJS)
  local: boolean; // доступен tab-канал (BroadcastChannel)
  links: number; // число подключённых пиров (у хоста)
  signal: 'connecting' | 'online' | 'error'; // статус соединения с ретранслятором PeerJS
  errorType?: string; // 'peer-unavailable' = комната не найдена, 'unavailable-id' = код занят, прочее = сеть
}

export interface Room {
  code: string;
  isHost: boolean;
  selfId: string;
  send: (t: string, p?: unknown) => void;
  close: () => void;
}

const prefix = (code: string) => `retropolia-v${APP_VERSION}-${code.toUpperCase()}`;

/**
 * Транспорт комнаты: PeerJS (онлайн, P2P через облачный брокер) +
 * BroadcastChannel (мгновенная синхронизация вкладок одного браузера —
 * идеальный режим для теста на одной машине). Сообщения дедуплицируются по mid.
 * Хост — авторитет: ретранслирует сообщения гостей остальным пирам.
 */
export function createRoom(
  code: string,
  isHost: boolean,
  selfId: string,
  onMsg: (m: NetMsg) => void,
  onNet: (info: NetInfo) => void,
): Room {
  const chanName = prefix(code);
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel(chanName) : null;
  const seen = new Set<string>();
  let closed = false;
  const conns = new Map<string, DataConnection>();
  let hostConn: DataConnection | null = null;
  let onlineLink = false;
  let signal: NetInfo['signal'] = 'connecting';
  let errorType: string | undefined;

  const info = () =>
    onNet({
      online: onlineLink,
      local: !!bc,
      links: isHost ? conns.size : hostConn && hostConn.open ? 1 : 0,
      signal,
      errorType,
    });

  const deliver = (m: NetMsg) => {
    if (closed || !m || typeof m.mid !== 'string') return;
    if (m.from === selfId) return;
    if (seen.has(m.mid)) return;
    seen.add(m.mid);
    if (seen.size > 4000) seen.clear();
    // хост ретранслирует гостевые сообщения другим пирам
    if (isHost) relay(m);
    onMsg(m);
  };

  const relay = (m: NetMsg) => {
    conns.forEach((c) => {
      if (c.open && c.peer !== m.from) {
        try { c.send(m); } catch { /* noop */ }
      }
    });
  };

  const guestQueue: NetMsg[] = [];
  const broadcast = (m: NetMsg) => {
    if (bc) {
      try { bc.postMessage(m); } catch { /* noop */ }
    }
    if (isHost) {
      conns.forEach((c) => {
        if (c.open) {
          try { c.send(m); } catch { /* noop */ }
        }
      });
    } else if (hostConn && hostConn.open) {
      try { hostConn.send(m); } catch { /* noop */ }
    } else if (hostConn) {
      guestQueue.push(m); // дождёмся открытия P2P-канала
    }
  };

  const send = (t: string, p?: unknown) => {
    const m: NetMsg = { mid: `${selfId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, from: selfId, t, p };
    broadcast(m);
    // Хост — авторитет: применяет собственные действия локально (гостям придут его state-эхо).
    // Гости ждут подтверждение от хоста, чтобы не рассинхронизироваться.
    if (isHost) onMsg(m);
  };

  let peer: Peer | null = null;
  try {
    if (isHost) {
      peer = new Peer(chanName, { debug: 0 });
      peer.on('open', () => { signal = 'online'; errorType = undefined; info(); });
      peer.on('connection', (conn) => {
        conns.set(conn.peer, conn);
        conn.on('open', () => { onlineLink = true; info(); });
        conn.on('data', (d) => deliver(d as NetMsg));
        conn.on('close', () => { conns.delete(conn.peer); onlineLink = conns.size > 0; info(); });
        conn.on('error', () => { conns.delete(conn.peer); info(); });
      });
      peer.on('error', (e) => {
        const t = (e as { type?: string }).type;
        if (t === 'unavailable-id') { signal = 'error'; errorType = 'unavailable-id'; }
        else if (t !== 'peer-unavailable') { signal = signal === 'online' ? 'online' : 'error'; errorType = t ?? 'network'; }
        info();
      });
      peer.on('disconnected', () => { try { peer?.reconnect(); } catch { /* noop */ } });
    } else {
      peer = new Peer({ debug: 0 });
      peer.on('open', () => {
        signal = 'online';
        errorType = undefined;
        info();
        const conn = peer!.connect(chanName, { reliable: true });
        hostConn = conn;
        conn.on('open', () => {
          onlineLink = true;
          while (guestQueue.length) {
            const m = guestQueue.shift()!;
            try { conn.send(m); } catch { /* noop */ }
          }
          info();
        });
        conn.on('data', (d) => deliver(d as NetMsg));
        conn.on('close', () => { onlineLink = false; info(); });
        conn.on('error', () => { onlineLink = false; info(); });
      });
      peer.on('error', (e) => {
        const t = (e as { type?: string }).type;
        signal = 'error';
        errorType = t === 'peer-unavailable' ? 'peer-unavailable' : (t ?? 'network');
        info();
      });
    }
  } catch {
    peer = null;
  }

  if (bc) bc.onmessage = (e) => deliver(e.data as NetMsg);

  setTimeout(info, 400);
  setTimeout(info, 1600);

  return {
    code,
    isHost,
    selfId,
    send,
    close: () => {
      closed = true;
      try { bc?.close(); } catch { /* noop */ }
      try { peer?.destroy(); } catch { /* noop */ }
      conns.clear();
    },
  };
}

export function genRoomCode(): string {
  const abc = 'ABCDEFGHKMNPRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
