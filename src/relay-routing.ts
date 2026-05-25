import type { RelayEnvelope, RelayRoute } from "./types";

interface BuildRelayEnvelopeInput {
  room: string;
  senderId: string;
  content: string;
  onlinePeers: string[];
  to?: string[];
  timestamp?: number;
  id?: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function getRoute(to?: string[]): RelayRoute {
  if (!to || to.length === 0) {
    return { mode: "broadcast" };
  }

  if (to.length === 1) {
    return { mode: "direct", to };
  }

  return { mode: "multicast", to };
}

export function buildRelayEnvelope(input: BuildRelayEnvelopeInput): RelayEnvelope {
  const timestamp = input.timestamp ?? Date.now();
  const route = getRoute(input.to);
  const onlinePeers = unique(input.onlinePeers);
  const targets = input.to && input.to.length > 0 ? unique(input.to) : onlinePeers;
  const resolvedRecipients = targets.filter((peer) => peer !== input.senderId && onlinePeers.includes(peer));

  return {
    id: input.id ?? `${timestamp}_${Math.random().toString(36).slice(2, 10)}`,
    room: input.room,
    senderId: input.senderId,
    sender: input.senderId,
    senderKind: "cc",
    content: input.content,
    timestamp,
    route,
    resolvedRecipients,
  };
}

export function getEnvelopeSenderId(envelope: RelayEnvelope): string | undefined {
  return envelope.senderId ?? envelope.sender;
}

export function getResolvedRecipients(
  envelope: RelayEnvelope,
  onlinePeers: string[],
  _endpoint: string,
): string[] {
  if (Array.isArray(envelope.resolvedRecipients)) {
    return unique(envelope.resolvedRecipients);
  }

  const senderId = getEnvelopeSenderId(envelope);
  return unique(onlinePeers).filter((peer) => peer !== senderId);
}

export function shouldDeliverEnvelopeToEndpoint(
  envelope: RelayEnvelope,
  room: string,
  endpoint: string,
): boolean {
  if (envelope.room !== room) {
    return false;
  }

  const senderId = getEnvelopeSenderId(envelope);
  if (senderId === endpoint) {
    return false;
  }

  if (Array.isArray(envelope.resolvedRecipients) && envelope.resolvedRecipients.length > 0) {
    return envelope.resolvedRecipients.includes(endpoint);
  }

  // Empty resolvedRecipients with broadcast mode → deliver to all (except sender)
  return true;
}

export function shouldDeleteEnvelope(
  envelope: RelayEnvelope,
  ackedRecipients: string[],
  now: number,
  ttlMs: number,
): boolean {
  const age = now - envelope.timestamp;
  if (!Array.isArray(envelope.resolvedRecipients)) {
    return age > ttlMs;
  }

  if (envelope.resolvedRecipients.length === 0) {
    // Empty resolvedRecipients = broadcast with no known peers at send time.
    // Fall through to TTL-based deletion instead of immediate delete.
    return age > ttlMs;
  }

  const acked = new Set(ackedRecipients);
  const everyoneAcked = envelope.resolvedRecipients.every((recipient) => acked.has(recipient));
  return everyoneAcked || age > ttlMs;
}
