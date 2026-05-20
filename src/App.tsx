import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Square,
  Terminal,
  Trash2,
  Wifi,
  WifiOff
} from "lucide-react";
import { createRemoteClient, RemoteError } from "./remoteClient";
import {
  applyPairingPrefill,
  formatRelayTransport,
  hasPairingPrefill,
  normalizePairingCode,
  pairingStageLabel,
  parsePairingUrlParams,
  sanitizePairingCode,
  validateRelayUrl
} from "./pairing";
import { clearConnection, loadConnection, saveConnection } from "./storage";
import type { ConnectionState, PairingStage, RemoteBridgeStatus, RemoteDevice, RemoteSessionAction } from "./types";

type MessageKind = "info" | "error";
type BusyAction = "pair" | "status" | "start-session" | "terminal-input" | "stop-session";

const SESSION_ACTIONS: Array<{ value: RemoteSessionAction; label: string }> = [
  { value: "exec", label: "一次性任务" },
  { value: "plan", label: "只做方案" },
  { value: "tui", label: "打开 TUI" },
  { value: "continue", label: "继续会话" },
  { value: "sessions", label: "会话列表" },
  { value: "doctor", label: "诊断环境" },
  { value: "setup", label: "初始化设置" },
  { value: "mcp-init", label: "初始化 MCP" }
];

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
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [remoteAction, setRemoteAction] = useState<RemoteSessionAction>("exec");
  const [remotePrompt, setRemotePrompt] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [message, setMessage] = useState(
    initialState.ignoredTokenParam ? "URL 中的 token 参数已忽略；设备 Token 只保存在当前浏览器。" : ""
  );
  const [messageKind, setMessageKind] = useState<MessageKind>("info");

  const pageProtocol = window.location.protocol;
  const pageHostname = window.location.hostname;
  const relayValidation = useMemo(
    () => validateRelayUrl(draft.relayUrl || connection.relayUrl, pageProtocol, pageHostname),
    [connection.relayUrl, draft.relayUrl, pageHostname, pageProtocol]
  );
  const normalizedPairingCode = normalizePairingCode(pairingCode);
  const draftReady = Boolean(relayValidation.ok && draft.deviceName.trim() && normalizedPairingCode.length === 6);
  const busy = busyAction !== null;
  const stage: PairingStage = busyAction === "pair"
    ? "pairing"
    : statusError
      ? "status-error"
      : connection.deviceToken
        ? "paired"
        : draftReady
          ? "ready-to-pair"
          : "idle";

  const client = useMemo(() => createRemoteClient(connection), [connection.deviceToken, connection.relayUrl]);
  const relayConnected = Boolean(status?.relay?.connected);
  const remoteControlEnabled = Boolean(status?.mobileRemoteControlEnabled);
  const remoteControlReady = Boolean(connection.deviceToken && relayConnected && remoteControlEnabled);
  const harnessRunning = Boolean(status?.harness.running);
  const activeSession = status?.harness.activeSession || null;
  const promptRequired = remoteAction === "exec" || remoteAction === "plan";
  const canStartRemoteSession = Boolean(remoteControlReady && !busy && (!promptRequired || remotePrompt.trim()));
  const canSendTerminalInput = Boolean(remoteControlReady && harnessRunning && !busy && terminalInput.trim());
  const canStopRemoteSession = Boolean(remoteControlReady && harnessRunning && !busy);
  const transport = formatRelayTransport(relayValidation);

  const showMessage = useCallback((text: string, kind: MessageKind = "info") => {
    setMessage(text);
    setMessageKind(kind);
  }, []);

  function updateDraft<K extends keyof ConnectionState>(key: K, value: ConnectionState[K]) {
    setDraft((current) => ({ ...current, [key]: value, deviceToken: "", deviceId: "", desktopId: "", relaySessionId: "" }));
    if (connection.deviceToken) {
      setConnection((current) => ({ ...current, deviceToken: "", deviceId: "", desktopId: "", relaySessionId: "" }));
      setStatus(null);
      setPairedDevice(null);
    }
    setStatusError(false);
  }

  async function pairDevice() {
    const validation = validateRelayUrl(draft.relayUrl, pageProtocol, pageHostname);
    if (!validation.ok) {
      showMessage(validation.message, "error");
      return;
    }
    if (!draft.deviceName.trim() || normalizedPairingCode.length !== 6) {
      showMessage("请填写设备名，并输入桌面端显示的 6 位配对码。", "error");
      return;
    }

    setBusyAction("pair");
    setStatusError(false);
    try {
      const pairClient = createRemoteClient({ relayUrl: validation.relayUrl, deviceToken: "" });
      const result = await pairClient.pair({
        pairingCode: normalizedPairingCode,
        deviceName: draft.deviceName,
        clientDeviceId: draft.clientDeviceId
      });

      if (!result.ok || !result.deviceToken) {
        throw new RemoteError(result.error || "配对失败", 400);
      }

      const next: ConnectionState = {
        ...draft,
        relayUrl: validation.relayUrl,
        deviceName: draft.deviceName.trim(),
        deviceToken: result.deviceToken,
        deviceId: result.deviceId || result.device?.id || "",
        desktopId: result.desktopId || result.device?.desktopId || result.status?.auth.desktopId || "",
        relaySessionId: result.relaySessionId || result.device?.relaySessionId || ""
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
      setBusyAction(null);
    }
  }

  async function refreshStatus() {
    if (!connection.relayUrl || !connection.deviceToken) {
      showMessage("请先用配对码完成设备绑定。", "error");
      return;
    }

    const validation = validateRelayUrl(connection.relayUrl, pageProtocol, pageHostname);
    if (!validation.ok) {
      showMessage(validation.message, "error");
      return;
    }

    setBusyAction("status");
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
      setBusyAction(null);
    }
  }

  async function startRemoteSession() {
    if (!remoteControlReady) {
      showMessage("请先完成配对，并在桌面端开启手机远程控制。", "error");
      return;
    }
    if (promptRequired && !remotePrompt.trim()) {
      showMessage("请输入要下发给桌面端的指令。", "error");
      return;
    }

    setBusyAction("start-session");
    try {
      const result = await client.startSession({
        action: remoteAction,
        prompt: remotePrompt
      });
      if (!result.ok) {
        throw new RemoteError(result.error || result.result?.error || "桌面端未接受该指令。", 400);
      }
      if (result.status) setStatus(result.status);
      setRemotePrompt("");
      showMessage("指令已下发到桌面端。");
    } catch (error) {
      showMessage(errorMessage(error), "error");
    } finally {
      setBusyAction(null);
    }
  }

  async function sendTerminalInput() {
    if (!remoteControlReady) {
      showMessage("请先完成配对，并在桌面端开启手机远程控制。", "error");
      return;
    }
    if (!harnessRunning) {
      showMessage("桌面端当前没有运行中的终端会话。", "error");
      return;
    }
    if (!terminalInput.trim()) {
      showMessage("请输入要发送到终端的内容。", "error");
      return;
    }

    setBusyAction("terminal-input");
    try {
      const data = terminalInput.endsWith("\n") ? terminalInput : `${terminalInput}\n`;
      const result = await client.sendTerminalInput(data);
      if (!result.ok) {
        throw new RemoteError(result.error || "桌面端未接受终端输入。", 400);
      }
      setTerminalInput("");
      showMessage("终端输入已发送。");
    } catch (error) {
      showMessage(errorMessage(error), "error");
    } finally {
      setBusyAction(null);
    }
  }

  async function stopRemoteSession() {
    if (!remoteControlReady) {
      showMessage("请先完成配对，并在桌面端开启手机远程控制。", "error");
      return;
    }

    setBusyAction("stop-session");
    try {
      const result = await client.stopSession();
      if (result.status) setStatus(result.status);
      showMessage(result.result?.ok === false ? "桌面端当前没有运行中的任务。" : "已请求停止桌面任务。");
    } catch (error) {
      showMessage(errorMessage(error), "error");
    } finally {
      setBusyAction(null);
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
          <h1>手机控制</h1>
        </div>
        <ConnectionPill stage={stage} ready={relayConnected} />
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
            <span className="section-label">Relay 配对</span>
            <h2>绑定当前手机</h2>
          </div>
          <SecurityBadge tone={stageTone(stage)} label={pairingStageLabel(stage)} />
        </div>

        <div className="connection-form">
          <div className="grid two">
            <label>
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
        </div>

        <p className={relayValidation.ok ? "inline-note" : "inline-warning"}>
          {relayValidation.ok ? <CheckCircle2 size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
          {relayValidation.ok ? transport.detail : relayValidation.message}
        </p>

        <div className="primary-action">
          <button type="button" className="primary" onClick={pairDevice} disabled={busy || !draftReady}>
            <ShieldCheck size={16} aria-hidden />
            {busyAction === "pair" ? "配对中" : "配对"}
          </button>
        </div>

        {connection.deviceToken ? (
          <div className="secondary-actions">
            <button type="button" className="quiet" onClick={refreshStatus} disabled={busy}>
              <RefreshCw size={15} aria-hidden />
              刷新
            </button>
            <button type="button" className="quiet danger" onClick={resetConnection} disabled={busy}>
              <Trash2 size={15} aria-hidden />
              清除
            </button>
          </div>
        ) : null}
      </section>

      <details className="panel mobile-details control-panel" open={remoteControlReady || harnessRunning}>
        <summary>
          <span>
            <small>远程下发</small>
            <strong>控制桌面端</strong>
          </span>
          <SecurityBadge
            tone={remoteControlReady ? "ok" : remoteControlEnabled ? "warn" : "muted"}
            label={remoteControlReady ? "可下发" : remoteControlEnabled ? "待刷新" : "未开启"}
          />
        </summary>

        <div className="details-body">
          <div className="status-strip">
            <StatusChip
              icon={<Link2 size={15} />}
              label="Relay"
              value={relayConnected ? "在线" : "未确认"}
              tone={relayConnected ? "ok" : "muted"}
            />
            <StatusChip
              icon={<ShieldCheck size={15} />}
              label="远控"
              value={remoteControlEnabled ? "开启" : "关闭"}
              tone={remoteControlEnabled ? "ok" : "warn"}
            />
            <StatusChip
              icon={<Play size={16} />}
              label="任务"
              value={harnessRunning ? "运行中" : "空闲"}
              tone={harnessRunning ? "warn" : "muted"}
            />
          </div>

          <div className="control-form">
            <label>
              执行方式
              <select
                value={remoteAction}
                onChange={(event) => setRemoteAction(event.target.value as RemoteSessionAction)}
                disabled={busy || !remoteControlReady}
              >
                {SESSION_ACTIONS.map((action) => (
                  <option key={action.value} value={action.value}>
                    {action.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              下发指令
              <textarea
                value={remotePrompt}
                onChange={(event) => setRemotePrompt(event.target.value)}
                placeholder={promptRequired ? "例如：运行测试并总结失败原因" : "该执行方式可不填写指令"}
                disabled={busy || !remoteControlReady}
              />
            </label>

            <div className="primary-action">
              <button type="button" className="primary" onClick={startRemoteSession} disabled={!canStartRemoteSession}>
                <Send size={16} aria-hidden />
                {busyAction === "start-session" ? "下发中" : "下发任务"}
              </button>
            </div>

            {harnessRunning ? (
              <button type="button" className="quiet" onClick={stopRemoteSession} disabled={!canStopRemoteSession}>
                <Square size={15} aria-hidden />
                {busyAction === "stop-session" ? "停止中" : "停止任务"}
              </button>
            ) : null}
          </div>

          <details className="mini-details">
            <summary>
              <Terminal size={15} aria-hidden />
              终端输入
            </summary>
            <div className="terminal-control">
              <label>
                输入内容
                <textarea
                  value={terminalInput}
                  onChange={(event) => setTerminalInput(event.target.value)}
                  placeholder="/status"
                  disabled={busy || !remoteControlReady || !harnessRunning}
                />
              </label>
              <button type="button" onClick={sendTerminalInput} disabled={!canSendTerminalInput}>
                <Terminal size={16} aria-hidden />
                {busyAction === "terminal-input" ? "发送中" : "发送输入"}
              </button>
            </div>
          </details>

          {status?.terminalPreview ? (
            <details className="mini-details">
              <summary>最近终端输出</summary>
              <pre className="terminal-preview" aria-label="最近终端输出">
                {status.terminalPreview}
              </pre>
            </details>
          ) : null}

          <p className={remoteControlReady ? "inline-note" : "inline-warning"}>
            {remoteControlReady ? <CheckCircle2 size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
            {remoteControlReady ? "手机已具备下发权限。" : "需要桌面端开启 Relay 和手机远程控制后才能下发。"}
          </p>
        </div>
      </details>

      <details className="panel mobile-details status-panel">
        <summary>
          <span>
            <small>桌面状态</small>
            <strong>{connection.deviceToken ? "设备已绑定" : "未绑定设备"}</strong>
          </span>
          <SecurityBadge tone={connection.deviceToken ? "ok" : "muted"} label={transport.label} />
        </summary>

        <div className="details-body">
          <div className="meta-list">
            <InfoRow label="设备名" value={pairedDevice?.name || connection.deviceName || draft.deviceName || "未命名"} />
            <InfoRow label="任务" value={harnessRunning ? `运行中${activeSession ? ` · ${activeSession.pid}` : ""}` : "空闲"} />
            <InfoRow label="工作目录" value={activeSession?.cwd || status?.harness.lastExit?.session?.cwd || "使用桌面端当前设置"} />
            <InfoRow label="Desktop ID" value={connection.desktopId || status?.auth.desktopId || "未刷新"} />
            <InfoRow label="Device ID" value={connection.deviceId || pairedDevice?.id || "未刷新"} />
            <InfoRow label="Relay" value={connection.relayUrl || draft.relayUrl || "未配置"} />
          </div>

          <p className="inline-note">
            <CheckCircle2 size={15} aria-hidden />
            设备 Token 不在页面展示；撤销设备请回到桌面端手机配对面板。
          </p>
        </div>
      </details>
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

function SecurityBadge({ label, tone }: { label: string; tone: "ok" | "warn" | "muted" }) {
  return <span className={`security-badge ${tone}`}>{label}</span>;
}

function StatusChip({
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
    <div className={`status-chip ${tone}`}>
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
  if (error instanceof RemoteError && error.status === 0) return error.message;
  if (error instanceof RemoteError && error.status === 400) return error.message || "配对码无效或已过期。";
  if (error instanceof RemoteError && error.status === 401) return "认证失败，请重新配对。";
  if (error instanceof RemoteError && error.status === 403) return "桌面端未开启手机远程控制，请在桌面端远程面板开启。";
  if (error instanceof RemoteError && error.status === 429) return "配对尝试过多，请稍后再试。";
  if (error instanceof Error) return error.message;
  return "操作失败。";
}
