import { normalizeRelayUrl } from "./remoteClient";
import type { ConnectionState, PairingStage } from "./types";

export const RELATED_DESKTOP_DOMAIN = "deepseektuidesktop.cn";
export const RELATED_DESKTOP_ORIGIN = `https://${RELATED_DESKTOP_DOMAIN}`;

export type PairingUrlPrefill = {
  relayUrl: string;
  deviceName: string;
  ignoredTokenParam: boolean;
  pairingCode: string;
};

export type RelayUrlValidation = {
  relayUrl: string;
  message: string;
  ok: boolean;
  protocol: "https" | "http" | "empty" | "invalid";
  localOnlyBlocked: boolean;
  publicHttpBlocked: boolean;
  relatedDesktopDomain: boolean;
};

export function parsePairingUrlParams(search: string): PairingUrlPrefill {
  const params = new URLSearchParams(search);
  return {
    relayUrl: (params.get("relay") || params.get("bridge") || "").trim(),
    deviceName: (params.get("deviceName") || "").trim(),
    ignoredTokenParam: params.has("token") || params.has("deviceToken") || params.has("device_token"),
    pairingCode: sanitizePairingCode(params.get("code") || "")
  };
}

export function hasPairingPrefill(prefill: PairingUrlPrefill): boolean {
  return Boolean(prefill.relayUrl || prefill.deviceName || prefill.pairingCode);
}

export function applyPairingPrefill(
  connection: ConnectionState,
  prefill: PairingUrlPrefill,
  clearToken = false
): ConnectionState {
  return {
    ...connection,
    relayUrl: prefill.relayUrl || connection.relayUrl,
    deviceName: prefill.deviceName || connection.deviceName,
    deviceToken: clearToken ? "" : connection.deviceToken,
    deviceId: clearToken ? "" : connection.deviceId,
    desktopId: clearToken ? "" : connection.desktopId,
    relaySessionId: clearToken ? "" : connection.relaySessionId
  };
}

export function sanitizePairingCode(value: string): string {
  return value.replace(/[^\d\s]/g, "").slice(0, 7);
}

export function normalizePairingCode(value: string): string {
  return sanitizePairingCode(value).replace(/\s+/g, "");
}

export function validateRelayUrl(value: string, pageProtocol = "https:", pageHostname = ""): RelayUrlValidation {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      relayUrl: "",
      message: "缺少 Relay 地址。",
      ok: false,
      protocol: "empty",
      localOnlyBlocked: false,
      publicHttpBlocked: false,
      relatedDesktopDomain: false
    };
  }

  let relayUrl = "";
  let parsed: URL;
  try {
    relayUrl = normalizeRelayUrl(trimmed);
    parsed = new URL(relayUrl);
  } catch {
    return {
      relayUrl: "",
      message: "Relay 地址格式不正确。",
      ok: false,
      protocol: "invalid",
      localOnlyBlocked: false,
      publicHttpBlocked: false,
      relatedDesktopDomain: false
    };
  }

  const relatedDesktopDomain = parsed.hostname === RELATED_DESKTOP_DOMAIN
    || parsed.hostname.endsWith(`.${RELATED_DESKTOP_DOMAIN}`);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      relayUrl: "",
      message: "Relay 地址只支持 HTTP 或 HTTPS。",
      ok: false,
      protocol: "invalid",
      localOnlyBlocked: false,
      publicHttpBlocked: false,
      relatedDesktopDomain
    };
  }

  const relayIsLoopback = isLoopbackHost(parsed.hostname);
  const pageIsLocal = isLoopbackHost(pageHostname);
  if (relayIsLoopback && !pageIsLocal) {
    return {
      relayUrl,
      message: "127.0.0.1 / localhost 只能用于同机开发，公开手机网页不能连接本机 Relay。",
      ok: false,
      protocol: parsed.protocol === "https:" ? "https" : "http",
      localOnlyBlocked: true,
      publicHttpBlocked: false,
      relatedDesktopDomain
    };
  }

  const publicHttpBlocked = pageProtocol === "https:" && parsed.protocol === "http:" && !relayIsLoopback;
  if (publicHttpBlocked) {
    return {
      relayUrl,
      message: "当前页面是 HTTPS，浏览器会阻止普通 HTTP Relay。请使用 HTTPS Relay。",
      ok: false,
      protocol: "http",
      localOnlyBlocked: false,
      publicHttpBlocked: true,
      relatedDesktopDomain
    };
  }

  return {
    relayUrl,
    message: "",
    ok: true,
    protocol: parsed.protocol === "https:" ? "https" : "http",
    localOnlyBlocked: false,
    publicHttpBlocked: false,
    relatedDesktopDomain
  };
}

export function formatRelayTransport(validation: RelayUrlValidation): {
  detail: string;
  label: string;
  tone: "ok" | "warn" | "muted";
} {
  if (validation.protocol === "https") {
    return {
      detail: validation.relatedDesktopDomain
        ? `${RELATED_DESKTOP_DOMAIN} Relay 已识别，手机会通过云端中继连接桌面端。`
        : "HTTPS Relay 可用于公开部署的手机网页。",
      label: "Relay",
      tone: "ok"
    };
  }
  if (validation.protocol === "http" && validation.ok) {
    return {
      detail: "HTTP Relay 仅适合同机开发，不适合公开手机网页。",
      label: "Dev Relay",
      tone: "warn"
    };
  }
  return {
    detail: validation.message || "Relay 未确认。",
    label: "未确认",
    tone: "muted"
  };
}

export function pairingStageLabel(stage: PairingStage): string {
  if (stage === "ready-to-pair") return "可配对";
  if (stage === "pairing") return "配对中";
  if (stage === "paired") return "已配对";
  if (stage === "status-error") return "需刷新";
  return "待填写";
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]"
    || hostname.endsWith(".localhost");
}
