import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  type BridgeCallMessage,
  type BridgeSession,
  type ClientToServerMessage,
  type ControlState,
  createDisconnectedStatus,
  evaluateProtocolCompatibility,
  type EditorStatus,
  parseClientMessage
} from "../protocol/messages.js";
import {
  BridgeControlError,
  BridgeProtocolCompatibilityError,
  BridgeRpcError,
  BridgeTimeoutError,
  BridgeUnavailableError
} from "./errors.js";

type PendingCall = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

export type EasyEdaBridgeOptions = {
  host?: string;
  port?: number;
  logger?: Pick<Console, "error" | "warn" | "info">;
  /** Label shown to other sessions, e.g. "claude-code (pid 123)". */
  label?: string;
  /** How long to wait before trying to become the hub again after losing it. */
  roleRetryMs?: number;
  /** How long a peer waits for the hub's welcome before treating the port owner as incompatible. */
  peerHandshakeMs?: number;
};

export type ControlAction = "status" | "take" | "release";

/**
 * Methods that change the project, the editor view, or write files. A session must hold the
 * control right to run them; everything else (reads) is open to every connected session.
 */
export const CONTROL_METHODS = new Set([
  "setComponentValues",
  "confirmedAction",
  "navigateComponent",
  "navigateRegion",
  "zoomBoard",
  "exportBom",
  "exportNetlist",
  "exportGerber",
  "exportPdf"
]);

const PEER_PATH = "/peer";

type Participant = { instanceId: string; label: string };

type PeerConnection = Participant & { socket: WebSocket };

/** Messages exchanged between easyeda-mcp processes on the /peer path. */
type PeerMessage =
  | { kind: "peer-hello"; instanceId: string; label: string }
  | { kind: "peer-welcome"; hubInstanceId: string; status: EditorStatus; control: ControlState }
  | { kind: "peer-status"; status: EditorStatus; control: ControlState }
  | { kind: "peer-call"; requestId: string; method: string; params?: unknown; timeoutMs: number }
  | { kind: "peer-control"; requestId: string; action: ControlAction }
  | { kind: "peer-result"; requestId: string; result: unknown }
  | { kind: "peer-error"; requestId: string; error: SerializedError };

type SerializedError = {
  type: "unavailable" | "timeout" | "protocol" | "control" | "rpc";
  message: string;
  code?: string;
  details?: unknown;
  expectedProtocolVersion?: string;
  actualProtocolVersion?: string;
  holder?: string;
};

/**
 * Connects MCP sessions to the EasyEDA Pro extension.
 *
 * Several MCP server processes can run at once (Claude Desktop starts one per chat, Cowork and
 * Code session). The first one to bind the port becomes the hub and talks to the extension; the
 * others connect to the hub as peers and relay their calls through it. If the hub exits, a peer
 * takes the port over and the rest reconnect to it.
 */
export class EasyEdaBridge {
  private readonly host: string;
  private readonly port: number;
  private readonly logger: Pick<Console, "error" | "warn" | "info">;
  private readonly roleRetryMs: number;
  private readonly peerHandshakeMs: number;
  readonly instanceId = randomUUID();
  private label: string;

  private role: BridgeSession["role"] = "starting";
  private stopped = false;
  private roleTimer?: NodeJS.Timeout;
  private status: EditorStatus = createDisconnectedStatus();
  private readonly pending = new Map<string, PendingCall>();

  // hub state
  private wss?: WebSocketServer;
  private socket?: WebSocket;
  private readonly peers = new Map<WebSocket, PeerConnection>();
  private control: ControlState = {};

  // peer state
  private hubSocket?: WebSocket;

  constructor(options: EasyEdaBridgeOptions = {}) {
    this.host = options.host ?? process.env.EASYEDA_MCP_WS_HOST ?? "127.0.0.1";
    this.port = options.port ?? Number(process.env.EASYEDA_MCP_WS_PORT ?? 8765);
    this.logger = options.logger ?? console;
    this.label = options.label ?? `easyeda-mcp (pid ${process.pid})`;
    this.roleRetryMs = options.roleRetryMs ?? 2_000;
    this.peerHandshakeMs = options.peerHandshakeMs ?? 2_000;
  }

  get endpoint(): string {
    const address = this.wss?.address();
    const activePort = typeof address === "object" && address ? address.port : this.port;
    return `ws://${this.host}:${activePort}`;
  }

  getStatus(): EditorStatus {
    return { ...this.status, session: this.session() };
  }

  setLabel(label: string): void {
    this.label = label;
    if (this.role === "hub") {
      this.broadcastPeerStatus();
    } else if (this.hubSocket?.readyState === WebSocket.OPEN) {
      this.sendPeer(this.hubSocket, { kind: "peer-hello", instanceId: this.instanceId, label });
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.resolveRole();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.roleTimer);
    this.roleTimer = undefined;
    this.rejectAll(new BridgeUnavailableError("EasyEDA Pro bridge is stopping."));
    this.hubSocket?.close();
    this.hubSocket = undefined;
    this.socket?.close();
    for (const peer of this.peers.keys()) peer.close();
    this.peers.clear();
    await new Promise<void>((resolve, reject) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close((error) => (error ? reject(error) : resolve()));
    });
    this.wss = undefined;
    this.socket = undefined;
    this.role = "starting";
    this.status = createDisconnectedStatus();
  }

  async call(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this.role === "hub") {
      return this.dispatch(this.self(), method, params, timeoutMs);
    }
    if (this.role === "peer" && this.hubSocket?.readyState === WebSocket.OPEN) {
      return this.peerRequest({ kind: "peer-call", requestId: randomUUID(), method, params, timeoutMs }, method, timeoutMs + 2_000);
    }
    throw new BridgeUnavailableError(this.status.message);
  }

  /** Reads, takes, or releases the control right for this session. */
  async controlAction(action: ControlAction): Promise<ControlState> {
    if (this.role === "hub") {
      return this.applyControl(this.self(), action);
    }
    if (this.role === "peer" && this.hubSocket?.readyState === WebSocket.OPEN) {
      return await this.peerRequest({ kind: "peer-control", requestId: randomUUID(), action }, "control", 5_000) as ControlState;
    }
    throw new BridgeUnavailableError(this.status.message);
  }

  // ---------------------------------------------------------------- role selection

  private async resolveRole(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.listen();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
    try {
      await this.connectAsPeer();
    } catch (error) {
      this.role = "standby";
      this.status = createDisconnectedStatus(
        `Port ${this.port} is held by a process that is not a compatible easyeda-mcp hub (${(error as Error).message}). Retrying.`
      );
      this.scheduleRoleRetry(this.roleRetryMs);
    }
  }

  private scheduleRoleRetry(delayMs: number): void {
    if (this.stopped || this.roleTimer) return;
    this.roleTimer = setTimeout(() => {
      this.roleTimer = undefined;
      this.resolveRole().catch((error: Error) => {
        this.logger.error(`[easyeda-mcp] Bridge role selection failed: ${error.message}`);
        this.scheduleRoleRetry(this.roleRetryMs);
      });
    }, delayMs);
    this.roleTimer.unref();
  }

  // ---------------------------------------------------------------- hub

  private async listen(): Promise<void> {
    const wss = new WebSocketServer({ host: this.host, port: this.port });
    try {
      await new Promise<void>((resolve, reject) => {
        wss.once("listening", resolve);
        wss.once("error", reject);
      });
    } catch (error) {
      wss.close();
      throw error;
    }
    this.wss = wss;
    this.role = "hub";
    this.status = createDisconnectedStatus();
    wss.on("connection", (socket, request) => this.acceptConnection(socket, request));
    this.logger.error(`[easyeda-mcp] WebSocket bridge listening at ${this.endpoint} (hub)`);
  }

  private acceptConnection(socket: WebSocket, request: IncomingMessage): void {
    if (request.url?.startsWith(PEER_PATH)) {
      this.acceptPeer(socket);
    } else {
      this.attachExtension(socket);
    }
  }

  private attachExtension(socket: WebSocket): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.rejectAll(new BridgeUnavailableError("EasyEDA Pro extension reconnected. Retry the MCP tool call."));
      this.socket.close(1012, "A newer EasyEDA Pro extension connection replaced this one.");
    }

    this.socket = socket;
    this.setStatus({
      connected: true,
      connectionState: "connecting",
      message: "EasyEDA Pro extension connected. Waiting for hello/status.",
      updatedAt: new Date().toISOString()
    });
    this.logger.error("[easyeda-mcp] EasyEDA Pro extension connected");

    socket.on("message", (data) => {
      try {
        this.handleExtensionMessage(parseClientMessage(data.toString()));
      } catch (error) {
        this.logger.warn(`[easyeda-mcp] Ignored invalid bridge message: ${String(error)}`);
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.setStatus(createDisconnectedStatus("EasyEDA Pro extension disconnected. Keep the extension open or reopen EasyEDA Pro."));
        this.rejectAll(new BridgeUnavailableError(this.status.message));
      }
      this.logger.error("[easyeda-mcp] EasyEDA Pro extension disconnected");
    });
  }

  private acceptPeer(socket: WebSocket): void {
    socket.on("message", (data) => {
      let message: PeerMessage;
      try {
        message = JSON.parse(data.toString()) as PeerMessage;
      } catch {
        return;
      }
      void this.handlePeerMessage(socket, message);
    });
    socket.on("close", () => {
      const peer = this.peers.get(socket);
      this.peers.delete(socket);
      if (peer && this.control.holderId === peer.instanceId) {
        this.control = {};
        this.broadcastPeerStatus();
      }
    });
  }

  private async handlePeerMessage(socket: WebSocket, message: PeerMessage): Promise<void> {
    if (message.kind === "peer-hello") {
      this.peers.set(socket, { socket, instanceId: message.instanceId, label: message.label });
      if (this.control.holderId === message.instanceId) {
        this.control = { ...this.control, holderLabel: message.label };
      }
      this.sendPeer(socket, { kind: "peer-welcome", hubInstanceId: this.instanceId, status: this.status, control: this.control });
      return;
    }

    const peer = this.peers.get(socket);
    if (!peer || (message.kind !== "peer-call" && message.kind !== "peer-control")) {
      return;
    }
    try {
      const result = message.kind === "peer-call"
        ? await this.dispatch(peer, message.method, message.params, message.timeoutMs)
        : this.applyControl(peer, message.action);
      this.sendPeer(socket, { kind: "peer-result", requestId: message.requestId, result });
    } catch (error) {
      this.sendPeer(socket, { kind: "peer-error", requestId: message.requestId, error: serializeError(error) });
    }
  }

  private async dispatch(caller: Participant, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (CONTROL_METHODS.has(method)) {
      if (!this.control.holderId) {
        this.setControl(caller);
      } else if (this.control.holderId !== caller.instanceId) {
        throw new BridgeControlError(method, this.control.holderLabel ?? this.control.holderId);
      }
    }
    return this.callExtension(method, params, timeoutMs);
  }

  private applyControl(caller: Participant, action: ControlAction): ControlState {
    if (action === "take") {
      this.setControl(caller);
    } else if (action === "release" && this.control.holderId === caller.instanceId) {
      this.control = {};
      this.broadcastPeerStatus();
    }
    return this.control;
  }

  private setControl(caller: Participant): void {
    if (this.control.holderId === caller.instanceId) return;
    this.control = { holderId: caller.instanceId, holderLabel: caller.label, since: new Date().toISOString() };
    this.logger.error(`[easyeda-mcp] Control right is now held by ${caller.label}`);
    this.broadcastPeerStatus();
  }

  private callExtension(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new BridgeUnavailableError();
    }

    if (this.status.compatibility && !this.status.compatibility.compatible) {
      throw new BridgeProtocolCompatibilityError(
        this.status.compatibility.reason ?? "EasyEDA Pro extension protocol is incompatible with the MCP server.",
        this.status.compatibility.expectedProtocolVersion,
        this.status.compatibility.actualProtocolVersion
      );
    }

    const requestId = randomUUID();
    const message: BridgeCallMessage = { kind: "call", requestId, method, params, timeoutMs };
    const response = this.track(requestId, method, timeoutMs, () => new BridgeTimeoutError(method, timeoutMs));
    this.socket.send(JSON.stringify(message));
    return response;
  }

  private handleExtensionMessage(message: ClientToServerMessage): void {
    if (message.kind === "hello") {
      const compatibility = evaluateProtocolCompatibility(message.protocolVersion);
      this.setStatus({
        connected: true,
        connectionState: compatibility.compatible ? "connected" : "blocked",
        extensionVersion: message.version,
        protocolVersion: message.protocolVersion,
        compatibility,
        capabilities: message.capabilities,
        ...message.status,
        message: compatibility.compatible ? message.status?.message : compatibility.reason,
        updatedAt: new Date().toISOString()
      });
      return;
    }

    if (message.kind === "status") {
      const reportedProtocolVersion = message.status.protocolVersion ?? this.status.protocolVersion;
      const compatibility = evaluateProtocolCompatibility(reportedProtocolVersion);
      this.setStatus({
        ...this.status,
        ...message.status,
        connected: true,
        connectionState: compatibility.compatible ? "connected" : "blocked",
        compatibility,
        message: compatibility.compatible ? message.status.message ?? this.status.message : compatibility.reason,
        updatedAt: new Date().toISOString()
      });
      return;
    }

    if (message.kind === "result" || message.kind === "error") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.kind === "result") {
        pending.resolve(message.result);
      } else {
        pending.reject(new BridgeRpcError(message.error.message, message.error.code, message.error.details));
      }
    }
  }

  private setStatus(status: EditorStatus): void {
    this.status = status;
    this.broadcastPeerStatus();
  }

  private broadcastPeerStatus(): void {
    for (const peer of this.peers.keys()) {
      this.sendPeer(peer, { kind: "peer-status", status: this.status, control: this.control });
    }
  }

  // ---------------------------------------------------------------- peer

  private connectAsPeer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://${this.host}:${this.port}${PEER_PATH}`);
      let welcomed = false;
      const handshake = setTimeout(() => {
        socket.terminate();
        reject(new Error("no hub handshake"));
      }, this.peerHandshakeMs);

      socket.once("error", (error) => {
        if (!welcomed) {
          clearTimeout(handshake);
          reject(error);
        }
      });
      socket.once("open", () => {
        this.sendPeer(socket, { kind: "peer-hello", instanceId: this.instanceId, label: this.label });
      });
      socket.on("message", (data) => {
        let message: PeerMessage;
        try {
          message = JSON.parse(data.toString()) as PeerMessage;
        } catch {
          return;
        }
        if (message.kind === "peer-welcome" && !welcomed) {
          welcomed = true;
          clearTimeout(handshake);
          this.hubSocket = socket;
          this.role = "peer";
          this.status = message.status;
          this.control = message.control;
          this.logger.error(`[easyeda-mcp] Connected to the bridge hub at ${this.endpoint} as a peer`);
          resolve();
          return;
        }
        this.handleHubMessage(message);
      });
      socket.on("close", () => {
        if (!welcomed) {
          clearTimeout(handshake);
          reject(new Error("hub closed the connection"));
          return;
        }
        if (this.hubSocket !== socket) return;
        this.hubSocket = undefined;
        this.role = "standby";
        this.control = {};
        this.status = createDisconnectedStatus("The bridge hub went away; this session is taking over or reconnecting.");
        this.rejectAll(new BridgeUnavailableError("The bridge hub went away. Retry the MCP tool call."));
        // Jitter so that several peers do not race for the port at the same instant.
        this.scheduleRoleRetry(100 + Math.floor(Math.random() * 400));
      });
    });
  }

  private handleHubMessage(message: PeerMessage): void {
    if (message.kind === "peer-status") {
      this.status = message.status;
      this.control = message.control;
      return;
    }
    if (message.kind !== "peer-result" && message.kind !== "peer-error") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.kind === "peer-result") {
      pending.resolve(message.result);
    } else {
      pending.reject(deserializeError(message.error));
    }
  }

  private peerRequest(message: PeerMessage & { requestId: string }, method: string, timeoutMs: number): Promise<unknown> {
    const response = this.track(message.requestId, method, timeoutMs, () => new BridgeTimeoutError(method, timeoutMs));
    this.sendPeer(this.hubSocket!, message);
    return response;
  }

  // ---------------------------------------------------------------- shared helpers

  private self(): Participant {
    return { instanceId: this.instanceId, label: this.label };
  }

  private session(): BridgeSession {
    return {
      role: this.role,
      instanceId: this.instanceId,
      label: this.label,
      peers: this.role === "hub" ? this.peers.size : undefined,
      control: {
        ...this.control,
        heldByThisSession: this.control.holderId === this.instanceId
      }
    };
  }

  private track(requestId: string, method: string, timeoutMs: number, onTimeout: () => Error): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(onTimeout());
      }, timeoutMs);
      this.pending.set(requestId, { method, resolve, reject, timer });
    });
  }

  private sendPeer(socket: WebSocket, message: PeerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof BridgeControlError) {
    return { type: "control", message: error.message, code: error.method, holder: error.holder };
  }
  if (error instanceof BridgeUnavailableError) {
    return { type: "unavailable", message: error.message };
  }
  if (error instanceof BridgeTimeoutError) {
    return { type: "timeout", message: error.message };
  }
  if (error instanceof BridgeProtocolCompatibilityError) {
    return {
      type: "protocol",
      message: error.message,
      expectedProtocolVersion: error.expectedProtocolVersion,
      actualProtocolVersion: error.actualProtocolVersion
    };
  }
  if (error instanceof BridgeRpcError) {
    return { type: "rpc", message: error.message, code: error.code, details: error.details };
  }
  return { type: "rpc", message: error instanceof Error ? error.message : String(error) };
}

function deserializeError(error: SerializedError): Error {
  switch (error.type) {
    case "control":
      return new BridgeControlError(error.code ?? "unknown", error.holder ?? "another session");
    case "unavailable":
      return new BridgeUnavailableError(error.message);
    case "timeout":
      return Object.assign(new BridgeTimeoutError("remote", 0), { message: error.message });
    case "protocol":
      return new BridgeProtocolCompatibilityError(error.message, error.expectedProtocolVersion ?? "", error.actualProtocolVersion);
    default:
      return new BridgeRpcError(error.message, error.code, error.details);
  }
}
