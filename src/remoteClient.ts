import type {
  ConnectionState,
  FrontendFeedbackResponse,
  FrontendPromptResponse,
  FrontendSelectResponse,
  FrontendStateResponse,
  PairResponse,
  RemoteSessionAction,
  StartSessionResponse,
  StatusResponse,
  StopSessionResponse,
  TerminalInputResponse
} from "./types";

export class RemoteError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteError";
    this.status = status;
  }
}

export function normalizeRelayUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:$/i.test(trimmed)) {
    throw new TypeError("Invalid Relay URL");
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function createRemoteClient(connection: Pick<ConnectionState, "relayUrl" | "deviceToken">) {
  const relayUrl = normalizeRelayUrl(connection.relayUrl);
  const deviceToken = connection.deviceToken.trim();

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!relayUrl) {
      throw new RemoteError("缺少 Relay 地址", 0);
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
      response = await fetch(`${relayUrl}${path}`, { ...init, headers });
    } catch {
      throw new RemoteError("无法连接 DeepSeek TUI Relay", 0);
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      throw new RemoteError(payload.error || `Relay 请求失败 (${response.status})`, response.status);
    }
    return payload as T;
  }

  return {
    relayUrl,
    deviceToken,
    status() {
      return request<StatusResponse>("/api/v1/status");
    },
    pair(payload: {
      pairingCode: string;
      deviceName: string;
      clientDeviceId: string;
    }) {
      return request<PairResponse>("/api/v1/pair", {
        method: "POST",
        body: JSON.stringify({
          pairingCode: payload.pairingCode.replace(/\s+/g, ""),
          deviceName: payload.deviceName.trim() || "Mobile Web",
          platform: "web",
          clientDeviceId: payload.clientDeviceId
        })
      });
    },
    startSession(payload: {
      action: RemoteSessionAction;
      prompt: string;
      conversationId?: string;
    }) {
      return request<StartSessionResponse>("/api/v1/session/start", {
        method: "POST",
        body: JSON.stringify({
          conversationId: payload.conversationId || "",
          action: payload.action,
          prompt: payload.prompt.trim()
        })
      });
    },
    frontendState() {
      return request<FrontendStateResponse>("/api/v1/frontend/state");
    },
    selectFrontend(payload: {
      projectId: string;
      conversationId?: string;
    }) {
      return request<FrontendSelectResponse>("/api/v1/frontend/select", {
        method: "POST",
        body: JSON.stringify({
          projectId: payload.projectId,
          conversationId: payload.conversationId || ""
        })
      });
    },
    sendFrontendPrompt(payload: {
      conversationId: string;
      prompt: string;
    }) {
      return request<FrontendPromptResponse>("/api/v1/frontend/prompt", {
        method: "POST",
        body: JSON.stringify({
          conversationId: payload.conversationId,
          prompt: payload.prompt.trim()
        })
      });
    },
    frontendFeedback(conversationId: string) {
      const search = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
      return request<FrontendFeedbackResponse>(`/api/v1/frontend/feedback${search}`);
    },
    stopSession() {
      return request<StopSessionResponse>("/api/v1/session/stop", {
        method: "POST"
      });
    },
    sendTerminalInput(data: string) {
      return request<TerminalInputResponse>("/api/v1/terminal/input", {
        method: "POST",
        body: JSON.stringify({ data })
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
