import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Link2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
  WifiOff
} from "lucide-react";
import { BridgeError, createBridgeClient } from "./bridgeClient";
import {
  applyPairingPrefill,
  formatBridgeTransport,
  hasPairingPrefill,
  pairingStageLabel,
  parsePairingUrlParams,
  RELATED_DESKTOP_DOMAIN,
  RELATED_DESKTOP_ORIGIN,
  sanitizePairingCode,
  validateBridgeUrl
} from "./pairing";
import { clearConnection, loadConnection, saveConnection } from "./storage";
import type { ConnectionState, PairingStage, RemoteBridgeStatus, RemoteDevice } from "./types";

type MessageKind = "info" | "error";

type InitialState = {
  connection: ConnectionState;
  draft: ConnectionState;
  ignoredTokenParam: boolean;
  pairingCode: string;
};

function createInitialState(): InitialState {
  const saved = loadConnection();
  const prefill = parsePairingUrlParams(window.location.search);
  const shouldStartFresh = hasPairingPrefill(prefill);
  const draft = applyPairingPrefill(saved, prefill, shouldStartFresh);

  return {
    connection: shouldStartFresh ? draft : saved,
    draft,
    ignoredTokenParam: prefill.ignoredTokenParam,
    pairingCode: prefill.pairingCode
  };
}

export function App() {
  const [initialState] = useState<InitialState>(() => createInitialState());
  const [connection, setConnection] = useState<ConnectionState>(initialState.connection);
  const [draft, setDraft] = useState<ConnectionState>(initialState.draft);
  const [pairingCode, setPairingCode] = useState(initialState.pairingCode);
  const [status, setStatus] = useState<RemoteBridgeStatus | null>(null);
  const [pairedDevice, setPairedDevice] = useState<RemoteDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [message, setMessage] = useState(
    initialState.ignoredTokenParam ? "URL 中的 token 参数已忽略；设备 Token 只保存在当前浏览器。" : ""
  );
  const [messageKind, setMessageKind] = useState<MessageKind>("info");

  const pageProtocol = window.location.protocol;
  const bridgeValidation = useMemo(
    () => validateBridgeUrl(draft.baseUrl || connection.baseUrl, pageProtocol),
    [connection.baseUrl, draft.baseUrl, pageProtocol]
  );
  const draftReady = Boolean(bridgeValidation.ok && draft.accountId.trim() && draft.deviceName.trim() && pairingCode.trim());
  const stage: PairingStage = busy
    ? "pairing"
    : statusError
      ? "status-error"
      : connection.deviceToken
        ? "paired"
        : draftReady
          ? "ready-to-pair"
          : "idle";

  const client = useMemo(() => createBridgeClient(connection), [connection.baseUrl, connection.deviceToken]);
  const bridgeReady = Boolean(status?.enabled && status.running);
  const transport = formatBridgeTransport(bridgeValidation);

  const showMessage = useCallback((text: string, kind: MessageKind = "info") => {
    setMessage(text);
    setMessageKind(kind);
  }, []);

  function updateDraft<K extends keyof ConnectionState>(key: K, value: ConnectionState[K]) {
    setDraft((current) => ({ ...current, [key]: value, deviceToken: "" }));
    if (connection.deviceToken) {
      setConnection((current) => ({ ...current, deviceToken: "" }));
      setStatus(null);
      setPairedDevice(null);
    }
    setStatusError(false);
  }

  async function pairDevice() {
    const validation = validateBridgeUrl(draft.baseUrl, pageProtocol);
    if (!validation.ok) {
      showMessage(validation.message, "error");
      return;
    }
    if (!draft.accountId.trim() || !draft.deviceName.trim() || !pairingCode.trim()) {
      showMessage("Bridge URL、邮箱标识、设备名和配对码不能为空。", "error");
      return;
    }

    setBusy(true);
    setStatusError(false);
    try {
      const pairClient = createBridgeClient({ baseUrl: validation.baseUrl, deviceToken: "" });
      const result = await pairClient.pair({
        accountId: draft.accountId,
        pairingCode,
        deviceName: draft.deviceName,
        clientDeviceId: draft.clientDeviceId
      });

      if (!result.ok || !result.deviceToken) {
        throw new BridgeError(result.error || "配对失败", 400);
      }

      const next: ConnectionState = {
        ...draft,
        baseUrl: validation.baseUrl,
        accountId: draft.accountId.trim(),
        deviceName: draft.deviceName.trim(),
        deviceToken: result.deviceToken
      };
      saveConnection(next);
      setConnection(next);
      setDraft(next);
      setPairingCode("");
      setStatus(result.status || null);
      setPairedDevice(result.device || null);
      showMessage(`已配对：${result.device?.name || next.deviceName}`);
    } catch (error) {
      showMessage(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus() {
    if (!connection.baseUrl || !connection.deviceToken) {
      showMessage("请先完成设备配对。", "error");
      return;
    }

    const validation = validateBridgeUrl(connection.baseUrl, pageProtocol);
    if (!validation.ok) {
      showMessage(validation.message, "error");
      return;
    }

    setBusy(true);
    setStatusError(false);
    try {
      const result = await client.status();
      setStatus(result.status);
      if (result.auth) setPairedDevice(result.auth);
      showMessage("桌面端状态已刷新。");
    } catch (error) {
      setStatusError(true);
      showMessage(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  function resetConnection() {
    const next = clearConnection();
    setConnection(next);
    setDraft(next);
    setStatus(null);
    setPairedDevice(null);
    setPairingCode("");
    setStatusError(false);
    showMessage("已清除本机配对。");
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">
            <Smartphone size={14} aria-hidden />
            DeepSeek TUI Mobile
          </span>
          <h1>手机配对网页</h1>
        </div>
        <ConnectionPill stage={stage} ready={bridgeReady} />
      </header>

      {message ? (
        <div className={messageKind === "error" ? "message error" : "message"} role="status">
          {messageKind === "error" ? <AlertTriangle size={16} aria-hidden /> : <CheckCircle2 size={16} aria-hidden />}
          <span>{message}</span>
        </div>
      ) : null}

      <section className="panel pairing-panel">
        <div className="panel-heading">
          <div>
            <span className="section-label">公开配对</span>
            <h2>绑定当前手机</h2>
          </div>
          <SecurityBadge tone={stageTone(stage)} label={pairingStageLabel(stage)} />
        </div>

        <StepList stage={stage} />

        <div className="connection-form">
          <label>
            Bridge URL
            <input
              value={draft.baseUrl}
              onChange={(event) => updateDraft("baseUrl", event.target.value)}
              placeholder={RELATED_DESKTOP_ORIGIN}
              inputMode="url"
              spellCheck={false}
              disabled={busy}
            />
          </label>

          <div className="grid two">
            <label>
              邮箱标识
              <input
                value={draft.accountId}
                onChange={(event) => updateDraft("accountId", event.target.value)}
                placeholder="name@example.com"
                inputMode="email"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <label>
              设备名
              <input
                value={draft.deviceName}
                onChange={(event) => updateDraft("deviceName", event.target.value)}
                placeholder="iPhone Web"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          </div>

          <label className="pair-code-field">
            配对码
            <input
              value={pairingCode}
              onChange={(event) => {
                setPairingCode(sanitizePairingCode(event.target.value));
                setStatusError(false);
              }}
              placeholder="123 456"
              inputMode="numeric"
              autoComplete="one-time-code"
              disabled={busy}
            />
          </label>
        </div>

        <p className={bridgeValidation.ok ? "inline-note" : "inline-warning"}>
          {bridgeValidation.ok ? <CheckCircle2 size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
          {bridgeValidation.ok ? transport.detail : bridgeValidation.message}
        </p>

        <div className="action-row">
          <button type="button" className="primary" onClick={pairDevice} disabled={busy || !draftReady}>
            <ShieldCheck size={16} aria-hidden />
            {busy ? "配对中" : "配对"}
          </button>
          <button type="button" onClick={refreshStatus} disabled={busy || !connection.deviceToken}>
            <RefreshCw size={16} aria-hidden />
            刷新状态
          </button>
          <button type="button" className="danger" onClick={resetConnection} disabled={busy}>
            <Trash2 size={16} aria-hidden />
            清除本机配对
          </button>
        </div>
      </section>

      <section className="panel status-panel">
        <div className="panel-heading">
          <div>
            <span className="section-label">只读状态</span>
            <h2>桌面端连接</h2>
          </div>
          <KeyRound size={20} aria-hidden />
        </div>

        <div className="security-grid">
          <StatusTile icon={<Link2 size={16} />} label="传输" value={transport.label} tone={transport.tone} />
          <StatusTile icon={<Wifi size={16} />} label="Bridge" value={bridgeReady ? "运行中" : "未确认"} tone={bridgeReady ? "ok" : "muted"} />
          <StatusTile icon={<ShieldCheck size={16} />} label="设备" value={connection.deviceToken ? "已配对" : "未配对"} tone={connection.deviceToken ? "ok" : "warn"} />
          <StatusTile
            icon={<WifiOff size={16} />}
            label="桌面控制"
            value={status?.mobileRemoteControlEnabled ? "桌面已开启" : "未开启"}
            tone="muted"
          />
        </div>

        <div className="meta-list">
          <InfoRow label="邮箱标识" value={connection.accountId || draft.accountId || "未填写"} />
          <InfoRow label="设备名" value={pairedDevice?.name || connection.deviceName || draft.deviceName || "未命名"} />
          <InfoRow label="桌面账号" value={status?.auth.account?.accountId || "未刷新"} />
          <InfoRow label="Desktop ID" value={status?.auth.desktopId || "未刷新"} />
          <InfoRow label="Bridge URL" value={connection.baseUrl || draft.baseUrl || "未填写"} />
          <InfoRow label="相关域名" value={RELATED_DESKTOP_DOMAIN} />
        </div>

        <p className="inline-note">
          <CheckCircle2 size={15} aria-hidden />
          设备 Token 不在页面展示；撤销设备请回到桌面端手机配对面板。
        </p>
      </section>
    </main>
  );
}

function ConnectionPill({ ready, stage }: { ready: boolean; stage: PairingStage }) {
  const online = ready && stage === "paired";
  return (
    <div className={online ? "connection-pill online" : "connection-pill"}>
      {online ? <Wifi size={15} aria-hidden /> : <WifiOff size={15} aria-hidden />}
      <span>{online ? "已连接" : pairingStageLabel(stage)}</span>
    </div>
  );
}

function StepList({ stage }: { stage: PairingStage }) {
  const current = stage === "paired" ? 3 : stage === "ready-to-pair" || stage === "pairing" ? 2 : 1;
  const steps = ["填写 Bridge URL", "输入邮箱与配对码", "刷新只读状态"];

  return (
    <ol className="step-list" aria-label="配对步骤">
      {steps.map((step, index) => (
        <li key={step} className={index + 1 <= current ? "active" : ""}>
          <span>{index + 1}</span>
          <strong>{step}</strong>
        </li>
      ))}
    </ol>
  );
}

function SecurityBadge({ label, tone }: { label: string; tone: "ok" | "warn" | "muted" }) {
  return <span className={`security-badge ${tone}`}>{label}</span>;
}

function StatusTile({
  icon,
  label,
  tone,
  value
}: {
  icon: ReactNode;
  label: string;
  tone: "ok" | "warn" | "muted";
  value: string;
}) {
  return (
    <div className={`status-tile ${tone}`}>
      <span>{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function stageTone(stage: PairingStage): "ok" | "warn" | "muted" {
  if (stage === "paired") return "ok";
  if (stage === "ready-to-pair" || stage === "status-error") return "warn";
  return "muted";
}

function errorMessage(error: unknown): string {
  if (error instanceof BridgeError && error.status === 0) return error.message;
  if (error instanceof BridgeError && error.status === 400) return error.message || "配对码无效或已过期。";
  if (error instanceof BridgeError && error.status === 401) return "认证失败，请重新配对。";
  if (error instanceof BridgeError && error.status === 429) return "配对尝试过多，请稍后再试。";
  if (error instanceof Error) return error.message;
  return "操作失败。";
}
