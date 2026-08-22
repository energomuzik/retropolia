# RETROPOLIA — свои серверы для онлайна

Два варианта: **игровой хаб** (работает прямо сейчас, бесплатно, на вашем
компьютере + туннель) и **VPS + Caddy + peer** (надёжно и постоянно, ~130–170 ₽/мес).
Netlify/Vercel для серверов **не подходят** — это статика, а сервер должен быть
постоянно живым.

---

## Вариант 0 (быстрый, бесплатный) — игровой хаб + туннель

Хаб (`relay-hub.js`) пересылает **весь трафик партии** через себя по WebSocket.
Не нужны ни облако `0.peerjs.com`, ни TURN, ни «пробивание» NAT — только одно
соединение с сервером. Запускается на вашем компьютере, а публичный адрес даёт
бесплатный туннель. Свой IP раздавать не нужно — только ссылку туннеля.

### 1. Запустите хаб

```
cd server
npm install
node relay-hub.js
```

Увидите `RETROPOLIA hub is running on :9001`. Проверка: http://localhost:9001/health
должен вернуть `{"ok":true,...}`. Окно не закрывайте, пока играете.

### 2. Дайте ему публичный адрес (туннель)

**ngrok** (надёжнее всего, нужна бесплатная регистрация на ngrok.com):

```
ngrok http 9001
```

В строке `Forwarding` будет адрес вида `https://abcd-1-2-3.ngrok-free.app` — это и есть адрес хаба.

**Без регистрации** (нужен только ssh, на Windows 10+ он встроен — команда в cmd):

```
ssh -R 80:localhost:9001 nokey@localhost.run
```

В выводе появится ссылка `https://xxxx.localhost.run`.

### 3. Подключите игру

На **всех** компьютерах: «Опции» → **«Игровой хаб»** → вставьте адрес туннеля
целиком, например `https://abcd-1-2-3.ngrok-free.app` (обязательно с `https://`).

Дальше как обычно: хост — «Создать игру», игроки — «Подключиться» по коду.
В лобби появится чип **«ХАБ: НА СВЯЗИ»**, а счётчик **«ИГРОКОВ»** покажет
реальное число подключившихся.

### Нюансы

- Адрес бесплатного туннеля меняется при перезапуске — впишите новый адрес заново.
- Весь трафик (включая трансляцию экрана) идёт через компьютер хоста и туннель —
  для 2–4 игроков хватает, для больших компаний берите VPS (Вариант 1).
- Хаб также можно поставить на VPS — тот же файл, и адрес станет постоянным.

---

## Вариант 1 (постоянный, для РФ) — VPS + Caddy + peer

Нужен VPS с «белым» IP. Недорогие варианты в РФ: **Timeweb Cloud, Selectel,
REG.RU, Beget VPS, RUVDS** (от ~130–170 ₽/мес, ОС — Ubuntu/Debian).
Домен не обязателен (см. шаг 5, вариант без домена).

Подключитесь к серверу по SSH и выполните команды блоками.

### 1. Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # v20.x
```

### 2. Скопировать папку `server/` на сервер и запустить как службу

Скопируйте всю папку `server/` (файлы `server.js`, `package.json`, `peer.service`)
на сервер, например в `/opt/retropolia-relay` (через `scp`, SFTP или git). Затем:

```bash
cd /opt/retropolia-relay
npm install                        # поставит express + peer

sudo cp peer.service /etc/systemd/system/peer.service
sudo systemctl daemon-reload
sudo systemctl enable --now peer
sudo systemctl status peer         # должно быть «active (running)»
```

Проверка: `curl http://127.0.0.1:9000/health` → `{"ok":true,"name":"retropolia-relay"}`.
Логи, если что-то не так: `journalctl -u peer -f`.

### 3. Caddy (авто-HTTPS)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### 4. Конфиг Caddy

Скопируйте `Caddyfile` (рядом с этим README) на сервер в `/etc/caddy/Caddyfile`
и отредактируйте под свой случай (внутри файла — оба варианта с пояснениями):

- **есть домен:** блок `relay.example.com { reverse_proxy 127.0.0.1:9000 }`
  (домен направьте A-записью на IP сервера; сертификат выпустится сам).
- **домена нет:** блок `https://ВАШ_IP { tls internal ... }`.

### 5. Запуск и проверка

```bash
sudo systemctl restart caddy
sudo systemctl status caddy     # «active (running)»
```

- с доменом: откройте `https://relay.example.com/peerjs` — не должно быть ошибки сертификата.
- без домена: откройте `https://ВАШ_IP` → «Дополнительно» → «Перейти (небезопасно)»
  (**каждый игрок делает это один раз** — браузер запомнит сертификат).

### 6. Подключение игры

На **всех** компьютерах: «Опции» → «Свой реле-сервер» → впишите **со схемой https://**:

- с доменом: `https://relay.example.com`
- без домена: `https://ВАШ_IP`

(Именно с `https://` — иначе браузер не откроет защищённый WebSocket.)

---

## Вариант 2 — свой ПК + Cloudflare Tunnel (если VPS не нужен)

Если у вас есть ПК, который может быть включён во время игры:

```bash
cd server && npm install && npm start        # поднимет peer на :9000
# в другом терминале:
cloudflared tunnel --url http://localhost:9000
```

`cloudflared` напечатает адрес вида `https://слово-слово.trycloudflare.com` —
его и вписывайте в «Опции → Свой реле-сервер». Свой IP не раскрывается,
порты открывать не надо. (Может не работать из сетей, блокирующих Cloudflare.)

---

## Вариант 3 — локальная сеть, без интернета

```bash
cd server && npm install && npm start        # порт 9000
```

В «Опции → Свой реле-сервер» впишите `IP_этого_компьютера:9000`
(IP: `ipconfig` → «IPv4-адрес», например `192.168.1.10:9000`).

---

## Примечания

- Пустое поле «Свой реле-сервер» = публичное облако `0.peerjs.com`
  (работает, но из РФ часто недоступно или «не знакомит» игроков).
- Игра после знакомства идёт **напрямую P2P** между игроками (WebRTC);
  реле нужен только для первоначального «знакомства».
- Если P2P не пробивается за строгим NAT, в коде уже прописаны STUN/TURN-серверы.
