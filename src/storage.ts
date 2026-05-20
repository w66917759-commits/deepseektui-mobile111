import type { ConnectionState } from "./types";

const STORAGE_KEY = "deepseektui.mobile.connection.v2";
const LEGACY_STORAGE_KEY = "deepseektui.mobile.connection.v1";

export const DEFAULT_RELAY_URL = "https://deepseektuidesktop.cn";

export function configuredRelayUrl(): string {
  return (import.meta.env.VITE_DEEPSEEK_RELAY_URL || DEFAULT_RELAY_URL).trim();
}

export function createClientDeviceId(): string {
  const existing = localStorage.getItem("deepseektui.mobile.clientDeviceId");
  if (existing) return existing;

  const next = crypto.randomUUID ? crypto.randomUUID() : `web-${Date.now().toString(36)}`;
  localStorage.setItem("deepseektui.mobile.clientDeviceId", next);
  return next;
}

export function defaultConnection(): ConnectionState {
  return {
    relayUrl: configuredRelayUrl(),
    deviceName: defaultDeviceName(),
    clientDeviceId: createClientDeviceId(),
    deviceToken: "",
    deviceId: "",
    desktopId: "",
    relaySessionId: ""
  };
}

export function loadConnection(): ConnectionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeStoredConnection(JSON.parse(raw));

    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      return normalizeStoredConnection({
        deviceName: legacy.deviceName,
        clientDeviceId: legacy.clientDeviceId
      });
    }
  } catch {
    return defaultConnection();
  }
  return defaultConnection();
}

export function saveConnection(connection: ConnectionState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
}

export function clearConnection(): ConnectionState {
  localStorage.removeItem(STORAGE_KEY);
  return defaultConnection();
}

function normalizeStoredConnection(value: Partial<ConnectionState>): ConnectionState {
  return {
    ...defaultConnection(),
    ...value,
    relayUrl: value.relayUrl || configuredRelayUrl(),
    deviceToken: value.deviceToken || "",
    deviceId: value.deviceId || "",
    desktopId: value.desktopId || "",
    relaySessionId: value.relaySessionId || ""
  };
}

function defaultDeviceName(): string {
  const platform = navigator.platform || "Mobile Web";
  return platform.includes("iPhone") || platform.includes("iPad") ? "iPhone Web" : "Mobile Web";
}
