#!/usr/bin/env bun
/**
 * cc-bridge CLI — direct WebSocket client for peer sessions using shell commands.
 * Usage:
 *   cc-bridge get-messages              # check for new messages (waits 3s)
 *   cc-bridge wait-for-messages [N]     # wait up to N seconds (default 30)
 *   cc-bridge reply "message text"      # send a message to all peers
 *   cc-bridge status                    # show daemon health
 *
 * Environment:
 *   CC_BRIDGE_ENDPOINT     - This instance's endpoint (e.g. "B")
 *   AGENTBRIDGE_CONTROL_PORT - Daemon WebSocket port (e.g. 4522)
 *   CC_BRIDGE_ROOM         - Room name (default: "default")
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const endpoint = process.env.CC_BRIDGE_ENDPOINT ?? "B";
const port = Number(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4522");
const room = process.env.CC_BRIDGE_ROOM ?? "default";
const cmd = process.argv[2] ?? "get-messages";
const stateDir = process.env.CC_BRIDGE_STATE_DIR ?? "/tmp/cc-bridge";
const cliStatePath = join(stateDir, room, `.cc-bridge-cli-${endpoint}.json`);

function readCliState(): { lastSender?: string } {
  try {
    return JSON.parse(readFileSync(cliStatePath, "utf-8")) as { lastSender?: string };
  } catch {
    return {};
  }
}

function writeCliState(state: { lastSender?: string }) {
  try {
    writeFileSync(cliStatePath, JSON.stringify(state), "utf-8");
  } catch {
    // best effort only
  }
}

function extractSender(msg: any): string {
  return msg.message?.sender ?? msg.message?.senderId ?? "?";
}

function rememberSender(sender: string) {
  if (sender && sender !== "?" && sender !== endpoint) {
    writeCliState({ lastSender: sender });
  }
}

async function main() {
  if (cmd === "status") {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    const d = await r.json();
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  // Connect WebSocket
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => reject(new Error("connect timeout")), 5000);
    w.onopen = () => { clearTimeout(t); resolve(w); };
    w.onerror = () => { clearTimeout(t); reject(new Error(`Cannot connect to daemon at port ${port}`)); };
  });

  // Register as coordinator
  ws.send(JSON.stringify({ type: "claude_connect", room, endpoint }));
  await new Promise(r => setTimeout(r, 300));

  if (cmd === "reply" || cmd === "send") {
    const content = process.argv.slice(3).join(" ");
    if (!content) {
      console.error("Usage: cc-bridge reply <message text>");
      ws.close();
      process.exit(1);
    }

    const state = readCliState();
    const to = state.lastSender && state.lastSender !== endpoint ? [state.lastSender] : undefined;
    const reqId = `cli_reply_${Date.now()}`;
    const result = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("send timeout")), 10000);
      ws.addEventListener("message", function handler(ev) {
        const msg = JSON.parse(ev.data as string);
        if (msg.requestId === reqId) {
          clearTimeout(t);
          ws.removeEventListener("message", handler);
          resolve(msg);
        }
      });
      ws.send(JSON.stringify({
        type: "post_message",
        requestId: reqId,
        message: { source: "claude", content },
        ...(to ? { to } : {}),
      }));
    });
    if (result.success) {
      const recipients = result.resolvedRecipients ?? [];
      console.log(`✓ Sent to: ${recipients.length > 0 ? recipients.join(", ") : "(none)"}`);
    } else {
      console.error("Send failed:", result.error);
      ws.close();
      process.exit(1);
    }

  } else if (cmd === "get-messages" || cmd === "get_messages") {
    // Use daemon pull_messages protocol to drain pendingPullMessages queue,
    // PLUS listen for push messages that arrive during the window.
    const reqId = `cli_pull_${Date.now()}`;
    const messages: string[] = [];

    // Listen for both pull_messages_result AND push (codex_to_claude) messages
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "pull_messages_result" && msg.requestId === reqId) {
        for (const m of msg.messages ?? []) {
          if (m.content) {
            const from = m.senderId ?? m.sender ?? "unknown";
            rememberSender(from);
            messages.push(`[From ${from}]: ${m.content}`);
          }
        }
      } else if (msg.type === "codex_to_claude" && msg.message?.content) {
        const from = extractSender(msg);
        rememberSender(from);
        messages.push(`[From ${from}]: ${msg.message.content}`);
      }
    });

    // Send pull request to drain queued messages
    ws.send(JSON.stringify({ type: "pull_messages", requestId: reqId }));
    // Also wait briefly for any push messages arriving via relay poll
    await new Promise(r => setTimeout(r, 3000));
    if (messages.length > 0) {
      // Deduplicate by content (pull and push may deliver the same message)
      const seen = new Set<string>();
      for (const m of messages) {
        if (!seen.has(m)) { seen.add(m); console.log(m); }
      }
    } else {
      console.log("(no new messages)");
    }

  } else if (cmd === "wait-for-messages" || cmd === "wait_for_messages") {
    const timeoutSec = parseInt(process.argv[3] ?? "30");
    let gotMessage = false;
    const reqId = `cli_wait_${Date.now()}`;
    const printed = new Set<string>();

    function printMessage(content: string, from: string) {
      const line = `[From ${from}]: ${content}`;
      if (printed.has(line)) return; // deduplicate push + pull
      printed.add(line);
      console.log(line);
      gotMessage = true;
    }

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), timeoutSec * 1000);

      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data as string);
        // Handle daemon wait_for_messages_result (pull path)
        if (msg.type === "wait_for_messages_result" && msg.requestId === reqId) {
          for (const m of msg.messages ?? []) {
            if (m.content) {
              const from = m.senderId ?? m.sender ?? "unknown";
              rememberSender(from);
              printMessage(m.content, from);
            }
          }
          // Re-issue wait request to keep listening (daemon fulfills once per request)
          ws.send(JSON.stringify({
            type: "wait_for_messages",
            requestId: `${reqId}_${Date.now()}`,
            timeoutMs: Math.max(1000, (timeoutSec * 1000) - (Date.now() % (timeoutSec * 1000))),
          }));
        }
        // Also handle push messages (codex_to_claude)
        if (msg.type === "codex_to_claude" && msg.message?.content) {
          const from = extractSender(msg);
          rememberSender(from);
          printMessage(msg.message.content, from);
        }
      });

      // Issue initial wait_for_messages to daemon — drains pendingPullMessages or waits
      ws.send(JSON.stringify({
        type: "wait_for_messages",
        requestId: reqId,
        timeoutMs: timeoutSec * 1000,
      }));
    });
    if (!gotMessage) console.log("(timeout — no messages received)");

  } else {
    console.error(`Unknown command: ${cmd}`);
    console.error("Commands: get-messages, wait-for-messages [N], reply <text>, status");
    ws.close();
    process.exit(1);
  }

  ws.close();
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
