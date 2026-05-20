import { describe, expect, it, vi } from "vitest";
import { RelayRegistry, sha256Hex } from "../src/relayCore";
import type { RemoteBridgeStatus } from "../src/types";

describe("RelayRegistry", () => {
  it("pairs a phone with only a six digit code and never sends the raw token to desktop", async () => {
    const now = Date.parse("2026-05-20T00:00:00.000Z");
    const registry = new RelayRegistry(() => now);
    const notify = vi.fn();
    registry.registerDesktop({
      desktopId: "desktop_1",
      relaySessionId: "relay_session_1",
      secret: "relay-secret",
      status: mockStatus(),
      notify,
      handleCommand: vi.fn()
    });
    registry.startPairing({
      codeHash: await sha256Hex("123456"),
      codePreview: "123 456",
      createdAt: new Date(now).toISOString(),
      desktopId: "desktop_1",
      expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
      relaySessionId: "relay_session_1"
    });

    const result = await registry.pair({
      attemptKey: "phone-ip",
      clientDeviceId: "web-installation",
      deviceName: "West iPhone",
      pairingCode: "123 456",
      platform: "web"
    });

    expect(result.ok).toBe(true);
    expect(result.deviceToken).toBeTruthy();
    expect(result.desktopId).toBe("desktop_1");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      type: "device.paired",
      device: {
        clientDeviceId: "web-installation",
        desktopId: "desktop_1",
        name: "West iPhone"
      }
    });
    expect(JSON.stringify(notify.mock.calls[0][0])).not.toContain(result.deviceToken || "impossible");
  });

  it("rejects expired pairing codes", async () => {
    const now = Date.parse("2026-05-20T00:10:01.000Z");
    const registry = new RelayRegistry(() => now);
    registry.registerDesktop({
      desktopId: "desktop_1",
      relaySessionId: "relay_session_1",
      secret: "relay-secret",
      status: mockStatus(),
      notify: vi.fn(),
      handleCommand: vi.fn()
    });
    registry.startPairing({
      codeHash: await sha256Hex("123456"),
      codePreview: "123 456",
      createdAt: "2026-05-20T00:00:00.000Z",
      desktopId: "desktop_1",
      expiresAt: "2026-05-20T00:10:00.000Z",
      relaySessionId: "relay_session_1"
    });

    const result = await registry.pair({
      attemptKey: "phone-ip",
      clientDeviceId: "web-installation",
      deviceName: "Phone",
      pairingCode: "123456"
    });

    expect(result).toMatchObject({
      ok: false,
      error: "No active pairing code",
      status: 400
    });
  });

  it("rate limits repeated pairing attempts", async () => {
    const registry = new RelayRegistry(() => Date.parse("2026-05-20T00:00:00.000Z"));
    let lastResult = await registry.pair({
      attemptKey: "phone-ip",
      clientDeviceId: "web-installation",
      deviceName: "Phone",
      pairingCode: "000000"
    });

    for (let index = 0; index < 20; index += 1) {
      lastResult = await registry.pair({
        attemptKey: "phone-ip",
        clientDeviceId: "web-installation",
        deviceName: "Phone",
        pairingCode: "000000"
      });
    }

    expect(lastResult).toMatchObject({
      ok: false,
      error: "Too many pairing attempts",
      status: 429
    });
  });

  it("forwards commands only for paired device tokens", async () => {
    const now = Date.parse("2026-05-20T00:00:00.000Z");
    const registry = new RelayRegistry(() => now);
    const handleCommand = vi.fn(async () => ({ ok: true, status: mockStatus({ running: true }) }));
    registry.registerDesktop({
      desktopId: "desktop_1",
      relaySessionId: "relay_session_1",
      secret: "relay-secret",
      status: mockStatus(),
      notify: vi.fn(),
      handleCommand
    });
    registry.startPairing({
      codeHash: await sha256Hex("123456"),
      codePreview: "123 456",
      createdAt: new Date(now).toISOString(),
      desktopId: "desktop_1",
      expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
      relaySessionId: "relay_session_1"
    });
    const pairResult = await registry.pair({
      clientDeviceId: "web-installation",
      deviceName: "Phone",
      pairingCode: "123456"
    });

    const commandResult = await registry.forwardCommand(pairResult.deviceToken || "", "session.start", {
      action: "exec",
      prompt: "run tests"
    });
    const unauthorized = await registry.forwardCommand("bad-token", "status");

    expect(commandResult).toMatchObject({ ok: true });
    expect(handleCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: "session.start",
      payload: {
        action: "exec",
        prompt: "run tests"
      }
    }));
    expect(unauthorized).toMatchObject({
      ok: false,
      error: "Unauthorized",
      status: 401
    });
  });
});

function mockStatus(overrides: { running?: boolean } = {}): RemoteBridgeStatus {
  return {
    auth: {
      account: null,
      desktopId: "desktop_1",
      devices: [],
      loggedIn: false,
      pairing: null
    },
    bindHost: "127.0.0.1",
    enabled: true,
    error: "",
    harness: {
      activeSession: null,
      lastExit: null,
      running: overrides.running ?? false
    },
    lanUrl: "http://127.0.0.1:8765",
    lastTerminalAt: "",
    lastUpdateNotice: null,
    localUrl: "http://127.0.0.1:8765",
    mobileRemoteControlEnabled: true,
    port: 8765,
    relay: {
      connected: true,
      enabled: true,
      lastConnectedAt: "2026-05-20T00:00:00.000Z",
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
