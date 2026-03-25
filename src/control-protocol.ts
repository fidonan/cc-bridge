import type { BridgeMessage } from "./types";

export interface DaemonStatus {
  bridgeReady: boolean;
  peerConnected: boolean;
  room: string;
  peerCount: number;
  queuedMessageCount: number;
  endpoint: string;
  pid: number;
}

export type ControlClientMessage =
  | { type: "claude_connect" }
  | { type: "claude_disconnect" }
  | { type: "claude_to_codex"; requestId: string; message: BridgeMessage }
  | { type: "pull_messages"; requestId: string }
  | { type: "wait_for_messages"; requestId: string; timeoutMs: number }
  | { type: "status" };

export type ControlServerMessage =
  | { type: "codex_to_claude"; message: BridgeMessage }
  | { type: "claude_to_codex_result"; requestId: string; success: boolean; error?: string }
  | { type: "pull_messages_result"; requestId: string; messages: BridgeMessage[] }
  | { type: "wait_for_messages_result"; requestId: string; messages: BridgeMessage[] }
  | { type: "status"; status: DaemonStatus };
