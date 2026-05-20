export type PairingStage = "idle" | "ready-to-pair" | "pairing" | "paired" | "status-error";

export type ConnectionState = {
  baseUrl: string;
  accountId: string;
  deviceName: string;
  clientDeviceId: string;
  deviceToken: string;
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
};

export type RemoteDevice = {
  id: string;
  name: string;
  platform: string;
  accountId: string;
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
  status?: RemoteBridgeStatus;
  error?: string;
};
