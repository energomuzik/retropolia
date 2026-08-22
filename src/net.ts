import Peer, { type DataConnection } from 'peerjs';
import type { NetMsg } from './types';
import { APP_VERSION } from './types';

export interface NetInfo {
  online: boolean; // есть ли peer-соединение через интернет (PeerJS)
  local: boolean; // доступен tab-канал (BroadcastChannel)
  links: number; // число подключённых пиров (у хоста)
  signal: 'connecting' | 'online' | 'error'; // статус соединения с сигнальным сервером
  errorType?: string; // 'peer-unavailable' = комната не найдена, 'unavailable-id' = код занят, прочее = сеть
  attempts: number; // сколько раз пробовали достучаться до реле
  lastError?: string; // человекочитаемая причина последней ошибки
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

/**
 * Живые бесплатные STUN/TURN. (metered.ca закрыт — не использовать.)
 * TURN повышает шанс P2P за строгими NAT после «знакомства».
 */
const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: 'turn:relay1.expressturn.com:443', username: 'efQKXKFWYQ0P1M5J0P', credential: 'v6tVXn0f7m4V4m8d' },
    { urls: 'turn:relay1.expressturn.com:443?transport=tcp', username: 'efQKXKFWYQ0P1M5J0P', credential: 'v6tVXn0f7m4V4m8d' },
  ],
};

// Пустая строка = облако PeerJS (0.peerjs.com). Иначе — свой сервер:
//   «https://имя.glitch.me» / «имя.glitch.me»  → защищённый, порт 443 (Glitch/Render/свой домен)
//   «192.168.1.10:9000» / «localhost:9000»     → локальный PeerServer (npx peer)
function relayOpts(custom: string | undefined): { host: string; port: number; secure: boolean; path: string; config: typeof ICE } {
  const c = (custom ?? '').trim().replace(/\/+$/, '');
  if (!c) return { host: '0.peerjs.com', port: 443, secure: true, path: '/', config: ICE };
  let secure = false;
  let rest = c;
  if (/^https:\/\//i.test(c)) { secure = true; rest = c.replace(/^https:\/\//i, ''); }
  else if (/^http:\/\//i.test(c)) { rest = c.replace(/^http:\/\//i, ''); }
  const [h, p] = rest.split(':');
  let port: number;
  if (p) port = Number(p);
  else if (secure) port = 443;
  else if (/\./.test(h) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) { port = 443; secure = true; } // голый домен → https
  else port = 9000; // IP или localhost → локальный PeerServer
  return { host: h, port, secure, path: '/', config: ICE };
}

const errText: Record<string, string> = {
  'peer-unavailable': 'Комната не найдена (хост ещё не создал игру или код неверный)',
  'unavailable-id': 'Этот код комнаты уже занят другим хостом',
  'network': 'Сеть недоступна или заблокирована (VPN / файрвол / антивирус)',
  'browser-incompatible': 'Браузер не поддерживает WebRTC',
  'invalid-id': 'Неверный формат кода комнаты',
  'server-error': 'Ошибка сигнального сервера',
};

/**
 * Транспорт комнаты: PeerJS (онлайн, P2P; «знакомство» через сигнальный сервер —
 * облако 0.peerjs.com или свой `npx peer`) + BroadcastChannel (мгновенная
 * синхронизация вкладок одного браузера). Хост — авторитет: ретранслирует
 * сообщения гостей остальным пирам.
 *
 * Надёжность: при обрыве/ошибке соединение пересоздаётся автоматически,
 * причём ХОСТ переподключается с ТЕМ ЖЕ id комнаты (гости его не теряют),
 * а статус «online» не сбрасывается, пока есть живые peer-соединения.
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
  let onlineLink = false; // есть хоть одно живое peer-соединение
  let signal: NetInfo['signal'] = 'connecting';
  let errorType: string | undefined;
  let lastError: string | undefined;
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
      lastError,
    });

  // Сигнальный канал считается «на связи», если:
  //  — peer подключён к серверу И нет свежих ошибок, ИЛИ
  //  — есть живые peer-соединения (тогда «online» даже при временных сбоях сервера).
  const markSignal = (s: NetInfo['signal'], err?: string) => {
    signal = s;
    if (err !== undefined) {
      errorType = err;
      lastError = errText[err] ?? err;
    } else {
      errorType = undefined;
      lastError = undefined;
    }
    info();
  };

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

  const hasLiveLinks = () => {
    if (isHost) {
      for (const c of conns.values()) if (c.open) return true;
      return false;
    }
    return !!(hostConn && hostConn.open);
  };

  const scheduleRetry = (delay = 4000) => {
    if (closed || retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      setup();
    }, delay);
  };

  // (пере)создание пира. Хост ВСЕГДА использует id комнаты (chanName),
  // чтобы при переподключении гости находили его по тому же адресу.
  const setup = () => {
    if (closed) return;
    if (peer) {
      try { peer.destroy(); } catch { /* noop */ }
      peer = null;
    }
    attempts++;
    markSignal('connecting');

    const opts = relayOpts(customRelay);
    try {
      if (isHost) {
        // ВАЖНО: id = chanName, чтобы переподключение не теряло комнату
        peer = new Peer(chanName, { ...opts, debug: 0 });
        peer.on('open', () => markSignal('online'));
        peer.on('connection', (conn) => {
          conns.set(conn.peer, conn);
          conn.on('open', () => { onlineLink = true; markSignal('online'); });
          conn.on('data', (d) => deliver(d as NetMsg));
          conn.on('close', () => {
            conns.delete(conn.peer);
            onlineLink = hasLiveLinks();
            // обрыв пира не означает обрыв реле — не трогаем signal, пока реле живо
            info();
          });
          conn.on('error', () => { conns.delete(conn.peer); onlineLink = hasLiveLinks(); info(); });
        });
        peer.on('error', (e) => {
          const t = (e as { type?: string }).type ?? 'network';
          // Пока есть живые соединения — считаем, что всё ок (временный сбой сервера)
          if (hasLiveLinks()) { onlineLink = true; info(); return; }
          markSignal('error', t);
          if (t === 'unavailable-id') return; // код занят — не крутим бесконечно
          scheduleRetry();
        });
        peer.on('disconnected', () => {
          // потеряли связь с сигнальным сервером — пробуем восстановить
          if (!hasLiveLinks()) markSignal('connecting');
          try { peer?.reconnect(); } catch { scheduleRetry(); }
        });
      } else {
        peer = new Peer({ ...opts, debug: 0 });
        peer.on('open', () => {
          markSignal('online');
          if (!peer) return;
          const conn = peer.connect(chanName, { reliable: true });
          hostConn = conn;
          conn.on('open', () => {
            onlineLink = true;
            markSignal('online');
            while (guestQueue.length) {
              const m = guestQueue.shift()!;
              try { conn.send(m); } catch { /* noop */ }
            }
          });
          conn.on('data', (d) => deliver(d as NetMsg));
          conn.on('close', () => {
            onlineLink = false;
            // хост мог переподключиться — пробуем найти его снова
            markSignal('connecting');
            scheduleRetry(2500);
          });
          conn.on('error', () => { onlineLink = false; info(); });
        });
        peer.on('error', (e) => {
          const t = (e as { type?: string }).type ?? 'network';
          if (t === 'peer-unavailable') {
            // комната ещё не создана хостом — ждём и повторяем (хост может появиться позже)
            markSignal('error', t);
            scheduleRetry(3000);
            return;
          }
          if (hasLiveLinks()) { info(); return; }
          markSignal('error', t);
          scheduleRetry();
        });
        peer.on('disconnected', () => {
          if (!hasLiveLinks()) markSignal('connecting');
          try { peer?.reconnect(); } catch { scheduleRetry(); }
        });
      }
    } catch {
      markSignal('error', 'init');
      scheduleRetry();
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
