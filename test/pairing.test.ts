import { describe, expect, it } from "vitest";
import {
  applyPairingPrefill,
  formatRelayTransport,
  normalizePairingCode,
  parsePairingUrlParams,
  sanitizePairingCode,
  validateRelayUrl
} from "../src/pairing";
import type { ConnectionState } from "../src/types";

const baseConnection: ConnectionState = {
  clientDeviceId: "web-device",
  desktopId: "desktop_1",
  deviceId: "device_1",
  deviceName: "Mobile Web",
  deviceToken: "saved-token",
  relaySessionId: "relay_session_1",
  relayUrl: "https://relay.example.com"
};

describe("pairing url prefill", () => {
  it("prefills only safe values and ignores token params", () => {
    const prefill = parsePairingUrlParams(
      "?relay=https%3A%2F%2Frelay.example.com&account=ignored%40example.com&code=12a3%20456&deviceName=iPhone&token=leak&deviceToken=leak2"
    );

    expect(prefill).toEqual({
      relayUrl: "https://relay.example.com",
      deviceName: "iPhone",
      ignoredTokenParam: true,
      pairingCode: "123 456"
    });
  });

  it("clears saved device token when a pairing link starts a fresh pairing", () => {
    const prefill = parsePairingUrlParams("?relay=https%3A%2F%2Frelay.example.com&code=123456");
    const next = applyPairingPrefill(baseConnection, prefill, true);

    expect(next.relayUrl).toBe("https://relay.example.com");
    expect(next.deviceToken).toBe("");
    expect(next.deviceId).toBe("");
    expect(next.desktopId).toBe("");
    expect(next.clientDeviceId).toBe("web-device");
  });
});

describe("relay url validation", () => {
  it("accepts HTTPS relay urls for public pages", () => {
    const validation = validateRelayUrl("relay.example.com/path/", "https:");

    expect(validation.ok).toBe(true);
    expect(validation.relayUrl).toBe("https://relay.example.com/path");
    expect(formatRelayTransport(validation)).toMatchObject({ label: "Relay", tone: "ok" });
  });

  it("recognizes the related DeepSeek TUI Desktop domain", () => {
    const validation = validateRelayUrl("deepseektuidesktop.cn", "https:");

    expect(validation.ok).toBe(true);
    expect(validation.relayUrl).toBe("https://deepseektuidesktop.cn");
    expect(validation.relatedDesktopDomain).toBe(true);
    expect(formatRelayTransport(validation).detail).toContain("deepseektuidesktop.cn");
  });

  it("blocks public HTTP relay urls from an HTTPS page", () => {
    const validation = validateRelayUrl("http://relay.example.com", "https:");

    expect(validation.ok).toBe(false);
    expect(validation.publicHttpBlocked).toBe(true);
    expect(validation.message).toContain("HTTPS");
  });

  it("blocks localhost relay urls from public mobile pages", () => {
    const validation = validateRelayUrl("http://127.0.0.1:8787", "https:", "mobile.example.com");

    expect(validation.ok).toBe(false);
    expect(validation.localOnlyBlocked).toBe(true);
    expect(validation.message).toContain("公开手机网页");
  });

  it("allows localhost HTTP for same-machine development", () => {
    const validation = validateRelayUrl("http://127.0.0.1:8787", "https:", "localhost");

    expect(validation.ok).toBe(true);
    expect(formatRelayTransport(validation)).toMatchObject({ label: "Dev Relay", tone: "warn" });
  });

  it("rejects empty and malformed relay urls", () => {
    expect(validateRelayUrl("", "https:")).toMatchObject({ ok: false, protocol: "empty" });
    expect(validateRelayUrl("https://", "https:")).toMatchObject({ ok: false, protocol: "invalid" });
  });
});

describe("pairing code sanitization", () => {
  it("keeps only digits and spacing within a six digit display shape", () => {
    expect(sanitizePairingCode("12a 3456xyz9")).toBe("12 3456");
    expect(normalizePairingCode("12a 3456xyz9")).toBe("123456");
  });
});
