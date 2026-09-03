# dsh-claude-any-model

**在 DeepSeek Harness（DSH）里，把本地安装的 Claude Code CLI 当作一等公民对话来用——而且可以用 DSH 里注册的任意模型，不再限于 Anthropic 自家模型。**

[English](./README.md) | [中文说明](./README.zh-CN.md)

---

## 本 fork 新增了什么

本仓库是 [`Norman-else/dsh-claude`](https://github.com/Norman-else/dsh-claude) 的 fork。原插件把本地安装的 Claude Code CLI 变成 DeepSeek Harness（DSH）里的一等公民对话提供者，其全部能力（对话体验、仓库/worktree/PR 工作流、诊断、权限桥接等）在本 fork 中完整保留，完整功能列表见原仓库。

在此之上，本 fork 增加了一个**内置的 Anthropic 协议桥**，让模型选择器的 **Claude 分组列出 DSH 里注册的所有支持文本的模型**——例如 `ark::ark-code-latest`、`kimi-coding::k3`、`deepseek-official::deepseek-v4-pro`——选中哪一个，Claude Code 就跑在哪个模型上：

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

Claude Code 自身的 agent 循环（工具、`CLAUDE.md`、Skills、MCP、经 DSH 的权限确认）原样保留，只是背后的模型换掉了。

### 工作原理

- **协议桥**（`src/anthropic-bridge.ts`）：实现了 Anthropic Messages API（`POST /v1/messages`，流式 SSE 与非流式 JSON）的回环 HTTP 服务器，在 Anthropic 请求与 DSH `ctx.llm.stream()` 调用之间双向翻译：系统提示词、工具 schema、`tool_use`/`tool_result`、thinking 块、用量、停止原因。只监听 `127.0.0.1`，端口由系统分配；token 随机生成并持久化在 `~/.dsh/anthropic-bridge-token`（重启不变，恢复会话不受 Host 重启影响）。
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

新建会话 → 打开模型选择器 → **Claude** 分组里选一个 `provider::model` 即可，列表与你的 DSH 实际注册的模型一致。

完整安装/卸载流程见 [INSTALL.md](./INSTALL.md)；想参与开发请先读 [AGENTS.md](./AGENTS.md)。

### 配置

- Host 进程环境变量 `DSH_CLAUDE_BRIDGE_DEBUG=1`：在 `~/.dsh/dsh-claude-bridge.log` 记录每个请求的详细日志。
- 桥 token 文件：`~/.dsh/anthropic-bridge-token`，删除后下次启动轮换（运行中的会话需要重启）。
- **允许的访问域名**（设置 → Claude Code）：默认情况下，插件自己的 HTTP 路由（诊断、设置、仓库面板、实时过程流）只接受 `127.0.0.1` / `localhost` 访问。`dsh web --trusted-host` 里列出的域名自动放行；额外域名可以在插件设置里以逗号分隔填写（也可直接编辑 `~/.dsh/plugins/dsh-claude/settings.json` 的 `trustedOrigins` 字段，下个请求即生效，无需重启）。所有非本机请求还必须携带有效的 dsh web 登录会话——插件会把请求的会话 Cookie 在本机回环上向 dsh 复验后才响应，公网上的匿名访问依然会被拒绝。

### 常见问题

- **桥返回 401 `authentication_error`**：有旧 token 的 CLI 进程还在跑。重启该会话（或 Host）即可；token 跨重启稳定，只有手动轮换后才会出现。
- **报错 `The supported API model names are … but you passed <composite>`**：请求没走桥——你的 `~/.claude/settings.json` 仍指向第三方端点，且会话未带桥设置启动。升级本 fork 至 ≥ 0.2.0，或清掉 `~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL`。
- **Claude 分组只显示 default/opus/sonnet/haiku**：DSH 目录枚举为空。检查其他 provider 是否注册且健康（已登录页面访问 `GET /plugins/dsh-claude/doctor`）。
- **设置页或实时转录报 `forbidden`**：你是通过一个既非本机回环、也未放行的域名访问 dsh（例如反向代理域名）。用 `dsh web --trusted-host <域名>` 启动（自动放行），或在 设置 → Claude Code → 允许的访问域名 里添加该域名，并确认浏览器已登录 dsh web（插件响应非本机请求前会先校验 dsh 会话）。
- **一轮对话失败，报 `result_type=assistant last_content_type=none stop_reason=end_turn`**（≥ 0.2.2 会直接显示真实原因）——模型上游端点返回了空响应：流结束了却没有任何内容块，通常是上游服务过载或故障。先重试本轮；仍失败就切换模型或新开会话。桥（≥ 0.2.2）会把它作为可重试的 `api_error` 上报，CLI 会自动重试而不是静默失败。

---

## 致谢

本项目 fork 自 **Norman-else** 的 [**dsh-claude**](https://github.com/Norman-else/dsh-claude)（MIT License）。原插件将 Claude Code CLI 变成 DSH 一等公民对话提供者的全部设计——仓库工作流、权限桥、sidecar 渲染、doctor 诊断——都是原作者的工作；本 fork 只是在其上增加了 Anthropic 协议桥与 DSH 模型目录集成。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
