# Bug: Relay messages lost when no coordinator connected

**Date**: 2026-03-29
**Severity**: High
**Status**: Fixed (deferred ACK in daemon.ts, verified 2026-03-29)

## Symptom

Peer B sends a message to peer A via the file relay. A's daemon reads and ACKs the relay message file, but if no coordinator (bridge frontend / CLI) is connected to A's daemon at that moment, the message is silently dropped. When a coordinator later connects, the message is gone from both relay (already ACK'd/deleted) and daemon memory (never queued).

## Reproduction

1. Start A daemon (standalone, no bridge frontend)
2. Start B daemon + bridge, have B send a message to A
3. Wait 5+ seconds, then connect A's CLI with `get-messages`
4. Result: `(no new messages)` — message lost

## Root Cause

In the relay scanner loop (`daemon.ts`), incoming relay messages are:

1. Read from `/tmp/cc-bridge/<room>/messages/*.json`
2. Immediately forwarded to the connected coordinator via WebSocket
3. ACK'd (written to `/tmp/cc-bridge/<room>/acks/`) and eventually deleted

**Step 2 fails silently if no coordinator is connected.** The message is still ACK'd in step 3, so it is permanently removed from the relay. The daemon does not maintain an in-memory delivery queue for messages that could not be forwarded.

## Expected Behavior

Messages read from the relay should be **queued in daemon memory** until successfully delivered to a coordinator. ACK should only happen after confirmed delivery, or the daemon should maintain a persistent undelivered queue.

## Proposed Fix

Option A — **Defer ACK until delivery**:
- Do not write ACK for a message until it has been forwarded to a connected coordinator
- Risk: relay message files accumulate if daemon stays coordinator-less for a long time; TTL GC will eventually clean them, which is acceptable

Option B — **In-memory delivery queue**:
- When no coordinator is connected, push incoming relay messages to an in-memory queue
- On coordinator connect, flush the queue before entering normal forwarding mode
- ACK relay messages immediately (current behavior), but retain a copy in the queue
- Risk: messages lost if daemon restarts before delivery (acceptable for local-only system)

**Recommendation**: Option A is simpler and more robust. Option B can supplement for lower latency.

## Actual Fix (by B/gpt-5.4)

Implemented Option A in `src/daemon.ts`:

- Added `getConnectedCoordinator(roomId)` — checks for an open coordinator WebSocket
- Added `forwardRelayMessageToCoordinator(roomId, message)` — attempts delivery, returns boolean
- `pollMessages()` line 1964: if `forwardRelayMessageToCoordinator` returns `false`, `continue` (skip ACK)
- ACK (`writeAck`) only runs after confirmed delivery (line 1968)
- Undelivered relay files stay on disk and are retried on the next poll cycle (700ms)

**Verification**: 190/190 tests pass. Manual round-trip test confirmed: message sent while A had no coordinator was retained in relay, then delivered when A reconnected.

## Workaround

Keep a coordinator connected **before** messages arrive:

```bash
# Long-polling wait — keeps coordinator WebSocket open
CC_BRIDGE_ENDPOINT=A AGENTBRIDGE_CONTROL_PORT=4512 \
  bun run scripts/cc-bridge-cli.ts wait-for-messages 120
```

Do **not** rely on short-lived `get-messages` calls (connects for ~3s then disconnects) to pick up messages that may have arrived while disconnected.
