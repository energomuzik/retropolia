/**
 * RETROPOLIA — ретранслятор (signaling-сервер PeerJS).
 *
 * Это аналог «сервера TeamSpeak»: один публичный адрес, к нему подключаются
 * все игроки для знакомства, дальше игра идёт напрямую P2P.
 *
 * ЗАПУСК:
 *  — Glitch / Render / Railway / Fly.io: загрузите эту папку как проект
 *    (см. server/README.md) — сервер поднимется автоматически;
 *  — локально:  npm install && npm start   (порт 9000);
 *  — или одной командой из корня игры:  npx peer --port 9000
 *
 * В игре: Опции → «Свой реле-сервер» → впишите адрес, например
 *   https://moj-relay.glitch.me   (или  192.168.1.10:9000  для локального)
 */
const express = require('express');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = app.listen(process.env.PORT || 9000, () => {
  const port = server.address().port;
  console.log(`RETROPOLIA relay is running on :${port}`);
});

// PeerServer: path '/' — совместим и с облаком 0.peerjs.com, и с `npx peer`
app.get('/health', (_req, res) => res.json({ ok: true, name: 'retropolia-relay' }));
app.use('/', ExpressPeerServer(server, { debug: false, allow_discovery: false }));

app.get('/', (_req, res) => {
  res.type('html').send('<pre style="font-family:monospace">RETROPOLIA relay: OK</pre>');
});
