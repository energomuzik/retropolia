/* =====================================================================
 * RETROPOLIA game hub - WebSocket relay for online parties.
 * NO external dependencies - pure Node.js (http + crypto). Run as-is:
 *
 *     node relay-hub.js
 *
 * Port: 9001 by default, override with the PORT env variable.
 * Health check:  GET /health
 * WebSocket:     ws://HOST:9001/hub?room=CODE&id=PLAYER_ID
 *
 * Protocol (matches the in-game client in src/hub.ts):
 *   client -> server : {"type":"msg","data":NetMsg}
 *   server -> client : {"type":"msg","data":NetMsg}   (relayed to others)
 *   server -> client : {"type":"presence","members":[id,...]}
 * ===================================================================== */
'use strict';

var http = require('http');
var crypto = require('crypto');

var PORT = Number(process.env.PORT) || 9001;
var GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* room -> Map(playerId -> connection) */
var rooms = new Map();

/* Heartbeat: раз в 25 с пингуем всех. Браузеры отвечают pong'ом на уровне
   протокола автоматически; любой трафик обновляет lastSeen. Мёртвые соединения
   (полуоткрытый TCP через туннель/прокси) вычищаем через 70 с тишины —
   иначе «призраки» висят в комнате и ломают presence. */
var PING_MS = 25000;
var DEAD_MS = 70000;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/* ---------- WebSocket frame encoding (server -> client, unmasked) ---------- */
function encodeFrame(text) {
  var payload = Buffer.from(text, 'utf8');
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; /* FIN + text */
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeControl(opcode, payload) {
  var header = Buffer.alloc(2);
  header[0] = 0x80 | opcode; /* FIN + opcode */
  header[1] = payload.length; /* control frames are always < 126 bytes */
  return Buffer.concat([header, payload]);
}

/* ---------- WebSocket frame decoding (client -> server, masked) ---------- */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  var b0 = buffer[0];
  var b1 = buffer[1];
  var fin = (b0 & 0x80) !== 0;
  var opcode = b0 & 0x0f;
  var masked = (b1 & 0x80) !== 0;
  var len = b1 & 0x7f;
  var offset = 2;

  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    len = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  var mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len) return null;

  var payload = Buffer.from(buffer.subarray(offset, offset + len)); /* copy */
  if (masked) {
    for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return {
    fin: fin,
    opcode: opcode,
    payload: payload,
    rest: buffer.subarray(offset + len)
  };
}

/* ---------- room helpers ---------- */
function presence(room) {
  var members = [];
  var conns = rooms.get(room);
  if (conns) conns.forEach(function (_conn, id) { members.push(id); });
  return JSON.stringify({ type: 'presence', members: members });
}

function broadcast(room, text, exceptId) {
  var conns = rooms.get(room);
  if (!conns) return;
  var frame = encodeFrame(text);
  conns.forEach(function (conn, id) {
    if (id !== exceptId && conn.alive) {
      try { conn.socket.write(frame); } catch (e) { /* ignore */ }
    }
  });
}

/* ---------- HTTP (health check) ---------- */
var server = http.createServer(function (req, res) {
  if (req.url === '/health' || req.url === '/') {
    var total = 0;
    rooms.forEach(function (conns) { total += conns.size; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'retropolia-hub', rooms: rooms.size, players: total }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

/* ---------- WebSocket upgrade ---------- */
server.on('upgrade', function (req, socket) {
  var url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { socket.destroy(); return; }

  var room = (url.searchParams.get('room') || '').toUpperCase();
  var id = url.searchParams.get('id') || '';
  var key = req.headers['sec-websocket-key'];
  if (!room || !id || !key) { socket.destroy(); return; }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );

  if (!rooms.has(room)) rooms.set(room, new Map());
  var conns = rooms.get(room);

  /* если игрок с таким id уже в комнате - закрываем старое соединение */
  var old = conns.get(id);
  if (old) { try { old.socket.destroy(); } catch (e) { /* ignore */ } }

  var conn = { socket: socket, alive: true, lastSeen: Date.now() };
  conns.set(id, conn);
  broadcast(room, presence(room));

  socket.on('data', markSeen);

  var buffer = Buffer.alloc(0);
  var fragments = [];      /* накопление фрагментированных сообщений */
  var fragmentOpcode = 0;

  socket.on('data', function (chunk) {
    markSeen(chunk);
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      var frame = decodeFrame(buffer);
      if (!frame) break;
      buffer = Buffer.from(frame.rest);

      if (frame.opcode === 0x8) { /* close */
        try { socket.write(encodeControl(0x8, Buffer.alloc(0))); } catch (e) { /* ignore */ }
        socket.end();
        break;
      } else if (frame.opcode === 0x9) { /* ping -> pong */
        try { socket.write(encodeControl(0xA, frame.payload)); } catch (e) { /* ignore */ }
      } else if (frame.opcode === 0x0) { /* continuation */
        fragments.push(frame.payload);
        if (frame.fin) handleMessage(Buffer.concat(fragments));
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2) { /* text / binary */
        if (frame.fin) {
          handleMessage(frame.payload);
        } else {
          fragmentOpcode = frame.opcode;
          fragments = [frame.payload];
        }
      }
    }
  });

  function handleMessage(payload) {
    var text = payload.toString('utf8');
    /* пересылаем сообщение всем остальным участникам комнаты */
    broadcast(room, text, id);
  }

  function markSeen() { conn.lastSeen = Date.now(); }

  function cleanup() {
    if (!conn.alive) return;
    conn.alive = false;
    conns.delete(id);
    if (conns.size === 0) {
      rooms.delete(room);
    } else {
      broadcast(room, presence(room));
    }
  }

  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

/* ---------- heartbeat / чистка мёртвых соединений ---------- */
setInterval(function () {
  var now = Date.now();
  var ping = encodeControl(0x9, Buffer.from(String(now))); /* ping-кадр */
  rooms.forEach(function (conns, room) {
    conns.forEach(function (conn, id) {
      if (now - conn.lastSeen > DEAD_MS) {
        /* тишина дольше DEAD_MS — считаем мёртвым и рвём: сработает cleanup */
        try { conn.socket.destroy(); } catch (e) { /* ignore */ }
        conns.delete(id);
        return;
      }
      try { conn.socket.write(ping); } catch (e) { /* ignore */ }
    });
    if (conns.size === 0) rooms.delete(room);
    else broadcast(room, presence(room)); /* presence после чистки */
  });
}, PING_MS).unref();

server.listen(PORT, function () {
  console.log('RETROPOLIA hub is running on :' + PORT);
  console.log('Health: http://localhost:' + PORT + '/health');
});
