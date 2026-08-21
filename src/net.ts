import Peer, { type DataConnection } from 'peerjs';
import type { NetMsg } from './types';
import { APP_VERSION } from './types';

export interface NetInfo {
  online: boolean; // есть ли peer-соединение через интернет (PeerJS)
  local: boolean; // доступен tab-канал (BroadcastChannel)
  links: number; // число подключённых пиров (у хоста)
  signal: 'connecting' | 'online' | 'error'; // статус соединения с ретранслятором (сигнальным сервером)
  errorType?: string; // 'peer-unavailable' = комната не найдена, 'unavailable-id' = код занят, прочее = сеть
  attempts: number; // сколько раз пробовали достучаться до реле
}

export interface Room {
  code: string;
  isHost: boolean;
  selfId: string;
  send: (t: string, p?: unknown) => void;
  retry: () => void; // пересоздать соединение с реле вручную
  close: () => void;
}

const prefix = (code: string) => `retropolia-v${APP_VERSION}-${code.toUpperCase()}`;

// STUN + публичный TURN — повышают шанс P2P после «знакомства» даже за строгими NAT
const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

// Пустая строка = облако PeerJS (0.peerjs.com). Иначе — свой сервер: «IP:порт» (запускается `npx peer --port 9000`).
function relayOpts(custom: string | undefined): { host: string; port: number; secure: boolean; path: string; config: typeof ICE } {
  const c = (custom ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!c) return { host: '0.peerjs.com', port: 443, secure: true, path: '/', config: ICE };
  const [h, p] = c.split(':');
  return { host: h, port: p ? Number(p) : 9000, secure: false, path: '/', config: ICE };
}

/**
 * Транспорт комнаты: PeerJS (онлайн, P2P; «знакомство» через сигнальный сервер —
 * облако 0.peerjs.com или свой `npx peer`) + BroadcastChannel (мгновенная
 * синхронизация вкладок одного браузера). Хост — авторитет: ретранслирует
 * сообщения гостей остальным пирам. При недоступности реле — автоповторы.
 */
export function createRoom(
  code: string,
  isHost: boolean,
  selfId: string,
  onMsg: (m: NetMsg) => void,
  onNet: (info: NetInfo) => void,
  customRelay?: string,
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
  let attempts = 0;
  let retryTimer: number | null = null;
  let peer: Peer | null = null;

  const info = () =>
    onNet({
      online: onlineLink,
      local: !!bc,
      links: isHost ? conns.size : hostConn && hostConn.open ? 1 : 0,
      signal,
      errorType,
      attempts,
    });

  const deliver = (m: NetMsg) => {
    if (closed || !m || typeof m.mid !== 'string') return;
    if (m.from === selfId) return;
    if (seen.has(m.mid)) return;
    seen.add(m.mid);
    if (seen.size > 4000) seen.clear();
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
      guestQueue.push(m);
    }
  };

  const send = (t: string, p?: unknown) => {
    const m: NetMsg = { mid: `${selfId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, from: selfId, t, p };
    broadcast(m);
    if (isHost) onMsg(m);
  };

  const scheduleRetry = () => {
    if (closed || retryTimer !== null) return;
    if (attempts >= 30) {
      signal = 'error';
      errorType = errorType ?? 'unreachable';
      info();
      return;
    }
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      setup();
    }, 5000);
  };

  // (пере)создание пира; вызывается при старте, сбоях и ручной кнопке «Повторить»
  const setup = () => {
    if (closed) return;
    if (peer) {
      try { peer.destroy(); } catch { /* noop */ }
      peer = null;
    }
    attempts++;
    signal = 'connecting';
    errorType = undefined;
    info();

    const opts = relayOpts(customRelay);
    try {
      if (isHost) {
        peer = new Peer(chanName, { ...opts, debug: 0 });
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
          errorType = t ?? 'network';
          if (t === 'unavailable-id') { signal = 'error'; info(); return; } // код занят — не крутим бесконечно
          scheduleRetry();
          info();
        });
        peer.on('disconnected', () => {
          try { peer?.reconnect(); } catch { scheduleRetry(); }
        });
      } else {
        peer = new Peer({ ...opts, debug: 0 });
        peer.on('open', () => {
          signal = 'online';
          errorType = undefined;
          info();
          if (!peer) return;
          const conn = peer.connect(chanName, { reliable: true });
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
          // комната может появиться позже (хост ещё создаёт) — повторяем, если это не «не найдена»
          if (t !== 'peer-unavailable') scheduleRetry();
        });
      }
    } catch {
      errorType = 'init';
      scheduleRetry();
      info();
    }
  };

  setup();
  if (bc) bc.onmessage = (e) => deliver(e.data as NetMsg);

  return {
    code,
    isHost,
    selfId,
    send,
    retry: () => {
      attempts = 0;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      setup();
    },
    close: () => {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
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
