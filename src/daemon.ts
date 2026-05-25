#!/usr/bin/env bun

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus, BindWorkerResult } from "./control-protocol";
import { getInstanceConfig } from "./instance-config";
import { buildRelayEnvelope, getEnvelopeSenderId, shouldDeleteEnvelope, shouldDeliverEnvelopeToEndpoint } from "./relay-routing";
import type { BridgeMessage, RelayEnvelope } from "./types";
import type { MessageEnvelope, ErrorEnvelope, PeerMetadata, LifecycleStatus, ErrorReceiptPayload, LaunchRequest, LaunchResult, EndpointId, BootstrapAck, TerminatePeerRequest, TerminatePeerResult, SpawnExitObservable, TaskAssignment, TaskAssignmentResult, LoopEvent, LoopState, RoomEvent } from "./protocol";
import { makeErrorEnvelope as _makeErrorEnvelope, validateEnvelope as _validateEnvelope, validateWorkdir, validateLaunchRequest, resolveIntendedTo as _resolveIntendedTo, processBootstrapAck } from "./phase1-handlers";

interface ControlSocketData {
  clientId: number;
  attached: boolean;
  roomId: string; // Phase 4A: room this WS belongs to; set to ROOM until claude_connect overrides
  workerEndpoint?: string; // Phase 4C-1: set iff this WS registered via worker_connect
  coordinatorEndpoint?: string; // Optional per-WS sender identity for CLI/MCP coordinator sessions
}

const INSTANCE = getInstanceConfig();
const CONTROL_PORT = INSTANCE.controlPort;
const PID_FILE = INSTANCE.pidFile;
const LOG_FILE = INSTANCE.logFile;
const ROOM = sanitizeName(process.env.CC_BRIDGE_ROOM ?? "default");
const ENDPOINT = sanitizeName(process.env.CC_BRIDGE_ENDPOINT ?? INSTANCE.instance);
const PEER_LABEL = process.env.CC_BRIDGE_PEER_LABEL ?? "Peer Claude";
const STATE_ROOT = process.env.CC_BRIDGE_STATE_DIR ?? "/tmp/cc-bridge";
// Phase 4D-2: per-room relay paths (lazy, demand-driven — NOT computed at module level)
function roomRelayPaths(roomId: string) {
  const base = join(STATE_ROOT, roomId);
  return {
    peersDir: join(base, "peers"),
    messagesDir: join(base, "messages"),
    acksDir: join(base, "acks"),
  };
}
const HEARTBEAT_MS = parsePositiveInt(process.env.CC_BRIDGE_HEARTBEAT_MS, 2000);
const BOOTSTRAP_TIMEOUT_MS = parsePositiveInt(process.env.CC_BRIDGE_BOOTSTRAP_TIMEOUT_MS, 30000);
const PEER_STALE_MS = parsePositiveInt(process.env.CC_BRIDGE_PEER_STALE_MS, 10000);
const STALL_ESCALATION_MS = parsePositiveInt(process.env.CC_BRIDGE_STALL_ESCALATION_MS, 30000);
const SPAWN_COMMAND = (process.env.CC_BRIDGE_SPAWN_COMMAND ?? "").trim();
const POLL_INTERVAL_MS = parsePositiveInt(process.env.CC_BRIDGE_POLL_INTERVAL_MS, 700);
const MESSAGE_TTL_MS = parsePositiveInt(process.env.CC_BRIDGE_MESSAGE_TTL_MS, 5 * 60 * 1000);
const IDLE_SHUTDOWN_MS = parsePositiveInt(process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS, 30000);
const ROOM_DEACTIVATE_GRACE_MS = parsePositiveInt(process.env.CC_BRIDGE_ROOM_DEACTIVATE_GRACE_MS, IDLE_SHUTDOWN_MS);
const MAX_BUFFERED_MESSAGES = parsePositiveInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES, 100);
const MAX_SUPERVISOR_BUFFER = 200;

// ===== Phase 4A/4B: Per-Room State =====

/**
 * Phase 4B: A coordinator's ownership slot for a named partition within a room.
 * Auth identity is the WS socket object; endpoint is routing/correlation metadata only.
 */
interface CoordinatorSlot {
  partition_id: string;
  socket: ServerWebSocket<ControlSocketData>;  // auth identity (claim authority)
  endpoint: EndpointId;                         // routing/correlation metadata only
}

/**
 * All per-room state. In Phase 3 these were daemon-global singletons.
 * Phase 4A wraps them in a Room object keyed by room ID.
 * Phase 4B adds partitions and partitionMembership.
 */
interface Room {
  id: string;
  // Coordinator candidates: WS connections that called claude_connect for this room.
  coordinators: Set<ServerWebSocket<ControlSocketData>>;
  // Phase 3A supervisor sink state (was daemon-global):
  supervisorSocket: ServerWebSocket<ControlSocketData> | null;
  supervisorEndpoint: EndpointId | null;
  supervisorEverAttached: boolean;
  supervisorBuffer: BridgeMessage[]; // Phase 4A: room-level buffer; per-coordinator-slot buffer is Phase 4B+ deferred
  // Phase 3B task state (was daemon-global):
  activeTasks: Map<string, ActiveTask>;
  // Phase 4B partition ownership:
  partitions: Map<string, CoordinatorSlot>;        // partition_id → CoordinatorSlot
  partitionMembership: Map<EndpointId, string>;    // worker endpoint → partition_id
}

// Phase 3B: active task entry; Phase 4B adds partition_id for cleanup routing
interface ActiveTask {
  assigned_to: EndpointId;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  partition_id?: string;  // Phase 4B: which partition owns this task (for coordinator disconnect cleanup)
}

const rooms = new Map<string, Room>();

function getOrCreateRoom(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = {
      id,
      coordinators: new Set(),
      supervisorSocket: null,
      supervisorEndpoint: null,
      supervisorEverAttached: false,
      supervisorBuffer: [],
      activeTasks: new Map(),
      partitions: new Map(),
      partitionMembership: new Map(),
    };
    rooms.set(id, room);
  }
  return room;
}

function getRoomForWs(ws: ServerWebSocket<ControlSocketData>): Room {
  return getOrCreateRoom(ws.data.roomId);
}

/**
 * Phase 4B: Find the CoordinatorSlot held by a given WS socket in a room.
 * Returns null if the WS holds no partition.
 */
function findPartitionForWs(room: Room, ws: ServerWebSocket<ControlSocketData>): CoordinatorSlot | null {
  for (const slot of room.partitions.values()) {
    if (slot.socket === ws) return slot;
  }
  return null;
}

/**
 * Phase 4B: Atomically release a partition and execute the 5-step cleanup contract.
 *
 * Steps (executed in order):
 * 1. Release partition slot: remove room.partitions[partitionId]
 * 2. Fail in-flight tasks owned by this partition: LoopEvent{state:'failed', reason:'coordinator_disconnected'}
 * 3. Clear worker bindings: remove all partitionMembership entries for this partition
 * 4. Emit worker_orphaned room events for each now-unbound worker
 * 5. Workers remain in peer registry (lifecycle unchanged)
 */
function releasePartition(room: Room, partitionId: string, reason: string): void {
  const slot = room.partitions.get(partitionId);
  if (!slot) return;

  // Step 1: release partition slot
  room.partitions.delete(partitionId);
  log(`Phase4B: partition '${partitionId}' released in room='${room.id}' (${reason})`);

  // Step 2: fail in-flight tasks owned by this partition
  for (const [taskId, task] of room.activeTasks) {
    if (task.partition_id !== partitionId) continue;
    removeActiveTask(room, taskId);
    log(`Phase4B: task '${taskId}' failed — coordinator disconnected (partition='${partitionId}')`);
    emitLoopEvent(room, {
      task_id: taskId,
      endpoint: task.assigned_to,
      state: "failed",
      observed_at: Date.now(),
      details: { reason: "coordinator_disconnected" },
    });
  }

  // Steps 3 + 4: clear bindings and emit orphan events for affected workers
  const orphanedWorkers: EndpointId[] = [];
  for (const [endpoint, pid] of room.partitionMembership) {
    if (pid !== partitionId) continue;
    orphanedWorkers.push(endpoint);
  }
  for (const endpoint of orphanedWorkers) {
    room.partitionMembership.delete(endpoint);
  }
  for (const endpoint of orphanedWorkers) {
    log(`Phase4B: worker '${endpoint}' orphaned — partition '${partitionId}' released in room='${room.id}'`);
    emitRoomEvent(room, {
      type: "room_event",
      event: "worker_orphaned",
      room: room.id,
      endpoint,
      partition_id: partitionId,
      observed_at: Date.now(),
    });
  }

  // Step 5: workers stay in peerRegistry — lifecycle unchanged

  // Emit partition_released room event
  emitRoomEvent(room, {
    type: "room_event",
    event: "partition_released",
    room: room.id,
    partition_id: partitionId,
    observed_at: Date.now(),
  });
}

/**
 * Phase 4B: Broadcast a RoomEvent to all coordinators in a room.
 */
function emitRoomEvent(room: Room, event: RoomEvent): void {
  const message: BridgeMessage = {
    id: `room_evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    source: "codex",
    content: JSON.stringify(event),
    timestamp: event.observed_at,
    senderId: ENDPOINT,
    sender: ENDPOINT,
    senderKind: "cc",
  };
  for (const coordinator of room.coordinators) {
    if (coordinator.readyState === WebSocket.OPEN) {
      trySendBridgeMessage(coordinator, message);
    }
  }
}

// ===== End Phase 4A/4B room state =====

let controlServer: ReturnType<typeof Bun.serve> | null = null;
// attachedClaude: backward-compat pointer to the active coordinator in the default room.
// Kept for: idle shutdown check, status flush on connect, and file-relay message delivery.
// In Phase 4A, it always equals the most recent coordinator WS in the default room.
let attachedClaude: ServerWebSocket<ControlSocketData> | null = null;
let nextControlClientId = 0;
let nextSystemMessageId = 0;
let shuttingDown = false;
let bootstrapped = false;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let peerConnected = false;
let peerCount = 0;
let knownPeers: string[] = [];
const bufferedMessages: BridgeMessage[] = [];
const pendingPullMessages: BridgeMessage[] = [];
const waiters = new Map<string, { ws: ServerWebSocket<ControlSocketData>; timer: ReturnType<typeof setTimeout> }>();
const seenMessageIds = new Set<string>();

// Phase 0: peer registry (endpoint → metadata) — daemon-global in Phase 4A; per-room in Phase 4B
const peerRegistry = new Map<string, PeerMetadata>();

// Phase 4C-1: direct worker WS connections (endpoint → WS).
// Only populated when worker calls worker_connect; evicted on WS close / peer termination.
// Invariant: one socket ↔ one endpoint (enforced in handleWorkerConnect).
const workerSockets = new Map<string, ServerWebSocket<ControlSocketData>>();

// Phase 4D-1: endpoint → room routing index for cross-room direct-send.
// Written on register (transport-derived from ws.data.roomId, not self-reported by peer).
// Cleared on terminated. Authority: peerRegistry for lifecycle; endpointToRoom for relay routing only.
const endpointToRoom = new Map<EndpointId, string>();

// Phase 4D-2: set of rooms this daemon actively participates in relay (writes heartbeat, polls).
// ROOM (startup room) is always active (daemon-owned participation).
// Non-default rooms are added on first coordinator attach, removed on last coordinator leave.
const relayActiveRooms = new Set<string>([ROOM]);
const pendingRoomDeactivationTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Phase 4D-2: per-room known peers cache (endpoint list per room, updated by refreshPeers).
const roomKnownPeers = new Map<string, string[]>([[ROOM, []]]);

// Phase 1: bootstrap timers (endpoint → timer handle)
const bootstrapTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Phase 2: spawned child processes (endpoint → {pid, proc})
const spawnedProcesses = new Map<string, { pid: number; proc: ReturnType<typeof Bun.spawn> }>();
// Phase 2: stalled→terminated escalation timers (endpoint → timer handle)
const escalationTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Phase 0/1: local adapters that bind module-level ENDPOINT to pure handler functions
function makeErrorEnvelope(
  code: ErrorReceiptPayload["code"],
  message: string,
  correlationId?: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return _makeErrorEnvelope(ENDPOINT, code, message, correlationId, details);
}

function validateEnvelope(
  raw: unknown,
  correlationId?: string,
): { ok: true; envelope: MessageEnvelope } | { ok: false; error: ErrorEnvelope } {
  return _validateEnvelope(raw, ENDPOINT, correlationId);
}

function resolveIntendedTo(intended: string[]): import("./phase1-handlers").RouteResolution {
  return _resolveIntendedTo(intended, [...peerRegistry.values()], ENDPOINT);
}

function startControlServer() {
  controlServer = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz" || url.pathname === "/readyz") {
        return Response.json(currentStatus());
      }

      if (url.pathname === "/ws" && server.upgrade(req, { data: { clientId: 0, attached: false, roomId: ROOM } })) {
        return undefined;
      }

      return new Response("cc-bridge daemon");
    },
    websocket: {
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextControlClientId;
        ws.data.roomId = ROOM; // default room; updated on claude_connect
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws: ServerWebSocket<ControlSocketData>) => {
        log(`Frontend socket closed (#${ws.data.clientId})`);
        // Phase 4C-1: evict worker socket binding if this WS was a worker connection
        if (ws.data.workerEndpoint) {
          workerSockets.delete(ws.data.workerEndpoint);
          log(`Phase4C: worker socket evicted for endpoint='${ws.data.workerEndpoint}' (socket closed)`);
        }
        // Per-room supervisor release (must precede coordinator detach)
        const room = rooms.get(ws.data.roomId);
        if (room?.supervisorSocket === ws) {
          releaseSupervisor(room, "socket closed");
        }
        // Blocker 2 fix: unified detach path for ALL coordinators, not just attachedClaude.
        // ws.data.attached is set true in attachCoordinator and false in detachCoordinator,
        // so this gate is the correct check for "was this WS a coordinator".
        if (ws.data.attached) {
          detachCoordinator(ws, "frontend socket closed");
        }
      },
      message: (ws: ServerWebSocket<ControlSocketData>, raw) => {
        handleControlMessage(ws, raw);
      },
    },
  });
}

function handleControlMessage(ws: ServerWebSocket<ControlSocketData>, raw: string | Buffer) {
  let message: ControlClientMessage;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    message = JSON.parse(text);
  } catch (e: any) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }

  switch (message.type) {
    case "claude_connect":
      // Phase 4A: route to room specified in message, or default room for backward compat
      ws.data.coordinatorEndpoint = message.endpoint ? sanitizeName(message.endpoint) : undefined;
      attachCoordinator(ws, message.room ?? ROOM);
      return;
    case "claude_disconnect":
      detachCoordinator(ws, "frontend requested disconnect");
      return;
    case "status":
      sendStatus(ws);
      return;
    case "post_message":
    case "claude_to_codex": {
      if (message.message.source !== "claude") {
        sendProtocolMessage(ws, {
          type: message.type === "post_message" ? "post_message_result" : "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Invalid message source",
        });
        return;
      }

      // Phase 5B: global broadcast shortcut
      if (message.type === "post_message" && message.scope === "global") {
        // Reject combined to+scope:"global" — would silently drop to[] and misdeliver
        if (message.to && message.to.length > 0) {
          sendProtocolMessage(ws, {
            type: "post_message_result",
            requestId: message.requestId,
            success: false,
            error: "Cannot combine 'to' with scope='global'. Use scope='room' for targeted delivery or omit 'to' for global broadcast.",
          });
          return;
        }
        const { delivered_rooms, skipped_rooms } = broadcastGlobal(message.message.content, ws.data.roomId);
        sendProtocolMessage(ws, {
          type: "post_message_result",
          requestId: message.requestId,
          success: delivered_rooms.length > 0 || skipped_rooms.length === 0,
          delivered_rooms,
          skipped_rooms,
        });
        return;
      }

      try {
        const envelope = postPeerMessage(message.message.content, message.type === "post_message" ? message.to : undefined, ws.data.roomId);
        sendProtocolMessage(ws, {
          type: message.type === "post_message" ? "post_message_result" : "claude_to_codex_result",
          requestId: message.requestId,
          success: true,
          ...(message.type === "post_message"
            ? {
                resolvedRecipients: envelope.resolvedRecipients,
                missingRecipients: envelope.route?.to?.filter(
                  (recipient) => !envelope.resolvedRecipients?.includes(recipient),
                ),
              }
            : {}),
        });
      } catch (err: any) {
        sendProtocolMessage(ws, {
          type: message.type === "post_message" ? "post_message_result" : "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: err.message,
        });
      }
      return;
    }
    case "pull_messages":
      sendProtocolMessage(ws, {
        type: "pull_messages_result",
        requestId: message.requestId,
        messages: drainPendingPullMessages(),
      });
      return;
    case "wait_for_messages":
      handleWaitForMessages(ws, message.requestId, message.timeoutMs);
      return;
    case "launch_peer": {
      const result = handleLaunchPeer(message.request);
      sendProtocolMessage(ws, { type: "launch_peer_result", requestId: message.requestId, result });
      return;
    }
    case "terminate_peer": {
      const result = handleTerminatePeer(message.request);
      sendProtocolMessage(ws, { type: "terminate_peer_result", requestId: message.requestId, result });
      return;
    }
    case "query_registry": {
      const snapshot = handleQueryRegistry();
      sendProtocolMessage(ws, { type: "query_registry_result", requestId: message.requestId, snapshot });
      return;
    }
    case "supervisor_attach":
      handleSupervisorAttach(ws, message.requestId, message.endpoint, message.partition_id);
      return;
    case "supervisor_detach":
      handleSupervisorDetach(ws, message.requestId, message.partition_id);
      return;
    case "bind_worker": {
      const result = handleBindWorker(ws, message.requestId, message.partition_id, message.endpoint);
      sendProtocolMessage(ws, { type: "bind_worker_result", requestId: message.requestId, result });
      return;
    }
    case "worker_connect":
      handleWorkerConnect(ws, message.requestId, message.endpoint);
      return;
    case "assign_task": {
      const result = handleAssignTask(ws, message.assignment);
      sendProtocolMessage(ws, { type: "assign_task_result", requestId: message.requestId, result });
      return;
    }
    case "post_envelope": {
      const validation = validateEnvelope(message.envelope, message.requestId);
      if (!validation.ok) {
        sendProtocolMessage(ws, {
          type: "post_envelope_result",
          requestId: message.requestId,
          success: false,
          error: validation.error,
        });
        return;
      }

      const handlerResult = handleEnvelopeIntent(validation.envelope, ws.data.roomId);
      if (!handlerResult.ok) {
        sendProtocolMessage(ws, {
          type: "post_envelope_result",
          requestId: message.requestId,
          success: false,
          error: makeErrorEnvelope(handlerResult.error.code, handlerResult.error.message, message.requestId, handlerResult.error.details as Record<string, unknown> | undefined),
        });
        return;
      }
      sendProtocolMessage(ws, {
        type: "post_envelope_result",
        requestId: message.requestId,
        success: true,
        ...(handlerResult.resolvedEndpoints ? { resolvedRecipients: handlerResult.resolvedEndpoints } : {}),
      });
      return;
    }
  }
}

/**
 * Phase 4A: Register WS as a coordinator for a room.
 * Replaces Phase 3 `attachClaude` (daemon-global singleton) with per-room coordinator set.
 *
 * Invariants enforced:
 * - One coordinator per room (Phase 4A). New claude_connect replaces previous for ALL rooms.
 *   True multi-coordinator is Phase 4B.
 * - WS is removed from its old room before being added to the new room, preventing stale
 *   membership when the same socket switches rooms via a second claude_connect call.
 * - `attachedClaude` tracks the coordinator of the default room for backward compat.
 */
function attachCoordinator(ws: ServerWebSocket<ControlSocketData>, roomId: string) {
  // Blocker 3 fix: if this WS was already a coordinator in a different room, clean up old room first.
  const oldRoomId = ws.data.roomId;
  if (ws.data.attached && oldRoomId !== roomId) {
    const oldRoom = rooms.get(oldRoomId);
    if (oldRoom) {
      // Blocker 4 fix: if this WS held supervisor in the old room, release it before leaving.
      if (oldRoom.supervisorSocket === ws) {
        releaseSupervisor(oldRoom, "room switch");
      }
      oldRoom.coordinators.delete(ws);
      // Phase 4D-2: deactivate relay for old non-default room when last coordinator leaves
      if (oldRoom.coordinators.size === 0 && oldRoomId !== ROOM) {
        scheduleRelayRoomDeactivation(oldRoomId);
      }
      if (oldRoom.coordinators.size === 0 && oldRoom.activeTasks.size === 0 && oldRoom.id !== ROOM) {
        rooms.delete(oldRoom.id);
      }
    }
    if (attachedClaude === ws) {
      attachedClaude = null;
    }
    ws.data.attached = false;
    log(`Phase4A: coordinator removed from old room='${oldRoomId}' before joining room='${roomId}' (#${ws.data.clientId})`);
  }

  ws.data.roomId = roomId;
  const room = getOrCreateRoom(roomId);

  // Blocker 1 fix: enforce one-coordinator-per-room invariant for ALL rooms (not just default).
  // Phase 4B removes this constraint and introduces partition arbitration.
  for (const existingWs of room.coordinators) {
    if (existingWs !== ws) {
      existingWs.close(4001, "replaced by a newer Claude session");
      room.coordinators.delete(existingWs);
    }
  }

  // Update backward-compat pointer for default room
  if (roomId === ROOM) {
    attachedClaude = ws;
  }

  room.coordinators.add(ws);
  ws.data.attached = true;
  cancelIdleShutdown();
  // Phase 4D-2: activate relay filesystem for non-default rooms on first coordinator attach
  if (roomId !== ROOM) activateRelayRoom(roomId);
  log(`Phase4A: coordinator attached room='${roomId}' (#${ws.data.clientId})`);

  sendStatus(ws);

  // Blocker 5 fix: global bufferedMessages is the default-room / legacy backlog.
  // Only flush it to coordinators of the default room; non-default rooms must not consume it.
  if (roomId === ROOM && bufferedMessages.length > 0) {
    flushBufferedMessages(ws);
  } else {
    sendBridgeMessage(ws, systemMessage("system_ready", currentReadyMessageForRoom(roomId)));
  }
}

/**
 * Phase 4A/4B: Remove WS from its room's coordinator set.
 * Phase 4B: also releases any partition the WS holds (5-step cleanup).
 * Replaces Phase 3 `detachClaude`.
 */
function detachCoordinator(ws: ServerWebSocket<ControlSocketData>, reason: string) {
  const room = rooms.get(ws.data.roomId);
  if (room) {
    // Phase 4B: release any partition held by this WS before removing from coordinators
    const slot = findPartitionForWs(room, ws);
    if (slot !== null) {
      releasePartition(room, slot.partition_id, reason);
    }

    room.coordinators.delete(ws);
    // Phase 4D-2: deactivate relay for non-default room when last coordinator leaves
    if (room.coordinators.size === 0 && room.id !== ROOM) {
      scheduleRelayRoomDeactivation(room.id);
    }
    // GC empty rooms (no coordinators and no peers) — Phase 4A basic GC
    if (room.coordinators.size === 0 && room.activeTasks.size === 0 && room.id !== ROOM) {
      rooms.delete(room.id);
    }
  }
  if (attachedClaude === ws) {
    attachedClaude = null;
  }
  ws.data.attached = false;
  log(`Phase4A: coordinator detached room='${ws.data.roomId}' (#${ws.data.clientId}, ${reason})`);
  clearWaitersForSocket(ws);
  scheduleIdleShutdown();
}

function emitToClaude(message: BridgeMessage) {
  pendingPullMessages.push(message);
  fulfillWaiters();
  if (attachedClaude && attachedClaude.readyState === WebSocket.OPEN) {
    if (trySendBridgeMessage(attachedClaude, message)) return;
    log("Send to Claude failed, buffering message for retry on reconnect");
  }

  bufferedMessages.push(message);
  if (bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
    const dropped = bufferedMessages.length - MAX_BUFFERED_MESSAGES;
    bufferedMessages.splice(0, dropped);
    log(`Message buffer overflow: dropped ${dropped} oldest message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
  }
}

function trySendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage): boolean {
  try {
    const result = ws.send(JSON.stringify({ type: "codex_to_claude", message } satisfies ControlServerMessage));
    if (typeof result === "number" && result <= 0) {
      log(`Bridge message send returned ${result} (0=dropped, -1=backpressure)`);
      return false;
    }
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function getCoordinatorSenderId(ws: ServerWebSocket<ControlSocketData>): string {
  return ws.data.coordinatorEndpoint ?? ENDPOINT;
}

function hasAnyRemotePeers(): boolean {
  for (const peers of roomKnownPeers.values()) {
    if (peers.some((peer) => peer !== ENDPOINT)) return true;
  }
  return false;
}

function forwardRelayMessageToCoordinator(roomId: string, message: BridgeMessage): boolean {
  // Broadcast to ALL connected coordinators (bridge.ts + CLI), not just the first.
  // This prevents messages from being consumed by one coordinator (e.g. bridge.ts)
  // while another (e.g. CLI wait-for-messages) never sees them.
  const recipients: ServerWebSocket<ControlSocketData>[] = [];

  if (roomId === ROOM && attachedClaude && attachedClaude.readyState === WebSocket.OPEN) {
    recipients.push(attachedClaude);
  }

  const room = rooms.get(roomId);
  if (room) {
    for (const coordinator of room.coordinators) {
      if (coordinator.readyState === WebSocket.OPEN && coordinator !== attachedClaude) {
        recipients.push(coordinator);
      }
    }
  }

  // Always queue for pull/wait consumers, regardless of push success.
  // This matches 副本 behavior where emitToClaude always populates pendingPullMessages.
  const pullMsg: BridgeMessage = {
    ...message,
    senderId: message.senderId ?? ENDPOINT,
    sender: message.sender ?? message.senderId ?? ENDPOINT,
    senderKind: message.senderKind ?? "cc",
  };
  pendingPullMessages.push(pullMsg);
  fulfillWaiters();

  if (recipients.length === 0) {
    // No coordinator connected — message is queued for pull but not push-delivered.
    return false;
  }

  let delivered = false;
  for (const ws of recipients) {
    const outbound: BridgeMessage = {
      ...message,
      senderId: message.senderId ?? getCoordinatorSenderId(ws),
      sender: message.sender ?? message.senderId ?? getCoordinatorSenderId(ws),
      senderKind: message.senderKind ?? "cc",
    };
    if (trySendBridgeMessage(ws, outbound)) {
      delivered = true;
    }
  }

  return delivered;
}

function flushBufferedMessages(ws: ServerWebSocket<ControlSocketData>) {
  const messages = bufferedMessages.splice(0, bufferedMessages.length);
  for (const message of messages) {
    if (!trySendBridgeMessage(ws, message)) {
      const failedIndex = messages.indexOf(message);
      const remaining = messages.slice(failedIndex);
      bufferedMessages.unshift(...remaining);
      log(`Flush interrupted: re-buffered ${remaining.length} message(s) after send failure`);
      return;
    }
  }
}

function sendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage) {
  trySendBridgeMessage(ws, message);
}

function sendStatus(ws: ServerWebSocket<ControlSocketData>) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}

// ===== Phase 3A: Supervisor Sink (now per-room via Room struct) =====

/**
 * Route an observable event to the appropriate sink for a specific room.
 *
 * Phase 4B routing (when room.partitions is non-empty and sourceEndpoint provided):
 *   - sourceEndpoint in partitionMembership → route to partition owner's supervisor socket (or buffer)
 *   - sourceEndpoint NOT in partitionMembership → broadcast to all coordinators
 *
 * Phase 3/4A routing (fallback when no partitions or no sourceEndpoint):
 *   1. Room supervisor attached and WS open → push directly (live path).
 *   2. Supervisor never attached for this room → backward compat: use room coordinator set.
 *   3. Supervisor was attached but is currently detached → buffer in room.supervisorBuffer.
 *
 * Always adds to pendingPullMessages / fulfillWaiters for wait_for_messages support.
 */
function emitObservable(room: Room, message: BridgeMessage, sourceEndpoint?: EndpointId): void {
  pendingPullMessages.push(message);
  fulfillWaiters();

  // Phase 4B partition-based routing: when partitions are active and source is known
  if (room.partitions.size > 0 && sourceEndpoint !== undefined) {
    const partitionId = room.partitionMembership.get(sourceEndpoint);
    if (partitionId !== undefined) {
      // Route to the partition owner's supervisor socket (or buffer on that partition)
      const slot = room.partitions.get(partitionId);
      if (slot && slot.socket.readyState === WebSocket.OPEN) {
        trySendBridgeMessage(slot.socket, message);
      } else {
        // Partition owner socket gone — buffer in room.supervisorBuffer
        room.supervisorBuffer.push(message);
        if (room.supervisorBuffer.length > MAX_SUPERVISOR_BUFFER) {
          room.supervisorBuffer.splice(0, room.supervisorBuffer.length - MAX_SUPERVISOR_BUFFER);
        }
      }
      return;
    }
    // Worker not in any partition: broadcast to all coordinators
    for (const coordinator of room.coordinators) {
      if (coordinator.readyState === WebSocket.OPEN) {
        trySendBridgeMessage(coordinator, message);
      }
    }
    return;
  }

  if (room.supervisorSocket !== null && room.supervisorSocket.readyState === WebSocket.OPEN) {
    trySendBridgeMessage(room.supervisorSocket, message);
    return;
  }

  if (!room.supervisorEverAttached) {
    // Route to room's coordinator if one is connected.
    const coordinator = room.coordinators.size > 0 ? [...room.coordinators][room.coordinators.size - 1] : null;
    if (coordinator && coordinator.readyState === WebSocket.OPEN) {
      trySendBridgeMessage(coordinator, message);
      return;
    }
    // No live coordinator. Default room falls back to global bufferedMessages (Phase 3 behavior).
    // Non-default rooms buffer in room.supervisorBuffer — flushed on supervisor_attach.
    // Cross-room fallback to attachedClaude is explicitly NOT allowed (B's non-blocking note).
    if (room.id === ROOM) {
      // Default room: buffer for coordinator reconnect or new claude_connect
      bufferedMessages.push(message);
      if (bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
        const dropped = bufferedMessages.length - MAX_BUFFERED_MESSAGES;
        bufferedMessages.splice(0, dropped);
        log(`Message buffer overflow: dropped ${dropped} oldest message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
      }
    } else {
      // Non-default room: buffer in room.supervisorBuffer; no cross-room leak
      room.supervisorBuffer.push(message);
      if (room.supervisorBuffer.length > MAX_SUPERVISOR_BUFFER) {
        room.supervisorBuffer.splice(0, room.supervisorBuffer.length - MAX_SUPERVISOR_BUFFER);
        log(`Phase4A: observable buffer overflow for room='${room.id}': dropped oldest events, ${MAX_SUPERVISOR_BUFFER} retained`);
      }
    }
    return;
  }

  // Supervisor was used but currently detached → buffer for next attach
  room.supervisorBuffer.push(message);
  if (room.supervisorBuffer.length > MAX_SUPERVISOR_BUFFER) {
    room.supervisorBuffer.splice(0, room.supervisorBuffer.length - MAX_SUPERVISOR_BUFFER);
    log(`Phase3A: supervisor buffer overflow for room='${room.id}': dropped oldest events, ${MAX_SUPERVISOR_BUFFER} retained`);
  }
}

/**
 * Emit an observable to the default room.
 * Used for worker lifecycle events (register, heartbeat, bootstrap, spawn/exit) which
 * are daemon-global in Phase 4A and have no per-room context yet.
 * Phase 4B will add explicit room context to worker events via partitionMembership.
 */
function emitObservableToDefaultRoom(message: BridgeMessage): void {
  emitObservable(getOrCreateRoom(ROOM), message);
}

/**
 * Release supervisor ownership for a room (explicit detach, socket close, or room switch).
 * SYNCHRONOUS — no await.
 * supervisorEverAttached remains true so future observables buffer instead of
 * falling through to the coordinator backward-compat path.
 *
 * Phase 4C-2: also fails all legacy-owned tasks (partition_id === undefined) in this room.
 * Partition-owned tasks are governed by releasePartition() and are left untouched.
 * Both triggers (explicit supervisor_detach and socket close) arrive here, as does the
 * room-switch path in attachCoordinator — so bundling the cleanup here covers all cases.
 *
 * Routing for failed-task events:
 *   - Explicit detach (socket still OPEN): emit BEFORE clearing room.supervisorSocket so
 *     emitLoopEvent → emitObservable finds the live socket and delivers immediately to the
 *     departing supervisor. Clear the pointer AFTER.
 *   - Socket close (readyState === CLOSED): clear room.supervisorSocket FIRST so
 *     emitLoopEvent → emitObservable falls through to room.supervisorBuffer
 *     (supervisorEverAttached=true path). The events are then flushed to the next
 *     coordinator that calls supervisor_attach for this room.
 */
function releaseSupervisor(room: Room, reason: string): void {
  if (room.supervisorSocket === null) return;
  log(`Phase3A: supervisor released for room='${room.id}' (${reason}) endpoint='${room.supervisorEndpoint ?? "?"}'`);

  const socketOpen = room.supervisorSocket.readyState === WebSocket.OPEN;

  // Phase 4C-2: socket-close path — null the pointer first so emitLoopEvent buffers
  if (!socketOpen) {
    room.supervisorSocket = null;
  }

  // Fail all legacy-owned tasks (partition_id === undefined); partition tasks left to releasePartition
  for (const [taskId, task] of [...room.activeTasks]) {
    if (task.partition_id !== undefined) continue;
    removeActiveTask(room, taskId);
    const event: LoopEvent = {
      task_id: taskId,
      endpoint: task.assigned_to,
      state: "failed",
      observed_at: Date.now(),
      details: { reason: "coordinator_disconnected" },
    };
    log(`Phase4C2: task '${taskId}' failed — legacy supervisor released (${reason}) room='${room.id}'`);
    // socketOpen=true: room.supervisorSocket still set → emitObservable delivers to live socket
    // socketOpen=false: room.supervisorSocket=null → emitObservable buffers in supervisorBuffer
    emitLoopEvent(room, event);
  }

  // Phase 4C-2: explicit-detach path — null AFTER emit so the departing supervisor received events
  if (socketOpen) {
    room.supervisorSocket = null;
  }
  // supervisorEndpoint and supervisorEverAttached intentionally preserved
}

/**
 * Handle supervisor_attach control message.
 * SYNCHRONOUS — no await allowed. Flush is atomic (single-threaded event loop).
 *
 * Phase 4A eligibility gate: WS must be in room.coordinators.
 * Phase 4B: if partition_id provided, claims a named partition slot (first-writer-wins).
 *   - No partition_id → backward compat: claims "default" partition / legacy supervisorSocket slot.
 *   - partition_id provided → CoordinatorSlot claim; COORDINATOR_ALREADY_HAS_PARTITION if WS already holds one.
 *   - Conflict on named partition → SUPERVISOR_PARTITION_CONFLICT.
 *   - Conflict on "default" (Phase 3A compat) → SUPERVISOR_ALREADY_ATTACHED.
 */
function handleSupervisorAttach(ws: ServerWebSocket<ControlSocketData>, requestId: string, endpoint: EndpointId, partitionId?: string): void {
  const room = getRoomForWs(ws);

  // Eligibility gate: only room coordinators may claim supervisor / partition
  if (!room.coordinators.has(ws)) {
    sendProtocolMessage(ws, {
      type: "supervisor_attach_result",
      requestId,
      success: false,
      error: { code: "SUPERVISOR_ATTACH_FORBIDDEN", message: "Only the coordinator connection (claude_connect) may attach as supervisor" },
    });
    return;
  }

  // Phase 4B: named partition claim path
  if (partitionId !== undefined) {
    // One-per-WS limit: calling WS must not already hold a partition
    const existingSlot = findPartitionForWs(room, ws);
    if (existingSlot !== null) {
      sendProtocolMessage(ws, {
        type: "supervisor_attach_result",
        requestId,
        success: false,
        error: { code: "COORDINATOR_ALREADY_HAS_PARTITION", message: `WS already holds partition '${existingSlot.partition_id}' — detach before claiming another` },
      });
      return;
    }

    // First-writer-wins: check if partition_id is already held by another WS
    const conflicting = room.partitions.get(partitionId);
    if (conflicting !== undefined && conflicting.socket !== ws) {
      sendProtocolMessage(ws, {
        type: "supervisor_attach_result",
        requestId,
        success: false,
        error: { code: "SUPERVISOR_PARTITION_CONFLICT", message: `Partition '${partitionId}' is already held by another coordinator` },
      });
      return;
    }

    // Claim the partition
    const slot: CoordinatorSlot = { partition_id: partitionId, socket: ws, endpoint };
    room.partitions.set(partitionId, slot);
    log(`Phase4B: partition '${partitionId}' claimed by endpoint='${endpoint}' socket=#${ws.data.clientId} room='${room.id}'`);

    // Flush supervisorBuffer to this socket (shared buffer; best effort for unrouted events)
    if (room.supervisorBuffer.length > 0) {
      const buffered = room.supervisorBuffer.splice(0, room.supervisorBuffer.length);
      for (const msg of buffered) {
        trySendBridgeMessage(ws, msg);
      }
      log(`Phase4B: flushed ${buffered.length} buffered observable(s) to partition '${partitionId}' in room='${room.id}'`);
    }

    sendProtocolMessage(ws, { type: "supervisor_attach_result", requestId, success: true });
    return;
  }

  // Phase 3A backward compat path: no partition_id → legacy supervisorSocket slot ("default" partition)
  // Conflict: a different WS already holds the slot
  if (room.supervisorSocket !== null && room.supervisorSocket !== ws) {
    sendProtocolMessage(ws, {
      type: "supervisor_attach_result",
      requestId,
      success: false,
      error: { code: "SUPERVISOR_ALREADY_ATTACHED", message: "A supervisor is already registered for this room" },
    });
    return;
  }

  // Atomic: set state BEFORE flush, BEFORE returning to event loop (no await)
  room.supervisorSocket = ws;
  room.supervisorEndpoint = endpoint;
  room.supervisorEverAttached = true;

  // Flush buffered observables synchronously (FIFO order, fire-and-forget sends)
  if (room.supervisorBuffer.length > 0) {
    const buffered = room.supervisorBuffer.splice(0, room.supervisorBuffer.length);
    for (const msg of buffered) {
      trySendBridgeMessage(ws, msg);
    }
    log(`Phase3A: flushed ${buffered.length} buffered observable(s) to supervisor '${endpoint}' in room='${room.id}'`);
  }

  log(`Phase3A: supervisor attached endpoint='${endpoint}' socket=#${ws.data.clientId} room='${room.id}'`);
  sendProtocolMessage(ws, { type: "supervisor_attach_result", requestId, success: true });
}

/**
 * Handle supervisor_detach control message.
 * Idempotent: detach from a non-owning WS succeeds as no-op.
 * Phase 4B: if partition_id provided, releases the named partition (5-step cleanup).
 * SYNCHRONOUS — no await.
 */
function handleSupervisorDetach(ws: ServerWebSocket<ControlSocketData>, requestId: string, partitionId?: string): void {
  const room = getRoomForWs(ws);

  if (partitionId !== undefined) {
    // Phase 4B: release named partition only if this WS owns it
    const slot = room.partitions.get(partitionId);
    if (slot && slot.socket === ws) {
      releasePartition(room, partitionId, "explicit detach");
    }
    // Idempotent: no-op if not owner
    sendProtocolMessage(ws, { type: "supervisor_detach_result", requestId, success: true });
    return;
  }

  // Phase 3A backward compat: release legacy supervisorSocket slot
  if (room.supervisorSocket === ws) {
    releaseSupervisor(room, "explicit detach");
  }
  // Idempotent: no-op if not the owner
  sendProtocolMessage(ws, { type: "supervisor_detach_result", requestId, success: true });
}

// ===== Phase 4B: Worker Binding =====

/**
 * Handle bind_worker control message.
 * Only the coordinator WS holding partition_id may bind a worker to that partition.
 * A worker may belong to at most one partition; rebind replaces previous binding.
 */
function handleBindWorker(ws: ServerWebSocket<ControlSocketData>, requestId: string, partitionId: string, endpoint: EndpointId): BindWorkerResult {
  const room = getRoomForWs(ws);

  // Eligibility: caller must be a room coordinator
  if (!room.coordinators.has(ws)) {
    return { success: false, error: { code: "BIND_NOT_AUTHORIZED", message: "Only a room coordinator may bind workers" } };
  }

  // Authorization: caller must hold the named partition
  const slot = room.partitions.get(partitionId);
  if (!slot || slot.socket !== ws) {
    return { success: false, error: { code: "BIND_NOT_AUTHORIZED", message: `Caller does not hold partition '${partitionId}'` } };
  }

  // Target must exist in peer registry
  const targetMeta = peerRegistry.get(endpoint);
  if (!targetMeta || targetMeta.status === "terminated") {
    return { success: false, error: { code: "BIND_TARGET_NOT_FOUND", message: `Endpoint '${endpoint}' not found or is terminated` } };
  }

  // Rebind: remove from any previous partition
  const previousPartition = room.partitionMembership.get(endpoint);
  if (previousPartition !== undefined && previousPartition !== partitionId) {
    log(`Phase4B: worker '${endpoint}' rebound from partition '${previousPartition}' to '${partitionId}' in room='${room.id}'`);
  }

  room.partitionMembership.set(endpoint, partitionId);
  log(`Phase4B: worker '${endpoint}' bound to partition '${partitionId}' in room='${room.id}'`);
  return { success: true };
}

// ===== Phase 4C-1: Direct Worker-WS Delivery =====

/**
 * Handle worker_connect control message.
 *
 * Worker declares its own WS connection so the daemon can deliver assign_task
 * relay envelopes directly, bypassing the supervisor/observable path.
 *
 * Binding contract (Rules 0–5):
 *   0. One socket ↔ one endpoint: same WS cannot claim a second endpoint.
 *   1. Endpoint must exist in peerRegistry (preallocated/spawned worker).
 *   2. Endpoint must not be terminated.
 *   3. Different live WS already bound → reject (no socket takeover).
 *   4. Same socket, same endpoint → idempotent success (no-op rebind).
 *   5. Otherwise: record binding.
 *
 * Direct delivery only works for preallocated/spawned workers (those whose
 * endpoint was pre-registered via launch_peer). Simulated workers that enter
 * peerRegistry via bare post_envelope register (without prior launch_peer)
 * cannot call worker_connect at spawn time and will continue using the
 * emitObservable fallback path — which is intentional for test harnesses.
 */
function handleWorkerConnect(ws: ServerWebSocket<ControlSocketData>, requestId: string, endpoint: string): void {
  // Rule 0: one socket ↔ one endpoint invariant
  if (ws.data.workerEndpoint !== undefined && ws.data.workerEndpoint !== endpoint) {
    sendProtocolMessage(ws, {
      type: "worker_connect_result", requestId, success: false,
      error: { code: "SUPERVISOR_ALREADY_ATTACHED", message: `This socket already registered as endpoint '${ws.data.workerEndpoint}'` },
    });
    return;
  }

  // Rule 1: endpoint must exist in peerRegistry
  const meta = peerRegistry.get(endpoint);
  if (!meta) {
    sendProtocolMessage(ws, {
      type: "worker_connect_result", requestId, success: false,
      error: { code: "ENDPOINT_NOT_FOUND", message: `Endpoint '${endpoint}' not in registry` },
    });
    return;
  }

  // Rule 2: terminated endpoint cannot bind
  if (meta.status === "terminated") {
    sendProtocolMessage(ws, {
      type: "worker_connect_result", requestId, success: false,
      error: { code: "ENDPOINT_NOT_FOUND", message: `Endpoint '${endpoint}' is terminated` },
    });
    return;
  }

  // Rule 3: different live socket already bound → reject
  const existing = workerSockets.get(endpoint);
  if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
    sendProtocolMessage(ws, {
      type: "worker_connect_result", requestId, success: false,
      error: { code: "SUPERVISOR_ALREADY_ATTACHED", message: `Endpoint '${endpoint}' already has a live worker socket` },
    });
    return;
  }

  // Rule 4+5: idempotent rebind or fresh bind
  workerSockets.set(endpoint, ws);
  ws.data.workerEndpoint = endpoint;
  log(`Phase4C: worker socket registered endpoint='${endpoint}' socket=#${ws.data.clientId}`);
  sendProtocolMessage(ws, { type: "worker_connect_result", requestId, success: true });
}

// ===== End Phase 4C-1 =====

// ===== End Phase 4B =====

// ===== End Phase 3A =====

// ===== Phase 3B: Task/Trigger Orchestration (now per-room via Room struct) =====

/**
 * Emit a LoopEvent observable to the supervisor sink of a specific room.
 *
 * Phase 4B: sourceEndpoint routes to the partition owner of the worker.
 *   - Worker-sourced events: pass event.endpoint (routes to partition owner).
 *   - Daemon-generated cleanup events (coordinator_disconnected): omit sourceEndpoint
 *     so they broadcast to all remaining room coordinators (per Phase 4B plan).
 */
function emitLoopEvent(room: Room, event: LoopEvent, sourceEndpoint?: EndpointId): void {
  emitObservable(room, {
    id: `loop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    source: "codex",
    content: JSON.stringify(event),
    timestamp: event.observed_at,
    senderId: ENDPOINT,
    sender: ENDPOINT,
    senderKind: "cc",
  }, sourceEndpoint);
}

/**
 * Clean up a task from room.activeTasks: cancel its timeout timer and remove the entry.
 * Returns the removed task (or undefined if not found).
 */
function removeActiveTask(room: Room, taskId: string): ActiveTask | undefined {
  const task = room.activeTasks.get(taskId);
  if (!task) return undefined;
  if (task.timeoutTimer !== null) clearTimeout(task.timeoutTimer);
  room.activeTasks.delete(taskId);
  return task;
}

/**
 * Cancel all in-flight tasks for a given endpoint across all rooms and emit LoopEvent{state:'failed'}.
 * Called when a worker is terminated, crashes, or is removed from the registry.
 * Iterates all rooms because worker endpoints are daemon-global in Phase 4A.
 */
function failTasksForEndpoint(endpoint: EndpointId): void {
  for (const room of rooms.values()) {
    for (const [taskId, task] of room.activeTasks) {
      if (task.assigned_to !== endpoint) continue;
      removeActiveTask(room, taskId);
      const event: LoopEvent = {
        task_id: taskId,
        endpoint,
        state: "failed",
        observed_at: Date.now(),
        details: { reason: "worker_terminated" },
      };
      log(`Phase3B: task '${taskId}' failed — worker '${endpoint}' terminated (room='${room.id}')`);
      // Pass endpoint so partition routing routes to the partition owner of the dead worker.
      emitLoopEvent(room, event, endpoint);
    }
  }
}

/**
 * Handle assign_task control message.
 * Phase 4A authority gate: WS must be in room.coordinators (has called claude_connect for this room).
 * Replaces Phase 3 gate: ws === attachedClaude.
 */
function handleAssignTask(ws: ServerWebSocket<ControlSocketData>, assignment: TaskAssignment): TaskAssignmentResult {
  const room = getRoomForWs(ws);
  const { task_id, assigned_to, timeout_ms } = assignment;

  // Phase 4A/4B authority gate: only room coordinators may assign tasks
  if (!room.coordinators.has(ws)) {
    return { success: false, task_id, error: { code: "TASK_ASSIGN_FORBIDDEN", message: "Only the coordinator connection may assign tasks" } };
  }

  // Phase 4B partition check: if any partition exists in this room, validate caller holds one
  // and the target worker is bound to that partition.
  let taskPartitionId: string | undefined;
  if (room.partitions.size > 0) {
    const callerSlot = findPartitionForWs(room, ws);
    if (callerSlot === null) {
      return { success: false, task_id, error: { code: "TASK_ASSIGN_FORBIDDEN", message: "Caller does not hold a partition — call supervisor_attach with a partition_id first" } };
    }
    const workerPartition = room.partitionMembership.get(assigned_to);
    if (workerPartition !== callerSlot.partition_id) {
      return { success: false, task_id, error: { code: "TASK_NOT_IN_PARTITION", message: `Worker '${assigned_to}' is not bound to caller's partition '${callerSlot.partition_id}'` } };
    }
    taskPartitionId = callerSlot.partition_id;
  }

  // Conflict: task_id already in-flight in this room
  if (room.activeTasks.has(task_id)) {
    return { success: false, task_id, error: { code: "TASK_ID_CONFLICT", message: `task_id '${task_id}' is already in-flight` } };
  }

  // Target validation: endpoint must be in registry and not terminated
  const targetMeta = peerRegistry.get(assigned_to);
  if (!targetMeta || targetMeta.status === "terminated") {
    return { success: false, task_id, error: { code: "TASK_TARGET_NOT_FOUND", message: `Endpoint '${assigned_to}' not found or is terminated` } };
  }

  // Register in room.activeTasks
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (timeout_ms && timeout_ms > 0) {
    timeoutTimer = setTimeout(() => {
      const task = room.activeTasks.get(task_id);
      if (!task) return; // already completed/failed
      removeActiveTask(room, task_id);
      log(`Phase3B: task '${task_id}' timed out after ${timeout_ms}ms (room='${room.id}')`);
      // Pass assigned_to so partition routing reaches the partition owner.
      emitLoopEvent(room, {
        task_id,
        endpoint: assigned_to,
        state: "timeout",
        observed_at: Date.now(),
      }, assigned_to);
    }, timeout_ms);
  }
  room.activeTasks.set(task_id, { assigned_to, timeoutTimer, ...(taskPartitionId ? { partition_id: taskPartitionId } : {}) });

  // Relay assignment as envelope to target worker via emitObservable (supervisor sink)
  const relayEnvelope: MessageEnvelope = {
    protocol_version: "1.0",
    message_id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    from: ENDPOINT,
    sent_at: Date.now(),
    kind: "work",
    intent: "task_assignment",
    payload: assignment,
    ...(assignment.task_id ? { task_id: assignment.task_id } : {}),
  };

  // Phase 4C-1: attempt direct delivery to worker's own WS connection.
  // If the worker registered via worker_connect and its socket is open, deliver directly.
  // Direct delivery is intentionally transport-only: authority/partition checks are unchanged.
  // After direct delivery, coordinator does NOT receive the relay envelope — this is intentional.
  // Coordinator still receives all subsequent loop_events from the worker via emitObservable.
  // Fallback to emitObservable (Phase 4B/3B path) when: no socket, socket closed, or send fails.
  const relayMessage: BridgeMessage = {
    id: relayEnvelope.message_id,
    source: "codex",
    content: JSON.stringify(relayEnvelope),
    timestamp: relayEnvelope.sent_at,
    senderId: ENDPOINT,
    sender: ENDPOINT,
    senderKind: "cc",
  };

  const workerWs = workerSockets.get(assigned_to);
  if (workerWs && workerWs.readyState === WebSocket.OPEN) {
    const sent = trySendBridgeMessage(workerWs, relayMessage);
    if (sent) {
      log(`Phase4C: assign_task relay direct-delivered to worker '${assigned_to}' socket=#${workerWs.data.clientId}`);
    } else {
      // Backpressure or send error — fall back to observable path
      log(`Phase4C: direct delivery failed for worker '${assigned_to}', falling back to emitObservable`);
      emitObservable(room, relayMessage, assigned_to);
    }
  } else {
    // No worker socket registered or socket closed — use Phase 4B/3B observable path
    emitObservable(room, relayMessage, assigned_to);
  }

  log(`Phase3B: task '${task_id}' assigned to '${assigned_to}' (room='${room.id}')${timeout_ms ? ` (timeout: ${timeout_ms}ms)` : ""}`);
  return { success: true, task_id };
}

/**
 * Handle loop_event envelope intent from worker.
 * Worker → daemon → supervisor sink (via emitLoopEvent).
 * Terminal states (completed/timeout/failed) remove task from activeTasks.
 *
 * Phase 4A: finds the room containing the task by scanning all rooms.
 * Phase 4B will derive room from partitionMembership.
 */
function handleLoopEventIntent(envelope: MessageEnvelope): void {
  const p = envelope.payload as Partial<LoopEvent>;
  const taskId = typeof p?.task_id === "string" ? p.task_id : undefined;
  const state = p?.state as LoopState | undefined;
  const endpoint = envelope.from;

  if (!taskId || !state) {
    log(`Phase3B: loop_event missing task_id or state from '${endpoint}'`);
    return;
  }

  // Find the room containing this task
  let targetRoom: Room | null = null;
  for (const room of rooms.values()) {
    if (room.activeTasks.has(taskId)) {
      targetRoom = room;
      break;
    }
  }
  // Fallback for late terminal events (task already removed from activeTasks):
  // Phase 4B: look for the room where the endpoint is in partitionMembership.
  // This avoids cross-room leaks to the default room for non-default-room workers.
  if (!targetRoom) {
    for (const room of rooms.values()) {
      if (room.partitionMembership.has(endpoint)) {
        targetRoom = room;
        break;
      }
    }
  }
  // Last resort: default room (Phase 3/4A backward compat)
  if (!targetRoom) {
    targetRoom = getOrCreateRoom(ROOM);
  }

  const event: LoopEvent = {
    ...(typeof p.loop_id === "string" ? { loop_id: p.loop_id } : {}),
    task_id: taskId,
    endpoint,
    state,
    observed_at: p.observed_at ?? Date.now(),
    ...(p.details ? { details: p.details } : {}),
  };

  // Terminal states: remove from activeTasks
  if (state === "completed" || state === "timeout" || state === "failed") {
    removeActiveTask(targetRoom, taskId);
    log(`Phase3B: task '${taskId}' reached terminal state '${state}' from '${endpoint}' (room='${targetRoom.id}')`);
  }

  // Worker-sourced event: pass endpoint for Phase 4B partition routing (routes to partition owner).
  emitLoopEvent(targetRoom, event, endpoint);
}

// ===== End Phase 3B =====

function broadcastStatus() {
  // Phase 4A: broadcast to all coordinators in all rooms
  for (const room of rooms.values()) {
    for (const coordinator of room.coordinators) {
      if (coordinator.readyState === WebSocket.OPEN) {
        sendStatus(coordinator);
      }
    }
  }
}

// ===== Phase 0: Envelope Protocol =====

function emitLifecycleAck(
  endpoint: string,
  status: LifecycleStatus,
  previousStatus?: LifecycleStatus,
  correlationId?: string,
): void {
  const observedAt = Date.now();
  const payload: Record<string, unknown> = { endpoint, status, observed_at: observedAt };
  if (previousStatus !== undefined) payload.previous_status = previousStatus;
  if (correlationId) payload.correlation_id = correlationId;

  const ack: MessageEnvelope = {
    protocol_version: "1.0",
    message_id: `ack_${observedAt}_${Math.random().toString(36).slice(2, 8)}`,
    from: ENDPOINT,
    sent_at: observedAt,
    kind: "control",
    intent: "lifecycle_ack",
    payload,
  };

  // Phase 4A: worker events go to default room (workers are daemon-global in Phase 4A)
  emitObservableToDefaultRoom({
    id: ack.message_id,
    source: "codex",
    content: JSON.stringify(ack),
    timestamp: ack.sent_at,
    senderId: ENDPOINT,
    sender: ENDPOINT,
    senderKind: "cc",
  });
}

function handleRegisterIntent(envelope: MessageEnvelope, roomId: string): void {
  const p = (envelope.payload ?? {}) as Record<string, unknown>;
  const endpoint = typeof p.endpoint === "string" ? p.endpoint : envelope.from;
  const startedAt = typeof p.started_at === "number" ? p.started_at : Date.now();

  const existing = peerRegistry.get(endpoint);
  const isPreAllocated = existing?.status === "launching";

  const meta: PeerMetadata = {
    endpoint,
    role: typeof p.role === "string" ? p.role : existing?.role,
    model: typeof p.model === "string" ? p.model : existing?.model,
    workdir: typeof p.workdir === "string" ? p.workdir : existing?.workdir,
    coordinator: typeof p.coordinator === "string" ? p.coordinator : existing?.coordinator,
    started_at: startedAt,
    last_heartbeat: startedAt,
    status: "connected",
    bootstrap_state: "pending",
  };

  peerRegistry.set(endpoint, meta);
  endpointToRoom.set(endpoint, roomId); // Phase 4D-1: transport-derived room for cross-room routing
  log(`Phase0: registered endpoint='${endpoint}' role='${meta.role ?? "?"}' isPreAllocated=${isPreAllocated} room='${roomId}'`);
  emitLifecycleAck(endpoint, "connected", existing?.status, envelope.message_id);

  // Phase 1: start bootstrap timer only for pre-allocated endpoints (from launch_peer)
  if (isPreAllocated) {
    startBootstrapTimer(endpoint, meta.role ?? "unknown");
    log(`Phase1: bootstrap timer started for endpoint='${endpoint}' (${BOOTSTRAP_TIMEOUT_MS}ms)`);
  }
}

function handleHeartbeatIntent(envelope: MessageEnvelope): void {
  const endpoint = envelope.from;
  const existing = peerRegistry.get(endpoint);

  if (!existing) {
    emitObservableToDefaultRoom({
      id: `sys_${Date.now()}`,
      source: "codex",
      content: JSON.stringify(
        makeErrorEnvelope("ROLE_NOT_FOUND", `Endpoint '${endpoint}' not registered`, envelope.message_id),
      ),
      timestamp: Date.now(),
      senderId: ENDPOINT,
      sender: ENDPOINT,
      senderKind: "cc",
    });
    return;
  }

  const previous = existing.status;
  const payloadObj = (envelope.payload as Record<string, unknown>) ?? {};
  const nextStatus: LifecycleStatus = payloadObj.status === "busy" ? "busy" : "idle";
  const updated: PeerMetadata = { ...existing, last_heartbeat: Date.now(), status: nextStatus };
  peerRegistry.set(endpoint, updated);

  // Phase 2: if recovering from stalled, cancel the escalation timer
  if (previous === "stalled") {
    clearEscalationTimer(endpoint);
  }

  const statusChanged = previous !== nextStatus;
  emitLifecycleAck(endpoint, nextStatus, statusChanged ? previous : undefined, envelope.message_id);
}

type EnvelopeHandlerResult = { ok: true; resolvedEndpoints?: string[] } | { ok: false; error: ErrorReceiptPayload };

function handleEnvelopeIntent(envelope: MessageEnvelope, roomId: string): EnvelopeHandlerResult {
  if (envelope.kind !== "control") {
    const intendedTo = Array.isArray(envelope.intended_to) ? (envelope.intended_to as string[]) : [];
    const routeResult = resolveIntendedTo(intendedTo);
    if (!routeResult.ok) return { ok: false, error: routeResult.error };

    // Phase 4A: relay messages go to default room (worker-to-worker relay is room-scoped in Phase 4B)
    emitObservableToDefaultRoom({
      id: envelope.message_id,
      source: "codex",
      content: JSON.stringify(envelope),
      timestamp: envelope.sent_at,
      senderId: envelope.from,
      sender: envelope.from,
      senderKind: "codex",
    });
    return { ok: true, resolvedEndpoints: routeResult.endpoints };
  }

  switch (envelope.intent) {
    case "register":
      handleRegisterIntent(envelope, roomId);
      return { ok: true };
    case "heartbeat":
      handleHeartbeatIntent(envelope);
      return { ok: true };
    case "bootstrap_ack":
      handleBootstrapAckIntent(envelope);
      return { ok: true };
    case "loop_event":
      handleLoopEventIntent(envelope);
      return { ok: true };
    default:
      log(`Phase1: unhandled control intent '${envelope.intent}'`);
      return { ok: true };
  }
}

function checkStalledPeers(): void {
  const now = Date.now();
  for (const [endpoint, meta] of peerRegistry) {
    if (meta.status === "stalled" || meta.status === "terminated") continue;
    if (now - meta.last_heartbeat > PEER_STALE_MS) {
      const previous = meta.status;
      peerRegistry.set(endpoint, { ...meta, status: "stalled" });
      log(`Phase0: endpoint='${endpoint}' stalled (age=${now - meta.last_heartbeat}ms)`);
      emitLifecycleAck(endpoint, "stalled", previous);
      startEscalationTimer(endpoint);
    }
  }
}

// ===== End Phase 0 =====

// ===== Phase 1: Bootstrap Handshake =====

function emitBootstrapAck(endpoint: string, role: string, status: BootstrapAck["status"], correlationId?: string): void {
  const ack: BootstrapAck = {
    endpoint,
    role,
    status,
    observed_at: Date.now(),
    ...(correlationId ? { correlation_id: correlationId } : {}),
  };
  emitObservableToDefaultRoom({
    id: `bootstrap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    source: "codex",
    content: JSON.stringify(ack),
    timestamp: Date.now(),
    senderId: ENDPOINT,
    sender: ENDPOINT,
    senderKind: "cc",
  });
}

function startBootstrapTimer(endpoint: string, role: string): void {
  if (bootstrapTimers.has(endpoint)) return;

  const timer = setTimeout(() => {
    bootstrapTimers.delete(endpoint);
    const meta = peerRegistry.get(endpoint);
    if (!meta || meta.bootstrap_state !== "pending") return;

    peerRegistry.set(endpoint, { ...meta, bootstrap_state: "timeout" });
    log(`Phase1: bootstrap timeout for endpoint='${endpoint}' role='${role}'`);
    emitBootstrapAck(endpoint, role, "timeout");
  }, BOOTSTRAP_TIMEOUT_MS);

  bootstrapTimers.set(endpoint, timer);
}

function clearBootstrapTimer(endpoint: string): void {
  const timer = bootstrapTimers.get(endpoint);
  if (timer) {
    clearTimeout(timer);
    bootstrapTimers.delete(endpoint);
  }
}

function handleBootstrapAckIntent(envelope: MessageEnvelope): void {
  const endpoint = envelope.from;
  const meta = peerRegistry.get(endpoint);
  const outcome = processBootstrapAck(meta?.bootstrap_state);

  switch (outcome.action) {
    case "unknown_endpoint":
      log(`Phase1: bootstrap_ack from unknown endpoint '${endpoint}' — rejected`);
      emitObservableToDefaultRoom({
        id: `sys_${Date.now()}`,
        source: "codex",
        content: JSON.stringify(
          makeErrorEnvelope("ENDPOINT_NOT_FOUND", `bootstrap_ack from unknown endpoint '${endpoint}'`, envelope.message_id),
        ),
        timestamp: Date.now(),
        senderId: ENDPOINT,
        sender: ENDPOINT,
        senderKind: "cc",
      });
      return;

    case "ignore_late":
      log(`Phase1: late bootstrap_ack from '${endpoint}' (already timed out) — ignored`);
      emitObservableToDefaultRoom({
        id: `sys_${Date.now()}`,
        source: "codex",
        content: JSON.stringify(
          makeErrorEnvelope(
            "BOOTSTRAP_TIMEOUT",
            `Late bootstrap_ack from '${endpoint}' received after timeout — state unchanged`,
            envelope.message_id,
          ),
        ),
        timestamp: Date.now(),
        senderId: ENDPOINT,
        sender: ENDPOINT,
        senderKind: "cc",
      });
      return;

    case "ignore_duplicate":
      log(`Phase1: duplicate bootstrap_ack from '${endpoint}' — ignored with observable receipt`);
      emitObservableToDefaultRoom({
        id: `sys_${Date.now()}`,
        source: "codex",
        content: JSON.stringify(
          makeErrorEnvelope(
            "BOOTSTRAP_DUPLICATE_ACK",
            `Duplicate bootstrap_ack from '${endpoint}' — endpoint already bootstrapped, ack ignored`,
            envelope.message_id,
          ),
        ),
        timestamp: Date.now(),
        senderId: ENDPOINT,
        sender: ENDPOINT,
        senderKind: "cc",
      });
      return;

    case "ack": {
      clearBootstrapTimer(endpoint);
      const updated: PeerMetadata = { ...meta!, bootstrap_state: "acked", status: "bootstrapped" };
      peerRegistry.set(endpoint, updated);
      log(`Phase1: bootstrap acked for endpoint='${endpoint}' role='${meta!.role ?? "?"}'`);
      emitBootstrapAck(endpoint, meta!.role ?? "unknown", "acked", envelope.message_id);
      emitLifecycleAck(endpoint, "bootstrapped", "connected", envelope.message_id);
      return;
    }
  }
}

// ===== Phase 1: Launch / Registry =====

function allocateEndpoint(role: string): EndpointId {
  const safe = sanitizeName(role);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${safe}-${Date.now()}-${rand}`;
}

function handleLaunchPeer(req: LaunchRequest): LaunchResult {
  const validationError = validateLaunchRequest(req);
  if (validationError) {
    return { success: false, error: validationError };
  }

  const coordinatorMeta = peerRegistry.get(req.coordinator);
  const resolvedWorkdir = req.workdir ?? coordinatorMeta?.workdir;
  if (resolvedWorkdir !== undefined) {
    const workdirError = validateWorkdir(resolvedWorkdir);
    if (workdirError) return { success: false, error: workdirError };
  }

  const endpoint = allocateEndpoint(req.role);
  const now = Date.now();
  const meta: PeerMetadata = {
    endpoint,
    role: req.role,
    model: req.model,
    workdir: resolvedWorkdir,
    coordinator: req.coordinator,
    started_at: now,
    last_heartbeat: now,
    status: "launching",
    bootstrap_state: "pending",
  };
  peerRegistry.set(endpoint, meta);

  if (!SPAWN_COMMAND) {
    log(`Phase2: CC_BRIDGE_SPAWN_COMMAND not set — spawn skipped (endpoint pre-allocated only)`);
    return { success: true, endpoint, peer: meta };
  }

  const spawnEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CC_BRIDGE_ENDPOINT: endpoint,
    CC_BRIDGE_ROLE: req.role,
    CC_BRIDGE_COORDINATOR: req.coordinator,
    CC_BRIDGE_COORDINATOR_PORT: String(CONTROL_PORT),
    ...(resolvedWorkdir ? { CC_BRIDGE_WORKDIR: resolvedWorkdir } : {}),
    ...(req.model ? { CC_BRIDGE_MODEL: req.model } : {}),
    ...(req.bootstrap_message ? { CC_BRIDGE_BOOTSTRAP_MESSAGE: req.bootstrap_message } : {}),
  };

  const cmdArgs = SPAWN_COMMAND.split(/\s+/);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmdArgs, { env: spawnEnv, stdout: "ignore", stderr: "ignore" });
  } catch (err: any) {
    peerRegistry.delete(endpoint);
    log(`Phase2: spawn failed for endpoint='${endpoint}': ${err.message}`);
    return { success: false, error: { code: "SPAWN_FAILED", message: `Failed to spawn peer: ${err.message}` } };
  }

  const pid = proc.pid;
  spawnedProcesses.set(endpoint, { pid, proc });
  log(`Phase2: spawned endpoint='${endpoint}' role='${req.role}' pid=${pid}`);

  proc.exited.then(() => {
    handleChildExit(endpoint, pid, proc.exitCode, proc.signalCode ?? null);
  });

  return { success: true, endpoint, pid, peer: { ...meta } };
}

function handleQueryRegistry(): import("./protocol").RegistrySnapshot {
  // Phase 4C-3: enrich each peer with a query-time active_task_count.
  // Count is summed across all rooms (activeTasks is per-room but endpoints are daemon-global).
  // This is computed at snapshot time only — not stored in peerRegistry.
  return {
    peers: [...peerRegistry.values()].map((meta) => {
      let count = 0;
      for (const room of rooms.values()) {
        for (const task of room.activeTasks.values()) {
          if (task.assigned_to === meta.endpoint) count++;
        }
      }
      // Phase 5A: enrich with room from endpointToRoom (query-time lookup, not stored in metadata)
      const room = endpointToRoom.get(meta.endpoint);
      return { ...meta, active_task_count: count, ...(room ? { room } : {}) };
    }),
  };
}

// ===== End Phase 1 =====

// ===== Phase 2: Process Lifecycle & Termination =====

function emitSpawnExitObservable(endpoint: string, role: string, pid: number, exitCode: number | null, signalName: string | null): void {
  const obs: SpawnExitObservable = { endpoint, role, pid, exit_code: exitCode, signal: signalName, observed_at: Date.now() };
  emitObservableToDefaultRoom({
    id: `exit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    source: "codex",
    content: JSON.stringify(obs),
    timestamp: Date.now(),
    senderId: ENDPOINT,
    sender: ENDPOINT,
    senderKind: "cc",
  });
}

function handleChildExit(endpoint: string, pid: number, exitCode: number | null, signalName: string | null): void {
  spawnedProcesses.delete(endpoint);
  // Phase 4C-1: evict worker socket on process exit
  workerSockets.delete(endpoint);
  const meta = peerRegistry.get(endpoint);
  const role = meta?.role ?? "unknown";

  emitSpawnExitObservable(endpoint, role, pid, exitCode, signalName);

  if (!meta || meta.status === "terminated") {
    return;
  }

  clearBootstrapTimer(endpoint);
  clearEscalationTimer(endpoint);

  const previous = meta.status;
  const newBootstrapState: PeerMetadata["bootstrap_state"] =
    meta.bootstrap_state === "acked" ? "acked" :
    meta.bootstrap_state === "timeout" ? "timeout" :
    "failed";

  peerRegistry.set(endpoint, { ...meta, status: "terminated", bootstrap_state: newBootstrapState });
  endpointToRoom.delete(endpoint); // Phase 4D-1: clear routing index on terminate
  log(`Phase2: child exited endpoint='${endpoint}' pid=${pid} exitCode=${exitCode} signal=${signalName ?? "none"} bootstrap_state=${newBootstrapState}`);
  emitLifecycleAck(endpoint, "terminated", previous);

  // Phase 3B: fail any in-flight tasks assigned to this endpoint (across all rooms)
  failTasksForEndpoint(endpoint);
}

function startEscalationTimer(endpoint: string): void {
  if (escalationTimers.has(endpoint)) return;

  const timer = setTimeout(() => {
    escalationTimers.delete(endpoint);
    const meta = peerRegistry.get(endpoint);
    if (!meta || meta.status !== "stalled") return;

    const newBootstrapState: PeerMetadata["bootstrap_state"] =
      meta.bootstrap_state === "acked" ? "acked" : "failed";
    peerRegistry.set(endpoint, { ...meta, status: "terminated", bootstrap_state: newBootstrapState });
    endpointToRoom.delete(endpoint); // Phase 4D-1: clear routing index on terminate
    log(`Phase2: stall escalation fired for endpoint='${endpoint}' role='${meta.role ?? "?"}'`);
    emitLifecycleAck(endpoint, "terminated", "stalled");
    // Phase 3B: fail any in-flight tasks assigned to this endpoint (across all rooms)
    failTasksForEndpoint(endpoint);
  }, STALL_ESCALATION_MS);

  escalationTimers.set(endpoint, timer);
}

function clearEscalationTimer(endpoint: string): void {
  const timer = escalationTimers.get(endpoint);
  if (timer) {
    clearTimeout(timer);
    escalationTimers.delete(endpoint);
  }
}

function handleTerminatePeer(req: TerminatePeerRequest): TerminatePeerResult {
  const { endpoint, signal = "SIGTERM" } = req;
  // Phase 4C-1: evict worker socket before termination
  workerSockets.delete(endpoint);
  const meta = peerRegistry.get(endpoint);

  if (!meta) {
    return { success: false, endpoint, error: { code: "ENDPOINT_NOT_FOUND", message: `Endpoint '${endpoint}' not found in registry` } };
  }

  if (meta.status === "terminated") {
    return { success: true, endpoint };
  }

  const spawned = spawnedProcesses.get(endpoint);
  if (spawned) {
    try {
      spawned.proc.kill(signal);
    } catch (err: any) {
      log(`Phase2: kill signal ${signal} failed for endpoint='${endpoint}' pid=${spawned.pid}: ${err.message}`);
      return { success: false, endpoint, error: { code: "TERMINATE_FAILED", message: `Failed to send ${signal} to pid ${spawned.pid}: ${err.message}` } };
    }
  }

  clearBootstrapTimer(endpoint);
  clearEscalationTimer(endpoint);

  const previous = meta.status;
  const newBootstrapState: PeerMetadata["bootstrap_state"] =
    meta.bootstrap_state === "acked" ? "acked" :
    meta.bootstrap_state === "timeout" ? "timeout" :
    "failed";
  peerRegistry.set(endpoint, { ...meta, status: "terminated", bootstrap_state: newBootstrapState });
  endpointToRoom.delete(endpoint); // Phase 4D-1: clear routing index on terminate
  log(`Phase2: terminate_peer endpoint='${endpoint}' signal=${spawned ? signal : "none (not spawned)"}`);
  emitLifecycleAck(endpoint, "terminated", previous);

  // Phase 3B: fail any in-flight tasks assigned to this endpoint (across all rooms)
  failTasksForEndpoint(endpoint);

  return { success: true, endpoint };
}

// ===== End Phase 2 =====

function sendProtocolMessage(ws: ServerWebSocket<ControlSocketData>, message: ControlServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch (err: any) {
    log(`Failed to send control message: ${err.message}`);
  }
}

function currentStatus(): DaemonStatus {
  return {
    bridgeReady: bootstrapped,
    peerConnected,
    room: ROOM,
    peerCount,
    queuedMessageCount: bufferedMessages.length,
    endpoint: ENDPOINT,
    pid: process.pid,
    peers: knownPeers,
  };
}

function drainPendingPullMessages(): BridgeMessage[] {
  return pendingPullMessages.splice(0, pendingPullMessages.length);
}

function handleWaitForMessages(ws: ServerWebSocket<ControlSocketData>, requestId: string, timeoutMs: number) {
  const messages = drainPendingPullMessages();
  if (messages.length > 0) {
    sendProtocolMessage(ws, { type: "wait_for_messages_result", requestId, messages });
    return;
  }

  const boundedTimeout = Math.max(1000, Math.min(120000, timeoutMs || 30000));
  const timer = setTimeout(() => {
    waiters.delete(requestId);
    sendProtocolMessage(ws, { type: "wait_for_messages_result", requestId, messages: [] });
  }, boundedTimeout);

  waiters.set(requestId, { ws, timer });
}

function fulfillWaiters() {
  if (pendingPullMessages.length === 0 || waiters.size === 0) return;

  const messages = drainPendingPullMessages();
  for (const [requestId, waiter] of waiters.entries()) {
    clearTimeout(waiter.timer);
    sendProtocolMessage(waiter.ws, { type: "wait_for_messages_result", requestId, messages });
    waiters.delete(requestId);
  }
}

function clearWaitersForSocket(ws: ServerWebSocket<ControlSocketData>) {
  for (const [requestId, waiter] of waiters.entries()) {
    if (waiter.ws !== ws) continue;
    clearTimeout(waiter.timer);
    waiters.delete(requestId);
  }
}

function currentReadyMessageForRoom(roomId: string): string {
  const peers = roomKnownPeers.get(roomId) ?? [];
  const peerCountForRoom = peers.filter((peer) => peer !== ENDPOINT).length;
  if (peerCountForRoom > 0) {
    return `✅ ${PEER_LABEL} connected in room '${roomId}'. Endpoint=${ENDPOINT}, peers=${peerCountForRoom}.`;
  }

  return `⏳ Waiting for another Claude window in room '${roomId}'. Endpoint=${ENDPOINT}.`;
}


function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${++nextSystemMessageId}`,
    source: "codex",
    content,
    timestamp: Date.now(),
    senderId: ENDPOINT,
    sender: ENDPOINT,
    senderKind: "cc",
  };
}

function ensureRelayDirs(roomId: string) {
  const p = roomRelayPaths(roomId);
  mkdirSync(p.peersDir, { recursive: true });
  mkdirSync(p.messagesDir, { recursive: true });
  mkdirSync(p.acksDir, { recursive: true });
}

function peerHeartbeatPath(endpoint: string, roomId: string) {
  return join(roomRelayPaths(roomId).peersDir, `${endpoint}.json`);
}

function messagePath(id: string, roomId: string) {
  return join(roomRelayPaths(roomId).messagesDir, `${id}.json`);
}

function ackDirPath(messageId: string, roomId: string) {
  return join(roomRelayPaths(roomId).acksDir, messageId);
}

function ackPath(messageId: string, endpoint: string, roomId: string) {
  return join(ackDirPath(messageId, roomId), `${endpoint}.ack`);
}

function writeHeartbeat(roomId: string) {
  ensureRelayDirs(roomId);
  const payload = {
    endpoint: ENDPOINT,
    room: roomId,
    updatedAt: Date.now(),
    pid: process.pid,
  };
  writeFileSync(peerHeartbeatPath(ENDPOINT, roomId), JSON.stringify(payload), "utf-8");
}

function refreshPeers(roomId: string) {
  ensureRelayDirs(roomId);
  const { peersDir } = roomRelayPaths(roomId);
  const peers = new Set<string>();

  for (const entry of readdirSync(peersDir)) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = join(peersDir, entry);
    try {
      const peer = JSON.parse(readFileSync(fullPath, "utf-8")) as { endpoint?: string; updatedAt?: number };
      const endpoint = sanitizeName(peer.endpoint ?? entry.replace(/\.json$/, ""));
      const updatedAt = Number(peer.updatedAt ?? 0);
      if (!updatedAt || Date.now() - updatedAt > PEER_STALE_MS) {
        unlinkSync(fullPath);
        continue;
      }
      peers.add(endpoint);
    } catch {
      try {
        unlinkSync(fullPath);
      } catch {}
    }
  }

  peers.add(ENDPOINT);
  const nextPeers = [...peers].sort();
  const nextPeerCount = nextPeers.filter((peer) => peer !== ENDPOINT).length;

  // Phase 4D-2: capture prior state BEFORE updating the cache (used for edge detection below)
  const prevPeers = roomKnownPeers.get(roomId) ?? [];
  const prevPeerCount = prevPeers.filter((peer) => peer !== ENDPOINT).length;
  roomKnownPeers.set(roomId, nextPeers);

  // Backward compat: keep module-level peerCount/peerConnected/knownPeers for default room status
  if (roomId === ROOM) {
    const wasConnected = peerConnected;
    knownPeers = nextPeers;
    peerCount = nextPeerCount;
    peerConnected = nextPeerCount > 0;
    if (!wasConnected && peerConnected) {
      emitToClaude(systemMessage("peer_joined", `✅ ${PEER_LABEL} joined room '${ROOM}'. peers=${peerCount}.`));
      broadcastStatus();
    } else if (wasConnected && !peerConnected) {
      emitToClaude(systemMessage("peer_left", `⚠️ No peer currently active in room '${ROOM}'.`));
      broadcastStatus();
    }
  } else {
    // Phase 4D-2: emit only on transition (0→N or N→0), not on every timer tick
    const room = rooms.get(roomId);
    if (room) {
      if (prevPeerCount === 0 && nextPeerCount > 0) {
        emitObservable(room, systemMessage("peer_joined", `✅ ${PEER_LABEL} joined room '${roomId}'. peers=${nextPeerCount}.`));
      } else if (prevPeerCount > 0 && nextPeerCount === 0) {
        emitObservable(room, systemMessage("peer_left", `⚠️ No peer currently active in room '${roomId}'.`));
      }
    }
  }
}

function pollMessages(roomId: string) {
  ensureRelayDirs(roomId);
  const { messagesDir } = roomRelayPaths(roomId);
  for (const entry of readdirSync(messagesDir)) {
    if (!entry.endsWith(".json")) continue;

    const fullPath = join(messagesDir, entry);
    try {
      const envelope = JSON.parse(readFileSync(fullPath, "utf-8")) as RelayEnvelope;
      if (seenMessageIds.has(envelope.id)) continue;
      if (existsSync(ackPath(envelope.id, ENDPOINT, roomId))) {
        seenMessageIds.add(envelope.id);
        continue;
      }
      if (!shouldDeliverEnvelopeToEndpoint(envelope, roomId, ENDPOINT)) continue;

      const senderId = getEnvelopeSenderId(envelope) ?? "unknown";
      const bridgeMsg: BridgeMessage = {
        id: envelope.id,
        source: "codex",
        content: envelope.content,
        timestamp: envelope.timestamp,
        senderId,
        sender: senderId,
        senderKind: envelope.senderKind ?? "cc",
      };

      // Default room: use emitToClaude (matches 副本 behavior) to ensure messages
      // are always queued in pendingPullMessages + bufferedMessages, regardless of
      // whether a coordinator is connected. This fixes the push/pull conflict where
      // forwardRelayMessageToCoordinator only queued on successful push delivery.
      if (roomId === ROOM) {
        emitToClaude(bridgeMsg);
      } else {
        if (!forwardRelayMessageToCoordinator(roomId, bridgeMsg)) {
          continue;
        }
      }

      writeAck(envelope.id, ENDPOINT, roomId);
      seenMessageIds.add(envelope.id);
    } catch (err: any) {
      log(`Failed to read relay message ${entry}: ${err.message}`);
    }
  }
}

function postPeerMessage(content: string, to?: string[], senderRoomId?: string): RelayEnvelope {
  const senderRoom = senderRoomId ?? ROOM;
  ensureRelayDirs(senderRoom);
  refreshPeers(senderRoom);
  const onlinePeers = roomKnownPeers.get(senderRoom) ?? [];
  const envelope = buildRelayEnvelope({
    room: senderRoom,
    senderId: ENDPOINT,
    content,
    onlinePeers,
    to,
  });

  const recipientCount = envelope.resolvedRecipients?.length ?? 0;

  // Phase 4D-1: room-local resolution failed — attempt cross-room coordinator forwarding.
  // Constraints: point-to-point only (to.length === 1); requires live coordinator WS in target room;
  // delivers directly to coordinator WS, bypassing emitObservable/supervisorBuffer semantics.
  // Relies on one-coordinator-per-room invariant (Phase 4A). Does NOT write to MESSAGES_DIR.
  if (to && to.length > 0 && recipientCount === 0) {
    if (to.length > 1) {
      throw new Error(`ENDPOINT_NOT_FOUND: Cross-room send is point-to-point only (got ${to.length} targets)`);
    }
    const target = to[0];
    const senderRoom = senderRoomId ?? ROOM;
    const meta = peerRegistry.get(target);
    if (!meta) {
      throw new Error(`ENDPOINT_NOT_FOUND: Endpoint '${target}' is not registered`);
    }
    if (meta.status === "terminated") {
      throw new Error(`PEER_TERMINATED: Endpoint '${target}' is terminated`);
    }
    const targetRoomId = endpointToRoom.get(target);
    if (!targetRoomId || targetRoomId === senderRoom) {
      throw new Error(`ENDPOINT_NOT_FOUND: Endpoint '${target}' is not reachable in any room other than the sender's`);
    }
    const targetRoom = rooms.get(targetRoomId);
    const liveCoord = targetRoom
      ? [...targetRoom.coordinators].find(c => c.readyState === WebSocket.OPEN)
      : undefined;
    if (!liveCoord) {
      throw new Error(`COORDINATOR_OFFLINE: No active coordinator for room '${targetRoomId}'`);
    }
    const xId = `xroom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const xEnvelope: RelayEnvelope = {
      id: xId,
      room: targetRoomId,
      senderId: ENDPOINT,          // daemon instance identity (not per-coordinator)
      sender: ENDPOINT,
      senderKind: "cc",
      content,
      timestamp: Date.now(),
      route: { mode: "direct", to: [target] },
      resolvedRecipients: [target],
      sender_room: senderRoom,     // Phase 4D-1: originating coordinator room
      target_endpoint: target,     // Phase 4D-1: explicit destination endpoint
    };
    seenMessageIds.add(xId);
    trySendBridgeMessage(liveCoord, {
      id: xId,
      source: "codex",
      content: JSON.stringify(xEnvelope),
      timestamp: xEnvelope.timestamp,
      senderId: ENDPOINT,
      sender: ENDPOINT,
      senderKind: "cc",
    });
    log(`Phase4D1: cross-room forward from='${ENDPOINT}' (room='${senderRoom}') to='${target}' targetRoom='${targetRoomId}'`);
    return { ...envelope, resolvedRecipients: [target] };
  }

  seenMessageIds.add(envelope.id);
  writeFileSync(messagePath(envelope.id, senderRoom), JSON.stringify(envelope), "utf-8");
  log(`Forwarding local Claude -> peer (${content.length} chars, recipients=${recipientCount})`);
  return envelope;
}

/**
 * Phase 5B: Global broadcast — send content to all relay-active rooms.
 * - ROOM (default room): delivered via emitToClaude (preserves buffered-messages/reconnect semantics)
 * - Non-default rooms: delivered to all live coordinator WS sockets in room.coordinators
 * Returns { delivered_rooms, skipped_rooms } (partial-success model).
 */
function broadcastGlobal(content: string, senderRoomId: string): { delivered_rooms: string[]; skipped_rooms: string[] } {
  const delivered_rooms: string[] = [];
  const skipped_rooms: string[] = [];
  const timestamp = Date.now();
  const msgId = `global_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
  seenMessageIds.add(msgId);

  for (const roomId of relayActiveRooms) {
    if (roomId === ROOM) {
      // Default room: use emitToClaude to preserve buffering/reconnect semantics
      const bridgeMsg: BridgeMessage = {
        id: msgId,
        source: "codex",
        content,
        timestamp,
        senderId: ENDPOINT,
        sender: ENDPOINT,
        senderKind: "cc",
      };
      emitToClaude(bridgeMsg);
      delivered_rooms.push(roomId);
      continue;
    }
    // Non-default room: fan out to all live coordinator WS sockets
    const room = rooms.get(roomId);
    if (!room) {
      skipped_rooms.push(roomId);
      continue;
    }
    const liveCoords = [...room.coordinators].filter(c => c.readyState === WebSocket.OPEN);
    if (liveCoords.length === 0) {
      skipped_rooms.push(roomId);
      continue;
    }
    const bridgeMsg: BridgeMessage = {
      id: msgId,
      source: "codex",
      content,
      timestamp,
      senderId: ENDPOINT,
      sender: ENDPOINT,
      senderKind: "cc",
    };
    const anyDelivered = liveCoords.some((coord) => trySendBridgeMessage(coord, bridgeMsg));
    if (anyDelivered) {
      delivered_rooms.push(roomId);
    } else {
      skipped_rooms.push(roomId);
    }
  }
  log(`Phase5B: global broadcast from='${ENDPOINT}' (senderRoom='${senderRoomId}') delivered=${delivered_rooms.join(",") || "none"} skipped=${skipped_rooms.join(",") || "none"}`);
  return { delivered_rooms, skipped_rooms };
}

function writeAck(messageId: string, endpoint: string, roomId: string) {
  const dir = ackDirPath(messageId, roomId);
  mkdirSync(dir, { recursive: true });
  const fullPath = ackPath(messageId, endpoint, roomId);
  if (existsSync(fullPath)) {
    return;
  }
  writeFileSync(fullPath, JSON.stringify({ endpoint, ackedAt: Date.now() }), "utf-8");
}

function readAckedRecipients(messageId: string, roomId: string): string[] {
  const dir = ackDirPath(messageId, roomId);
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".ack"))
    .map((entry) => entry.replace(/\.ack$/, ""))
    .sort();
}

function janitorMessages(roomId: string) {
  ensureRelayDirs(roomId);
  const { messagesDir } = roomRelayPaths(roomId);
  const now = Date.now();
  for (const entry of readdirSync(messagesDir)) {
    if (!entry.endsWith(".json")) continue;

    const fullPath = join(messagesDir, entry);
    try {
      const envelope = JSON.parse(readFileSync(fullPath, "utf-8")) as RelayEnvelope;
      const ackedRecipients = readAckedRecipients(envelope.id, roomId);
      if (!shouldDeleteEnvelope(envelope, ackedRecipients, now, MESSAGE_TTL_MS)) {
        continue;
      }

      unlinkSync(fullPath);
      try {
        rmSync(ackDirPath(envelope.id, roomId), { recursive: true, force: true });
      } catch {}
    } catch (err: any) {
      log(`Failed to janitor relay message ${entry}: ${err.message}`);
    }
  }
}

// Phase 4D-2: activate relay participation for a non-default room (synchronous priming).
// Called when the first coordinator attaches to a previously inactive non-default room.
function activateRelayRoom(roomId: string) {
  cancelPendingRoomDeactivation(roomId);
  if (relayActiveRooms.has(roomId)) return;
  relayActiveRooms.add(roomId);
  ensureRelayDirs(roomId);
  writeHeartbeat(roomId);
  refreshPeers(roomId);
  pollMessages(roomId);
  janitorMessages(roomId);
  log(`Phase4D2: relay activated for room='${roomId}'`);
}

function cancelPendingRoomDeactivation(roomId: string) {
  const timer = pendingRoomDeactivationTimers.get(roomId);
  if (!timer) return;
  clearTimeout(timer);
  pendingRoomDeactivationTimers.delete(roomId);
}

function scheduleRelayRoomDeactivation(roomId: string) {
  if (roomId === ROOM) return;
  if (!relayActiveRooms.has(roomId)) return;
  if (pendingRoomDeactivationTimers.has(roomId)) return;

  const timer = setTimeout(() => {
    pendingRoomDeactivationTimers.delete(roomId);
    const room = rooms.get(roomId);
    if (room && room.coordinators.size > 0) {
      log(`Phase4D2: relay deactivation skipped for room='${roomId}' because a coordinator reattached`);
      return;
    }
    deactivateRelayRoom(roomId);
  }, ROOM_DEACTIVATE_GRACE_MS);

  pendingRoomDeactivationTimers.set(roomId, timer);
  log(`Phase4D2: scheduled relay deactivation for room='${roomId}' in ${ROOM_DEACTIVATE_GRACE_MS}ms`);
}


// Phase 4D-2: deactivate relay participation for a non-default room.
// Called when the last coordinator leaves a non-default room.
// ROOM (startup room) is never deactivated.
function deactivateRelayRoom(roomId: string) {
  cancelPendingRoomDeactivation(roomId);
  if (roomId === ROOM || !relayActiveRooms.has(roomId)) return;
  relayActiveRooms.delete(roomId);
  roomKnownPeers.delete(roomId);
  try {
    unlinkSync(peerHeartbeatPath(ENDPOINT, roomId));
  } catch {}
  log(`Phase4D2: relay deactivated for room='${roomId}'`);
}

function startRelayLoops() {
  writeHeartbeat(ROOM);
  refreshPeers(ROOM);
  pollMessages(ROOM);
  janitorMessages(ROOM);

  heartbeatTimer = setInterval(() => {
    for (const r of relayActiveRooms) { writeHeartbeat(r); refreshPeers(r); }
    checkStalledPeers();
  }, HEARTBEAT_MS);

  pollTimer = setInterval(() => {
    for (const r of relayActiveRooms) { pollMessages(r); janitorMessages(r); }
  }, POLL_INTERVAL_MS);
}

function stopRelayLoops() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const r of relayActiveRooms) {
    try { unlinkSync(peerHeartbeatPath(ENDPOINT, r)); } catch {}
  }
}

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  // Phase 4A: idle if no coordinators in any room (check all rooms + legacy attachedClaude)
  if (attachedClaude) return;
  for (const room of rooms.values()) {
    if (room.coordinators.size > 0) return;
  }

  log(`No coordinator connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    if (attachedClaude) {
      log("Idle shutdown cancelled: coordinator reconnected during grace period");
      return;
    }
    for (const room of rooms.values()) {
      if (room.coordinators.size > 0) {
        log("Idle shutdown cancelled: coordinator reconnected during grace period");
        return;
      }
    }
    shutdown("idle — no coordinator connected");
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

function writePidFile() {
  writeFileSync(PID_FILE, `${process.pid}\n`, "utf-8");
}

function removePidFile() {
  try {
    unlinkSync(PID_FILE);
  } catch {}
}

function bootRelay() {
  log(`Starting cc-bridge daemon for room='${ROOM}' endpoint='${ENDPOINT}'`);
  log(`Control server: ws://127.0.0.1:${CONTROL_PORT}/ws`);
  log(`Relay state dir: ${join(STATE_ROOT, ROOM)}`);

  // Phase 4A: pre-create the default room so it exists even before claude_connect
  getOrCreateRoom(ROOM);

  ensureRelayDirs(ROOM);
  startRelayLoops();
  bootstrapped = true;
  emitToClaude(systemMessage("system_ready", currentReadyMessageForRoom(ROOM)));
  broadcastStatus();
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  for (const waiter of waiters.values()) {
    clearTimeout(waiter.timer);
  }
  waiters.clear();
  for (const timer of bootstrapTimers.values()) {
    clearTimeout(timer);
  }
  bootstrapTimers.clear();
  for (const timer of escalationTimers.values()) {
    clearTimeout(timer);
  }
  escalationTimers.clear();
  while (pendingRoomDeactivationTimers.size > 0) {
    const [roomId, timer] = pendingRoomDeactivationTimers.entries().next().value;
    clearTimeout(timer);
    pendingRoomDeactivationTimers.delete(roomId);
  }
  for (const { proc } of spawnedProcesses.values()) {
    try { proc.kill(); } catch {}
  }
  spawnedProcesses.clear();
  // Phase 4A: cancel all active task timeout timers across all rooms
  for (const room of rooms.values()) {
    for (const task of room.activeTasks.values()) {
      if (task.timeoutTimer !== null) clearTimeout(task.timeoutTimer);
    }
    room.activeTasks.clear();
  }
  rooms.clear();
  stopRelayLoops();
  controlServer?.stop();
  controlServer = null;
  removePidFile();
  process.exit(0);
}

function sanitizeName(raw: string): string {
  const trimmed = raw.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "default";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  stopRelayLoops();
  removePidFile();
});
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
  process.exit(1);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [cc-bridge] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}

writePidFile();
startControlServer();
bootRelay();
