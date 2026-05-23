import type { RemoteBridgeStatus, RemoteDevice } from "./types";

export type RelayCommand =
  | "status"
  | "frontend.state"
  | "frontend.select"
  | "frontend.prompt"
  | "frontend.feedback"
  | "session.start"
  | "session.stop"
  | "terminal.input";

export type RelayDesktopMessage = {
  type: "device.paired";
  device: RelayDeviceRecord;
  tokenHash: string;
};

export type RelayDeviceRecord = RemoteDevice & {
  clientDeviceId: string;
  tokenHash: string;
};

export type RelayDesktopConnection = {
  desktopId: string;
  relaySessionId: string;
  secret: string;
  status: RemoteBridgeStatus;
  notify: (message: RelayDesktopMessage) => void | Promise<void>;
  handleCommand: (message: {
    command: RelayCommand;
    device: RelayDeviceRecord;
    payload?: unknown;
  }) => Promise<unknown>;
};

export type RelayPairingRecord = {
  desktopId: string;
  relaySessionId: string;
  codeHash: string;
  codePreview: string;
  expiresAt: string;
  createdAt: string;
};

export type RelayPairResult = {
  ok: boolean;
  error?: string;
  status?: number;
  device?: RemoteDevice;
  deviceToken?: string;
  deviceId?: string;
  desktopId?: string;
  relaySessionId?: string;
  desktopStatus?: RemoteBridgeStatus;
};

const PAIRING_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 20;

export class RelayRegistry {
  private desktops = new Map<string, RelayDesktopConnection>();
  private pairings = new Map<string, RelayPairingRecord>();
  private devices = new Map<string, RelayDeviceRecord>();
  private attempts = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  registerDesktop(connection: RelayDesktopConnection): void {
    this.desktops.set(connection.desktopId, connection);
  }

  unregisterDesktop(desktopId: string): void {
    this.desktops.delete(desktopId);
  }

  startPairing(pairing: RelayPairingRecord): void {
    this.pruneExpiredPairings();
    this.pairings.set(pairing.relaySessionId, pairing);
  }

  async pair(input: {
    pairingCode: string;
    deviceName: string;
    clientDeviceId: string;
    platform?: string;
    attemptKey?: string;
  }): Promise<RelayPairResult> {
    if (!this.allowPairingAttempt(input.attemptKey || "global")) {
      return { ok: false, error: "Too many pairing attempts", status: 429 };
    }

    const normalizedCode = input.pairingCode.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(normalizedCode)) {
      return { ok: false, error: "Invalid pairing code", status: 400 };
    }

    this.pruneExpiredPairings();
    const codeHash = await sha256Hex(normalizedCode);
    const pairing = Array.from(this.pairings.values()).find((candidate) => candidate.codeHash === codeHash);
    if (!pairing) {
      return { ok: false, error: "No active pairing code", status: 400 };
    }

    const desktop = this.desktops.get(pairing.desktopId);
    if (!desktop) {
      return { ok: false, error: "Desktop is offline", status: 400 };
    }

    const deviceToken = createToken();
    const tokenHash = await sha256Hex(deviceToken);
    const now = new Date(this.nowMs()).toISOString();
    const device: RelayDeviceRecord = {
      id: createId("device"),
      name: trim(input.deviceName, 120) || "Mobile Web",
      platform: trim(input.platform || "web", 40),
      clientDeviceId: trim(input.clientDeviceId, 160),
      desktopId: pairing.desktopId,
      relaySessionId: pairing.relaySessionId,
      tokenHash,
      pairedAt: now,
      lastSeenAt: now,
      enabled: true
    };

    for (const [hash, candidate] of this.devices) {
      if (candidate.clientDeviceId && candidate.clientDeviceId === device.clientDeviceId) {
        this.devices.delete(hash);
      }
    }
    this.devices.set(tokenHash, device);
    this.pairings.delete(pairing.relaySessionId);

    await desktop.notify({ type: "device.paired", device, tokenHash });

    return {
      ok: true,
      device: publicDevice(device),
      deviceToken,
      deviceId: device.id,
      desktopId: pairing.desktopId,
      relaySessionId: pairing.relaySessionId,
      desktopStatus: desktop.status
    };
  }

  async authenticateDevice(deviceToken: string): Promise<RelayDeviceRecord | null> {
    const tokenHash = await sha256Hex(deviceToken);
    const device = this.devices.get(tokenHash);
    if (!device || device.enabled === false) return null;
    device.lastSeenAt = new Date(this.nowMs()).toISOString();
    return device;
  }

  async forwardCommand(deviceToken: string, command: RelayCommand, payload?: unknown): Promise<unknown> {
    const device = await this.authenticateDevice(deviceToken);
    if (!device) {
      return { ok: false, error: "Unauthorized", status: 401 };
    }

    const desktop = this.desktops.get(device.desktopId || "");
    if (!desktop) {
      return { ok: false, error: "Desktop is offline", status: 503 };
    }

    return desktop.handleCommand({ command, device, payload });
  }

  private pruneExpiredPairings(): void {
    const now = this.nowMs();
    for (const [relaySessionId, pairing] of this.pairings) {
      if (Date.parse(pairing.expiresAt) <= now) {
        this.pairings.delete(relaySessionId);
      }
    }
  }

  private allowPairingAttempt(key: string): boolean {
    const now = this.nowMs();
    const current = this.attempts.get(key);
    if (!current || current.expiresAt <= now) {
      this.attempts.set(key, { count: 1, expiresAt: now + PAIRING_ATTEMPT_TTL_MS });
      return true;
    }
    current.count += 1;
    return current.count <= MAX_PAIRING_ATTEMPTS;
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function publicDevice(device: RelayDeviceRecord): RemoteDevice {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    desktopId: device.desktopId,
    relaySessionId: device.relaySessionId,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    enabled: device.enabled
  };
}

function createToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${suffix}`;
}

function trim(value: string, maxLength: number): string {
  return String(value || "").trim().slice(0, maxLength);
}
