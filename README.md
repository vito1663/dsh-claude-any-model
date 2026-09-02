# dsh-claude-any-model

**Run the local Claude Code CLI as a first-class conversation inside DeepSeek Harness — on any model DSH has registered, not just Anthropic's.**

[English](./README.md) | [中文说明](./README.zh-CN.md)

---

## What this fork adds

This is a fork of [`Norman-else/dsh-claude`](https://github.com/Norman-else/dsh-claude), which runs the locally installed Claude Code CLI as a first-class conversation provider inside DeepSeek Harness (DSH). All of the original plugin's capabilities are preserved — see the original repository for the full feature list (conversation, repository/worktree/PR workflows, diagnostics, permission bridges, and more).

On top of that, this fork adds a **built-in Anthropic-protocol bridge**, so the model picker's **Claude group lists every text-capable model registered in DSH** — for example `ark::ark-code-latest`, `kimi-coding::k3`, `deepseek-official::deepseek-v4-pro` — and picking one runs Claude Code on that model:

```
DSH session ──selects──> claude / agentplan::ark-code-latest
      │
      ▼
ClaudeCodeAdapter (plugin)
      │
      ▼
Claude Code CLI  ──ANTHROPIC_BASE_URL──>  local bridge (127.0.0.1, token-authenticated)
                                                │  translates Anthropic Messages ⇄ DSH llm.stream()
                                                ▼
                                     the DSH-registered model you picked
```

The CLI keeps its whole agent loop — tools, `CLAUDE.md`, Skills, MCP servers, permission prompts through DSH. Only the model behind it changes.

### How it works

- `src/anthropic-bridge.ts` — a loopback HTTP server implementing the Anthropic Messages API (`POST /v1/messages`, streaming SSE and non-streaming JSON). It translates between Anthropic requests and DSH `ctx.llm.stream()` calls: system prompts, tool schemas, assistant `tool_use` blocks, `tool_result` messages, thinking blocks, usage, and stop reasons. The bridge binds to `127.0.0.1` only, on an OS-assigned port, with a random per-install token persisted at `~/.dsh/anthropic-bridge-token` (stable across restarts, so resumed sessions survive Host restarts).
- `src/adapter.ts` — the Claude provider's model catalog now enumerates the DSH registry (`provider::model` composite ids; the `claude` route itself and `*-vision` mirror routes are excluded). Claude's own lineup remains as the fallback before the DSH catalog is warm.
- `src/spawn.ts` — when a session model is a composite, the spawner points the CLI at the bridge via an inline `--settings` document (the highest-precedence settings layer in the CLI) plus a process-environment copy, and aliases the background "small/fast model" tiers to a DSH model as well. Sessions on Claude's own models are untouched.
- Bridge authentication accepts the bridge token **and** the `ANTHROPIC_AUTH_TOKEN` from your own `~/.claude/settings.json` (read at request time, never stored). This is what keeps pre-existing third-party endpoint configurations working — the CLI's settings cascade lets that file out-rank anything the spawner injects. The socket is loopback-only, so this stays a local trust.

### Known limitations

- **Image input** is not forwardable through the bridge yet: DSH image input needs an attachment reference the CLI protocol does not carry. Image blocks degrade to a text note.
- The bridge routes one DSH model call per Anthropic request; token usage is reported as reported by the target model's adapter.

### Install

Requirements: a running DSH Host (Web or Desktop), and a locally installed, already-authenticated Claude Code CLI. The plugin never asks for or stores Claude credentials.

```sh
git clone https://github.com/vito1663/dsh-claude-any-model.git
cd dsh-claude-any-model
pnpm install && pnpm run build
dsh plugin --profile web add "link:$(pwd)"
```

Then create a conversation, open the model picker, and pick a model from the **Claude** group — every row is a DSH model, shown as `provider::model`. What you see matches what your DSH actually has.

See [INSTALL.md](./INSTALL.md) for the full runbook, and [AGENTS.md](./AGENTS.md) for the codebase conventions if you want to contribute.

### Configuration

- `DSH_CLAUDE_BRIDGE_DEBUG=1` (Host process environment) enables a verbose per-request bridge log at `~/.dsh/dsh-claude-bridge.log`.
- Bridge token file: `~/.dsh/anthropic-bridge-token`. Delete it to rotate the token on next start (running sessions will need to be restarted).
- **Remote access domains** (Settings → Claude Code → Allowed access domains): by default the plugin's own HTTP routes (doctor, settings, repository panels, the live projection stream) answer only to `127.0.0.1` / `localhost`. Hosts listed in the Host's `dsh web --trusted-host` flag are accepted automatically. Extra domains can be added as a comma-separated list in the plugin settings (or edited directly in `~/.dsh/plugins/dsh-claude/settings.json`, key `trustedOrigins`; applies on the next request without a restart). Every non-loopback request must additionally carry a valid dsh web login session — the plugin re-verifies the request's session cookie with the Host over loopback before serving it, so anonymous internet traffic to a public domain stays rejected.

### Troubleshooting

- **401 `authentication_error` from the bridge** — a CLI process is running with an older bridge token. Restart the conversation (or the Host); the token is stable across restarts, so this should only happen after manually rotating it.
- **`The supported API model names are … but you passed <composite>`** — the request did not go through the bridge: your `~/.claude/settings.json` still points at a third-party endpoint and the session was not spawned with the bridge settings. Update this fork to ≥ 0.2.0 (the spawner injects `--settings`), or clear `ANTHROPIC_BASE_URL` from your `~/.claude/settings.json`.
- **The Claude group shows Claude's own models (default/opus/sonnet/haiku)** — the DSH catalog walk returned nothing; check that other providers are registered and healthy (`GET /plugins/dsh-claude/doctor` from a logged-in page).
- **Settings panels or the live Claude transcript fail with `forbidden`** — you are reaching dsh through a domain that is neither loopback nor allowlisted (for example a reverse-proxy domain). Add the domain via `dsh web --trusted-host <domain>` (accepted automatically) or in Settings → Claude Code → Allowed access domains, and make sure you are logged into dsh web in that browser (the plugin verifies the dsh session before serving non-loopback requests).

---

## Acknowledgements

This project is a fork of [**dsh-claude**](https://github.com/Norman-else/dsh-claude) by **Norman-else**, licensed under the MIT License. The original plugin — running the Claude Code CLI as a first-class DSH conversation provider with its repository workflow, permission bridge, sidecar renderer, and doctor diagnostics — is entirely the original author's work; this fork only adds the Anthropic-protocol bridge and the DSH model catalog integration on top of it.

## License

MIT — see [LICENSE](./LICENSE).
