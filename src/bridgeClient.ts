import type {
  ConnectionState,
  PairResponse,
  StatusResponse
} from "./types";

export class BridgeError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
  }
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:$/i.test(trimmed)) {
    throw new TypeError("Invalid Bridge URL");
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function createBridgeClient(connection: Pick<ConnectionState, "baseUrl" | "deviceToken">) {
  const baseUrl = normalizeBaseUrl(connection.baseUrl);
  const deviceToken = connection.deviceToken.trim();

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!baseUrl) {
      throw new BridgeError("缺少 Bridge URL", 0);
    }

    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (deviceToken) {
      headers.set("authorization", `Bearer ${deviceToken}`);
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new BridgeError("无法连接桌面端 Bridge", 0);
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      throw new BridgeError(payload.error || `Bridge 请求失败 (${response.status})`, response.status);
    }
    return payload as T;
  }

  return {
    baseUrl,
    deviceToken,
    status() {
      return request<StatusResponse>("/api/v1/status");
    },
    pair(payload: {
      accountId: string;
      pairingCode: string;
      deviceName: string;
      clientDeviceId: string;
    }) {
      return request<PairResponse>("/api/v1/auth/pair", {
        method: "POST",
        body: JSON.stringify({
          accountId: payload.accountId.trim(),
          pairingCode: payload.pairingCode.replace(/\s+/g, ""),
          deviceName: payload.deviceName.trim() || "Mobile Web",
          platform: "web",
          clientDeviceId: payload.clientDeviceId
        })
      });
    }
  };
}

async function readPayload(response: Response): Promise<{ error?: string; [key: string]: unknown }> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
