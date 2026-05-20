# DeepSeek TUI Mobile Pairing

Public static pairing page for DeepSeek TUI Desktop.

The desktop app remains the runtime host. It owns the PTY, DeepSeek TUI process, API keys, workspace filesystem access, and permission model. This mobile page only pairs the current browser with a user's desktop bridge and shows read-only bridge status.

It does not expose task start, task stop, terminal input, or live terminal streaming.

## User Flow

1. Open DeepSeek TUI Desktop.
2. Open `手机控制`.
3. Sign in with the email/account id that will be typed on the phone.
4. Enable the bridge.
5. Generate a phone pairing code.
6. Open this mobile pairing page.
7. Enter the HTTPS Bridge URL, email/account id, device name, and pairing code.
8. Pair the phone and refresh read-only status.

## Bridge URL

For public mobile use, the Bridge URL should be HTTPS. A typical local tunnel target is:

```bash
cloudflared tunnel --url http://127.0.0.1:8765
```

Paste the generated `https://...` tunnel URL into the mobile page.

Related public desktop domain: `https://deepseektuidesktop.cn`. If this domain is configured as the HTTPS bridge or relay entry, paste that origin into the mobile page's Bridge URL field.

Do not expose the bridge port directly to the public internet. A public HTTPS page will block ordinary `http://` bridge URLs because browsers enforce mixed-content rules. `http://localhost` and `http://127.0.0.1` are only intended for local development.

## URL Prefill

The page accepts these query parameters:

- `bridge`: prefill the Bridge URL.
- `account`: prefill the email/account id.
- `code`: prefill the pairing code.
- `deviceName`: prefill the local browser device name.

Device tokens are never accepted from URL parameters and are never displayed in the UI.

Example:

```text
https://example.com/?bridge=https%3A%2F%2Fyour-tunnel.example.com&account=user%40example.com&code=123456
```

## API Surface

The mobile page only calls:

- `POST /api/v1/auth/pair`
- `GET /api/v1/status`

It intentionally does not call:

- `GET /api/v1/events`
- `POST /api/v1/session/start`
- `POST /api/v1/session/stop`
- `POST /api/v1/terminal/input`

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm test
npm run typecheck
npm run build
```
