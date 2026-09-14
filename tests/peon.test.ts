import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import peonExtension, { DEFAULT_PEON_BIN } from "../index.ts";

const PEON_STUB = join(import.meta.dirname, "fixtures", "peon-stub");

interface StubHandle {
	native: Map<string, (event: unknown, ctx: unknown) => void>;
	custom: Map<string, (data: unknown) => void>;
	sent: Array<Record<string, unknown>>;
	emitted: Array<{ channel: string; data: unknown }>;
	ctx: (overrides?: { hasUI?: boolean; cwd?: string }) => {
		hasUI: boolean;
		cwd: string;
		sessionManager: { getSessionId: () => string };
	};
	switchSession: (next: string) => void;
}

/**
 * Register the extension against a stub pi API. By default payloads are
 * captured via the injected send seam; `realDelivery` leaves the seam
 * uninjected so handlers go through the real deliver() child-process path.
 */
function mountExtension(
	initialSessionId: string,
	options: { realDelivery?: boolean } = {},
): StubHandle {
	const native = new Map<string, (event: unknown, ctx: unknown) => void>();
	const custom = new Map<string, (data: unknown) => void>();
	const sent: Array<Record<string, unknown>> = [];
	const emitted: Array<{ channel: string; data: unknown }> = [];
	let sessionId = initialSessionId;

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
			native.set(event, handler);
		},
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				custom.set(channel, handler);
			},
			emit: (channel: string, data: unknown) => {
				emitted.push({ channel, data });
			},
		},
	};
	const deps = options.realDelivery
		? undefined
		: {
				send: (payload: Record<string, unknown>) => {
					sent.push(payload);
				},
			};
	peonExtension(pi as unknown as ExtensionAPI, deps);

	return {
		native,
		custom,
		sent,
		emitted,
		ctx: (overrides = {}) => ({
			hasUI: true,
			cwd: "/tmp/peon-test",
			sessionManager: { getSessionId: () => sessionId },
			...overrides,
		}),
		switchSession: (next: string) => {
			sessionId = next;
		},
	};
}

function fireNative(
	stub: StubHandle,
	event: string,
	payload: unknown = {},
	ctxOverrides: { hasUI?: boolean; cwd?: string } = {},
): void {
	const handler = stub.native.get(event);
	assert.ok(handler, `no native handler registered for "${event}"`);
	handler(payload, stub.ctx(ctxOverrides));
}

function fireCustom(stub: StubHandle, channel: string, data: unknown): void {
	const handler = stub.custom.get(channel);
	assert.ok(handler, `no custom handler registered for "${channel}"`);
	handler(data);
}

/** Poll until the capture file holds a non-empty line, or fail past the deadline. */
async function pollForCapture(
	file: string,
	deadlineMs: number,
): Promise<string> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (existsSync(file)) {
			const content = readFileSync(file, "utf8").trim();
			if (content !== "") return content;
		}
		await delay(20);
	}
	assert.fail(`capture file never received a payload: ${file}`);
}

function capturePath(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-peon-test-")), "capture.json");
}

describe("registration", () => {
	it("registers exactly the native lifecycle handlers", () => {
		const stub = mountExtension("s0");
		assert.deepEqual([...stub.native.keys()].sort(), [
			"agent_settled",
			"agent_start",
			"session_shutdown",
			"session_start",
			"tool_execution_end",
		]);
	});

	it("registers exactly the custom channels", () => {
		const stub = mountExtension("s0");
		assert.deepEqual([...stub.custom.keys()].sort(), [
			"herdr:blocked",
			"request-attention",
			"rpiv:ask-user:blocked",
		]);
	});

	it("does not register the replaced agent_end event", () => {
		const stub = mountExtension("s0");
		assert.equal(stub.native.has("agent_end"), false);
	});
});

describe("native event mappings", () => {
	it("maps session_start to SessionStart", () => {
		const stub = mountExtension("sess-a");
		fireNative(stub, "session_start", {
			type: "session_start",
			reason: "startup",
		});
		assert.equal(stub.sent.length, 1);
		assert.equal(stub.sent[0].hook_event_name, "SessionStart");
	});

	it("maps agent_start to UserPromptSubmit", () => {
		const stub = mountExtension("sess-a");
		fireNative(stub, "agent_start", { type: "agent_start" });
		assert.equal(stub.sent.length, 1);
		assert.equal(stub.sent[0].hook_event_name, "UserPromptSubmit");
	});

	it("maps agent_settled to exactly one Stop", () => {
		const stub = mountExtension("sess-a");
		fireNative(stub, "agent_settled", { type: "agent_settled" });
		const stops = stub.sent.filter((p) => p.hook_event_name === "Stop");
		assert.equal(stops.length, 1);
	});

	it("maps a failed tool_execution_end to PostToolUseFailure with tool context", () => {
		const stub = mountExtension("sess-a");
		fireNative(stub, "tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: "boom",
			isError: true,
		});
		assert.equal(stub.sent.length, 1);
		assert.equal(stub.sent[0].hook_event_name, "PostToolUseFailure");
		assert.equal(stub.sent[0].tool_name, "Bash");
		assert.equal(stub.sent[0].error, "Tool error");
	});
});

describe("gating", () => {
	it("sends nothing when hasUI is false (each native mapping)", () => {
		const stub = mountExtension("sess-a");
		fireNative(stub, "session_start", {}, { hasUI: false });
		fireNative(stub, "agent_start", {}, { hasUI: false });
		fireNative(stub, "agent_settled", {}, { hasUI: false });
		fireNative(
			stub,
			"tool_execution_end",
			{ toolName: "bash", isError: true },
			{ hasUI: false },
		);
		assert.equal(stub.sent.length, 0);
	});

	it("sends nothing for a successful tool execution", () => {
		const stub = mountExtension("sess-a");
		fireNative(stub, "tool_execution_end", { toolName: "bash", isError: false });
		assert.equal(stub.sent.length, 0);
	});
});

describe("tool name normalization", () => {
	const cases = [
		["bash", "Bash"],
		["BASH", "Bash"],
		["task", "Bash"],
		["Task", "Bash"],
		["read", "read"],
		["Edit", "Edit"],
	] as const;
	for (const [raw, expected] of cases) {
		it(`normalizes "${raw}" to "${expected}"`, () => {
			const stub = mountExtension("sess-a");
			fireNative(stub, "tool_execution_end", { toolName: raw, isError: true });
			assert.equal(stub.sent[0].tool_name, expected);
		});
	}
});

describe("session identity", () => {
	it("payloads follow getSessionId() across two sessions", () => {
		const stub = mountExtension("sess-one");
		fireNative(stub, "session_start");
		assert.equal(stub.sent[0].session_id, "sess-one");
		stub.switchSession("sess-two");
		fireNative(stub, "session_start");
		fireNative(stub, "agent_settled");
		assert.equal(stub.sent[1].session_id, "sess-two");
		assert.equal(stub.sent[2].session_id, "sess-two");
	});

	it("custom-channel payloads carry the cached session id", () => {
		const stub = mountExtension("sess-cached");
		fireNative(stub, "session_start");
		stub.switchSession("sess-next");
		fireCustom(stub, "rpiv:ask-user:blocked", { active: true });
		fireCustom(stub, "request-attention", { message: "approve?" });
		fireCustom(stub, "herdr:blocked", { active: true, label: "worker-1" });
		for (const payload of stub.sent.slice(-3)) {
			assert.equal(payload.session_id, "sess-cached");
		}
	});
});

describe("session_shutdown gating", () => {
	it("maps a quit shutdown to SessionEnd", () => {
		const stub = mountExtension("sess-a");
		fireNative(stub, "session_shutdown", {
			type: "session_shutdown",
			reason: "quit",
		});
		assert.equal(stub.sent.length, 1);
		assert.equal(stub.sent[0].hook_event_name, "SessionEnd");
	});

	it("emits nothing for reload/new/resume/fork shutdowns", () => {
		const stub = mountExtension("sess-a");
		for (const reason of ["reload", "new", "resume", "fork"] as const) {
			fireNative(stub, "session_shutdown", { type: "session_shutdown", reason });
		}
		assert.equal(stub.sent.length, 0);
	});

	it("emits nothing for a quit shutdown without UI", () => {
		const stub = mountExtension("sess-a");
		fireNative(
			stub,
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			{ hasUI: false },
		);
		assert.equal(stub.sent.length, 0);
	});
});

describe("custom channel gating", () => {
	it("maps request-attention to a permission_request notification", () => {
		const stub = mountExtension("sess-a");
		fireCustom(stub, "request-attention", { message: "sandbox needs approval" });
		assert.equal(stub.sent.length, 1);
		assert.equal(stub.sent[0].hook_event_name, "Notification");
		assert.equal(stub.sent[0].notification_type, "permission_request");
		assert.equal(
			"message" in stub.sent[0],
			false,
			"message must not be forwarded",
		);
	});

	it("ignores request-attention events without a payload", () => {
		const stub = mountExtension("sess-a");
		fireCustom(stub, "request-attention", undefined);
		fireCustom(stub, "request-attention", null);
		assert.equal(stub.sent.length, 0);
	});

	it("maps a rising herdr:blocked edge with label to subagent_attention", () => {
		const stub = mountExtension("sess-a");
		fireCustom(stub, "herdr:blocked", { active: true, label: "reviewer" });
		assert.equal(stub.sent.length, 1);
		assert.equal(stub.sent[0].notification_type, "subagent_attention");
		assert.equal(stub.sent[0].label, "reviewer");
	});

	it("notifies on a rising herdr:blocked edge without a label, omitting the label field", () => {
		const stub = mountExtension("sess-a");
		fireCustom(stub, "herdr:blocked", { active: true });
		assert.equal(stub.sent.length, 1);
		assert.equal(stub.sent[0].notification_type, "subagent_attention");
		assert.equal("label" in stub.sent[0], false);
	});

	it("emits nothing on a falling herdr:blocked edge", () => {
		const stub = mountExtension("sess-a");
		fireCustom(stub, "herdr:blocked", { active: false });
		assert.equal(stub.sent.length, 0);
	});

	it("emits nothing for rpiv falling edges", () => {
		const stub = mountExtension("sess-a");
		fireCustom(stub, "rpiv:ask-user:blocked", { active: false });
		assert.equal(stub.sent.length, 0);
	});

	it("maps a rising rpiv:ask-user:blocked edge to an elicitation_dialog notification", () => {
		const stub = mountExtension("sess-a");
		fireCustom(stub, "rpiv:ask-user:blocked", { active: true });
		assert.equal(stub.sent.length, 1);
		assert.equal(stub.sent[0].hook_event_name, "Notification");
		assert.equal(stub.sent[0].notification_type, "elicitation_dialog");
	});

	it("stays a pure consumer: zero pi.events.emit calls across all handlers", () => {
		const stub = mountExtension("sess-a");
		fireNative(stub, "session_start");
		fireNative(stub, "agent_start");
		fireNative(stub, "agent_settled");
		fireNative(stub, "tool_execution_end", { toolName: "bash", isError: true });
		fireNative(stub, "session_shutdown", {
			type: "session_shutdown",
			reason: "quit",
		});
		fireCustom(stub, "rpiv:ask-user:blocked", { active: true });
		fireCustom(stub, "rpiv:ask-user:blocked", { active: false });
		fireCustom(stub, "request-attention", { message: "approve?" });
		fireCustom(stub, "request-attention", undefined);
		fireCustom(stub, "herdr:blocked", { active: true, label: "worker" });
		fireCustom(stub, "herdr:blocked", { active: false });
		assert.equal(stub.emitted.length, 0);
	});
});

describe("payload base shape", () => {
	it('carries hook_event_name, session_id, cwd, and source:"pi" on every payload', () => {
		const stub = mountExtension("sess-shape");
		fireNative(stub, "session_start");
		fireNative(stub, "agent_start");
		fireNative(stub, "agent_settled");
		fireNative(stub, "tool_execution_end", { toolName: "bash", isError: true });
		fireCustom(stub, "rpiv:ask-user:blocked", { active: true });
		assert.ok(stub.sent.length >= 5);
		for (const payload of stub.sent) {
			assert.equal(typeof payload.hook_event_name, "string");
			assert.equal(typeof payload.session_id, "string");
			assert.ok((payload.session_id as string).length > 0);
			assert.equal(typeof payload.cwd, "string");
			assert.equal(payload.source, "pi");
		}
	});
});

describe("integration (real child process)", () => {
	it("delivers a SessionStart payload through PEON_BIN with CLAUDE_CONFIG_DIR stripped", async () => {
		const capture = capturePath();
		process.env.PEON_BIN = PEON_STUB;
		process.env.PEON_CAPTURE = capture;
		process.env.CLAUDE_CONFIG_DIR = "peon-test-claude-dir";
		try {
			const stub = mountExtension("sess-live", { realDelivery: true });
			fireNative(stub, "session_start");
			const payload = JSON.parse(await pollForCapture(capture, 2000));
			assert.equal(payload.hook_event_name, "SessionStart");
			assert.equal(payload.session_id, "sess-live");
			assert.equal(payload.source, "pi");
			assert.equal(typeof payload.cwd, "string");
			const childEnv = readFileSync(`${capture}.env`, "utf8");
			assert.match(childEnv, /^PEON_CAPTURE=/m);
			assert.doesNotMatch(childEnv, /^CLAUDE_CONFIG_DIR=/m);
		} finally {
			delete process.env.PEON_BIN;
			delete process.env.PEON_CAPTURE;
			delete process.env.CLAUDE_CONFIG_DIR;
			rmSync(join(capture, ".."), { recursive: true, force: true });
		}
	});

	it("survives a nonexistent PEON_BIN without crashing the host", async () => {
		const capture = capturePath();
		process.env.PEON_BIN = "/nonexistent/peon";
		process.env.PEON_CAPTURE = capture;
		try {
			const stub = mountExtension("sess-enoent", { realDelivery: true });
			fireNative(stub, "session_start");
			// An unhandled spawn 'error' would kill the whole test process —
			// reaching the assertion below is the detection mechanism.
			await delay(250);
			assert.equal(existsSync(capture), false);
		} finally {
			delete process.env.PEON_BIN;
			delete process.env.PEON_CAPTURE;
			rmSync(join(capture, ".."), { recursive: true, force: true });
		}
	});

	it("silently skips when no binary resolves (PATH-sandboxed)", (t) => {
		if (existsSync(DEFAULT_PEON_BIN)) {
			t.skip(
				`${DEFAULT_PEON_BIN} exists on this machine — the "no default-path hit" precondition cannot be established`,
			);
			return;
		}
		const originalPath = process.env.PATH;
		const sandbox = mkdtempSync(join(tmpdir(), "pi-peon-path-"));
		delete process.env.PEON_BIN;
		process.env.PATH = sandbox;
		try {
			const stub = mountExtension("sess-nores", { realDelivery: true });
			fireNative(stub, "session_start");
			assert.ok(true, "no resolution and no crash");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
