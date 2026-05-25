import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { launchPeers } from "./window-launcher";

const TEST_STATE_DIR = "/tmp/cc-bridge-wl-test";

afterAll(() => {
  try { rmSync(TEST_STATE_DIR, { recursive: true, force: true }); } catch {}
});

describe("window launcher", () => {
  test("returns clear error when no launch template is configured", () => {
    const oldTemplate = process.env.CC_BRIDGE_LAUNCH_TEMPLATE;
    delete process.env.CC_BRIDGE_LAUNCH_TEMPLATE;

    const result = launchPeers({ targets: ["B", "C"] });

    expect(result.success).toBe(false);
    expect(result.launched).toEqual([]);
    expect(result.failed.B).toContain("CC_BRIDGE_LAUNCH_TEMPLATE");
    expect(result.failed.C).toContain("CC_BRIDGE_LAUNCH_TEMPLATE");

    if (oldTemplate !== undefined) {
      process.env.CC_BRIDGE_LAUNCH_TEMPLATE = oldTemplate;
    }
  });

  test("supports count-based generation starting from B by default", () => {
    const oldTemplate = process.env.CC_BRIDGE_LAUNCH_TEMPLATE;
    delete process.env.CC_BRIDGE_LAUNCH_TEMPLATE;

    const result = launchPeers({ count: 4 });

    expect(Object.keys(result.failed)).toEqual(["B", "C", "D", "E"]);

    if (oldTemplate !== undefined) {
      process.env.CC_BRIDGE_LAUNCH_TEMPLATE = oldTemplate;
    }
  });

  test("supports count-based generation with custom startFrom", () => {
    const oldTemplate = process.env.CC_BRIDGE_LAUNCH_TEMPLATE;
    delete process.env.CC_BRIDGE_LAUNCH_TEMPLATE;

    const result = launchPeers({ count: 3, startFrom: "D" });

    expect(Object.keys(result.failed)).toEqual(["D", "E", "F"]);

    if (oldTemplate !== undefined) {
      process.env.CC_BRIDGE_LAUNCH_TEMPLATE = oldTemplate;
    }
  });
});

describe("Phase 5C: target_room routing", () => {
  test("target_room in peerTarget is sanitized — shell-special chars are stripped", () => {
    // target_room with shell metacharacters must be sanitized before reaching templates
    const oldTemplate = process.env.CC_BRIDGE_LAUNCH_TEMPLATE;
    const oldStateDir = process.env.CC_BRIDGE_STATE_DIR;
    const oldRoom = process.env.CC_BRIDGE_ROOM;
    const oldEndpoint = process.env.CC_BRIDGE_ENDPOINT;

    // Use an echo template so the launcher "succeeds" without opening a terminal
    process.env.CC_BRIDGE_LAUNCH_TEMPLATE = "echo launched {endpoint}";
    process.env.CC_BRIDGE_STATE_DIR = TEST_STATE_DIR;
    process.env.CC_BRIDGE_ROOM = "caller-room";
    process.env.CC_BRIDGE_ENDPOINT = "A";
    mkdirSync(join(TEST_STATE_DIR, "caller-room", "messages"), { recursive: true });

    const result = launchPeers({
      peerTargets: [{
        endpoint: "B",
        // Shell-injection attempt in target_room
        target_room: "evil'; rm -rf /tmp/cc-bridge-wl-test; echo '",
        bootstrap_message: "",
      }],
    });

    // Launcher should succeed (echo always exits 0)
    expect(result.launched).toContain("B");

    // Bootstrap message dir should be written to sanitized room, not the raw malicious string
    // sanitizeName replaces non-alnum chars with _, so the room becomes safe
    const files = readdirSync(TEST_STATE_DIR);
    // No directory should have shell metacharacters in its name
    for (const f of files) {
      expect(f).not.toContain("'");
      expect(f).not.toContain(";");
    }

    if (oldTemplate !== undefined) process.env.CC_BRIDGE_LAUNCH_TEMPLATE = oldTemplate;
    else delete process.env.CC_BRIDGE_LAUNCH_TEMPLATE;
    if (oldStateDir !== undefined) process.env.CC_BRIDGE_STATE_DIR = oldStateDir;
    else delete process.env.CC_BRIDGE_STATE_DIR;
    if (oldRoom !== undefined) process.env.CC_BRIDGE_ROOM = oldRoom;
    else delete process.env.CC_BRIDGE_ROOM;
    if (oldEndpoint !== undefined) process.env.CC_BRIDGE_ENDPOINT = oldEndpoint;
    else delete process.env.CC_BRIDGE_ENDPOINT;
  });

  test("bootstrap message is written to target_room directory, not caller room", () => {
    const oldTemplate = process.env.CC_BRIDGE_LAUNCH_TEMPLATE;
    const oldStateDir = process.env.CC_BRIDGE_STATE_DIR;
    const oldRoom = process.env.CC_BRIDGE_ROOM;
    const oldEndpoint = process.env.CC_BRIDGE_ENDPOINT;

    process.env.CC_BRIDGE_LAUNCH_TEMPLATE = "echo launched {endpoint}";
    process.env.CC_BRIDGE_STATE_DIR = TEST_STATE_DIR;
    process.env.CC_BRIDGE_ROOM = "caller-room";
    process.env.CC_BRIDGE_ENDPOINT = "A";
    mkdirSync(join(TEST_STATE_DIR, "caller-room", "messages"), { recursive: true });

    launchPeers({
      peerTargets: [{
        endpoint: "C",
        target_room: "special-room",
        bootstrap_message: "Hello from A, please start",
      }],
    });

    // Message should be in special-room/messages/, not caller-room/messages/
    const targetMsgsDir = join(TEST_STATE_DIR, "special-room", "messages");
    const callerMsgsDir = join(TEST_STATE_DIR, "caller-room", "messages");

    const targetFiles = readdirSync(targetMsgsDir).filter((f) => f.endsWith(".json"));
    const callerFiles = readdirSync(callerMsgsDir).filter((f) => f.endsWith(".json"));

    expect(targetFiles.length).toBeGreaterThan(0);
    expect(callerFiles.length).toBe(0);

    if (oldTemplate !== undefined) process.env.CC_BRIDGE_LAUNCH_TEMPLATE = oldTemplate;
    else delete process.env.CC_BRIDGE_LAUNCH_TEMPLATE;
    if (oldStateDir !== undefined) process.env.CC_BRIDGE_STATE_DIR = oldStateDir;
    else delete process.env.CC_BRIDGE_STATE_DIR;
    if (oldRoom !== undefined) process.env.CC_BRIDGE_ROOM = oldRoom;
    else delete process.env.CC_BRIDGE_ROOM;
    if (oldEndpoint !== undefined) process.env.CC_BRIDGE_ENDPOINT = oldEndpoint;
    else delete process.env.CC_BRIDGE_ENDPOINT;
  });
});
