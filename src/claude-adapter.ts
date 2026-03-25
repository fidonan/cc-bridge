/**
 * Claude Code MCP Server — Dual-Mode Message Transport
 *
 * Supports two delivery modes:
 *   - Push mode (OAuth): real-time via notifications/claude/channel
 *   - Pull mode (API key): message queue + get_messages tool
 *
 * Mode defaults to push in auto mode, or set explicitly via AGENTBRIDGE_MODE env var.
 *
 * Emits:
 *   - "ready"   ()                   — MCP connected, mode resolved
 *   - "reply"   (msg: BridgeMessage) — Claude used the reply tool
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { getInstanceConfig } from "./instance-config";
import type { BridgeMessage } from "./types";

export type ReplySender = (msg: BridgeMessage) => Promise<{ success: boolean; error?: string }>;
export type PullMessageReader = () => Promise<BridgeMessage[]>;
export type WaitMessageReader = (timeoutMs: number) => Promise<BridgeMessage[]>;
export type DeliveryMode = "push" | "pull" | "auto";

export const CLAUDE_INSTRUCTIONS = [
  "Your peer is another Claude Code session running on the same machine.",
  "",
  "## Message delivery",
  "Messages from your peer may arrive in two ways depending on the connection mode:",
  "- As <channel source=\"cc-bridge\" chat_id=\"...\" user=\"Peer Claude\" ...> tags (push mode)",
  "- Via the get_messages tool (pull mode)",
  "",
  "## Collaboration roles",
  "Default roles in this setup:",
  "- Local Claude: reviewer / coordinator / challenger",
  "- Peer Claude: independent engineer / implementer / verifier",
  "- Expect the peer to provide independent technical judgment and evidence, not passive agreement.",
  "",
  "## Thinking patterns (task-driven)",
  "- Analytical/review tasks: Independent Analysis & Convergence",
  "- Implementation tasks: Architect -> Builder -> Critic",
  "- Debugging tasks: Hypothesis -> Experiment -> Interpretation",
  "",
  "## Collaboration language",
  "- Use explicit phrases such as \"My independent view is:\", \"I agree on:\", \"I disagree on:\", and \"Current consensus:\".",
  "",
  "## How to interact",
  "- Use the reply tool to send messages back to your peer — pass chat_id back.",
  "- Use the get_messages tool to check for pending messages from your peer.",
  "- Use the wait_for_messages tool to stay in an active dialogue without manual polling.",
  "- After sending a reply, call get_messages to check for responses.",
  "- When the user asks about peer status or progress, call get_messages.",
  "",
  "## Turn coordination",
  "- Use short, explicit messages and wait for your peer's response before changing direction.",
  "- After your peer replies, you have an attention window to review and respond before new messages arrive.",
  "- If the reply tool returns a busy error, wait and try again later.",
].join("\n");

const LOG_FILE = getInstanceConfig().logFile;

export class ClaudeAdapter extends EventEmitter {
  private server: Server;
  private notificationSeq = 0;
  private sessionId: string;
  private replySender: ReplySender | null = null;
  private pullMessageReader: PullMessageReader | null = null;
  private waitMessageReader: WaitMessageReader | null = null;

  // Dual-mode transport
  private readonly configuredMode: DeliveryMode;
  private resolvedMode: "push" | "pull" | null = null;
  private pendingMessages: BridgeMessage[] = [];
  private readonly maxBufferedMessages: number;
  private droppedMessageCount = 0;

  constructor() {
    super();
    this.sessionId = `codex_${Date.now()}`;

    const envMode = process.env.AGENTBRIDGE_MODE as DeliveryMode | undefined;
    this.configuredMode = envMode && ["push", "pull", "auto"].includes(envMode) ? envMode : "auto";
    this.maxBufferedMessages = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);

    this.server = new Server(
      { name: "cc-bridge", version: "0.1.0" },
      {
        capabilities: {
          experimental: { "claude/channel": {} },
          tools: {},
        },
        instructions: CLAUDE_INSTRUCTIONS,
      },
    );

    this.setupHandlers();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start() {
    const transport = new StdioServerTransport();
    this.resolveMode();
    await this.server.connect(transport);
    this.log(`MCP server connected (mode: ${this.resolvedMode})`);
    this.emit("ready");
  }

  /** Register the async sender that bridge provides for reply delivery. */
  setReplySender(sender: ReplySender) {
    this.replySender = sender;
  }

  setPullMessageReader(reader: PullMessageReader) {
    this.pullMessageReader = reader;
  }

  setWaitMessageReader(reader: WaitMessageReader) {
    this.waitMessageReader = reader;
  }

  /** Returns the resolved delivery mode. */
  getDeliveryMode(): "push" | "pull" {
    return this.resolvedMode ?? "pull";
  }

  /** Returns the number of messages waiting in the pull queue. */
  getPendingMessageCount(): number {
    return this.pendingMessages.length;
  }

  // ── Mode Detection ─────────────────────────────────────────

  private resolveMode(): void {
    if (this.resolvedMode) return;

    if (this.configuredMode === "push" || this.configuredMode === "pull") {
      this.resolvedMode = this.configuredMode;
      this.log(`Delivery mode set by AGENTBRIDGE_MODE: ${this.resolvedMode}`);
    } else {
      // Default to push — Claude Code doesn't declare channel support in
      // client capabilities, so we can't detect it. Push is the better default
      // because it's real-time; if channels aren't available, notifications
      // are silently ignored (no error), and users can set AGENTBRIDGE_MODE=pull
      // explicitly for API key setups.
      this.resolvedMode = "push";
      this.log("Delivery mode defaulting to push (set AGENTBRIDGE_MODE=pull for API key mode)");
    }
  }

  // ── Message Delivery ───────────────────────────────────────

  async pushNotification(message: BridgeMessage) {
    if (this.resolvedMode === "push") {
      await this.pushViaChannel(message);
    } else if (!this.pullMessageReader) {
      this.queueForPull(message);
    }
  }

  private async pushViaChannel(message: BridgeMessage) {
    const msgId = `codex_msg_${++this.notificationSeq}`;
    const ts = new Date(message.timestamp).toISOString();

    try {
      await this.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: message.content,
          meta: {
            chat_id: this.sessionId,
            message_id: msgId,
            user: "Codex",
            user_id: "codex",
            ts,
            source_type: "codex",
          },
        },
      });
      this.log(`Pushed notification: ${msgId}`);
    } catch (e: any) {
      this.log(`Push notification failed: ${e.message}`);
      // Do NOT fall back to queue — the notification may have been partially
      // delivered, and queuing would risk duplicate messages when Claude polls.
    }
  }

  private queueForPull(message: BridgeMessage) {
    if (this.pendingMessages.length >= this.maxBufferedMessages) {
      this.pendingMessages.shift();
      this.droppedMessageCount++;
      this.log(`Message queue full, dropped oldest message (total dropped: ${this.droppedMessageCount})`);
    }
    this.pendingMessages.push(message);
    this.log(`Queued message for pull (${this.pendingMessages.length} pending)`);
  }

  // ── get_messages ───────────────────────────────────────────

  private async drainMessages(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (this.pullMessageReader) {
      const pulled = await this.pullMessageReader();
      if (pulled.length > 0) {
        this.pendingMessages.push(...pulled);
      }
    }

    if (this.pendingMessages.length === 0 && this.droppedMessageCount === 0) {
      return {
        content: [{ type: "text" as const, text: "No new messages from your peer." }],
      };
    }

    // Snapshot and clear atomically to avoid issues with concurrent writes
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    const dropped = this.droppedMessageCount;
    this.droppedMessageCount = 0;

    const count = messages.length;
    let header = `[${count} new message${count > 1 ? "s" : ""} from peer]`;
    if (dropped > 0) {
      header += ` (${dropped} older message${dropped > 1 ? "s" : ""} were dropped due to queue overflow)`;
    }
    header += `\nchat_id: ${this.sessionId}`;

    const formatted = messages
      .map((msg, i) => {
        const ts = new Date(msg.timestamp).toISOString();
        return `---\n[${i + 1}] ${ts}\nPeer: ${msg.content}`;
      })
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `${header}\n\n${formatted}`,
        },
      ],
    };
  }

  // ── MCP Tool Handlers ─────────────────────────────────────

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "reply",
          description:
            "Send a message to the peer Claude session through cc-bridge.",
          inputSchema: {
            type: "object" as const,
            properties: {
              chat_id: {
                type: "string",
                description: "The conversation to reply in (from the inbound <channel> tag).",
              },
              text: {
                type: "string",
                description: "The message to send to Codex.",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "get_messages",
          description:
            "Check for new messages from your peer Claude session. Call this after sending a reply or when you expect a response.",
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
          },
        },
        {
          name: "wait_for_messages",
          description:
            "Wait for new messages from your peer Claude session. Use this for ongoing back-and-forth without manual polling.",
          inputSchema: {
            type: "object" as const,
            properties: {
              timeout_ms: {
                type: "number",
                description: "Maximum time to wait before returning. Default 30000.",
              },
            },
            required: [],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "reply") {
        return this.handleReply(args as Record<string, unknown>);
      }

      if (name === "get_messages") {
        return await this.drainMessages();
      }

      if (name === "wait_for_messages") {
        return await this.waitForMessages(args as Record<string, unknown>);
      }

      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    });
  }

  private async handleReply(args: Record<string, unknown>) {
    const text = args?.text as string | undefined;
    if (!text) {
      return {
        content: [{ type: "text" as const, text: "Error: missing required parameter 'text'" }],
        isError: true,
      };
    }

    const bridgeMsg: BridgeMessage = {
      id: (args?.chat_id as string) ?? `reply_${Date.now()}`,
      source: "claude",
      content: text,
      timestamp: Date.now(),
    };

    if (!this.replySender) {
      this.log("No reply sender registered");
      return {
        content: [{ type: "text" as const, text: "Error: bridge not initialized, cannot send reply." }],
        isError: true,
      };
    }

    const result = await this.replySender(bridgeMsg);
    if (!result.success) {
      this.log(`Reply delivery failed: ${result.error}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    // Include pending message hint
    const pending = this.pendingMessages.length;
    let responseText = "Reply sent to peer Claude.";
    if (pending > 0) {
      responseText += ` Note: ${pending} unread peer message${pending > 1 ? "s" : ""} already waiting \u2014 call get_messages to read them.`;
    }

    return {
      content: [{ type: "text" as const, text: responseText }],
    };
  }

  private async waitForMessages(args: Record<string, unknown>) {
    const timeoutArg = args?.timeout_ms;
    const timeoutMs = typeof timeoutArg === "number" && Number.isFinite(timeoutArg)
      ? Math.max(1000, Math.min(120000, Math.trunc(timeoutArg)))
      : 30000;

    const immediate = await this.drainMessages();
    const immediateText = immediate.content[0]?.text ?? "";
    if (immediateText !== "No new messages from your peer.") {
      return immediate;
    }

    if (!this.waitMessageReader) {
      return {
        content: [{ type: "text" as const, text: `No new messages arrived within ${timeoutMs}ms.` }],
      };
    }

    const waited = await this.waitMessageReader(timeoutMs);
    if (waited.length > 0) {
      this.pendingMessages.push(...waited);
      return await this.drainMessages();
    }

    return {
      content: [{ type: "text" as const, text: `No new messages arrived within ${timeoutMs}ms.` }],
    };
  }

  private log(msg: string) {
    const line = `[${new Date().toISOString()}] [ClaudeAdapter] ${msg}\n`;
    process.stderr.write(line);
    try {
      appendFileSync(LOG_FILE, line);
    } catch {}
  }
}
