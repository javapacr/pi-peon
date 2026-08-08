# pi-peon

Thin pi → [peon-ping](https://github.com/javapacr/peon-ping) CLI bridge.

Pipes pi lifecycle events as JSON to the `peon` CLI on stdin. All audio, notifications, spam detection, debounce, relay, and pack management are handled by the CLI — this extension is just the hook.

## How it works

The extension listens for pi lifecycle events and forwards them to `/opt/homebrew/bin/peon` via `execFile` with the JSON payload on stdin:

| pi Event | peon Event | Trigger |
|----------|-----------|---------|
| `session_start` | `SessionStart` | New session starts (UI only) |
| `agent_start` | `UserPromptSubmit` | Agent begins processing (UI only) |
| `agent_end` | `Stop` | Agent finishes (UI only) |
| `tool_execution_end` (error) | `PostToolUseFailure` | Tool execution fails (UI only) |
| `rpiv:ask-user:blocked` | `Notification` | User input dialog appears |

A `session_id` (random UUID) is generated once on load and included in every payload for correlation. Tool names are normalized to Claude Code convention (`bash`/`task` → `Bash`).

The `CLAUDE_CONFIG_DIR` environment variable is stripped so that `peon` resolves its data directory to `~/.openpeon` instead of the protected `~/.config/claude/hooks/peon-ping/` path.

## Installation

```bash
# Requires the peon CLI at /opt/homebrew/bin/peon
# (Install via: brew install javapacr/tap/peon or equivalent)

# Clone and link
git clone https://github.com/javapacr/pi-peon.git
cd pi-peon
npm install  # installs type deps

# Add to pi settings.json:
# "extensions": ["./path/to/pi-peon/peon.ts"]
```

## Known Issues

- The `peon` binary path is hardcoded to `/opt/homebrew/bin/peon` — no fallback or configuration.
- If `peon` is not installed, failures are silently swallowed (intentional — no noise).
- The `execFile` call has a 5-second timeout; slow peon startup may result in dropped events.

## Decision Note

**Standalone vs merge:** Evaluated during the extension-promotion backlog review. The backlog initially suggested merging into `pi-subagents` or `pi-patty-bg-tasks`. Decided to **promote standalone** — `peon.ts` is a focused single-purpose bridge with zero runtime npm dependencies, and keeping it standalone allows independent iteration of the peon CLI integration without coupling to other extensions.

## License

MIT
