export type EndpointId = string;
export type Role = string; // e.g., 'Coordinator', 'Planner'
export type LifecycleStatus = 'launching' | 'connected' | 'bootstrapped' | 'idle' | 'busy' | 'stalled' | 'terminated';

export interface PeerMetadata {
  endpoint: EndpointId;
  role?: Role;
  model?: string;
  workdir?: string;
  coordinator?: EndpointId;
  started_at: number;
  last_heartbeat: number; // Will be initialized to started_at during registration
  status: LifecycleStatus;
  bootstrap_state?: 'pending' | 'acked' | 'timeout' | 'failed';
}

export interface ErrorReceiptPayload {
  code: 'MISSING_FIELD' | 'INVALID_FORMAT' | 'ROLE_NOT_FOUND' | 'ROLE_AMBIGUOUS' | 'BOOTSTRAP_TIMEOUT' | 'BOOTSTRAP_DUPLICATE_ACK' | 'WORKDIR_INVALID' | 'ENDPOINT_NOT_FOUND' | 'SPAWN_FAILED' | 'TERMINATE_FAILED' | 'SUPERVISOR_ALREADY_ATTACHED' | 'SUPERVISOR_ATTACH_FORBIDDEN' | 'TASK_TARGET_NOT_FOUND' | 'TASK_ASSIGN_FORBIDDEN' | 'TASK_ID_CONFLICT' | 'SUPERVISOR_PARTITION_CONFLICT' | 'COORDINATOR_ALREADY_HAS_PARTITION' | 'BIND_NOT_AUTHORIZED' | 'BIND_TARGET_NOT_FOUND' | 'TASK_NOT_IN_PARTITION' | 'PEER_TERMINATED' | 'COORDINATOR_OFFLINE';
  message: string;
  details?: Record<string, unknown>;
}

export interface MessageEnvelope {
  protocol_version: '1.0';
  message_id: string;
  correlation_id?: string;
  task_id?: string;
  from: EndpointId;
  from_role?: Role;
  intended_to?: string[];
  resolved_endpoints?: EndpointId[];
  sent_at: number;
  kind: 'control' | 'work' | 'error';
  intent: string;
  payload: unknown;
}

export interface ErrorEnvelope extends MessageEnvelope {
  kind: 'error';
  payload: ErrorReceiptPayload;
}

export interface LifecycleAckPayload {
  endpoint: EndpointId;
  status: LifecycleStatus;
  observed_at: number;
  previous_status?: LifecycleStatus;
  correlation_id?: string;
}

// Phase 1: Launch contract

export interface LaunchRequest {
  role: string;
  model?: string;
  workdir?: string;
  coordinator: EndpointId;
  bootstrap_message?: string;
}

export interface LaunchResult {
  success: boolean;
  endpoint?: EndpointId;
  peer?: PeerMetadata;
  pid?: number;             // OS pid of spawned process (Phase 2+)
  error?: ErrorReceiptPayload;
}

// Phase 1: only emits 'acked' or 'timeout'.
// Phase 2: 'failed' used when bootstrap did not complete before child process exited.
export interface BootstrapAck {
  endpoint: EndpointId;
  role: string;
  status: 'acked' | 'timeout';
  observed_at: number;
  correlation_id?: string;
}

// Phase 2: Process lifecycle

export interface TerminatePeerRequest {
  endpoint: EndpointId;
  signal?: 'SIGTERM' | 'SIGKILL'; // default: SIGTERM
  reason?: string;                 // logged only, not transmitted to peer
}

export interface TerminatePeerResult {
  success: boolean;
  endpoint: EndpointId;
  error?: ErrorReceiptPayload;
}

/** Emitted to coordinator when a spawned child process exits. */
export interface SpawnExitObservable {
  endpoint: EndpointId;
  role: string;
  pid: number;
  exit_code: number | null;
  signal: string | null;
  observed_at: number;
}

/**
 * Phase 4C-3: Per-peer snapshot entry — PeerMetadata enriched with query-time
 * load stats. Computed at handleQueryRegistry time; NOT stored in peerRegistry.
 * Phase 5A: room is derived at query-time from endpointToRoom (not stored in PeerMetadata).
 */
export interface PeerSnapshotEntry extends PeerMetadata {
  active_task_count: number; // tasks currently in-flight across all rooms for this endpoint
  room?: string;             // Phase 5A: room this endpoint registered from (undefined if not yet registered via relay)
}

export interface RegistrySnapshot {
  peers: PeerSnapshotEntry[];
}

// Phase 3B: Task/Trigger Orchestration Primitives

/**
 * Task assignment sent from coordinator → daemon → worker.
 * task_id must be unique among in-flight tasks (TASK_ID_CONFLICT if duplicate).
 * role is optional metadata only — daemon does NOT validate endpoint/role match.
 * timeout_ms fires LoopEvent{state:'timeout'} asynchronously; NOT part of assign_task_result.
 */
export interface TaskAssignment {
  task_id: string;
  assigned_to: EndpointId;
  role?: string;
  payload: unknown;
  timeout_ms?: number;
}

/**
 * Immediate control-plane result of assign_task.
 * success=true means daemon successfully relayed the assignment to the worker.
 * It does NOT mean the task is complete or even started.
 */
export interface TaskAssignmentResult {
  success: boolean;
  task_id: string;
  error?: ErrorReceiptPayload;
}

/** Loop execution states emitted by worker (or daemon on timeout). */
export type LoopState = 'running' | 'completed' | 'timeout' | 'failed';

/**
 * Observable emitted by a worker (or by daemon on timeout) for each loop state transition.
 * loop_id: worker-generated at execution start; absent in daemon-generated timeout/cleanup events.
 * task_id: required — primary correlation handle to TaskAssignment.
 */
export interface LoopEvent {
  loop_id?: string;
  task_id: string;
  endpoint: EndpointId;
  state: LoopState;
  observed_at: number;
  details?: Record<string, unknown>;
}

// Phase 4B: Room-level system events broadcast to all coordinators in a room.
export interface RoomEvent {
  type: 'room_event';
  event: 'partition_released' | 'worker_orphaned' | 'coordinator_joined' | 'coordinator_left';
  room: string;
  endpoint?: EndpointId;       // affected worker (for worker_orphaned)
  partition_id?: string;       // affected partition (for partition_released)
  observed_at: number;
}
