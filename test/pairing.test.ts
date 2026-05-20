import { describe, expect, it } from "vitest";
import {
  applyPairingPrefill,
  formatBridgeTransport,
  parsePairingUrlParams,
  sanitizePairingCode,
  validateBridgeUrl
} from "../src/pairing";
import type { ConnectionState } from "../src/types";

const baseConnection: ConnectionState = {
  accountId: "",
  baseUrl: "",
  clientDeviceId: "web-device",
  deviceName: "Mobile Web",
  deviceToken: "saved-token"
};

describe("pairing url prefill", () => {
  it("prefills only safe values and ignores token params", () => {
    const prefill = parsePairingUrlParams(
      "?bridge=https%3A%2F%2Fbridge.example.com&account=User%40Example.com&code=12a3%20456&deviceName=iPhone&token=leak&deviceToken=leak2"
    );

    expect(prefill).toEqual({
      accountId: "User@Example.com",
      bridgeUrl: "https://bridge.example.com",
      deviceName: "iPhone",
      ignoredTokenParam: true,
      pairingCode: "123 456"
    });
  });

  it("clears saved device token when a pairing link starts a fresh pairing", () => {
    const prefill = parsePairingUrlParams("?bridge=https%3A%2F%2Fbridge.example.com&account=user%40example.com");
    const next = applyPairingPrefill(baseConnection, prefill, true);

    expect(next.baseUrl).toBe("https://bridge.example.com");
    expect(next.accountId).toBe("user@example.com");
    expect(next.deviceToken).toBe("");
    expect(next.clientDeviceId).toBe("web-device");
  });
});

describe("bridge url validation", () => {
  it("accepts HTTPS bridge urls for public pages", () => {
    const validation = validateBridgeUrl("bridge.example.com/path/", "https:");

    expect(validation.ok).toBe(true);
    expect(validation.baseUrl).toBe("https://bridge.example.com/path");
    expect(formatBridgeTransport(validation)).toMatchObject({ label: "HTTPS", tone: "ok" });
  });

  it("recognizes the related DeepSeek TUI Desktop domain", () => {
    const validation = validateBridgeUrl("deepseektuidesktop.cn", "https:");

    expect(validation.ok).toBe(true);
    expect(validation.baseUrl).toBe("https://deepseektuidesktop.cn");
    expect(validation.relatedDesktopDomain).toBe(true);
    expect(formatBridgeTransport(validation).detail).toContain("deepseektuidesktop.cn");
  });

  it("blocks public HTTP bridge urls from an HTTPS page", () => {
    const validation = validateBridgeUrl("http://bridge.example.com", "https:");

    expect(validation.ok).toBe(false);
    expect(validation.publicHttpBlocked).toBe(true);
    expect(validation.message).toContain("HTTPS");
  });

  it("allows localhost HTTP for development", () => {
    const validation = validateBridgeUrl("http://127.0.0.1:8765", "https:");

    expect(validation.ok).toBe(true);
    expect(formatBridgeTransport(validation)).toMatchObject({ label: "HTTP", tone: "warn" });
  });

  it("rejects empty and malformed bridge urls", () => {
    expect(validateBridgeUrl("", "https:")).toMatchObject({ ok: false, protocol: "empty" });
    expect(validateBridgeUrl("https://", "https:")).toMatchObject({ ok: false, protocol: "invalid" });
  });
});

describe("pairing code sanitization", () => {
  it("keeps only digits and spacing within a six digit display shape", () => {
    expect(sanitizePairingCode("12a 3456xyz9")).toBe("12 3456");
  });
});
