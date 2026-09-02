import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import {
  DSH_ENV_PREFIX,
  SENSITIVE_ENV_PATTERN,
  type SubprocessHandle,
  type SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'
import { getActiveBridge, type AnthropicBridge } from './anthropic-bridge.ts'

export const CLAUDE_PROCESS_GRACE_MS = 2_000
export const CLAUDE_STDERR_TAIL_BYTES = 32 * 1024

const ADDITIONAL_SENSITIVE_ENV_PATTERN = /(?:authorization|cookie|credential|database[_-]?url|private[_-]?key|netrc)/iu

export function scrubClaudeSpawnEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (key.toUpperCase().startsWith(DSH_ENV_PREFIX)) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (ADDITIONAL_SENSITIVE_ENV_PATTERN.test(key)) continue
    safe[key] = value
  }
  return safe
}

export class ManagedClaudeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly handle: SubprocessHandle
  #killed = false
  #exitCode: number | null = null
  #signalCode: NodeJS.Signals | null = null

  constructor(handle: SubprocessHandle) {
    super()
    if (handle.stdin === undefined || handle.stdout === undefined) {
      throw new Error('dsh-claude: managed Claude process requires piped stdin/stdout')
    }
    this.handle = handle
    this.stdin = handle.stdin
    this.stdout = handle.stdout
    void handle.done.then(
      outcome => {
        this.#exitCode = outcome.exitCode
        this.#signalCode = outcome.signal
        this.emit('exit', outcome.exitCode, outcome.signal)
      },
      error => {
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
      },
    )
  }

  get killed(): boolean {
    return this.#killed
  }

  get exitCode(): number | null {
    return this.#exitCode
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#signalCode
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.#exitCode !== null || this.#signalCode !== null) return false
    this.#killed = true
    this.handle.terminate()
    return true
  }

  stderrTail(): string {
    return this.handle.collected.stderr?.readFrom(0).text ?? ''
  }
}

export type SpawnObserver = (process: ManagedClaudeProcess, options: SpawnOptions) => void

/** Parse the model the CLI is being spawned with from its argv. The SDK hands
 *  the query's `model` option through as `--model <value>` or `--model=<value>`. */
function spawnModelArg(args: readonly string[] | undefined): string | undefined {
  if (args === undefined) return undefined
  const at = args.indexOf('--model')
  if (at >= 0 && typeof args[at + 1] === 'string') return args[at + 1]
  const inline = args.find(arg => typeof arg === 'string' && arg.startsWith('--model='))
  return inline === undefined ? undefined : inline.slice('--model='.length)
}

/** Environment overrides for a CLI about to serve a DSH model through the
 *  bridge. The `ANTHROPIC_DEFAULT_*` aliases matter because Claude Code routes
 *  background utility calls (session titles, topic detection) to those tiers
 *  regardless of the session model. */
function bridgeSpawnEnvironment(bridge: AnthropicBridge, model: string): Record<string, string> {
  const small = bridge.fallbackModel() ?? model
  return {
    ANTHROPIC_BASE_URL: bridge.url,
    ANTHROPIC_API_KEY: bridge.token,
    ANTHROPIC_AUTH_TOKEN: bridge.token,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: small,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

export function createManagedClaudeSpawner(
  runtime: Pick<SubprocessRuntime, 'spawn'>,
  executablePath: string,
  observe?: SpawnObserver,
): (options: SpawnOptions) => SpawnedProcess {
  return options => {
    if (options.command !== executablePath) {
      throw new Error(`dsh-claude: SDK requested unexpected executable ${JSON.stringify(options.command)}`)
    }
    // A session on a DSH model (`provider::model`) serves its Anthropic traffic
    // from the local bridge. The CLI's settings cascade lets a user
    // `~/.claude/settings.json` out-rank the spawn environment, so the
    // overrides travel as an inline `--settings` document (the highest
    // precedence the CLI reads) with a process-environment copy as a second
    // chance. Sessions on Claude's own models keep the user's endpoint
    // configuration untouched.
    let extraArgs: string[] = []
    let bridgeEnv: Record<string, string> | undefined
    const bridge = getActiveBridge()
    const model = spawnModelArg(options.args)
    if (bridge !== undefined && model !== undefined && model.includes('::')) {
      bridgeEnv = bridgeSpawnEnvironment(bridge, model)
      extraArgs = ['--settings', JSON.stringify({ env: bridgeEnv })]
    }
    const env = bridgeEnv === undefined
      ? scrubClaudeSpawnEnv(options.env)
      : { ...scrubClaudeSpawnEnv(options.env), ...bridgeEnv }
    const handle = runtime.spawn({
      argv: [executablePath, ...options.args, ...extraArgs],
      cwd: options.cwd ?? process.cwd(),
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: CLAUDE_STDERR_TAIL_BYTES },
      },
      graceMs: CLAUDE_PROCESS_GRACE_MS,
      signal: options.signal,
      env,
    })
    const managed = new ManagedClaudeProcess(handle)
    observe?.(managed, options)
    return managed
  }
}
