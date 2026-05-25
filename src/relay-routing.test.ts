import { describe, expect, test } from "bun:test";
import {
  buildRelayEnvelope,
  getResolvedRecipients,
  shouldDeliverEnvelopeToEndpoint,
  shouldDeleteEnvelope,
} from "./relay-routing";
import type { RelayEnvelope } from "./types";

describe("buildRelayEnvelope", () => {
  test("broadcast resolves to all online peers except sender", () => {
    const envelope = buildRelayEnvelope({
      room: "default",
      senderId: "A",
      content: "hello",
      onlinePeers: ["A", "B", "C"],
    });

    expect(envelope.route).toEqual({ mode: "broadcast" });
    expect(envelope.resolvedRecipients).toEqual(["B", "C"]);
    expect(envelope.senderId).toBe("A");
  });

  test("targeted send keeps only online recipients and excludes sender", () => {
    const envelope = buildRelayEnvelope({
      room: "default",
      senderId: "B",
      content: "hello",
      onlinePeers: ["A", "B", "C"],
      to: ["B", "C", "D"],
    });

    expect(envelope.route).toEqual({ mode: "multicast", to: ["B", "C", "D"] });
    expect(envelope.resolvedRecipients).toEqual(["C"]);
  });

  test("targeted send preserves requested route so missing recipients can be reported", () => {
    const envelope = buildRelayEnvelope({
      room: "default",
      senderId: "A",
      content: "hello",
      onlinePeers: ["A", "B"],
      to: ["B", "Z"],
    });

    expect(envelope.route).toEqual({ mode: "multicast", to: ["B", "Z"] });
    expect(envelope.resolvedRecipients).toEqual(["B"]);
  });

  test("multiple resolved recipients use multicast route", () => {
    const envelope = buildRelayEnvelope({
      room: "default",
      senderId: "A",
      content: "hello",
      onlinePeers: ["A", "B", "C", "D"],
      to: ["B", "D"],
    });

    expect(envelope.route).toEqual({ mode: "multicast", to: ["B", "D"] });
    expect(envelope.resolvedRecipients).toEqual(["B", "D"]);
  });
});

describe("getResolvedRecipients", () => {
  test("falls back to legacy broadcast semantics when resolvedRecipients are absent", () => {
    const legacyEnvelope = {
      id: "1",
      sender: "A",
      room: "default",
      content: "legacy",
      timestamp: 1,
    } as RelayEnvelope;

    expect(getResolvedRecipients(legacyEnvelope, ["A", "B", "C"], "B")).toEqual(["B", "C"]);
  });
});

describe("shouldDeliverEnvelopeToEndpoint", () => {
  test("delivers new-format envelope only to resolved recipients", () => {
    const envelope: RelayEnvelope = {
      id: "1",
      room: "default",
      senderId: "A",
      content: "hello",
      timestamp: 1,
      route: { mode: "broadcast" },
      resolvedRecipients: ["B"],
    };

    expect(shouldDeliverEnvelopeToEndpoint(envelope, "default", "B")).toBe(true);
    expect(shouldDeliverEnvelopeToEndpoint(envelope, "default", "C")).toBe(false);
  });

  test("legacy envelope is delivered to every non-sender peer in the room", () => {
    const legacyEnvelope = {
      id: "1",
      sender: "A",
      room: "default",
      content: "legacy",
      timestamp: 1,
    } as RelayEnvelope;

    expect(shouldDeliverEnvelopeToEndpoint(legacyEnvelope, "default", "B")).toBe(true);
    expect(shouldDeliverEnvelopeToEndpoint(legacyEnvelope, "default", "A")).toBe(false);
    expect(shouldDeliverEnvelopeToEndpoint(legacyEnvelope, "other", "B")).toBe(false);
  });
});

describe("shouldDeleteEnvelope", () => {
  test("deletes new-format envelope when every recipient acked", () => {
    const envelope: RelayEnvelope = {
      id: "1",
      room: "default",
      senderId: "A",
      content: "hello",
      timestamp: 1,
      route: { mode: "multicast", to: ["B", "C"] },
      resolvedRecipients: ["B", "C"],
    };

    expect(shouldDeleteEnvelope(envelope, ["B", "C"], 1000, 5000)).toBe(true);
  });

  test("keeps new-format envelope when acks are incomplete and ttl not expired", () => {
    const envelope: RelayEnvelope = {
      id: "1",
      room: "default",
      senderId: "A",
      content: "hello",
      timestamp: 900,
      route: { mode: "multicast", to: ["B", "C"] },
      resolvedRecipients: ["B", "C"],
    };

    expect(shouldDeleteEnvelope(envelope, ["B"], 1000, 5000)).toBe(false);
  });

  test("deletes new-format envelope with no resolved recipients", () => {
    const envelope: RelayEnvelope = {
      id: "1",
      room: "default",
      senderId: "A",
      content: "hello",
      timestamp: 900,
      route: { mode: "direct", to: ["Z"] },
      resolvedRecipients: [],
    };

    // Empty resolvedRecipients now uses TTL-based deletion (not immediate)
    expect(shouldDeleteEnvelope(envelope, [], 1000, 5000)).toBe(false);
    // But should delete after TTL expires
    expect(shouldDeleteEnvelope(envelope, [], 6000, 5000)).toBe(true);
  });

  test("deletes legacy envelope only after ttl expires", () => {
    const legacyEnvelope = {
      id: "1",
      sender: "A",
      room: "default",
      content: "legacy",
      timestamp: 100,
    } as RelayEnvelope;

    expect(shouldDeleteEnvelope(legacyEnvelope, [], 1000, 500)).toBe(true);
    expect(shouldDeleteEnvelope(legacyEnvelope, [], 400, 500)).toBe(false);
  });
});
