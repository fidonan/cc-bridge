#!/usr/bin/env bun
/**
 * Test peer child process for Phase 2 integration tests.
 *
 * Reads spawn config from env vars, connects to the coordinator's control
 * WebSocket, and executes a scenario determined by CC_BRIDGE_TEST_SCENARIO:
 *
 *   "register_and_ack"   — register + bootstrap_ack, then idle until killed
 *   "register_only"      — register but never send bootstrap_ack (timeout test)
 *   "crash_after_register" — register then exit immediately (no ack)
 *   "exit_clean"         — register + ack + exit cleanly after short delay
 */

const COORDINATOR_PORT = process.env.CC_BRIDGE_COORDINATOR_PORT ?? "";
const ENDPOINT = process.env.CC_BRIDGE_ENDPOINT ?? "";
const ROLE = process.env.CC_BRIDGE_ROLE ?? "TestPeer";
// Scenario is passed via CC_BRIDGE_BOOTSTRAP_MESSAGE or CC_BRIDGE_TEST_SCENARIO
const SCENARIO = process.env.CC_BRIDGE_BOOTSTRAP_MESSAGE ?? process.env.CC_BRIDGE_TEST_SCENARIO ?? "register_and_ack";

if (!COORDINATOR_PORT || !ENDPOINT) {
  process.stderr.write("test-peer-child: missing CC_BRIDGE_COORDINATOR_PORT or CC_BRIDGE_ENDPOINT\n");
  process.exit(1);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

let msgCounter = 0;
function makeEnvelope(kind: "control" | "work", intent: string, payload: unknown = {}) {
  return {
    protocol_version: "1.0",
    message_id: `child_${++msgCounter}_${Date.now()}`,
    from: ENDPOINT,
    sent_at: Date.now(),
    kind,
    intent,
    payload,
  };
}

// Phase 4C-1: received task assignments via direct worker-WS delivery.
// Populated by ws.onmessage handler; exported for test assertions via env/IPC.
const receivedTaskAssignments: unknown[] = [];

async function run() {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${COORDINATOR_PORT}/ws`);

    // Phase 4C-1: receive direct relay deliveries from daemon.
    // Daemon sends codex_to_claude with BridgeMessage.content = JSON relay envelope.
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "codex_to_claude") {
          try {
            const envelope = JSON.parse(msg.message?.content ?? "{}");
            if (envelope.intent === "task_assignment") {
              receivedTaskAssignments.push(envelope.payload);
            }
          } catch {}
        }
      } catch {}
    };

    ws.onopen = async () => {
      // Do NOT send claude_connect — coordinator's test client is the attached client.
      // Phase 4C-1: declare worker socket binding BEFORE register so daemon can accept it.
      // worker_connect requires endpoint already in peerRegistry (launching state from launch_peer).
      await sleep(50);
      ws.send(JSON.stringify({ type: "worker_connect", requestId: `wc_${Date.now()}`, endpoint: ENDPOINT }));
      await sleep(50);

      // Register with the coordinator using the pre-allocated endpoint
      ws.send(JSON.stringify({
        type: "post_envelope",
        requestId: `reg_${Date.now()}`,
        envelope: makeEnvelope("control", "register", { endpoint: ENDPOINT, role: ROLE, started_at: Date.now() }),
      }));
      await sleep(200);

      if (SCENARIO === "crash_after_register") {
        // Exit without sending bootstrap_ack
        process.exit(1);
      }

      if (SCENARIO === "register_only") {
        // Stay alive but never ack — wait to be killed or timeout
        await sleep(120000);
        process.exit(0);
      }

      // Send bootstrap_ack
      ws.send(JSON.stringify({
        type: "post_envelope",
        requestId: `ack_${Date.now()}`,
        envelope: makeEnvelope("control", "bootstrap_ack", {}),
      }));

      if (SCENARIO === "exit_clean") {
        await sleep(300);
        process.exit(0);
      }

      // "register_and_ack": stay alive until killed
      await sleep(120000);
      process.exit(0);
    };

    ws.onerror = (e) => {
      process.stderr.write(`test-peer-child WS error: ${e}\n`);
      reject(e);
    };
  });
}

run().catch((e) => {
  process.stderr.write(`test-peer-child error: ${e}\n`);
  process.exit(1);
});
