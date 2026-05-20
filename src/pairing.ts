import { normalizeBaseUrl } from "./bridgeClient";
import type { ConnectionState, PairingStage } from "./types";

export const RELATED_DESKTOP_DOMAIN = "deepseektuidesktop.cn";
export const RELATED_DESKTOP_ORIGIN = `https://${RELATED_DESKTOP_DOMAIN}`;

export type PairingUrlPrefill = {
  accountId: string;
  bridgeUrl: string;
  deviceName: string;
  ignoredTokenParam: boolean;
  pairingCode: string;
};

export type BridgeUrlValidation = {
  baseUrl: string;
  message: string;
  ok: boolean;
  protocol: "https" | "http" | "empty" | "invalid";
  publicHttpBlocked: boolean;
  relatedDesktopDomain: boolean;
};

export function parsePairingUrlParams(search: string): PairingUrlPrefill {
  const params = new URLSearchParams(search);
  return {
    accountId: (params.get("account") || "").trim(),
    bridgeUrl: (params.get("bridge") || "").trim(),
    deviceName: (params.get("deviceName") || "").trim(),
    ignoredTokenParam: params.has("token") || params.has("deviceToken") || params.has("device_token"),
    pairingCode: sanitizePairingCode(params.get("code") || "")
  };
}

export function hasPairingPrefill(prefill: PairingUrlPrefill): boolean {
  return Boolean(prefill.accountId || prefill.bridgeUrl || prefill.deviceName || prefill.pairingCode);
}

export function applyPairingPrefill(
  connection: ConnectionState,
  prefill: PairingUrlPrefill,
  clearToken = false
): ConnectionState {
  return {
    ...connection,
    baseUrl: prefill.bridgeUrl || connection.baseUrl,
    accountId: prefill.accountId || connection.accountId,
    deviceName: prefill.deviceName || connection.deviceName,
    deviceToken: clearToken ? "" : connection.deviceToken
  };
}

export function sanitizePairingCode(value: string): string {
  return value.replace(/[^\d\s]/g, "").slice(0, 7);
}

export function validateBridgeUrl(value: string, pageProtocol = "https:"): BridgeUrlValidation {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      baseUrl: "",
      message: "请填写桌面端 Bridge URL。",
      ok: false,
      protocol: "empty",
      publicHttpBlocked: false,
      relatedDesktopDomain: false
    };
  }

  let baseUrl = "";
  let parsed: URL;
  try {
    baseUrl = normalizeBaseUrl(trimmed);
    parsed = new URL(baseUrl);
  } catch {
    return {
      baseUrl: "",
      message: "Bridge URL 格式不正确。",
      ok: false,
      protocol: "invalid",
      publicHttpBlocked: false,
      relatedDesktopDomain: false
    };
  }

  const relatedDesktopDomain = parsed.hostname === RELATED_DESKTOP_DOMAIN
    || parsed.hostname.endsWith(`.${RELATED_DESKTOP_DOMAIN}`);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      baseUrl: "",
      message: "Bridge URL 只支持 HTTP 或 HTTPS。",
      ok: false,
      protocol: "invalid",
      publicHttpBlocked: false,
      relatedDesktopDomain
    };
  }

  const publicHttpBlocked = pageProtocol === "https:" && parsed.protocol === "http:" && !isLocalBridgeHost(parsed.hostname);
  if (publicHttpBlocked) {
    return {
      baseUrl,
      message: "当前页面是 HTTPS，浏览器会阻止普通 HTTP Bridge。请使用 HTTPS tunnel URL。",
      ok: false,
      protocol: "http",
      publicHttpBlocked: true,
      relatedDesktopDomain
    };
  }

  return {
    baseUrl,
    message: "",
    ok: true,
    protocol: parsed.protocol === "https:" ? "https" : "http",
    publicHttpBlocked: false,
    relatedDesktopDomain
  };
}

export function formatBridgeTransport(validation: BridgeUrlValidation): {
  detail: string;
  label: string;
  tone: "ok" | "warn" | "muted";
} {
  if (validation.protocol === "https") {
    return {
      detail: validation.relatedDesktopDomain
        ? `${RELATED_DESKTOP_DOMAIN} 已作为相关桌面端域名识别，可用于公开部署的手机网页。`
        : "HTTPS Bridge URL 可用于公开部署的手机网页。",
      label: "HTTPS",
      tone: "ok"
    };
  }
  if (validation.protocol === "http" && validation.ok) {
    return {
      detail: "HTTP Bridge 仅适合本地开发或浏览器允许的 localhost 场景。",
      label: "HTTP",
      tone: "warn"
    };
  }
  return {
    detail: validation.message || "Bridge URL 未确认。",
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

function isLocalBridgeHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]"
    || hostname.endsWith(".localhost");
}
