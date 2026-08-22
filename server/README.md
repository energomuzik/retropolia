# RETROPOLIA — свой реле-сервер (PeerJS)

Аналог «сервера TeamSpeak»: один публичный адрес, который знают все игроки.
Свой IP раздавать никому не нужно — только имя сервера.

> Glitch закрыл хостинг проектов, поэтому ниже — только актуальные бесплатные
> варианты (Render, Koyeb) и запуск на своём компьютере через Cloudflare Tunnel.

## Вариант 1 — Render.com (рекомендуется, бесплатно)

Понадобится бесплатный аккаунт GitHub (github.com) — Render разворачивает код из репозитория.

1. **Создайте репозиторий на GitHub:**
   - войдите на https://github.com → кнопка «+» → **«New repository»**;
   - название, например `retropolia-relay`, «Public», поставьте «Add a README»;
   - создайте.
2. **Загрузите два файла из этой папки** (`server.js` и `package.json`):
   - откройте созданный репозиторий → «Add file» → **«Upload files»**;
   - перетащите `server.js` и `package.json` → «Commit changes».
3. **Подключите Render:**
   - https://render.com → «Get Started» → войдите через GitHub;
   - «New» → **«Web Service»** → выберите репозиторий `retropolia-relay`;
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** выберите **Free**;
   - «Create Web Service».
4. Через минуту появится адрес вида `https://retropolia-relay.onrender.com`.
5. **Проверка:** откройте `https://retropolia-relay.onrender.com/health` —
   должно быть `{"ok":true,...}`.

> Бесплатный Render «засыпает» после ~15 минут без активности и просыпается
> при первом подключении (~30–60 секунд). Пока комната открыта и идёт игра — не спит.

## Вариант 2 — Koyeb (бесплатно, тоже из GitHub)

1. Тот же репозиторий на GitHub (шаги 1–2 выше).
2. https://www.koyeb.com → войдите через GitHub → «Create App» → выберите репозиторий.
3. Koyeb сам определит Node.js, команду запуска брать из `package.json` (`npm start`).
4. Выберите бесплатный **«Nano»** инстанс → «Deploy».
5. Адрес вида `https://retropolia-relay-xxx.koyeb.app`, проверка — `/health`.

## Вариант 3 — свой компьютер + Cloudflare Tunnel (без раздачи IP)

Если не хочется внешнего хостинга, можно держать сервер на своём ПК и получить
публичный адрес через Cloudflare — порты открывать и IP раздавать не нужно.

1. Запустите сервер локально:
   ```
   cd server
   npm install
   npm start          # поднимется на порту 9000
   ```
2. Установите `cloudflared` (один раз): `winget install cloudflare.cloudflared`
   или скачайте с https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/.
3. В отдельном окне:
   ```
   cloudflared tunnel --url http://localhost:9000
   ```
4. В выводе появится публичный адрес вида `https://слово-слово.trycloudflare.com` —
   это и есть ваш реле. Раздайте его игрокам.
5. Проверка: `https://слово-слово.trycloudflare.com/health` → `{"ok":true,...}`.

> Минус: компьютер с сервером должен быть включён, а адрес меняется при каждом
> запуске `cloudflared tunnel`. Для постоянного адреса нужен бесплатный аккаунт
> Cloudflare + именованный туннель.

## Вариант 4 — локальная сеть (без интернета)

```
cd server
npm install
npm start          # поднимется на порту 9000
```

Адрес для игры — `IP_этого_компьютера:9000` (IP: `ipconfig` → строка «IPv4-адрес»).
Работает только для компьютеров в одной сети.

## Как подключить игру к серверу

На **всех** компьютерах: «Опции» → поле **«Свой реле-сервер»** → впишите адрес:

- Render: `https://retropolia-relay.onrender.com` (или без `https://`)
- Koyeb: `retropolia-relay-xxx.koyeb.app`
- Cloudflare Tunnel: `слово-слово.trycloudflare.com`
- локальный: `192.168.1.10:9000`

Пустое поле = публичное облако `0.peerjs.com` (работает, но часто перегружено).
