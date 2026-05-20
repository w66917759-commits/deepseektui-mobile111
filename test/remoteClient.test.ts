import { createServer } from "node:http";
import type { AddressInfo, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteClient } from "../src/remoteClient";

type JsonHandler = (request: IncomingMessage, body: unknown) => {
  payload: unknown;
  status?: number;
};

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("createRemoteClient", () => {
  it("pairs with only pairing code, device name, and client device id", async () => {
    let requestBody: any = null;
    let authHeader = "";
    const relayUrl = await startMockRelay((request, body) => {
      requestBody = body;
      authHeader = String(request.headers.authorization || "");
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/v1/pair");
      return {
        payload: {
          ok: true,
          device: mockDevice("device_1"),
          deviceId: "device_1",
          desktopId: "desktop_1",
          relaySessionId: "relay_session_1",
          deviceToken: "device-token"
        }
      };
    });

    const client = createRemoteClient({ relayUrl, deviceToken: "" });
    const result = await client.pair({
      clientDeviceId: "web-installation",
      deviceName: "West iPhone",
      pairingCode: "123 456"
    });

    expect(authHeader).toBe("");
    expect(requestBody).toMatchObject({
      clientDeviceId: "web-installation",
      deviceName: "West iPhone",
      pairingCode: "123456",
      platform: "web"
    });
    expect(requestBody.accountId).toBeUndefined();
    expect(result.deviceToken).toBe("device-token");
    expect(result.desktopId).toBe("desktop_1");
  });

  it.each([
    ["Invalid pairing code"],
    ["No active pairing code"],
    ["Desktop is offline"]
  ])("surfaces pairing failure: %s", async (message) => {
    const relayUrl = await startMockRelay(() => ({
      status: 400,
      payload: { ok: false, error: message }
    }));

    const client = createRemoteClient({ relayUrl, deviceToken: "" });
    await expect(client.pair({
      clientDeviceId: "web-installation",
      deviceName: "Phone",
      pairingCode: "123456"
    })).rejects.toMatchObject({
      message,
      status: 400
    });
  });

  it("requires a relay url before requests", async () => {
    const client = createRemoteClient({ relayUrl: "", deviceToken: "" });

    await expect(client.status()).rejects.toMatchObject({
      message: "缺少 Relay 地址",
      status: 0
    });
  });

  it("sends the stored device token when refreshing status", async () => {
    let authHeader = "";
    const relayUrl = await startMockRelay((request) => {
      authHeader = String(request.headers.authorization || "");
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/api/v1/status");
      return {
        payload: {
          ok: true,
          auth: mockDevice("device_1"),
          status: mockStatus()
        }
      };
    });

    const client = createRemoteClient({ relayUrl, deviceToken: "device-token" });
    const result = await client.status();

    expect(authHeader).toBe("Bearer device-token");
    expect(result.status.auth.desktopId).toBe("desktop_1");
  });

  it("surfaces status authorization failures", async () => {
    const relayUrl = await startMockRelay(() => ({
      status: 401,
      payload: { ok: false, error: "Unauthorized" }
    }));

    const client = createRemoteClient({ relayUrl, deviceToken: "bad-token" });
    await expect(client.status()).rejects.toMatchObject({
      message: "Unauthorized",
      status: 401
    });
  });

  it("reports connection failures when a relay is unreachable", async () => {
    const relayUrl = await startMockRelay(() => ({
      payload: { ok: true, status: mockStatus() }
    }));
    await Promise.all(servers.splice(0).map((server) => server.close()));

    const client = createRemoteClient({ relayUrl, deviceToken: "device-token" });
    await expect(client.status()).rejects.toMatchObject({
      message: "无法连接 DeepSeek TUI Relay",
      status: 0
    });
  });

  it("starts a desktop session from a paired device", async () => {
    let requestBody: any = null;
    let authHeader = "";
    const relayUrl = await startMockRelay((request, body) => {
      requestBody = body;
      authHeader = String(request.headers.authorization || "");
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/v1/session/start");
      return {
        payload: {
          ok: true,
          result: { ok: true, pid: 1234 },
          status: mockStatus({ running: true })
        }
      };
    });

    const client = createRemoteClient({ relayUrl, deviceToken: "device-token" });
    const result = await client.startSession({
      action: "exec",
      prompt: "  run tests  "
    });

    expect(authHeader).toBe("Bearer device-token");
    expect(requestBody).toEqual({
      action: "exec",
      prompt: "run tests"
    });
    expect(result.status?.harness.running).toBe(true);
  });

  it("sends terminal input to an active desktop session", async () => {
    let requestBody: any = null;
    let authHeader = "";
    const relayUrl = await startMockRelay((request, body) => {
      requestBody = body;
      authHeader = String(request.headers.authorization || "");
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/v1/terminal/input");
      return {
        payload: { ok: true }
      };
    });

    const client = createRemoteClient({ relayUrl, deviceToken: "device-token" });
    const result = await client.sendTerminalInput("/status\n");

    expect(authHeader).toBe("Bearer device-token");
    expect(requestBody).toEqual({ data: "/status\n" });
    expect(result.ok).toBe(true);
  });

  it("stops the desktop session from a paired device", async () => {
    let authHeader = "";
    const relayUrl = await startMockRelay((request) => {
      authHeader = String(request.headers.authorization || "");
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/v1/session/stop");
      return {
        payload: {
          ok: true,
          result: { ok: true },
          status: mockStatus({ running: false })
        }
      };
    });

    const client = createRemoteClient({ relayUrl, deviceToken: "device-token" });
    const result = await client.stopSession();

    expect(authHeader).toBe("Bearer device-token");
    expect(result.status?.harness.running).toBe(false);
  });

  it("surfaces disabled remote-control responses", async () => {
    const relayUrl = await startMockRelay(() => ({
      status: 403,
      payload: { ok: false, error: "Remote control is disabled on this desktop" }
    }));

    const client = createRemoteClient({ relayUrl, deviceToken: "device-token" });
    await expect(client.startSession({
      action: "exec",
      prompt: "run tests"
    })).rejects.toMatchObject({
      message: "Remote control is disabled on this desktop",
      status: 403
    });
  });
});

function startMockRelay(handler: JsonHandler): Promise<string> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readJsonBody(request);
    const result = handler(request, body);
    response.writeHead(result.status || 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.payload));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      servers.push({
        close: () => new Promise<void>((closeResolve) => server.close(() => closeResolve()))
      });
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function mockDevice(id: string) {
  return {
    desktopId: "desktop_1",
    id,
    lastSeenAt: "2026-05-19T00:00:00.000Z",
    name: "West iPhone",
    pairedAt: "2026-05-19T00:00:00.000Z",
    platform: "web",
    relaySessionId: "relay_session_1"
  };
}

function mockStatus(overrides: { running?: boolean; remoteControl?: boolean } = {}) {
  const running = overrides.running ?? false;
  return {
    auth: {
      account: null,
      desktopId: "desktop_1",
      devices: [mockDevice("device_1")],
      loggedIn: false,
      pairing: null
    },
    bindHost: "127.0.0.1",
    enabled: true,
    error: "",
    harness: {
      activeSession: running
        ? {
          args: ["exec", "--auto", "run tests"],
          command: "deepseek",
          cwd: "/tmp/project",
          id: "session_1",
          pid: 1234,
          startedAt: "2026-05-19T00:00:00.000Z"
        }
        : null,
      lastExit: null,
      running
    },
    lanUrl: "http://127.0.0.1:8765",
    lastTerminalAt: "",
    lastUpdateNotice: null,
    localUrl: "http://127.0.0.1:8765",
    mobileRemoteControlEnabled: overrides.remoteControl ?? false,
    port: 8765,
    relay: {
      connected: true,
      enabled: true,
      lastConnectedAt: "2026-05-19T00:00:00.000Z",
      lastError: "",
      sessionId: "relay_session_1",
      url: "https://relay.example.com"
    },
    running: true,
    sseClients: 0,
    terminalPreview: "",
    tokenPreview: "",
    updatePushEnabled: false
  };
}
