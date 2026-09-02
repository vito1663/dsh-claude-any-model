# dsh-claude-any-model

**Run the local Claude Code CLI as a first-class conversation inside DeepSeek Harness — on any model DSH has registered, not just Anthropic's.**

[English](#english) | [中文说明见下](#中文说明)

---

<a id="english"></a>

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

### Troubleshooting

- **401 `authentication_error` from the bridge** — a CLI process is running with an older bridge token. Restart the conversation (or the Host); the token is stable across restarts, so this should only happen after manually rotating it.
- **`The supported API model names are … but you passed <composite>`** — the request did not go through the bridge: your `~/.claude/settings.json` still points at a third-party endpoint and the session was not spawned with the bridge settings. Update this fork to ≥ 0.2.0 (the spawner injects `--settings`), or clear `ANTHROPIC_BASE_URL` from your `~/.claude/settings.json`.
- **The Claude group shows Claude's own models (default/opus/sonnet/haiku)** — the DSH catalog walk returned nothing; check that other providers are registered and healthy (`GET /plugins/dsh-claude/doctor` from a logged-in page).

---

<a id="中文说明"></a>

## 中文说明

**在 DeepSeek Harness（DSH）里，把本地安装的 Claude Code CLI 当作一等公民对话来用——而且可以用 DSH 里注册的任意模型，不再限于 Anthropic 自家模型。**

本仓库是 [`Norman-else/dsh-claude`](https://github.com/Norman-else/dsh-claude) 的 fork。原插件的全部能力（对话体验、仓库/worktree/PR 工作流、诊断、权限桥接等）全部保留，在此之上增加了一个**内置的 Anthropic 协议桥**：

- 模型选择器的 **Claude 分组会列出 DSH 里注册的所有支持文本的模型**，形如 `agentplan::ark-code-latest`、`kimi-coding::k3`、`deepseek-official::deepseek-v4-pro`；
- 选中任何一个，Claude Code 就跑在那个模型上；
- Claude Code 自身的 agent 循环（工具、`CLAUDE.md`、Skills、MCP、经 DSH 的权限确认）原样保留，只是背后的模型换掉了。

### 工作原理

```
DSH 会话 ──选择──> claude / agentplan::ark-code-latest
      │
      ▼
插件适配器（ClaudeCodeAdapter）
      │
      ▼
Claude Code CLI ──ANTHROPIC_BASE_URL──> 本地协议桥（仅 127.0.0.1，token 认证）
                                            │  Anthropic Messages ⇄ DSH llm.stream() 双向翻译
                                            ▼
                                   你选的那个 DSH 模型
```

- **协议桥**（`src/anthropic-bridge.ts`）：实现了 Anthropic Messages API（`POST /v1/messages`，流式 SSE 与非流式 JSON），在 Anthropic 请求与 DSH `ctx.llm.stream()` 之间双向翻译：系统提示词、工具 schema、`tool_use`/`tool_result`、thinking 块、用量、停止原因。只监听 `127.0.0.1`，端口由系统分配；token 随机生成并持久化在 `~/.dsh/anthropic-bridge-token`（重启不变，恢复会话不受 Host 重启影响）。
- **模型目录**（`src/adapter.ts`）：claude 路由的模型列表改为枚举 DSH 注册表（`provider::model` 复合 id；排除 `claude` 自身与 `*-vision` 镜像路由）。DSH 目录未就绪时回退到 Claude 自家模型列表，选择器不会空白。
- **进程拉起**（`src/spawn.ts`）：会话模型是复合 id 时，通过内联 `--settings`（CLI 中优先级最高的配置层）+ 进程环境变量双通道把 CLI 指向桥，并把后台"小模型"档位也映射到 DSH 模型。选 Claude 自家模型的会话完全不受影响。
- **认证**：桥同时接受桥 token 与你自己 `~/.claude/settings.json` 里的 `ANTHROPIC_AUTH_TOKEN`（请求时读取、绝不存储）。这是为了兼容已有第三方端点配置——CLI 的配置层级会让该文件压过注入值。套接字仅监听回环地址，信任范围仅限本机。

### 已知限制

- **图片输入**暂不支持过桥：DSH 的图片输入需要 CLI 协议不携带的附件引用，图片块会降级为文字占位。
- 用量数字按目标模型适配器的上报为准。

### 安装

前提：一个运行中的 DSH Host（Web 或桌面版），以及本地已安装并登录的 Claude Code CLI。插件不会索取或存储任何 Claude 凭证。

```sh
git clone https://github.com/vito1663/dsh-claude-any-model.git
cd dsh-claude-any-model
pnpm install && pnpm run build
dsh plugin --profile web add "link:$(pwd)"
```

新建会话 → 打开模型选择器 → **Claude** 分组里选一个 `provider::model` 即可。

完整安装/卸载流程见 [INSTALL.md](./INSTALL.md)；想参与开发请先读 [AGENTS.md](./AGENTS.md)。

### 常见问题

- **桥返回 401 `authentication_error`**：有旧 token 的 CLI 进程还在跑。重启该会话（或 Host）即可；token 跨重启稳定，只有手动轮换后才会出现。
- **报错 `The supported API model names are … but you passed <composite>`**：请求没走桥——你的 `~/.claude/settings.json` 仍指向第三方端点，且会话未带桥设置启动。升级本 fork 至 ≥ 0.2.0，或清掉 `~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL`。
- **Claude 分组只显示 default/opus/sonnet/haiku**：DSH 目录枚举为空。检查其他 provider 是否注册且健康（已登录页面访问 `GET /plugins/dsh-claude/doctor`）。

### Debug

- Host 进程环境变量 `DSH_CLAUDE_BRIDGE_DEBUG=1`：在 `~/.dsh/dsh-claude-bridge.log` 记录每个请求。
- 桥 token 文件：`~/.dsh/anthropic-bridge-token`，删除后下次启动轮换（运行中的会话需要重启）。

---

## Acknowledgements / 致谢

This project is a fork of [**dsh-claude**](https://github.com/Norman-else/dsh-claude) by **Norman-else**, licensed under the MIT License. The original plugin — running the Claude Code CLI as a first-class DSH conversation provider with its repository workflow, permission bridge, sidecar renderer, and doctor diagnostics — is entirely the original author's work; this fork only adds the Anthropic-protocol bridge and the DSH model catalog integration on top of it.

本项目 fork 自 **Norman-else** 的 [**dsh-claude**](https://github.com/Norman-else/dsh-claude)（MIT License）。原插件将 Claude Code CLI 变成 DSH 一等公民对话提供者的全部设计——仓库工作流、权限桥、sidecar 渲染、doctor 诊断——都是原作者的工作；本 fork 只是在其上增加了 Anthropic 协议桥与 DSH 模型目录集成。

## License

MIT — see [LICENSE](./LICENSE). / 见 [LICENSE](./LICENSE)。
