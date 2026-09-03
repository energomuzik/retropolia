import type { NetInfo } from './net';
import type { NetMsg } from './types';

export interface Room {
  code: string;
  isHost: boolean;
  selfId: string;
  transport: 'peer' | 'hub';
  send: (t: string, p?: unknown) => void;
  retry: () => void;
  close: () => void;
}

/**
 * Транспорт «игровой хаб»: весь трафик партии идёт через WebSocket-сервер
 * (server/relay-hub.js). Надёжнее PeerJS: не нужны облако 0.peerjs.com,
 * TURN-серверы и «пробивание» NAT — только обычное соединение с сервером.
 */
export function createHubRoom(
  hubBase: string,
  code: string,
  isHost: boolean,
  selfId: string,
  onMsg: (m: NetMsg) => void,
  onNet: (info: NetInfo) => void,
): Room {
  const base = hubBase.trim().replace(/\/+$/, '');
  const wsUrl = `${base.replace(/^http/i, 'ws')}/hub?room=${encodeURIComponent(code)}&id=${encodeURIComponent(selfId)}`;

  let current: WebSocket | null = null;
  let closed = false;
  let open = false;
  let attempt = 0;
  let others = 0;
  let retryTimer: number | null = null;
  const seen = new Set<string>();
  // Очередь исходящих: сообщения, отправленные до открытия сокета (например,
  // «hello» гостя сразу после входа), не должны теряться — они уйдут при open.
  const outQueue: string[] = [];

  const info = () =>
    onNet({
      online: open,
      local: false,
      links: others,
      signal: open ? 'online' : 'connecting',
      errorType: undefined,
      attempts: attempt,
    });

  const scheduleRetry = () => {
    if (closed || retryTimer !== null) return;
    if (attempt >= 60) return;
    const delay = Math.min(10000, 1000 * 2 ** Math.min(attempt, 4));
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed) return;
    attempt++;
    open = false;
    info();
    let w: WebSocket;
    try {
      w = new WebSocket(wsUrl);
    } catch {
      scheduleRetry();
      return;
    }
    current = w;
    w.onopen = () => {
      if (w !== current) return;
      open = true;
      attempt = 0;
      // спустить накопившиеся сообщения (hello гостя и т.п.)
      while (outQueue.length && w.readyState === WebSocket.OPEN) {
        try { w.send(outQueue.shift()!); } catch { break; }
      }
      info();
    };
    w.onmessage = (e) => {
      if (w !== current) return;
      let m: { type?: string; from?: string; data?: NetMsg; members?: string[] } | null = null;
      try {
        m = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (!m) return;
      if (m.type === 'msg' && m.data) {
        const msg = m.data;
        if (typeof msg.mid === 'string') {
          if (seen.has(msg.mid)) return;
          seen.add(msg.mid);
          if (seen.size > 4000) seen.clear();
        }
        onMsg(msg);
      } else if (m.type === 'presence' && Array.isArray(m.members)) {
        others = Math.max(0, m.members.filter((id) => id !== selfId).length);
        info();
      }
    };
    w.onclose = () => {
      if (w !== current || closed) return;
      open = false;
      info();
      scheduleRetry();
    };
    w.onerror = () => {
      try {
        w.close();
      } catch {
        /* noop */
      }
    };
  };

  const send = (t: string, p?: unknown) => {
    const m: NetMsg = {
      mid: `${selfId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      from: selfId,
      t,
      p,
    };
    const payload = JSON.stringify({ type: 'msg', data: m });
    if (current && current.readyState === WebSocket.OPEN) {
      try {
        current.send(payload);
      } catch {
        outQueue.push(payload);
      }
    } else {
      // сокет ещё не открыт (или переподключается) — сохраним, отправим при open.
      // Лимит поднят под чанковые передачи: карта+библиотека — это сотни кусочков.
      outQueue.push(payload);
      if (outQueue.length > 3000) outQueue.splice(0, outQueue.length - 3000);
    }
    // хост — авторитет: применяет собственные действия локально
    if (isHost) onMsg(m);
  };

  connect();

  return {
    code,
    isHost,
    selfId,
    transport: 'hub' as const,
    send,
    retry: () => {
      attempt = 0;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        current?.close();
      } catch {
        /* noop */
      }
      connect();
    },
    close: () => {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      try {
        current?.close();
      } catch {
        /* noop */
      }
    },
  };
}
