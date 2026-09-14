/**
 * peon — thin pi → peon-ping CLI bridge
 *
 * Pipes pi lifecycle events as JSON to the peon CLI on stdin.
 * All audio, notifications, spam detection, debounce, relay, and
 * pack management are handled by the CLI — this file is just the hook.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

/** Homebrew install location of the peon CLI (fallback after PEON_BIN). */
export const DEFAULT_PEON_BIN = "/opt/homebrew/bin/peon";

/** Session id cache: written by native handlers (which get ctx), read by custom-channel handlers (which don't). */
let currentSessionId: string | null = null;

type PeonPayload = Record<string, unknown>;
type Send = (payload: PeonPayload) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

interface SessionIdSource {
	sessionManager?: { getSessionId(): string };
}

/**
 * Resolve the peon binary per call: `PEON_BIN` verbatim, then the Homebrew
 * default, then an existence-checked PATH scan. Resolving per call keeps the
 * chain steerable by tests and by env changes after module load.
 */
function resolvePeonBin(): string | null {
	const override = process.env.PEON_BIN;
	if (override) return override;
	if (existsSync(DEFAULT_PEON_BIN)) return DEFAULT_PEON_BIN;
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.join(dir, "peon");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Spawn env for the peon CLI. CLAUDE_CONFIG_DIR is stripped so peon resolves
 * its data dir to ~/.openpeon instead of the protected
 * ~/.config/claude/hooks/peon-ping/ path.
 */
function spawnEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.CLAUDE_CONFIG_DIR;
	return env;
}

/**
 * Best-effort delivery: one JSON line on the resolved binary's stdin. Every
 * failure mode — no resolvable binary, spawn ENOENT, non-zero child exit,
 * EPIPE from a child that dies before draining stdin, the 5s timeout — ends
 * as a silently skipped notification, never an error in the host session.
 */
function deliver(payload: PeonPayload): void {
	const bin = resolvePeonBin();
	if (bin === null) return;
	try {
		// The no-op callback subscribes as the child's error listener, so
		// spawn failures (ENOENT etc.) are genuinely silent.
		const child = execFile(bin, [], { timeout: 5000, env: spawnEnv() }, () => {});
		child.stdin?.write(JSON.stringify(payload));
		child.stdin?.end();
	} catch {
		// stdin raced a child that already died (EPIPE) — still best-effort
	}
}

export default function (pi: ExtensionAPI, deps?: { send?: Send }): void {
	const send: Send = deps?.send ?? deliver;

	function sendHook(
		hookEvent: string,
		sessionId: string,
		cwd: string,
		extra: PeonPayload = {},
	): void {
		send({
			hook_event_name: hookEvent,
			session_id: sessionId,
			cwd,
			source: "pi",
			...extra,
		});
	}

	function refreshSessionId(ctx: SessionIdSource): string {
		const sessionId =
			ctx.sessionManager?.getSessionId() ?? currentSessionId ?? randomUUID();
		currentSessionId = sessionId;
		return sessionId;
	}

	function cachedSessionId(): string {
		return currentSessionId ?? randomUUID();
	}

	pi.on("session_start", (_event, ctx) => {
		const sessionId = refreshSessionId(ctx);
		if (!ctx.hasUI) return;
		sendHook("SessionStart", sessionId, ctx.cwd);
	});

	pi.on("agent_start", (_event, ctx) => {
		const sessionId = refreshSessionId(ctx);
		if (!ctx.hasUI) return;
		sendHook("UserPromptSubmit", sessionId, ctx.cwd);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const sessionId = refreshSessionId(ctx);
		if (!ctx.hasUI) return;
		sendHook("Stop", sessionId, ctx.cwd);
	});

		pi.on("tool_execution_end", (event, ctx) => {
			const sessionId = refreshSessionId(ctx);
			if (!event.isError || !ctx.hasUI) return;
			// peon checks tool_name === "Bash": normalize pi's bash and task
			// (background task runner) names to the Claude Code convention.
			const toolName = ["bash", "task"].includes(event.toolName.toLowerCase())
				? "Bash"
				: event.toolName;
			sendHook("PostToolUseFailure", sessionId, ctx.cwd, {
				tool_name: toolName,
				error: "Tool error",
			});
		});

		pi.on("session_shutdown", (event, ctx) => {
			const sessionId = refreshSessionId(ctx);
			if (!ctx.hasUI) return;
			if (event.reason !== "quit") return;
			sendHook("SessionEnd", sessionId, ctx.cwd);
		});

		pi.events.on("rpiv:ask-user:blocked", (data) => {
			if (!isRecord(data) || !data.active) return;
			sendHook("Notification", cachedSessionId(), process.cwd(), {
				notification_type: "elicitation_dialog",
			});
		});

		pi.events.on("request-attention", (data) => {
			if (!isRecord(data)) return;
			// The emitter's message stays unforwarded — the peon CLI's handling
			// of extra fields is unaudited, so payloads stay minimal.
			sendHook("Notification", cachedSessionId(), process.cwd(), {
				notification_type: "permission_request",
			});
		});

		pi.events.on("herdr:blocked", (data) => {
			// Edge-paired channel: only the rising edge (active:true) is
			// attention; the falling edge carries no label and emits nothing.
			if (!isRecord(data) || !data.active) return;
			const extra: PeonPayload = { notification_type: "subagent_attention" };
			if (typeof data.label === "string") extra.label = data.label;
			sendHook("Notification", cachedSessionId(), process.cwd(), extra);
		});
}
