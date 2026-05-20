export type PairingStage = "idle" | "ready-to-pair" | "pairing" | "paired" | "status-error";

export type ConnectionState = {
  relayUrl: string;
  deviceName: string;
  clientDeviceId: string;
  deviceToken: string;
  deviceId: string;
  desktopId: string;
  relaySessionId: string;
};

export type RemoteAuthAccount = {
  accountId: string;
  email: string;
  displayName: string;
  loggedInAt: string;
};

export type RemotePairingState = {
  active: boolean;
  codePreview: string;
  expiresAt: string;
  createdAt: string;
  relaySessionId?: string;
};

export type RemoteDevice = {
  id: string;
  name: string;
  platform: string;
  accountId?: string;
  desktopId?: string;
  relaySessionId?: string;
  pairedAt: string;
  lastSeenAt: string;
  enabled?: boolean;
};

export type RemoteAuthState = {
  desktopId: string;
  loggedIn: boolean;
  account: RemoteAuthAccount | null;
  pairing: RemotePairingState | null;
  devices: RemoteDevice[];
};

export type ActiveSession = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  startedAt: string;
};

export type LastExit = {
  exitCode?: number;
  signal?: number;
  exitedAt?: string;
  session?: ActiveSession | null;
};

export type RemoteSessionAction = "tui" | "continue" | "doctor" | "setup" | "mcp-init" | "sessions" | "exec" | "plan";

export type UpdateNotice = {
  id: string;
  source: string;
  accountId: string;
  matchedDeviceIds: string[];
  version: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
};

export type RemoteBridgeStatus = {
  enabled: boolean;
  running: boolean;
  error: string;
  bindHost: string;
  port: number;
  localUrl: string;
  lanUrl: string;
  tokenPreview: string;
  relay?: {
    enabled: boolean;
    connected: boolean;
    url: string;
    sessionId: string;
    lastConnectedAt: string;
    lastError: string;
  };
  mobileRemoteControlEnabled: boolean;
  updatePushEnabled: boolean;
  auth: RemoteAuthState;
  sseClients: number;
  terminalPreview: string;
  lastTerminalAt: string;
  lastUpdateNotice: UpdateNotice | null;
  harness: {
    running: boolean;
    activeSession: ActiveSession | null;
    lastExit: LastExit | null;
  };
};

export type StatusResponse = {
  ok: boolean;
  status: RemoteBridgeStatus;
  auth?: RemoteDevice | null;
  error?: string;
};

export type PairResponse = {
  ok: boolean;
  device?: RemoteDevice;
  deviceToken?: string;
  deviceId?: string;
  desktopId?: string;
  relaySessionId?: string;
  status?: RemoteBridgeStatus;
  error?: string;
};

export type StartSessionResponse = {
  ok: boolean;
  result?: {
    ok?: boolean;
    error?: string;
    pid?: number;
    session?: ActiveSession;
  };
  status?: RemoteBridgeStatus;
  error?: string;
};

export type StopSessionResponse = {
  ok: boolean;
  result?: {
    ok?: boolean;
  };
  status?: RemoteBridgeStatus;
  error?: string;
};

export type TerminalInputResponse = {
  ok: boolean;
  error?: string;
};
