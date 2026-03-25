const DEFAULT_BASE_PORT = 4500;
const DEFAULT_PORT_STRIDE = 10;

export interface InstanceConfig {
  instance: string;
  appPort: number;
  proxyPort: number;
  controlPort: number;
  pidFile: string;
  logFile: string;
}

export function getInstanceConfig(env = process.env): InstanceConfig {
  const instance = sanitizeInstance(env.AGENTBRIDGE_INSTANCE ?? "default");
  const stride = parsePositiveInt(env.AGENTBRIDGE_PORT_STRIDE, DEFAULT_PORT_STRIDE);

  const useLegacyDefaults =
    instance === "default" &&
    env.CODEX_WS_PORT === undefined &&
    env.CODEX_PROXY_PORT === undefined &&
    env.AGENTBRIDGE_CONTROL_PORT === undefined;

  const basePort = useLegacyDefaults
    ? DEFAULT_BASE_PORT
    : parsePositiveInt(env.AGENTBRIDGE_BASE_PORT, DEFAULT_BASE_PORT) + getInstanceSlot(instance) * stride;

  const appPort = parsePositiveInt(env.CODEX_WS_PORT, basePort);
  const proxyPort = parsePositiveInt(env.CODEX_PROXY_PORT, basePort + 1);
  const controlPort = parsePositiveInt(env.AGENTBRIDGE_CONTROL_PORT, basePort + 2);
  const pidFile = env.AGENTBRIDGE_PID_FILE ?? defaultPidFile(instance, controlPort);
  const logFile = env.AGENTBRIDGE_LOG_FILE ?? defaultLogFile(instance);

  return {
    instance,
    appPort,
    proxyPort,
    controlPort,
    pidFile,
    logFile,
  };
}

function sanitizeInstance(raw: string): string {
  const trimmed = raw.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "default";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getInstanceSlot(instance: string): number {
  if (instance === "default") return 0;
  if (/^\d+$/.test(instance)) {
    return Number.parseInt(instance, 10);
  }

  let hash = 0;
  for (const ch of instance) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }

  return (hash % 200) + 1;
}

function defaultPidFile(instance: string, controlPort: number): string {
  return instance === "default"
    ? `/tmp/cc-bridge-daemon-${controlPort}.pid`
    : `/tmp/cc-bridge-daemon-${instance}-${controlPort}.pid`;
}

function defaultLogFile(instance: string): string {
  return instance === "default"
    ? "/tmp/cc-bridge.log"
    : `/tmp/cc-bridge-${instance}.log`;
}
