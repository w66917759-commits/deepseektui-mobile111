import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Link2,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
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
import type {
  ConnectionState,
  PairingStage,
  RemoteBridgeStatus,
  RemoteDevice,
  RemoteFrontendFeedback,
  RemoteFrontendState
} from "./types";

type MessageKind = "info" | "error";
type BusyAction = "pair" | "status" | "frontend-state" | "frontend-select" | "frontend-prompt" | "frontend-feedback";

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
  const [frontendState, setFrontendState] = useState<RemoteFrontendState | null>(null);
  const [feedback, setFeedback] = useState<RemoteFrontendFeedback | null>(null);
  const [pairedDevice, setPairedDevice] = useState<RemoteDevice | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [remotePrompt, setRemotePrompt] = useState("");
  const [message, setMessage] = useState(
    initialState.ignoredTokenParam ? "URL 中的 token 参数已忽略；设备 Token 只保存在当前浏览器。" : ""
  );
  const [messageKind, setMessageKind] = useState<MessageKind>("info");
  const lastAutoRefreshKey = useRef("");

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
  const currentFrontendState = frontendState || status?.frontend || null;
  const activeProjectId = currentFrontendState?.activeProjectId || "";
  const activeConversationId = currentFrontendState?.activeConversationId || "";
  const activeConversation = currentFrontendState?.conversations.find((conversation) => conversation.id === activeConversationId) || null;
  const frontendBusy = Boolean(currentFrontendState?.busy || activeConversation?.busy);
  const canLoadFrontendState = Boolean(remoteControlReady && !busy);
  const canSendFrontendPrompt = Boolean(remoteControlReady && !busy && !frontendBusy && activeConversationId && remotePrompt.trim());
  const canRefreshFeedback = Boolean(remoteControlReady && !busy && activeConversationId);
  const transport = formatRelayTransport(relayValidation);

  const showMessage = useCallback((text: string, kind: MessageKind = "info") => {
    setMessage(text);
    setMessageKind(kind);
  }, []);

  const applyFrontendState = useCallback((nextState?: RemoteFrontendState | null) => {
    if (!nextState) return;
    setFrontendState(nextState);
    setFeedback(nextState.feedback || null);
  }, []);

  const applyStatusPayload = useCallback((nextStatus?: RemoteBridgeStatus | null, nextAuth?: RemoteDevice | null) => {
    if (!nextStatus) return;
    setStatus(nextStatus);
    applyFrontendState(nextStatus.frontend || null);
    if (nextAuth) setPairedDevice(nextAuth);
  }, [applyFrontendState]);

  const syncConnectionStatus = useCallback(async (
    targetConnection: ConnectionState,
    options: { action?: BusyAction; silent?: boolean } = {}
  ) => {
    if (!targetConnection.relayUrl || !targetConnection.deviceToken) {
      if (!options.silent) showMessage("请先用配对码完成设备绑定。", "error");
      return false;
    }

    const validation = validateRelayUrl(targetConnection.relayUrl, pageProtocol, pageHostname);
    if (!validation.ok) {
      if (!options.silent) showMessage(validation.message, "error");
      return false;
    }

    if (options.action) setBusyAction(options.action);
    setStatusError(false);
    try {
      const nextClient = createRemoteClient(targetConnection);
      const result = await nextClient.status();
      applyStatusPayload(result.status, result.auth || null);

      if (result.status?.relay?.connected && result.status.mobileRemoteControlEnabled) {
        const frontendResult = await nextClient.frontendState();
        if (frontendResult.ok) applyFrontendState(frontendResult.state);
      }

      if (!options.silent) showMessage("桌面端状态已刷新。");
      return true;
    } catch (error) {
      setStatusError(true);
      if (!options.silent) showMessage(errorMessage(error), "error");
      return false;
    } finally {
      if (options.action) setBusyAction(null);
    }
  }, [applyFrontendState, applyStatusPayload, pageHostname, pageProtocol, showMessage]);

  useEffect(() => {
    const key = `${connection.relayUrl}|${connection.deviceToken}`;
    if (!connection.deviceToken || !connection.relayUrl || lastAutoRefreshKey.current === key) return;
    lastAutoRefreshKey.current = key;
    void syncConnectionStatus(connection, { action: "status", silent: true });
  }, [connection, syncConnectionStatus]);

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
      applyFrontendState(result.status?.frontend || null);
      setPairedDevice(result.device || null);
      const synced = await syncConnectionStatus(next, { silent: true });
      showMessage(synced ? "已配对，并已同步桌面前端状态。" : `已配对：${result.device?.name || next.deviceName}。如果前端调度未开启，请点刷新。`, synced ? "info" : "error");
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

    await syncConnectionStatus(connection, { action: "status" });
  }

  async function loadFrontendState() {
    if (!remoteControlReady) {
      showMessage("请先完成配对，并在桌面端开启手机远程控制。", "error");
      return;
    }

    setBusyAction("frontend-state");
    try {
      const result = await client.frontendState();
      if (!result.ok) {
        throw new RemoteError(result.error || "无法读取桌面前端状态。", 400);
      }
      applyFrontendState(result.state);
      showMessage("已读取桌面前端项目和对话。");
    } catch (error) {
      showMessage(errorMessage(error), "error");
    } finally {
      setBusyAction(null);
    }
  }

  async function selectFrontendProject(projectId: string) {
    if (!remoteControlReady) {
      showMessage("请先完成配对，并在桌面端开启手机远程控制。", "error");
      return;
    }

    setBusyAction("frontend-select");
    try {
      const result = await client.selectFrontend({ projectId });
      if (!result.ok) {
        throw new RemoteError(result.error || "桌面端未接受项目选择。", 400);
      }
      applyFrontendState(result.state);
      showMessage("已切换项目。");
    } catch (error) {
      showMessage(errorMessage(error), "error");
    } finally {
      setBusyAction(null);
    }
  }

  async function selectFrontendConversation(conversationId: string) {
    if (!remoteControlReady) {
      showMessage("请先完成配对，并在桌面端开启手机远程控制。", "error");
      return;
    }

    setBusyAction("frontend-select");
    try {
      const result = await client.selectFrontend({
        projectId: activeProjectId,
        conversationId
      });
      if (!result.ok) {
        throw new RemoteError(result.error || "桌面端未接受对话选择。", 400);
      }
      applyFrontendState(result.state);
      showMessage("已切换对话。");
    } catch (error) {
      showMessage(errorMessage(error), "error");
    } finally {
      setBusyAction(null);
    }
  }

  async function sendFrontendPrompt() {
    if (!remoteControlReady) {
      showMessage("请先完成配对，并在桌面端开启手机远程控制。", "error");
      return;
    }
    if (!activeConversationId) {
      showMessage("请先选择一个桌面端对话。", "error");
      return;
    }
    if (!remotePrompt.trim()) {
      showMessage("请输入要发送到当前对话的内容。", "error");
      return;
    }

    setBusyAction("frontend-prompt");
    try {
      const result = await client.sendFrontendPrompt({
        conversationId: activeConversationId,
        prompt: remotePrompt
      });
      if (!result.ok) {
        throw new RemoteError(result.error || "桌面端未接受该指令。", 400);
      }
      applyFrontendState(result.state);
      setRemotePrompt("");
      showMessage("内容已发送到桌面前端对话。完成后刷新反馈即可查看结果。");
    } catch (error) {
      showMessage(errorMessage(error), "error");
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshFrontendFeedback() {
    if (!remoteControlReady) {
      showMessage("请先完成配对，并在桌面端开启手机远程控制。", "error");
      return;
    }
    if (!activeConversationId) {
      showMessage("请先选择一个桌面端对话。", "error");
      return;
    }

    setBusyAction("frontend-feedback");
    try {
      const result = await client.frontendFeedback(activeConversationId);
      if (!result.ok) {
        throw new RemoteError(result.error || "无法读取对话反馈。", 400);
      }
      if (result.state) applyFrontendState(result.state);
      setFeedback(result.feedback || result.state?.feedback || null);
      showMessage("反馈已刷新。");
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
    setFrontendState(null);
    setFeedback(null);
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

      <details className="panel mobile-details control-panel" open={remoteControlReady}>
        <summary>
          <span>
            <small>前端调度</small>
            <strong>{activeConversation?.title || "选择桌面端对话"}</strong>
          </span>
          <SecurityBadge
            tone={remoteControlReady ? "ok" : remoteControlEnabled ? "warn" : "muted"}
            label={remoteControlReady ? "已连接前端" : remoteControlEnabled ? "待刷新" : "未开启"}
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
              icon={<FolderOpen size={15} />}
              label="项目"
              value={currentFrontendState?.projects.length ? String(currentFrontendState.projects.length) : "未读取"}
              tone={currentFrontendState?.projects.length ? "ok" : "muted"}
            />
            <StatusChip
              icon={<MessageSquare size={16} />}
              label="对话"
              value={activeConversation ? "已选择" : "未选择"}
              tone={activeConversation ? "ok" : "muted"}
            />
          </div>

          <div className="control-form">
            <label>
              项目
              <select
                value={activeProjectId}
                onChange={(event) => void selectFrontendProject(event.target.value)}
                disabled={busy || !remoteControlReady || !currentFrontendState?.projects.length}
              >
                {!currentFrontendState?.projects.length ? <option value="">暂无项目</option> : null}
                {currentFrontendState?.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} · {project.sessionCount}
                  </option>
                ))}
              </select>
            </label>

            <label>
              对话
              <select
                value={activeConversationId}
                onChange={(event) => void selectFrontendConversation(event.target.value)}
                disabled={busy || !remoteControlReady || !currentFrontendState?.conversations.length}
              >
                {!currentFrontendState?.conversations.length ? <option value="">暂无对话</option> : null}
                {currentFrontendState?.conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title} · {conversation.messageCount}
                  </option>
                ))}
              </select>
            </label>

            <div className="secondary-actions left">
              <button type="button" className="quiet" onClick={loadFrontendState} disabled={!canLoadFrontendState}>
                <RefreshCw size={15} aria-hidden />
                {busyAction === "frontend-state" ? "读取中" : "读取项目/对话"}
              </button>
              <button type="button" className="quiet" onClick={refreshFrontendFeedback} disabled={!canRefreshFeedback}>
                <RefreshCw size={15} aria-hidden />
                {busyAction === "frontend-feedback" ? "刷新中" : "刷新反馈"}
              </button>
            </div>

            <label>
              发送到当前对话
              <textarea
                value={remotePrompt}
                onChange={(event) => setRemotePrompt(event.target.value)}
                placeholder="例如：检查当前实现并给出下一步建议"
                disabled={busy || !remoteControlReady || !activeConversationId || frontendBusy}
              />
            </label>

            <div className="primary-action">
              <button type="button" className="primary" onClick={sendFrontendPrompt} disabled={!canSendFrontendPrompt}>
                <Send size={16} aria-hidden />
                {busyAction === "frontend-prompt" ? "发送中" : "发送到桌面前端"}
              </button>
            </div>
          </div>

          <section className={feedback?.content ? "feedback-card" : "feedback-card empty"}>
            <div>
              <span className="section-label">总结反馈</span>
              <h2>{feedback?.title || (feedback?.pending ? "等待桌面端完成" : "暂无反馈")}</h2>
            </div>
            {feedback?.content ? <p>{feedback.content}</p> : <p>这里显示桌面前端当前对话里已有的最近反馈，不会重新生成总结。</p>}
          </section>

          <p className={remoteControlReady ? "inline-note" : "inline-warning"}>
            {remoteControlReady ? <CheckCircle2 size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
            {remoteControlReady ? "手机端只调度桌面前端能力，不直接写入 CLI 终端。" : "需要桌面端开启 Relay 和手机远程控制后才能读取前端。"}
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
            <InfoRow label="CLI 状态" value={harnessRunning ? `运行中${activeSession ? ` · ${activeSession.pid}` : ""}` : "空闲"} />
            <InfoRow label="当前项目" value={currentFrontendState?.projects.find((project) => project.id === activeProjectId)?.name || "未选择"} />
            <InfoRow label="当前对话" value={activeConversation?.title || "未选择"} />
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
