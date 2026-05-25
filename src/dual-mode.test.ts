import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "./claude-adapter";

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const original = process.env[key];

  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

function createAdapter(envMode?: string): any {
  return withEnv("AGENTBRIDGE_MODE", envMode, () => new ClaudeAdapter() as any);
}

function makeBridgeMessage(content: string, ts?: number) {
  return {
    id: `test_${Date.now()}`,
    source: "codex" as const,
    content,
    timestamp: ts ?? Date.now(),
  };
}

describe("Dual-mode transport: mode resolution", () => {
  test("configuredMode defaults to 'auto' when AGENTBRIDGE_MODE is not set", () => {
    const adapter = createAdapter();
    expect(adapter.configuredMode).toBe("auto");
  });

  test("configuredMode respects AGENTBRIDGE_MODE=push", () => {
    const adapter = createAdapter("push");
    expect(adapter.configuredMode).toBe("push");
  });

  test("configuredMode respects AGENTBRIDGE_MODE=pull", () => {
    const adapter = createAdapter("pull");
    expect(adapter.configuredMode).toBe("pull");
  });

  test("invalid AGENTBRIDGE_MODE falls back to 'auto'", () => {
    const adapter = createAdapter("invalid");
    expect(adapter.configuredMode).toBe("auto");
  });

  test("auto mode resolves to push once initialized", () => {
    const adapter = createAdapter();
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("push");
    expect(adapter.getDeliveryMode()).toBe("push");
  });

  test("resolveMode sets 'push' when configuredMode is 'push'", () => {
    const adapter = createAdapter("push");
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("push");
    expect(adapter.getDeliveryMode()).toBe("push");
  });

  test("resolveMode sets 'pull' when configuredMode is 'pull'", () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("pull");
    expect(adapter.getDeliveryMode()).toBe("pull");
  });
});

describe("Dual-mode transport: pull mode message queue", () => {
  test("queueForPull adds message to pendingMessages", () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const msg = makeBridgeMessage("hello from codex");
    adapter.queueForPull(msg);

    expect(adapter.pendingMessages).toHaveLength(1);
    expect(adapter.pendingMessages[0].content).toBe("hello from codex");
    expect(adapter.getPendingMessageCount()).toBe(1);
  });

  test("queueForPull drops oldest when queue is full", () => {
    const adapter = withEnv("AGENTBRIDGE_MAX_BUFFERED_MESSAGES", "3", () => createAdapter("pull"));
    adapter.resolveMode();

    adapter.queueForPull(makeBridgeMessage("msg1"));
    adapter.queueForPull(makeBridgeMessage("msg2"));
    adapter.queueForPull(makeBridgeMessage("msg3"));
    adapter.queueForPull(makeBridgeMessage("msg4"));

    expect(adapter.pendingMessages).toHaveLength(3);
    expect(adapter.pendingMessages[0].content).toBe("msg2");
    expect(adapter.pendingMessages[2].content).toBe("msg4");
    expect(adapter.droppedMessageCount).toBe(1);
  });

  test("pushNotification queues in pull mode", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    await adapter.pushNotification(makeBridgeMessage("pull msg"));

    expect(adapter.pendingMessages).toHaveLength(1);
    expect(adapter.pendingMessages[0].content).toBe("pull msg");
  });
});

describe("Dual-mode transport: drainMessages (get_messages)", () => {
  test("returns 'no new messages' when queue is empty", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const result = await adapter.drainMessages();
    expect(result.content[0].text).toBe("No new messages from your peer.");
  });

  test("returns formatted messages and clears queue", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const ts = 1705312200000;
    adapter.queueForPull(makeBridgeMessage("first message", ts));
    adapter.queueForPull(makeBridgeMessage("second message", ts + 5000));

    const result = await adapter.drainMessages();
    const text = result.content[0].text;

    expect(text).toContain("[2 new messages from peer]");
    expect(text).toContain("chat_id:");
    expect(text).toContain("[1]");
    expect(text).toContain("first message");
    expect(text).toContain("[2]");
    expect(text).toContain("second message");

    expect(adapter.pendingMessages).toHaveLength(0);
    expect(adapter.getPendingMessageCount()).toBe(0);
  });

  test("includes dropped count when messages were lost", async () => {
    const adapter = withEnv("AGENTBRIDGE_MAX_BUFFERED_MESSAGES", "2", () => createAdapter("pull"));
    adapter.resolveMode();

    adapter.queueForPull(makeBridgeMessage("a"));
    adapter.queueForPull(makeBridgeMessage("b"));
    adapter.queueForPull(makeBridgeMessage("c"));

    const result = await adapter.drainMessages();
    const text = result.content[0].text;

    expect(text).toContain("1 older message");
    expect(text).toContain("dropped due to queue overflow");
    expect(adapter.droppedMessageCount).toBe(0);
  });

  test("singular message uses correct grammar", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    adapter.queueForPull(makeBridgeMessage("only one"));

    const result = await adapter.drainMessages();
    expect(result.content[0].text).toContain("[1 new message from peer]");
  });
});

describe("Dual-mode transport: reply pending hint", () => {
  test("handleReply includes pending message hint when queue is non-empty", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    adapter.replySender = async () => ({ success: true });
    adapter.queueForPull(makeBridgeMessage("waiting msg 1"));
    adapter.queueForPull(makeBridgeMessage("waiting msg 2"));

    const result = await adapter.handleReply({ chat_id: "test", text: "hello codex" });
    const text = result.content[0].text;

    expect(text).toContain("Reply sent to peer Claude.");
    expect(text).toContain("2 unread peer messages");
    expect(text).toContain("get_messages");
  });

  test("handleReply has no hint when queue is empty", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    adapter.replySender = async () => ({ success: true });

    const result = await adapter.handleReply({ chat_id: "test", text: "hello codex" });
    expect(result.content[0].text).toBe("Reply sent to peer Claude.");
  });

  test("handleReply reports delivered and missing recipients for partial targeted sends", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    adapter.replySender = async () => ({
      success: true,
      resolvedRecipients: ["B"],
      missingRecipients: ["Z"],
    });

    const result = await adapter.handleReply({ chat_id: "test", text: "hello peers", to: ["B", "Z"] });
    const text = result.content[0].text;

    expect(text).toContain("Delivered to: B.");
    expect(text).toContain("Not delivered to offline/unknown peers: Z.");
  });

  test("handleReply returns error when text is missing", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const result = await adapter.handleReply({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing required parameter");
  });

  test("handleReply returns error when replySender is not set", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const result = await adapter.handleReply({ text: "hello" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bridge not initialized");
  });
});
