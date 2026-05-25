import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RelayEnvelope } from "./types";

export interface LaunchPeerTarget {
  endpoint: string;
  role?: string;
  profile?: string;
  workdir?: string;
  bootstrap_message?: string;
  target_room?: string; // Phase 5C: override the room the peer should join
}

export interface LaunchPeersInput {
  peerTargets?: LaunchPeerTarget[];
  targets?: string[];
  count?: number;
  startFrom?: string;
  profiles?: Record<string, string>;
  workdir?: string;
  initialPrompt?: string;
  initialPrompts?: Record<string, string>;
}

export interface LaunchPeersResult {
  success: boolean;
  launched: string[];
  failed: Record<string, string>;
  note?: string;
}

export function launchPeers(input: LaunchPeersInput): LaunchPeersResult {
  const peerTargets = resolvePeerTargets(input);
  if (peerTargets.length === 0) {
    return {
      success: false,
      launched: [],
      failed: {},
      note: "Provide either peerTargets, a non-empty targets array, or a count >= 1.",
    };
  }

  const template = process.env.CC_BRIDGE_LAUNCH_TEMPLATE?.trim();
  if (!template) {
    return {
      success: false,
      launched: [],
      failed: Object.fromEntries(
        peerTargets.map((target) => [target.endpoint, "CC_BRIDGE_LAUNCH_TEMPLATE is not configured."]),
      ),
      note:
        "Set CC_BRIDGE_LAUNCH_TEMPLATE to a shell command template, for example one that uses ccswitch and opens a new terminal window.",
    };
  }

  const bridgeRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const normalizedTemplate = normalizeTemplate(template, bridgeRoot);
  const launched: string[] = [];
  const failed: Record<string, string> = {};
  const room = sanitizeName(process.env.CC_BRIDGE_ROOM ?? "default");
  const senderId = sanitizeName(process.env.CC_BRIDGE_ENDPOINT ?? "A");
  const stateRoot = process.env.CC_BRIDGE_STATE_DIR ?? "/tmp/cc-bridge";

  for (const target of peerTargets) {
    const endpoint = target.endpoint;
    const instance = resolveInstanceForEndpoint(endpoint);
    const profile = target.profile ?? process.env.CC_BRIDGE_DEFAULT_PROFILE ?? "claude_api";
    const workdir = target.workdir ?? process.env.CC_BRIDGE_WORKDIR ?? bridgeRoot;
    const initialPrompt = target.bootstrapMessage ?? "";
    const promptB64 = initialPrompt ? Buffer.from(initialPrompt, "utf8").toString("base64") : "";
    const targetRoom = sanitizeName(target.targetRoom ?? room);
    const command = renderTemplate(normalizedTemplate, {
      endpoint,
      instance,
      profile,
      workdir,
      rootdir: bridgeRoot,
      prompt_b64: promptB64,
      server: `cc-bridge-${instance}`,
      target_room: targetRoom,
    });

    try {
      const child = spawnSync("/bin/zsh", ["-lc", command], {
        cwd: workdir,
        env: { ...process.env },
        encoding: "utf8",
        timeout: 45000,
      });

      if (child.error) {
        failed[endpoint] = child.error.message;
        continue;
      }

      if ((child.status ?? 0) !== 0) {
        const stderr = (child.stderr || "").trim();
        const stdout = (child.stdout || "").trim();
        failed[endpoint] = stderr || stdout || `Launcher exited with status ${child.status}`;
        continue;
      }

      launched.push(endpoint);

      if (initialPrompt.trim().length > 0) {
        enqueueBootstrapMessage({
          stateRoot,
          room: targetRoom,
          senderId,
          endpoint,
          content: initialPrompt,
        });
      }
    } catch (err: any) {
      failed[endpoint] = err?.message ?? "Failed to execute launcher command";
    }
  }

  return {
    success: launched.length > 0 && Object.keys(failed).length === 0,
    launched,
    failed,
    note:
      "launch_peers only starts peer windows. You still need those windows to use their matching cc-bridge-N MCP tools after they open.",
  };
}

function resolvePeerTargets(input: LaunchPeersInput): Array<{
  endpoint: string;
  profile?: string;
  workdir?: string;
  bootstrapMessage?: string;
  targetRoom?: string;
}> {
  if (Array.isArray(input.peerTargets) && input.peerTargets.length > 0) {
    const deduped = new Map<string, { endpoint: string; profile?: string; workdir?: string; bootstrapMessage?: string; targetRoom?: string }>();
    for (const rawTarget of input.peerTargets) {
      if (!rawTarget || typeof rawTarget !== "object") continue;
      const endpoint = normalizeEndpoint(rawTarget.endpoint);
      deduped.set(endpoint, {
        endpoint,
        profile: rawTarget.profile?.trim() || undefined,
        workdir: rawTarget.workdir?.trim() || input.workdir?.trim() || undefined,
        bootstrapMessage: rawTarget.bootstrap_message?.trim() || undefined,
        targetRoom: rawTarget.target_room?.trim() ? sanitizeName(rawTarget.target_room.trim()) : undefined,
      });
    }
    return [...deduped.values()];
  }

  const targets = resolveTargets(input);
  const defaultWorkdir = input.workdir?.trim() || undefined;
  return targets.map((endpoint) => ({
    endpoint,
    profile: input.profiles?.[endpoint]?.trim() || undefined,
    workdir: defaultWorkdir,
    bootstrapMessage:
      input.initialPrompts?.[endpoint]?.trim() || input.initialPrompt?.trim() || undefined,
  }));
}

function resolveTargets(input: LaunchPeersInput): string[] {
  if (Array.isArray(input.targets) && input.targets.length > 0) {
    return [...new Set(input.targets.map((value) => normalizeEndpoint(value)).filter(Boolean))];
  }

  const count = Math.max(0, Math.trunc(input.count ?? 0));
  if (count === 0) {
    return [];
  }

  const startFrom = normalizeEndpoint(input.startFrom ?? "B");
  const startIndex = endpointLabelToIndex(startFrom);
  return Array.from({ length: count }, (_, offset) => endpointIndexToLabel(startIndex + offset));
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

function normalizeTemplate(template: string, bridgeRoot: string): string {
  const fixed = template.replace("{workdir}/scripts/launch-claude-peer.sh", `${bridgeRoot}/scripts/launch-claude-peer.sh`);
  if (fixed.includes("{prompt_b64}")) {
    return fixed;
  }
  return `${fixed} {prompt_b64}`;
}

function enqueueBootstrapMessage(input: {
  stateRoot: string;
  room: string;
  senderId: string;
  endpoint: string;
  content: string;
}) {
  const roomDir = join(input.stateRoot, input.room);
  const messagesDir = join(roomDir, "messages");
  mkdirSync(messagesDir, { recursive: true });

  const timestamp = Date.now();
  const envelope: RelayEnvelope = {
    id: `bootstrap_${timestamp}_${Math.random().toString(36).slice(2, 10)}`,
    room: input.room,
    senderId: input.senderId,
    sender: input.senderId,
    senderKind: "cc",
    content: input.content,
    timestamp,
    route: { mode: "direct", to: [input.endpoint] },
    resolvedRecipients: [input.endpoint],
  };

  writeFileSync(join(messagesDir, `${envelope.id}.json`), JSON.stringify(envelope), "utf-8");
}

function sanitizeName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, "_") || "default";
}

function resolveInstanceForEndpoint(endpoint: string): string {
  const explicit = parseEndpointMap(process.env.CC_BRIDGE_ENDPOINT_INSTANCE_MAP)[endpoint];
  if (explicit) {
    return explicit;
  }

  if (/^[A-Z]$/.test(endpoint)) {
    return String(endpoint.charCodeAt(0) - 64);
  }

  return endpoint;
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]+$/.test(trimmed) ? trimmed : "B";
}

function endpointLabelToIndex(label: string): number {
  let index = 0;
  for (const ch of label) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return Math.max(1, index);
}

function endpointIndexToLabel(index: number): string {
  let value = Math.max(1, index);
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function parseEndpointMap(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }

  return Object.fromEntries(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((pair) => {
        const [endpoint, instance] = pair.split(":").map((v) => v.trim());
        return [endpoint, instance];
      })
      .filter(([endpoint, instance]) => endpoint && instance),
  );
}
