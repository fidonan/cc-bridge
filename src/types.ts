// ===== Bridge Core Types =====

export type MessageSource = string;
export type SenderKind = "cc" | "wechat" | "codex" | (string & {});
export type RelayRouteMode = "direct" | "multicast" | "broadcast";

export interface BridgeMessage {
  id: string;
  source: MessageSource;
  content: string;
  timestamp: number;
  senderId?: string;
  sender?: string;
  senderKind?: SenderKind;
}

export interface RelayRoute {
  mode: RelayRouteMode;
  to?: string[];
}

export interface RelayEnvelope {
  id: string;
  room: string;
  content: string;
  timestamp: number;
  senderId?: string;
  senderKind?: SenderKind;
  route?: RelayRoute;
  resolvedRecipients?: string[];
  sender?: string;
  // Phase 4D-1: cross-room forwarding fields.
  // sender_room: the room of the originating coordinator (daemon + room identifies sender in 4D-1).
  // target_endpoint: explicit destination EndpointId for cross-room point-to-point sends.
  sender_room?: string;
  target_endpoint?: string;
}

// ===== JSON-RPC 2.0 =====

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  method: string;
  id: number;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: Record<string, any>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ===== Codex App Server Types =====

export interface CodexThread {
  id: string;
}

export interface CodexItem {
  id: string;
  type: string;
  content?: Array<{ type: string; text?: string }>;
}

export interface CodexTurn {
  id: string;
}

// ===== MCP Tool Schema =====

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}
