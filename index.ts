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

const PEON_BIN = "/opt/homebrew/bin/peon";
const SESSION_ID = randomUUID();

// Strip CLAUDE_CONFIG_DIR so peon resolves its data dir to ~/.openpeon
// instead of the protected ~/.config/claude/hooks/peon-ping/ path.
const peonEnv = { ...process.env };
delete peonEnv.CLAUDE_CONFIG_DIR;

function peon(
	event: string,
	cwd: string,
	extra: Record<string, unknown> = {},
): void {
	const payload = JSON.stringify({
		hook_event_name: event,
		session_id: SESSION_ID,
		cwd,
		source: "pi",
		...extra,
	});
	try {
		const child = execFile(PEON_BIN, [], { timeout: 5000, env: peonEnv });
		child.stdin?.write(payload);
		child.stdin?.end();
	} catch {
		// peon not installed — silently skip
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		peon("SessionStart", ctx.cwd);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		peon("UserPromptSubmit", ctx.cwd);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		peon("Stop", ctx.cwd);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!event.isError || !ctx.hasUI) return;
		// Normalize pi tool names to Claude Code convention (peon checks tool_name === 'Bash')
		// Both 'bash' and 'task' (background task runner) should trigger task.error
		const rawName = event.toolName ?? "";
		const toolName = ["bash", "task"].includes(rawName.toLowerCase())
			? "Bash"
			: rawName;
		peon("PostToolUseFailure", ctx.cwd, {
			tool_name: toolName,
			error: "Tool error",
		});
	});

	pi.events.on("rpiv:ask-user:blocked", (data) => {
		const payload = data as { active: boolean };
		if (!payload.active) return;
		peon("Notification", process.cwd(), {
			notification_type: "elicitation_dialog",
		});
	});
}
