# pi-peon

Thin pi → [peon-ping](https://github.com/javapacr/peon-ping) CLI bridge.

Pipes pi lifecycle and attention events as hook-shaped JSON to the `peon` CLI on stdin. All audio, notifications, spam detection, debounce, relay, and pack management are handled by the CLI — this extension is just the hook, and a **pure consumer**: it never emits anything on the `pi.events` bus.

## How it works

The extension listens for pi events and forwards them to the peon binary via `execFile`, one JSON line on stdin:

```json
{ "hook_event_name": "SessionStart", "session_id": "…", "cwd": "…", "source": "pi" }
```

Delivery is best-effort by contract: no resolvable binary, spawn ENOENT, non-zero child exit, EPIPE from a dying child, and the 5-second timeout all end as a silently skipped notification — never an error in the host session. `CLAUDE_CONFIG_DIR` is stripped from the spawn env so peon resolves its data dir to `~/.openpeon` instead of the protected `~/.config/claude/hooks/peon-ping/` path.

### Event map

| # | pi channel | Bus | peon `hook_event_name` | Payload extras | Gate |
|---|------------|-----|------------------------|----------------|------|
| 1 | `session_start` | native | `SessionStart` | — | `ctx.hasUI` |
| 2 | `agent_start` | native | `UserPromptSubmit` | — | `ctx.hasUI` |
| 3 | `agent_settled` | native | `Stop` | — | `ctx.hasUI` |
| 4 | `tool_execution_end` | native | `PostToolUseFailure` | `tool_name` (normalized), `error: "Tool error"` | `isError` **and** `ctx.hasUI` |
| 5 | `rpiv:ask-user:blocked` | custom | `Notification` | `notification_type: "elicitation_dialog"` | rising edge (`active: true`) |
| 6 | `request-attention` | custom | `Notification` | `notification_type: "permission_request"` | payload present; the emitter's `message` is **not** forwarded |
| 7 | `herdr:blocked` | custom | `Notification` | `notification_type: "subagent_attention"`, plus `label` when the payload carries a string label | rising edge only; `active: false` emits nothing |
| 8 | `session_shutdown` | native | `SessionEnd` | — | `ctx.hasUI` **and** `reason === "quit"` |

`agent_settled` (fires only after a run fully settles — no pending retry, compaction, or continuation) replaced the old `agent_end` mapping, so an auto-retried turn yields exactly one `Stop`. Tool names are normalized to Claude Code convention (`bash`/`task` → `Bash`, case-insensitive) because peon checks `tool_name === "Bash"`. Native events gate on `ctx.hasUI`; custom channels carry no ctx and use `process.cwd()` — their emitters UI-gate themselves.

### Binary resolution (`PEON_BIN`)

Resolved **per call**, in order:

1. `process.env.PEON_BIN`, used verbatim
2. `/opt/homebrew/bin/peon` (Homebrew default)
3. first existence-checked hit scanning `PATH` (split on `path.delimiter`)
4. nothing → silent skip, no spawn

The spawned path is always absolute (the pi process PATH is not guaranteed to match the shell's).

### Session id semantics

Payloads carry the **current session's** id, not a per-extension-load UUID: native handlers read `ctx.sessionManager.getSessionId()` and refresh a module-level cache, so `/new`, `/resume`, and `/fork` within one pi process produce new ids. Custom-channel handlers (which receive no ctx) read the cache, falling back to a fresh `randomUUID()`.

## Installation

```bash
pi install git:github.com/javapacr/pi-peon
```

When run with `PI_CODING_AGENT_DIR` pointed at a profile, the install auto-adds the `git:github.com/javapacr/pi-peon` entry to that profile's `settings.json` `packages` — what a profile loads is decided solely by `packages`, never an `extensions` key, and never a manual clone.

Requires the peon CLI (`brew install javapacr/tap/peon` or equivalent); without it the extension simply stays silent.

## Verification

1. Fresh **interactive** session (not `pi -p`) — read the **last** `[Extensions]` banner; it must name `pi-peon`. The banner proves discovery, not load — do step 2.
2. Observable behavior with a logging stub:

   ```bash
   cat > /tmp/peon-stub <<'EOF'
   #!/bin/sh
   cat > /tmp/peon-capture.json
   EOF
   chmod +x /tmp/peon-stub
   PEON_BIN=/tmp/peon-stub pi   # in this session:
   ```

   Trigger a failing tool call (e.g. ask the agent to run `false` via bash), then check `/tmp/peon-capture.json`: it must contain a `PostToolUseFailure` line with `tool_name: "Bash"`, `source: "pi"`, and the session's id. Merely opening the session alone should already have produced a `SessionStart` line.

3. `npm test` — the node:test suite covers the full event map, gating, normalization, env stripping, and spawn-failure tolerance with a real child process.

## Tests

```
npm test          # node --test tests/*.test.ts
npm run typecheck # tsc --noEmit
```

## Event-survey dispositions

Surveyed 2026-09-14 against the installed extension ecosystem:

- **rpiv-todo** — `@juicesharp/rpiv-todo` v2.9.0 emits zero custom events and exposes no hook surface (exhaustive 16-file read): nothing to consume. Closed.
- **Pure consumer** — pi-peon emits zero events on `pi.events` (no `peon:*` channels); zero subscribers exist and a second outbound path is pure stability burden. Locked.
- **Deferred**: `ui_prompt_start` (overlaps the three adopted Notification paths; needs a live probe of permission-related kinds plus a dedupe layer), `subagent:async-complete` (payload unaudited), `session_compact_failed` (low signal-to-noise).
- **Rejected**: `herdr:busy` (means "subagent work in flight" — routine, not attention) and the orchestration/self-protocol channels (`plannotator:*`, `pi-claude-permissions:*`, `tui_filled_handoff`, pi-handoff internals, herdr-agent-state) — machine-to-machine coordination, not user-attention signals.

### Audit findings disposition

| # | Finding | Disposition |
|---|---------|-------------|
| F1 | README wrong install key/method | Fixed — this rewrite |
| F2 | `execFile` spawn errors unhandled (ENOENT could crash the host) | Fixed — no-op error-listening callback, ENOENT tolerance tested |
| F3 | No real tests (echo placeholder) | Fixed — 32-test node:test suite |
| F4 | Hardcoded binary path, no override | Fixed — `PEON_BIN` → default → PATH-scan chain |
| F5 | Session id per-load, stale across `/new`/`/resume`/`/fork` | Fixed — per-session cache fed by `sessionManager.getSessionId()` |
| F6 | `agent_end` → `Stop` double-fires on retries | Fixed — `agent_settled` |
| F7 | `package-lock.json` not committed | Fixed — committed |
| F8 | Entry named `peon.ts` vs peer `index.ts` | Fixed — atomic rename with manifest flip |
| F9 | `package.json` lacks `"private": true` | Fixed |
| F10 | BACKLOG.md absent | Not needed — findings 4–6 fixed, nothing deferred at repo level |

## Known Issues

- The peon CLI's handling of the newer payload types (`permission_request`, `subagent_attention`, `SessionEnd`) is unaudited at the ping-behavior level — smoke-tested 2026-09-14 (all three exit 0 against the real binary); the silent-fail contract bounds any mismatch to a missing ping, never host harm.
- If `peon` is not installed and not overridable via `PEON_BIN`/`PATH`, events are silently dropped (intentional — no noise). The binary path is **no longer hardcoded**: resolution order is `PEON_BIN` → `/opt/homebrew/bin/peon` → `PATH`.
- The `execFile` call has a 5-second timeout; slow peon startup may result in dropped events.

## Decision Note

**Standalone vs merge:** Evaluated during the extension-promotion backlog review. The backlog initially suggested merging into `pi-subagents` or `pi-patty-bg-tasks`. Decided to **promote standalone** — pi-peon is a focused single-purpose bridge with zero runtime npm dependencies, and keeping it standalone allows independent iteration of the peon CLI integration without coupling to other extensions.

## License

MIT
