import { describe, expect, test } from "bun:test";
import { CLAUDE_INSTRUCTIONS } from "./claude-adapter";
import { BRIDGE_CONTRACT_REMINDER } from "./message-filter";

describe("role-aware collaboration guidance", () => {
  test("claude instructions include role keywords and thinking patterns", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("Local Claude: reviewer / coordinator / challenger");
    expect(CLAUDE_INSTRUCTIONS).toContain("Peer Claude: independent engineer / implementer / verifier");
    expect(CLAUDE_INSTRUCTIONS).toContain("Independent Analysis & Convergence");
    expect(CLAUDE_INSTRUCTIONS).toContain("Architect -> Builder -> Critic");
    expect(CLAUDE_INSTRUCTIONS).toContain("Hypothesis -> Experiment -> Interpretation");
    expect(CLAUDE_INSTRUCTIONS).toContain("My independent view is:");
    expect(CLAUDE_INSTRUCTIONS).toContain("I agree on:");
    expect(CLAUDE_INSTRUCTIONS).toContain("I disagree on:");
    expect(CLAUDE_INSTRUCTIONS).toContain("Current consensus:");
  });

  test("claude instructions include turn coordination guidance", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("wait for your peer's response before changing direction");
    expect(CLAUDE_INSTRUCTIONS).toContain("attention window");
    expect(CLAUDE_INSTRUCTIONS).toContain("busy error");
  });

  test("bridge contract reminder includes codex role guidance", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Your default role: Implementer, Executor, Verifier");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Independent Analysis & Convergence");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Architect -> Builder -> Critic");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Hypothesis -> Experiment -> Interpretation");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Do not blindly follow Claude");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("My independent view is:");
  });

  test("bridge contract reminder specifies marker must be at start", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("at the very start");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("MUST be the first text");
  });

  test("bridge contract reminder forbids git write operations", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Git Operations — FORBIDDEN");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("MUST NOT execute any git write commands");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("hang indefinitely");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("delegated to Claude Code");
  });
});
