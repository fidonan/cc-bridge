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

export type ReplySender = (
  msg: BridgeMessage,
  to?: string[],
  scope?: "room" | "global",
) => Promise<{ success: boolean; error?: string; resolvedRecipients?: string[]; missingRecipients?: string[]; delivered_rooms?: string[]; skipped_rooms?: string[] }>;
export type PullMessageReader = () => Promise<BridgeMessage[]>;
export type WaitMessageReader = (timeoutMs: number) => Promise<BridgeMessage[]>;
export type PeerLister = () => string[];
export type RegistryReader = () => Promise<import("./protocol").RegistrySnapshot>;
export type PeerLauncher = (input: {
  peerTargets?: Array<{
    endpoint: string;
    role?: string;
    profile?: string;
    workdir?: string;
    bootstrap_message?: string;
  }>;
  targets?: string[];
  count?: number;
  startFrom?: string;
  profiles?: Record<string, string>;
  workdir?: string;
  initialPrompt?: string;
  initialPrompts?: Record<string, string>;
}) => Promise<{
  success: boolean;
  launched: string[];
  failed: Record<string, string>;
  note?: string;
}>;
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
  private peerLister: PeerLister | null = null;
  private peerLauncher: PeerLauncher | null = null;
  private registryReader: RegistryReader | null = null;

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

  setPeerLister(lister: PeerLister) {
    this.peerLister = lister;
  }

  setPeerLauncher(launcher: PeerLauncher) {
    this.peerLauncher = launcher;
  }

  setRegistryReader(reader: RegistryReader) {
    this.registryReader = reader;
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
            "Send a message to one or more peer Claude sessions through cc-bridge. Omit 'to' to broadcast to all peers.",
          inputSchema: {
            type: "object" as const,
            properties: {
              chat_id: {
                type: "string",
                description: "The conversation to reply in (from the inbound <channel> tag).",
              },
              text: {
                type: "string",
                description: "The message to send.",
              },
              to: {
                type: "array",
                items: { type: "string" },
                description: "Optional list of peer endpoint names to send to (e.g. ['B', 'C']). Omit or pass empty array to broadcast to all peers in room.",
              },
              scope: {
                type: "string",
                enum: ["room", "global"],
                description: "Optional delivery scope. 'room' (default) sends to peers in the current room. 'global' broadcasts to all active rooms across the bridge.",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "list_peers",
          description: "List the currently active peer endpoints in this room.",
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
          },
        },
        {
          name: "list_all_peers",
          description: "List all known peer endpoints across all rooms, including their role, status, room, and load stats. Uses the daemon registry (not just the current room).",
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
          },
        },
        {
          name: "launch_peers",
          description:
            "Launch one or more peer Claude Code windows using the configured local launcher template. This is intended for window A to start B/C/D/E via ccswitch or a similar wrapper.",
          inputSchema: {
            type: "object" as const,
            properties: {
              targets: {
                type: "array",
                items: { type: "string" },
                description: "Optional explicit peer endpoint names to launch, for example ['B', 'C', 'D', 'E'].",
              },
              peer_targets: {
                type: "array",
                description: "Preferred role-aware launch format. Each target may define endpoint, role, profile, workdir, and bootstrap_message.",
                items: {
                  type: "object",
                  properties: {
                    endpoint: { type: "string" },
                    role: { type: "string" },
                    profile: { type: "string" },
                    workdir: { type: "string" },
                    bootstrap_message: { type: "string" },
                    target_room: { type: "string", description: "Phase 5C: room the peer should join on startup (defaults to caller's room)." },
                  },
                  required: ["endpoint"],
                },
              },
              count: {
                type: "number",
                description: "Optional number of peer windows to launch. If targets is omitted, endpoints are generated automatically.",
              },
              start_from: {
                type: "string",
                description: "Optional starting endpoint label for count-based generation, for example 'B' or 'D'.",
              },
              profiles: {
                type: "object",
                additionalProperties: { type: "string" },
                description: "Optional endpoint -> ccswitch profile map, for example {\"B\":\"sonnet\",\"C\":\"opus\"}.",
              },
              workdir: {
                type: "string",
                description: "Optional working directory for launched windows. Defaults to the current cc-bridge directory.",
              },
              initial_prompt: {
                type: "string",
                description: "Optional initial prompt sent to all launched peer windows at startup.",
              },
              initial_prompts: {
                type: "object",
                additionalProperties: { type: "string" },
                description: "Optional endpoint -> initial prompt map, for example {\"B\":\"You are planner B\"}. Overrides initial_prompt per endpoint.",
              },
            },
            required: [],
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

      if (name === "list_peers") {
        const peers = this.peerLister ? this.peerLister() : [];
        const text = peers.length > 0
          ? `Active peers in room: ${peers.join(", ")}`
          : "No peers currently active in room.";
        return { content: [{ type: "text" as const, text }] };
      }

      if (name === "list_all_peers") {
        return await this.handleListAllPeers();
      }

      if (name === "launch_peers") {
        return await this.handleLaunchPeers(args as Record<string, unknown>);
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

    const toRaw = args?.to;
    let to: string[] | undefined;
    if (Array.isArray(toRaw) && toRaw.length > 0) {
      const valid = [...new Set(
        (toRaw as unknown[])
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
      )];
      if (valid.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: 'to' parameter contained no valid peer names. Pass a non-empty array of strings or omit 'to' to broadcast." }],
          isError: true,
        };
      }
      to = valid;
    }

    const scopeRaw = args?.scope;
    const scope: "room" | "global" | undefined =
      scopeRaw === "room" || scopeRaw === "global" ? scopeRaw : undefined;

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

    const result = await this.replySender(bridgeMsg, to, scope);
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
    if (result.delivered_rooms && result.delivered_rooms.length > 0) {
      responseText += ` Global broadcast delivered to rooms: ${result.delivered_rooms.join(", ")}.`;
    }
    if (result.skipped_rooms && result.skipped_rooms.length > 0) {
      responseText += ` Skipped rooms (no live coordinator): ${result.skipped_rooms.join(", ")}.`;
    }
    if (result.resolvedRecipients && result.resolvedRecipients.length > 0) {
      responseText += ` Delivered to: ${result.resolvedRecipients.join(", ")}.`;
    }
    if (result.missingRecipients && result.missingRecipients.length > 0) {
      responseText += ` Not delivered to offline/unknown peers: ${result.missingRecipients.join(", ")}.`;
    }
    if (pending > 0) {
      responseText += ` Note: ${pending} unread peer message${pending > 1 ? "s" : ""} already waiting \u2014 call get_messages to read them.`;
    }

    return {
      content: [{ type: "text" as const, text: responseText }],
    };
  }

  private async handleListAllPeers() {
    if (!this.registryReader) {
      return {
        content: [{ type: "text" as const, text: "Error: registry reader not configured in this cc-bridge instance." }],
        isError: true,
      };
    }
    const snapshot = await this.registryReader();
    if (snapshot.peers.length === 0) {
      return { content: [{ type: "text" as const, text: "No peers registered in daemon registry." }] };
    }
    const lines = snapshot.peers.map((p) => {
      const parts = [`endpoint=${p.endpoint}`, `status=${p.status}`];
      if (p.role) parts.push(`role=${p.role}`);
      if (p.room) parts.push(`room=${p.room}`);
      if (p.active_task_count > 0) parts.push(`tasks=${p.active_task_count}`);
      return parts.join(" ");
    });
    return {
      content: [{ type: "text" as const, text: `Registry peers (${snapshot.peers.length}):\n${lines.join("\n")}` }],
    };
  }

  private async handleLaunchPeers(args: Record<string, unknown>) {
    const rawTargets = args?.targets;
    const targets = Array.isArray(rawTargets)
      ? [...new Set(rawTargets.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))]
      : [];
    const rawPeerTargets = Array.isArray(args?.peer_targets) ? args.peer_targets : [];
    const count = typeof args?.count === "number" && Number.isFinite(args.count)
      ? Math.max(0, Math.trunc(args.count))
      : undefined;
    const startFrom = typeof args?.start_from === "string" ? args.start_from.trim() : undefined;

    if (!this.peerLauncher) {
      return {
        content: [{ type: "text" as const, text: "Error: peer launcher is not configured in this cc-bridge instance." }],
        isError: true,
      };
    }

    if (targets.length === 0 && rawPeerTargets.length === 0 && (!count || count <= 0)) {
      return {
        content: [{ type: "text" as const, text: "Error: launch_peers requires peer_targets, a non-empty 'targets' array, or a positive 'count'." }],
        isError: true,
      };
    }

    const profiles = args?.profiles && typeof args.profiles === "object" && !Array.isArray(args.profiles)
      ? Object.fromEntries(
          Object.entries(args.profiles as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")
            .map(([key, value]) => [key, (value as string).trim()]),
        )
      : undefined;

    const workdir = typeof args?.workdir === "string" ? args.workdir.trim() : undefined;
    const initialPrompt = typeof args?.initial_prompt === "string" ? args.initial_prompt : undefined;
    const initialPrompts = args?.initial_prompts && typeof args.initial_prompts === "object" && !Array.isArray(args.initial_prompts)
      ? Object.fromEntries(
          Object.entries(args.initial_prompts as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")
            .map(([key, value]) => [key, value as string]),
        )
      : undefined;
    const peerTargets = rawPeerTargets
      .filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value))
      .map((value) => ({
        endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
        role: typeof value.role === "string" ? value.role : undefined,
        profile: typeof value.profile === "string" ? value.profile : undefined,
        workdir: typeof value.workdir === "string" ? value.workdir : undefined,
        bootstrap_message: typeof value.bootstrap_message === "string" ? value.bootstrap_message : undefined,
        target_room: typeof value.target_room === "string" && value.target_room.trim() ? value.target_room.trim() : undefined,
      }))
      .filter((value) => value.endpoint.trim().length > 0);
    const result = await this.peerLauncher({
      peerTargets,
      targets,
      count,
      startFrom,
      profiles,
      workdir,
      initialPrompt,
      initialPrompts,
    });

    const lines = [
      result.success ? "Peer launch command executed." : "Peer launch command finished with errors.",
      `Launched: ${result.launched.length > 0 ? result.launched.join(", ") : "(none)"}`,
    ];
    if (Object.keys(result.failed).length > 0) {
      lines.push(
        `Failed: ${Object.entries(result.failed)
          .map(([endpoint, error]) => `${endpoint} (${error})`)
          .join(", ")}`,
      );
    }
    if (result.note) {
      lines.push(`Note: ${result.note}`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      isError: !result.success,
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
