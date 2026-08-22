/**
 * RETROPOLIA — игровой хаб (WebSocket-ретранслятор).
 *
 * В отличие от PeerJS-реле (которое только «знакомит» игроков, а дальше они
 * соединяются напрямую P2P), хаб пересылает ВЕСЬ трафик партии через себя.
 * Поэтому не нужны ни облако 0.peerjs.com, ни TURN-серверы, ни «пробивание» NAT —
 * достаточно обычного WebSocket-соединения с сервером.
 *
 * ЗАПУСК:
 *   npm install
 *   node relay-hub.js            # слушает порт 9001 (или $PORT)
 *
 * ПУБЛИЧНЫЙ АДРЕС (чтобы игроки из интернета могли подключиться):
 *   — ngrok:      ngrok http 9001   → https://xxxx.ngrok-free.app
 *   — localhost.run (без регистрации, нужен ssh):
 *                 ssh -R 80:localhost:9001 nokey@localhost.run
 *
 * В игре: Опции → «Игровой хаб» → вписать https://xxxx.ngrok-free.app
 */
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/hub', maxPayload: 4 * 1024 * 1024 });

/** code комнаты -> Map<clientId, ws> */
const rooms = new Map();

function membersOf(code) {
  if (!rooms.has(code)) rooms.set(code, new Map());
  return rooms.get(code);
}

function broadcastPresence(code) {
  const members = rooms.get(code);
  if (!members) return;
  const ids = [...members.keys()];
  const out = JSON.stringify({ type: 'presence', members: ids });
  members.forEach((w) => {
    if (w.readyState === 1) w.send(out);
  });
}

function relayToOthers(code, fromId, payload) {
  const members = rooms.get(code);
  if (!members) return;
  members.forEach((w, id) => {
    if (id !== fromId && w.readyState === 1) {
      try { w.send(payload); } catch { /* noop */ }
    }
  });
}

wss.on('connection', (ws, req) => {
  let room = null;
  let clientId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // параметры комнаты — из query: /hub?room=XXXX&id=p-...
  try {
    const url = new URL(req.url, 'http://x');
    room = (url.searchParams.get('room') || '').toUpperCase().slice(0, 16);
    clientId = (url.searchParams.get('id') || '').slice(0, 64);
  } catch { room = null; }

  if (!room || !clientId) {
    try { ws.close(4000, 'room and id are required'); } catch { /* noop */ }
    return;
  }

  const members = membersOf(room);
  const old = members.get(clientId);
  if (old && old !== ws) {
    try { old.close(4001, 'reconnected'); } catch { /* noop */ }
  }
  members.set(clientId, ws);
  broadcastPresence(room);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || m.type !== 'msg' || !m.data) return;
    relayToOthers(room, clientId, JSON.stringify({ type: 'msg', from: clientId, data: m.data }));
  });

  const leave = () => {
    const cur = rooms.get(room);
    if (cur && cur.get(clientId) === ws) {
      cur.delete(clientId);
      if (cur.size === 0) rooms.delete(room);
      else broadcastPresence(room);
    }
  };
  ws.on('close', leave);
  ws.on('error', leave);

  try { ws.send(JSON.stringify({ type: 'joined', room, id: clientId })); } catch { /* noop */ }
});

// heartbeat: глушим мёртвые соединения
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      try { ws.terminate(); } catch { /* noop */ }
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  });
}, 25000);

app.get('/health', (_req, res) =>
  res.json({ ok: true, name: 'retropolia-hub', rooms: rooms.size, sockets: wss.clients.size }),
);
app.get('/', (_req, res) => {
  res.type('html').send(
    '<pre style="font-family:monospace;background:#0b0e1c;color:#ffcf3f;padding:16px">RETROPOLIA hub: OK\nws-path: /hub?room=XXXX&id=...</n</pre>',
  );
});

const PORT = process.env.PORT || 9001;
server.listen(PORT, () => {
  console.log(`RETROPOLIA hub is running on :${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
