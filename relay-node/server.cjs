const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "https://relay.deepseektuidesktop.cn").replace(/\/+$/, "");
const DATA_DIR = process.env.RELAY_DATA_DIR || path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "relay-store.json");
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = Number(process.env.MAX_PAIRING_ATTEMPTS || 20);
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 30_000);
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_ALLOWED_ORIGINS = [
  "https://deepseektuidesktop.cn",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const desktops = new Map();
const pairings = new Map();
const pendingCommands = new Map();
const attempts = new Map();
let store = readStore();

const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((error) => {
    sendJson(req, res, 500, { ok: false, error: error.message || "Relay request failed" });
  });
});
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = parseRequestUrl(req);
  if (url.pathname !== "/desktop/connect") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => connectDesktop(req, ws, url));
});

server.listen(PORT, HOST, () => {
  console.log(`DeepSeek TUI Relay listening on http://${HOST}:${PORT}`);
});

setInterval(cleanupExpiredState, 60_000).unref();

async function handleHttpRequest(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!originAllowed(req)) {
    sendJson(req, res, 403, { ok: false, error: "Origin is not allowed" });
    return;
  }

  const url = parseRequestUrl(req);
  if ((url.pathname === "/health" || url.pathname === "/api/v1/health") && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      at: now(),
      desktops: desktops.size,
      pairings: pairings.size,
      devices: store.devices.length
    });
    return;
  }

  if (url.pathname === "/desktop/connect") {
    sendJson(req, res, 426, { ok: false, error: "Expected WebSocket upgrade" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/pair") {
    const body = await readJsonBody(req);
    const result = await pairPhone(req, body);
    sendJson(req, res, result.ok ? 200 : result.status || 400, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/status") {
    const result = await forwardPhoneCommand(req, "status");
    sendJson(req, res, statusCodeFor(result), result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/session/start") {
    const result = await forwardPhoneCommand(req, "session.start", await readJsonBody(req));
    sendJson(req, res, statusCodeFor(result), result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/session/stop") {
    const result = await forwardPhoneCommand(req, "session.stop", await readJsonBody(req));
    sendJson(req, res, statusCodeFor(result), result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/terminal/input") {
    const result = await forwardPhoneCommand(req, "terminal.input", await readJsonBody(req));
    sendJson(req, res, statusCodeFor(result), result);
    return;
  }

  sendJson(req, res, 404, { ok: false, error: "Not found" });
}

function connectDesktop(req, ws, url) {
  const desktopId = trim(url.searchParams.get("desktopId"), 160);
  const secret = trim(url.searchParams.get("secret"), 240);
  if (!desktopId || !secret) {
    ws.close(1008, "Missing desktop id or secret");
    return;
  }

  const relaySessionId = createId("relay");
  const previous = desktops.get(desktopId);
  if (previous?.ws && previous.ws !== ws) {
    try {
      previous.ws.close(1000, "Replaced by newer desktop connection");
    } catch {
      // Ignore stale socket close failures.
    }
  }

  const desktop = { desktopId, relaySessionId, secret, status: null, ws };
  desktops.set(desktopId, desktop);

  ws.on("message", (raw) => handleDesktopMessage(desktopId, raw).catch(() => undefined));
  ws.on("close", () => {
    const current = desktops.get(desktopId);
    if (current?.relaySessionId === relaySessionId) desktops.delete(desktopId);
  });
  ws.on("error", () => undefined);
  sendWs(ws, { type: "relay.ready", desktopId, relaySessionId });
}

async function handleDesktopMessage(desktopId, raw) {
  const message = JSON.parse(String(raw || "{}"));
  const desktop = desktops.get(desktopId);
  if (!desktop) return;

  if (message.type === "desktop.hello") {
    desktop.status = message.status || null;
    desktop.secret = message.secret || desktop.secret;
    return;
  }

  if (message.type === "pairing.start") {
    const relaySessionId = trim(message.relaySessionId || desktop.relaySessionId, 160);
    const pairing = {
      desktopId,
      relaySessionId,
      codeHash: trim(message.codeHash, 128),
      codePreview: trim(message.codePreview, 16),
      expiresAt: trim(message.expiresAt, 80),
      createdAt: trim(message.createdAt || now(), 80)
    };
    pairings.set(relaySessionId, pairing);
    return;
  }

  if (message.type === "command.result") {
    const requestId = trim(message.requestId, 120);
    const pending = pendingCommands.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingCommands.delete(requestId);
    pending.resolve(message.payload);
  }
}

async function pairPhone(req, body) {
  const attemptKey = clientIp(req);
  if (!allowPairingAttempt(attemptKey)) {
    return { ok: false, error: "Too many pairing attempts", status: 429 };
  }

  cleanupExpiredState();
  const pairingCode = trim(body.pairingCode || body.code, 32).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(pairingCode)) {
    return { ok: false, error: "Invalid pairing code", status: 400 };
  }

  const codeHash = hashSecret(pairingCode);
  const pairing = Array.from(pairings.values()).find((candidate) => candidate.codeHash === codeHash);
  if (!pairing) {
    return { ok: false, error: "No active pairing code", status: 400 };
  }

  const desktop = desktops.get(pairing.desktopId);
  if (!desktop) {
    return { ok: false, error: "Desktop is offline", status: 400 };
  }

  const deviceToken = createToken();
  const tokenHash = hashSecret(deviceToken);
  const device = {
    id: createId("device"),
    name: trim(body.deviceName || body.name || "Mobile Web", 120),
    platform: trim(body.platform || "web", 40),
    clientDeviceId: trim(body.clientDeviceId, 160),
    desktopId: pairing.desktopId,
    relaySessionId: pairing.relaySessionId,
    tokenHash,
    pairedAt: now(),
    lastSeenAt: now(),
    enabled: true
  };

  store.devices = store.devices.filter((candidate) => (
    candidate.tokenHash !== tokenHash
    && (!device.clientDeviceId || candidate.clientDeviceId !== device.clientDeviceId)
  ));
  store.devices.push(device);
  writeStore();
  pairings.delete(pairing.relaySessionId);

  sendWs(desktop.ws, { type: "device.paired", device, tokenHash });

  return {
    ok: true,
    device: publicDevice(device),
    deviceToken,
    deviceId: device.id,
    desktopId: device.desktopId,
    relaySessionId: device.relaySessionId,
    status: desktop.status
  };
}

async function forwardPhoneCommand(req, command, payload) {
  const device = authenticateDevice(req);
  if (!device) {
    return { ok: false, error: "Unauthorized", status: 401 };
  }

  const desktop = desktops.get(device.desktopId);
  if (!desktop) {
    return { ok: false, error: "Desktop is offline", status: 503 };
  }

  const requestId = createId("cmd");
  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(requestId);
      resolve({ ok: false, error: "Desktop command timed out", status: 504 });
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(requestId, { resolve, timeout });
    sendWs(desktop.ws, {
      type: "command",
      requestId,
      command,
      device: publicDevice(device),
      payload
    });
  });

  return result;
}

function authenticateDevice(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;

  const tokenHash = hashSecret(token);
  const device = store.devices.find((candidate) => candidate.enabled !== false && candidate.tokenHash === tokenHash);
  if (!device) return null;

  const previous = Date.parse(device.lastSeenAt || "0") || 0;
  if (Date.now() - previous > 30_000) {
    device.lastSeenAt = now();
    writeStore();
  }
  return device;
}

function allowPairingAttempt(key) {
  const current = attempts.get(key);
  if (!current || current.expiresAt <= Date.now()) {
    attempts.set(key, { count: 1, expiresAt: Date.now() + PAIRING_ATTEMPT_TTL_MS });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_PAIRING_ATTEMPTS;
}

function cleanupExpiredState() {
  const currentTime = Date.now();
  for (const [relaySessionId, pairing] of pairings) {
    const expiresAt = Date.parse(pairing.expiresAt || "0") || 0;
    if (!expiresAt || expiresAt <= currentTime) pairings.delete(relaySessionId);
  }
  for (const [key, attempt] of attempts) {
    if (attempt.expiresAt <= currentTime) attempts.delete(key);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return { devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
  } catch {
    return { devices: [] };
  }
}

function writeStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2));
  fs.renameSync(temporaryPath, STORE_PATH);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  const allowAll = ALLOWED_ORIGINS.includes("*");
  const allowedOrigin = allowAll ? "*" : origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
}

function originAllowed(req) {
  const origin = req.headers.origin || "";
  return !origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin);
}

function sendJson(req, res, statusCode, payload) {
  setCorsHeaders(req, res);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendWs(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function parseRequestUrl(req) {
  return new URL(req.url || "/", PUBLIC_ORIGIN);
}

function statusCodeFor(result) {
  return result?.status && result.status >= 400 ? result.status : 200;
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
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

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function trim(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function now() {
  return new Date().toISOString();
}
