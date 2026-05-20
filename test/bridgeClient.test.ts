import { createServer } from "node:http";
import type { AddressInfo, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError, createBridgeClient } from "../src/bridgeClient";

type JsonHandler = (request: IncomingMessage, body: unknown) => {
  payload: unknown;
  status?: number;
};

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("createBridgeClient", () => {
  it("pairs with account, pairing code, device name, and client device id", async () => {
    let requestBody: any = null;
    let authHeader = "";
    const baseUrl = await startMockBridge((request, body) => {
      requestBody = body;
      authHeader = String(request.headers.authorization || "");
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/v1/auth/pair");
      return {
        payload: {
          ok: true,
          device: mockDevice("device_1"),
          deviceToken: "device-token"
        }
      };
    });

    const client = createBridgeClient({ baseUrl, deviceToken: "" });
    const result = await client.pair({
      accountId: " User@Example.com ",
      clientDeviceId: "web-installation",
      deviceName: "West iPhone",
      pairingCode: "123 456"
    });

    expect(authHeader).toBe("");
    expect(requestBody).toMatchObject({
      accountId: "User@Example.com",
      clientDeviceId: "web-installation",
      deviceName: "West iPhone",
      pairingCode: "123456",
      platform: "web"
    });
    expect(result.deviceToken).toBe("device-token");
  });

  it.each([
    ["Account mismatch"],
    ["Invalid pairing code"],
    ["No active pairing code"]
  ])("surfaces pairing failure: %s", async (message) => {
    const baseUrl = await startMockBridge(() => ({
      status: 400,
      payload: { ok: false, error: message }
    }));

    const client = createBridgeClient({ baseUrl, deviceToken: "" });
    await expect(client.pair({
      accountId: "user@example.com",
      clientDeviceId: "web-installation",
      deviceName: "Phone",
      pairingCode: "123456"
    })).rejects.toMatchObject({
      message,
      status: 400
    });
  });

  it("requires a bridge url before requests", async () => {
    const client = createBridgeClient({ baseUrl: "", deviceToken: "" });

    await expect(client.status()).rejects.toMatchObject({
      message: "缺少 Bridge URL",
      status: 0
    });
  });

  it("sends the stored device token when refreshing status", async () => {
    let authHeader = "";
    const baseUrl = await startMockBridge((request) => {
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

    const client = createBridgeClient({ baseUrl, deviceToken: "device-token" });
    const result = await client.status();

    expect(authHeader).toBe("Bearer device-token");
    expect(result.status.auth.account?.accountId).toBe("user@example.com");
  });

  it("surfaces status authorization failures", async () => {
    const baseUrl = await startMockBridge(() => ({
      status: 401,
      payload: { ok: false, error: "Unauthorized" }
    }));

    const client = createBridgeClient({ baseUrl, deviceToken: "bad-token" });
    await expect(client.status()).rejects.toMatchObject({
      message: "Unauthorized",
      status: 401
    });
  });

  it("reports connection failures when a bridge is unreachable", async () => {
    const baseUrl = await startMockBridge(() => ({
      payload: { ok: true, status: mockStatus() }
    }));
    await Promise.all(servers.splice(0).map((server) => server.close()));

    const client = createBridgeClient({ baseUrl, deviceToken: "device-token" });
    await expect(client.status()).rejects.toMatchObject({
      message: "无法连接桌面端 Bridge",
      status: 0
    });
  });
});

function startMockBridge(handler: JsonHandler): Promise<string> {
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
    accountId: "user@example.com",
    id,
    lastSeenAt: "2026-05-19T00:00:00.000Z",
    name: "West iPhone",
    pairedAt: "2026-05-19T00:00:00.000Z",
    platform: "web"
  };
}

function mockStatus() {
  return {
    auth: {
      account: {
        accountId: "user@example.com",
        displayName: "User",
        email: "user@example.com",
        loggedInAt: "2026-05-19T00:00:00.000Z"
      },
      desktopId: "desktop_1",
      devices: [mockDevice("device_1")],
      loggedIn: true,
      pairing: null
    },
    bindHost: "127.0.0.1",
    enabled: true,
    error: "",
    harness: {
      activeSession: null,
      lastExit: null,
      running: false
    },
    lanUrl: "http://127.0.0.1:8765",
    lastTerminalAt: "",
    lastUpdateNotice: null,
    localUrl: "http://127.0.0.1:8765",
    mobileRemoteControlEnabled: false,
    port: 8765,
    running: true,
    sseClients: 0,
    terminalPreview: "",
    tokenPreview: "",
    updatePushEnabled: false
  };
}
