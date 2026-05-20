const encoder = new TextEncoder();
const pairingTtlMs = 10 * 60 * 1000;
const maxPairingAttempts = 20;

export default {
  fetch(request, env) {
    const id = env.DEEPSEEK_TUI_RELAY.idFromName("global");
    return env.DEEPSEEK_TUI_RELAY.get(id).fetch(request);
  }
};

export class DeepSeekTuiRelay {
  constructor(state) {
    this.state = state;
    this.desktops = new Map();
    this.pendingCommands = new Map();
    this.attempts = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return emptyResponse(204);

    if (url.pathname === "/desktop/connect") {
      return this.connectDesktop(request);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/pair") {
      return this.pairPhone(request);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/status") {
      return this.forwardPhoneCommand(request, "status");
    }
    if (request.method === "POST" && url.pathname === "/api/v1/session/start") {
      return this.forwardPhoneCommand(request, "session.start", await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/session/stop") {
      return this.forwardPhoneCommand(request, "session.stop", await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/terminal/input") {
      return this.forwardPhoneCommand(request, "terminal.input", await readJson(request));
    }

    return json({ ok: false, error: "Not found" }, 404);
  }

  async connectDesktop(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return json({ ok: false, error: "Expected WebSocket upgrade" }, 426);
    }

    const url = new URL(request.url);
    const desktopId = trim(url.searchParams.get("desktopId"), 160);
    const secret = trim(url.searchParams.get("secret"), 240);
    if (!desktopId || !secret) {
      return json({ ok: false, error: "Missing desktop id or secret" }, 400);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const relaySessionId = createId("relay");
    this.desktops.set(desktopId, { desktopId, relaySessionId, secret, socket: server, status: null });

    server.addEventListener("message", (event) => {
      this.handleDesktopMessage(desktopId, event.data).catch(() => undefined);
    });
    server.addEventListener("close", () => {
      const current = this.desktops.get(desktopId);
      if (current?.relaySessionId === relaySessionId) this.desktops.delete(desktopId);
    });

    server.send(JSON.stringify({ type: "relay.ready", desktopId, relaySessionId }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleDesktopMessage(desktopId, raw) {
    const message = JSON.parse(String(raw || "{}"));
    const desktop = this.desktops.get(desktopId);
    if (!desktop) return;

    if (message.type === "desktop.hello") {
      desktop.status = message.status || null;
      desktop.secret = message.secret || desktop.secret;
      return;
    }
    if (message.type === "pairing.start") {
      const pairing = {
        desktopId,
        relaySessionId: message.relaySessionId || desktop.relaySessionId,
        codeHash: message.codeHash,
        codePreview: message.codePreview,
        expiresAt: message.expiresAt,
        createdAt: message.createdAt || new Date().toISOString()
      };
      await this.state.storage.put(`pairing:${pairing.relaySessionId}`, pairing);
      return;
    }
    if (message.type === "command.result") {
      const pending = this.pendingCommands.get(message.requestId);
      if (pending) {
        pending.resolve(message.payload);
        this.pendingCommands.delete(message.requestId);
      }
    }
  }

  async pairPhone(request) {
    const body = await readJson(request);
    const attemptKey = request.headers.get("cf-connecting-ip") || "global";
    if (!this.allowPairingAttempt(attemptKey)) {
      return json({ ok: false, error: "Too many pairing attempts" }, 429);
    }

    const pairingCode = trim(body.pairingCode, 32).replace(/\s+/g, "");
    if (!/^\d{6}$/.test(pairingCode)) {
      return json({ ok: false, error: "Invalid pairing code" }, 400);
    }

    const codeHash = await sha256Hex(pairingCode);
    const pairings = await this.state.storage.list({ prefix: "pairing:" });
    let matched = null;
    for (const [key, pairing] of pairings) {
      if (Date.parse(pairing.expiresAt) <= Date.now()) {
        await this.state.storage.delete(key);
        continue;
      }
      if (pairing.codeHash === codeHash) {
        matched = pairing;
        break;
      }
    }
    if (!matched) return json({ ok: false, error: "No active pairing code" }, 400);

    const desktop = this.desktops.get(matched.desktopId);
    if (!desktop) return json({ ok: false, error: "Desktop is offline" }, 400);

    const deviceToken = createToken();
    const tokenHash = await sha256Hex(deviceToken);
    const now = new Date().toISOString();
    const device = {
      id: createId("device"),
      name: trim(body.deviceName || "Mobile Web", 120),
      platform: trim(body.platform || "web", 40),
      clientDeviceId: trim(body.clientDeviceId, 160),
      desktopId: matched.desktopId,
      relaySessionId: matched.relaySessionId,
      tokenHash,
      pairedAt: now,
      lastSeenAt: now,
      enabled: true
    };

    await this.state.storage.delete(`pairing:${matched.relaySessionId}`);
    await this.state.storage.put(`device:${tokenHash}`, device);
    desktop.socket.send(JSON.stringify({ type: "device.paired", device, tokenHash }));

    return json({
      ok: true,
      device: publicDevice(device),
      deviceToken,
      deviceId: device.id,
      desktopId: device.desktopId,
      relaySessionId: device.relaySessionId,
      status: desktop.status
    });
  }

  async forwardPhoneCommand(request, command, payload) {
    const device = await this.authenticateDevice(request);
    if (!device) return json({ ok: false, error: "Unauthorized" }, 401);

    const desktop = this.desktops.get(device.desktopId);
    if (!desktop) return json({ ok: false, error: "Desktop is offline" }, 503);

    const requestId = createId("cmd");
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        resolve({ ok: false, error: "Desktop command timed out" });
      }, 30000);
      this.pendingCommands.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        }
      });
      desktop.socket.send(JSON.stringify({ type: "command", requestId, command, device: publicDevice(device), payload }));
    });

    return json(result, result?.status && result.status >= 400 ? result.status : 200);
  }

  async authenticateDevice(request) {
    const auth = request.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return null;

    const tokenHash = await sha256Hex(token);
    const device = await this.state.storage.get(`device:${tokenHash}`);
    if (!device || device.enabled === false) return null;
    device.lastSeenAt = new Date().toISOString();
    await this.state.storage.put(`device:${tokenHash}`, device);
    return device;
  }

  allowPairingAttempt(key) {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || current.expiresAt <= now) {
      this.attempts.set(key, { count: 1, expiresAt: now + pairingTtlMs });
      return true;
    }
    current.count += 1;
    return current.count <= maxPairingAttempts;
  }
}

async function readJson(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function emptyResponse(status) {
  return new Response(null, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    }
  });
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    desktopId: device.desktopId,
    relaySessionId: device.relaySessionId,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    enabled: device.enabled
  };
}

function createToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createId(prefix) {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${suffix}`;
}

function trim(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}
