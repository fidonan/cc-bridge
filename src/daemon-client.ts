import { EventEmitter } from "node:events";
import type { BridgeMessage } from "./types";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "./control-protocol";
import type { RegistrySnapshot } from "./protocol";

interface DaemonClientEvents {
  codexMessage: [BridgeMessage];
  disconnect: [];
  status: [DaemonStatus];
}

export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private ws: WebSocket | null = null;
  private nextRequestId = 1;
  private connectPromise: Promise<void> | null = null;
  private pendingPulls = new Map<
    string,
    {
      resolve: (value: BridgeMessage[]) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingWaits = new Map<
    string,
    {
      resolve: (value: BridgeMessage[]) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingReplies = new Map<
    string,
    {
      resolve: (value: { success: boolean; error?: string; resolvedRecipients?: string[]; missingRecipients?: string[]; delivered_rooms?: string[]; skipped_rooms?: string[] }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingRegistryQueries = new Map<
    string,
    {
      resolve: (value: RegistrySnapshot) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private latestPeers: string[] = [];
  private selfEndpoint: string | null = null;
  private autoReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RECONNECT_DELAY_MS = 3000;
  private static readonly MAX_RECONNECT_DELAY_MS = 30000;
  private reconnectAttempts = 0;

  constructor(private readonly url: string) {
    super();
  }

  enableAutoReconnect() {
    this.autoReconnect = true;
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let settled = false;

      ws.onopen = () => {
        settled = true;
        this.ws = ws;
        this.attachSocketHandlers(ws);
        resolve();
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to connect to cc-bridge daemon at ${this.url}`));
      };

      ws.onclose = () => {
        if (settled) return;
        settled = true;
        reject(new Error(`cc-bridge daemon closed the connection during startup (${this.url})`));
      };
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  attachClaude() {
    this.send({ type: "claude_connect" });
  }

  async disconnect() {
    if (!this.ws) return;

    try {
      this.send({ type: "claude_disconnect" });
    } catch {}

    try {
      this.ws.close();
    } catch {}

    this.ws = null;
    this.rejectPendingReplies("Daemon connection closed");
  }

  listPeers(): string[] {
    return this.selfEndpoint
      ? this.latestPeers.filter((p) => p !== this.selfEndpoint)
      : this.latestPeers;
  }

  async sendReply(
    message: BridgeMessage,
    to?: string[],
    scope?: "room" | "global",
  ): Promise<{ success: boolean; error?: string; resolvedRecipients?: string[]; missingRecipients?: string[]; delivered_rooms?: string[]; skipped_rooms?: string[] }> {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await this.connect();
        this.attachClaude();
      }
    } catch (err: any) {
      return { success: false, error: err.message ?? "cc-bridge daemon is not connected." };
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: "cc-bridge daemon is not connected." };
    }

    const requestId = `reply_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        resolve({ success: false, error: "Timed out waiting for cc-bridge daemon reply." });
      }, 15000);

      this.pendingReplies.set(requestId, { resolve, timer });
      this.send({
        type: "post_message",
        requestId,
        message,
        ...(to && to.length > 0 ? { to } : {}),
        ...(scope ? { scope } : {}),
      });
    });
  }

  async queryRegistry(): Promise<RegistrySnapshot> {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await this.connect();
        this.attachClaude();
      }
    } catch {
      return { peers: [] };
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { peers: [] };
    }

    const requestId = `registry_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRegistryQueries.delete(requestId);
        resolve({ peers: [] });
      }, 15000);

      this.pendingRegistryQueries.set(requestId, { resolve, timer });
      this.send({ type: "query_registry", requestId });
    });
  }

  async pullMessages(): Promise<BridgeMessage[]> {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await this.connect();
        this.attachClaude();
      }
    } catch {
      return [];
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return [];
    }

    const requestId = `pull_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPulls.delete(requestId);
        resolve([]);
      }, 15000);

      this.pendingPulls.set(requestId, { resolve, timer });
      this.send({ type: "pull_messages", requestId });
    });
  }

  async waitForMessages(timeoutMs = 30000): Promise<BridgeMessage[]> {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await this.connect();
        this.attachClaude();
      }
    } catch {
      return [];
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return [];
    }

    const requestId = `wait_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWaits.delete(requestId);
        resolve([]);
      }, timeoutMs + 2000);

      this.pendingWaits.set(requestId, { resolve, timer });
      this.send({ type: "wait_for_messages", requestId, timeoutMs });
    });
  }

  private attachSocketHandlers(ws: WebSocket) {
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();

      let message: ControlServerMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      switch (message.type) {
        case "codex_to_claude":
          this.emit("codexMessage", message.message);
          return;
        case "post_message_result": {
          const pending = this.pendingReplies.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingReplies.delete(message.requestId);
          pending.resolve({
            success: message.success,
            error: message.error,
            resolvedRecipients: message.resolvedRecipients,
            missingRecipients: message.missingRecipients,
            delivered_rooms: message.delivered_rooms,
            skipped_rooms: message.skipped_rooms,
          });
          return;
        }
        case "query_registry_result": {
          const pending = this.pendingRegistryQueries.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingRegistryQueries.delete(message.requestId);
          pending.resolve(message.snapshot);
          return;
        }
        case "pull_messages_result": {
          const pending = this.pendingPulls.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingPulls.delete(message.requestId);
          pending.resolve(message.messages);
          return;
        }
        case "wait_for_messages_result": {
          const pending = this.pendingWaits.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingWaits.delete(message.requestId);
          pending.resolve(message.messages);
          return;
        }
        case "status":
          this.selfEndpoint = message.status.endpoint ?? null;
          this.latestPeers = message.status.peers ?? [];
          this.emit("status", message.status);
          return;
      }
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.rejectPendingReplies("cc-bridge daemon disconnected.");
      this.emit("disconnect");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // The close handler is the single place that tears down pending state.
    };
  }

  private rejectPendingReplies(error: string) {
    for (const [requestId, pending] of this.pendingReplies.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, error });
      this.pendingReplies.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingPulls.entries()) {
      clearTimeout(pending.timer);
      pending.resolve([]);
      this.pendingPulls.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingWaits.entries()) {
      clearTimeout(pending.timer);
      pending.resolve([]);
      this.pendingWaits.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingRegistryQueries.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ peers: [] });
      this.pendingRegistryQueries.delete(requestId);
    }
  }

  private send(message: ControlClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("cc-bridge daemon socket is not open.");
    }

    this.ws.send(JSON.stringify(message));
  }

  private scheduleReconnect() {
    if (!this.autoReconnect) return;
    if (this.reconnectTimer) return;

    const delay = Math.min(
      DaemonClient.RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      DaemonClient.MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      try {
        await this.connect();
        this.attachClaude();
        this.reconnectAttempts = 0;
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.autoReconnect = false;
  }
}
