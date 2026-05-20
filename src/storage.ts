import type { ConnectionState } from "./types";

const STORAGE_KEY = "deepseektui.mobile.connection.v1";

export function createClientDeviceId(): string {
  const existing = localStorage.getItem("deepseektui.mobile.clientDeviceId");
  if (existing) return existing;

  const next = crypto.randomUUID ? crypto.randomUUID() : `web-${Date.now().toString(36)}`;
  localStorage.setItem("deepseektui.mobile.clientDeviceId", next);
  return next;
}

export function defaultConnection(): ConnectionState {
  return {
    baseUrl: "",
    accountId: "",
    deviceName: defaultDeviceName(),
    clientDeviceId: createClientDeviceId(),
    deviceToken: ""
  };
}

export function loadConnection(): ConnectionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConnection();
    return { ...defaultConnection(), ...JSON.parse(raw) };
  } catch {
    return defaultConnection();
  }
}

export function saveConnection(connection: ConnectionState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
}

export function clearConnection(): ConnectionState {
  localStorage.removeItem(STORAGE_KEY);
  return defaultConnection();
}

function defaultDeviceName(): string {
  const platform = navigator.platform || "Mobile Web";
  return platform.includes("iPhone") || platform.includes("iPad") ? "iPhone Web" : "Mobile Web";
}
