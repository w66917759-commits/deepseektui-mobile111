# DeepSeek TUI Mobile

Public mobile control page for DeepSeek TUI Desktop.

The desktop app remains the runtime host. It owns the PTY, DeepSeek TUI process, API keys, workspace filesystem access, and permission model. This mobile page pairs the current browser through DeepSeek TUI Relay, shows desktop status, and can send commands back to the desktop when mobile remote control is explicitly enabled on the desktop.

Remote control stays opt-in. Pairing alone is not enough; the desktop must have both Relay and mobile remote control enabled before the mobile page can start tasks, stop tasks, or write terminal input.

## User Flow

1. Open DeepSeek TUI Desktop.
2. Open `手机控制`.
3. Enable mobile control and confirm Relay is connected.
4. Generate a phone pairing code.
5. Open this mobile page.
6. Enter the six digit pairing code and confirm the device name.
7. Pair the phone and refresh desktop status.
8. If remote control is enabled on desktop, use the mobile control panel to start a task, send terminal input, or stop the current task.

Users do not need an email/account id, public IP, public domain, or manual Bridge URL for the v1 pairing flow.

## Relay

The default Relay URL is `https://relay.deepseektuidesktop.cn`. Override it for internal testing with:

```bash
VITE_DEEPSEEK_RELAY_URL=https://relay.example.com npm run dev
```

The desktop connects outbound to Relay over WebSocket:

```text
WSS /desktop/connect
```

The phone calls Relay over HTTPS:

- `POST /api/v1/pair`
- `GET /api/v1/status`
- `POST /api/v1/session/start`
- `POST /api/v1/session/stop`
- `POST /api/v1/terminal/input`

The local desktop HTTP Bridge still exists as a development surface, but `http://localhost` and `http://127.0.0.1` are not valid public mobile addresses.

## URL Prefill

The page accepts these query parameters:

- `relay`: override the Relay URL for development.
- `code`: prefill the pairing code.
- `deviceName`: prefill the local browser device name.

Device tokens are never accepted from URL parameters and are never displayed in the UI.

Example:

```text
https://deepseektuidesktop.cn/?relay=https%3A%2F%2Frelay.deepseektuidesktop.cn&code=123456
```

## Relay Worker

`relay/worker.js` contains the Cloudflare Worker / Durable Object entry for Relay v1, and `relay/wrangler.toml` contains the minimal Cloudflare deployment binding. The Relay keeps desktop WebSocket connections in the Durable Object, stores pairing-code hashes and device-token hashes, and forwards mobile commands to the paired desktop.

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
