import type { BridgeMessage } from "./types";
import type { MessageEnvelope, ErrorEnvelope, LaunchRequest, LaunchResult, RegistrySnapshot, TerminatePeerRequest, TerminatePeerResult, EndpointId, ErrorReceiptPayload, TaskAssignment, TaskAssignmentResult } from "./protocol";

// Phase 4B: Worker binding result
export interface BindWorkerResult {
  success: boolean;
  error?: ErrorReceiptPayload;
}

export interface DaemonStatus {
  bridgeReady: boolean;
  peerConnected: boolean;
  room: string;
  peerCount: number;
  queuedMessageCount: number;
  endpoint: string;
  pid: number;
  peers: string[];
}

export type ControlClientMessage =
  | { type: "claude_connect"; room?: string; endpoint?: string } // Phase 4A: optional room field; omit for default room (backward compat)
  | { type: "claude_disconnect" }
  | { type: "post_message"; requestId: string; message: BridgeMessage; to?: string[]; scope?: "room" | "global" } // Phase 5B: scope="global" broadcasts across all active rooms
  | { type: "claude_to_codex"; requestId: string; message: BridgeMessage }
  | { type: "pull_messages"; requestId: string }
  | { type: "wait_for_messages"; requestId: string; timeoutMs: number }
  | { type: "status" }
  | { type: "post_envelope"; requestId: string; envelope: MessageEnvelope }
  | { type: "launch_peer"; requestId: string; request: LaunchRequest }
  | { type: "terminate_peer"; requestId: string; request: TerminatePeerRequest }
  | { type: "query_registry"; requestId: string }
  // Phase 3A: supervisor attachment (Phase 4B adds optional partition_id)
  | { type: "supervisor_attach"; requestId: string; endpoint: EndpointId; partition_id?: string }
  | { type: "supervisor_detach"; requestId: string; partition_id?: string }
  // Phase 3B: task assignment
  | { type: "assign_task"; requestId: string; assignment: TaskAssignment }
  // Phase 4B: worker binding to a coordinator partition
  | { type: "bind_worker"; requestId: string; partition_id: string; endpoint: EndpointId }
  // Phase 4C-1: worker declares its own WS connection to daemon for direct relay delivery
  | { type: "worker_connect"; requestId: string; endpoint: EndpointId };

export type ControlServerMessage =
  | { type: "codex_to_claude"; message: BridgeMessage }
  | {
      type: "post_message_result";
      requestId: string;
      success: boolean;
      error?: string;
      resolvedRecipients?: string[];
      missingRecipients?: string[];
      delivered_rooms?: string[];  // Phase 5B: rooms that received the global broadcast
      skipped_rooms?: string[];    // Phase 5B: rooms with no live coordinator (skipped)
    }
  | { type: "claude_to_codex_result"; requestId: string; success: boolean; error?: string }
  | { type: "pull_messages_result"; requestId: string; messages: BridgeMessage[] }
  | { type: "wait_for_messages_result"; requestId: string; messages: BridgeMessage[] }
  | { type: "status"; status: DaemonStatus }
  | { type: "post_envelope_result"; requestId: string; success: boolean; resolvedRecipients?: string[]; error?: ErrorEnvelope }
  | { type: "launch_peer_result"; requestId: string; result: LaunchResult }
  | { type: "terminate_peer_result"; requestId: string; result: TerminatePeerResult }
  | { type: "query_registry_result"; requestId: string; snapshot: RegistrySnapshot }
  // Phase 3A: supervisor attachment
  | { type: "supervisor_attach_result"; requestId: string; success: boolean; error?: ErrorReceiptPayload }
  | { type: "supervisor_detach_result"; requestId: string; success: boolean }
  // Phase 3B: task assignment
  | { type: "assign_task_result"; requestId: string; result: TaskAssignmentResult }
  // Phase 4B: worker binding
  | { type: "bind_worker_result"; requestId: string; result: BindWorkerResult }
  // Phase 4C-1: worker_connect result
  | { type: "worker_connect_result"; requestId: string; success: boolean; error?: ErrorReceiptPayload };
