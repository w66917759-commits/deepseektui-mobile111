# DeepSeek TUI Relay for Alibaba Cloud

This is the production Relay service for Mainland China deployments. It keeps the same protocol as the desktop and mobile web clients:

- Desktop WebSocket: `GET /desktop/connect?desktopId=...&secret=...`
- Mobile pairing: `POST /api/v1/pair`
- Mobile status: `GET /api/v1/status`
- Mobile control: `POST /api/v1/session/start`, `POST /api/v1/session/stop`, `POST /api/v1/terminal/input`

## Recommended Aliyun Shape

Use a single ECS or lightweight application server first:

```text
relay.deepseektuidesktop.cn
  -> Aliyun DNS A record
  -> ECS public IP
  -> Nginx HTTPS/WSS reverse proxy
  -> Node Relay on 127.0.0.1:8787
```

For a later multi-instance deployment, move `data/relay-store.json` to Redis/RDS and use sticky routing for desktop WebSocket connections.

## Install

```bash
cd /opt/deepseek-tui-relay
npm ci --omit=dev
```

## Run

```bash
PUBLIC_ORIGIN=https://relay.deepseektuidesktop.cn \
ALLOWED_ORIGINS=https://deepseektuidesktop.cn \
RELAY_DATA_DIR=/var/lib/deepseek-tui-relay \
HOST=127.0.0.1 \
PORT=8787 \
npm start
```

## Nginx

Use `nginx.conf.example` as the site config. The important part is preserving WebSocket upgrade headers for `/desktop/connect`.

## Verify

Before Nginx:

```bash
curl -i http://127.0.0.1:8787/api/v1/health
curl -i http://127.0.0.1:8787/desktop/connect
```

After HTTPS:

```bash
curl -i https://relay.deepseektuidesktop.cn/api/v1/health
curl -i https://relay.deepseektuidesktop.cn/desktop/connect
```

The second command should return `426` with `Expected WebSocket upgrade`.

Local protocol smoke test:

```bash
npm run test:smoke
```
