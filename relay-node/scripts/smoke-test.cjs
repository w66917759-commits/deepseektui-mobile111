#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const port = 18_787 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-relay-"));
const serverPath = path.resolve(__dirname, "..", "server.cjs");
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    RELAY_DATA_DIR: dataDir,
    ALLOWED_ORIGINS: "*"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

child.stderr.pipe(process.stderr);

main().finally(() => {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function main() {
  await waitForHealth();

  const desktopId = "desktop_smoke";
  const secret = "relay-secret";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/desktop/connect?desktopId=${desktopId}&secret=${secret}`);
  const ready = await nextWsMessage(ws);
  assert.equal(ready.type, "relay.ready");

  ws.send(JSON.stringify({
    type: "desktop.hello",
    desktopId,
    secret,
    status: { enabled: true, relay: { connected: true }, harness: { running: false } }
  }));

  const pairingCode = "123456";
  ws.send(JSON.stringify({
    type: "pairing.start",
    desktopId,
    relaySessionId: ready.relaySessionId,
    codeHash: sha256(pairingCode),
    codePreview: "123 456",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString()
  }));

  const pairedNoticePromise = nextWsMessage(ws);
  const pairResponse = await requestJson("POST", "/api/v1/pair", {
    pairingCode,
    deviceName: "DesktopBrowserTest",
    clientDeviceId: "smoke-browser"
  });
  assert.equal(pairResponse.ok, true);
  assert.ok(pairResponse.deviceToken);

  const pairedNotice = await pairedNoticePromise;
  assert.equal(pairedNotice.type, "device.paired");

  const commandPromise = nextWsMessage(ws);
  const statusPromise = requestJson("GET", "/api/v1/status", null, pairResponse.deviceToken);
  const command = await commandPromise;
  assert.equal(command.type, "command");
  assert.equal(command.command, "status");
  ws.send(JSON.stringify({
    type: "command.result",
    requestId: command.requestId,
    payload: { ok: true, status: { harness: { running: false } } }
  }));
  const statusResponse = await statusPromise;
  assert.equal(statusResponse.ok, true);

  const frontendPromise = nextWsMessage(ws);
  const frontendStatePromise = requestJson("GET", "/api/v1/frontend/state", null, pairResponse.deviceToken);
  const frontendCommand = await frontendPromise;
  assert.equal(frontendCommand.type, "command");
  assert.equal(frontendCommand.command, "frontend.state");
  ws.send(JSON.stringify({
    type: "command.result",
    requestId: frontendCommand.requestId,
    payload: { ok: true, state: { ready: true, projects: [], conversations: [] } }
  }));
  const frontendStateResponse = await frontendStatePromise;
  assert.equal(frontendStateResponse.ok, true);
  assert.equal(frontendStateResponse.state.ready, true);

  const terminalResponse = await requestJson("POST", "/api/v1/terminal/input", { data: "/status\n" }, pairResponse.deviceToken);
  assert.equal(terminalResponse.ok, false);
  assert.equal(terminalResponse.status, 410);

  console.log("Relay smoke test passed");
}

function waitForHealth() {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      requestJson("GET", "/api/v1/health")
        .then(resolve)
        .catch((error) => {
          if (Date.now() - started > 8_000) reject(error);
          else setTimeout(poll, 100);
        });
    };
    poll();
  });
}

function requestJson(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function nextWsMessage(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), 5_000);
    ws.once("message", (raw) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(raw)));
    });
    ws.once("error", reject);
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}
