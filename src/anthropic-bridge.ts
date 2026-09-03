/** Anthropic Messages-API bridge: run Claude Code on any model DSH has registered.
 *
 * Claude Code only speaks the Anthropic protocol. When a session picks a DSH
 * model through this plugin's provider (model ids of the form
 * `provider::model`), the spawned CLI is pointed at this local bridge instead
 * of its usual endpoint; the bridge translates each Anthropic Messages request
 * into a DSH {@link GenerateOptions} call on the chosen provider/model and
 * streams the DSH chunks back as Anthropic SSE.
 *
 * The bridge listens on `127.0.0.1` only, on an OS-assigned port, with a random
 * per-install token persisted under `~/.dsh/`. On top of the bridge token it
 * also accepts the `ANTHROPIC_AUTH_TOKEN` found in the user's own
 * `~/.claude/settings.json`: that file out-ranks the spawn environment inside
 * the CLI's settings cascade, so a user with a pre-existing third-party
 * endpoint configuration would otherwise authenticate with that key no matter
 * what the spawner injects. Accepting the user's own key keeps those setups
 * working; nothing off-host can reach the socket.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import {
  MessageId,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'

/** Structural slice of the DSH LlmRuntime the bridge needs. `LlmRuntime`
 *  satisfies this shape. */
export interface DshModelCatalog {
  listProviders(): readonly { id: string, name?: string }[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

interface CatalogRow {
  readonly composite: string
  readonly provider: string
  readonly model: string
  readonly name: string
  readonly description: string
}

interface ModelTarget {
  readonly provider: string
  readonly model: string
}

interface AnthropicContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface AnthropicMessageInput {
  role?: unknown
  content?: unknown
}

interface AnthropicRequestBody {
  model?: unknown
  messages?: readonly AnthropicMessageInput[]
  system?: unknown
  tools?: readonly { name?: unknown, description?: unknown, input_schema?: unknown }[]
  temperature?: unknown
  stop_sequences?: unknown
  stream?: unknown
}

const CATALOG_TTL_MS = 60_000
const MAX_BODY_BYTES = 64 * 1024 * 1024
/** Vision-router style mirror routes re-advertise other providers' models; the
 *  base route already lists them here. */
const VISION_ROUTE_SUFFIX = /-vision$/u

let catalogCache: { at: number, rows: readonly CatalogRow[] } = { at: 0, rows: [] }

/** Enumerate every text-capable model registered in DSH, as `provider::model`
 *  rows. Cached briefly: the selector refresh and the fallback resolver both
 *  land here, and a cold registry should not cost a catalog walk per call. */
export async function enumerateDshModels(llm: DshModelCatalog, force = false): Promise<readonly CatalogRow[]> {
  const now = Date.now()
  if (!force && catalogCache.rows.length > 0 && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.rows
  const providers = llm.listProviders().filter(provider =>
    typeof provider?.id === 'string'
    && provider.id.length > 0
    && provider.id !== 'claude'
    && !VISION_ROUTE_SUFFIX.test(provider.id),
  )
  const rows: CatalogRow[] = []
  for (const provider of providers) {
    let models: readonly LlmModelInfo[]
    try {
      models = await llm.listModels(provider.id)
    } catch {
      continue
    }
    for (const model of models) {
      if (typeof model?.id !== 'string' || model.id.length === 0) continue
      const modalities = model.inputModalities
      if (modalities !== undefined && modalities.length > 0 && !modalities.includes('text')) continue
      rows.push({
        composite: `${provider.id}::${model.id}`,
        provider: provider.id,
        model: model.id,
        name: model.name.length > 0 ? model.name : model.id,
        description: provider.name ?? provider.id,
      })
    }
  }
  catalogCache = { at: now, rows }
  return rows
}

/** Bridge token, stable across Host restarts so surviving Claude Code
 *  processes keep authenticating while their sessions are resumed. */
function readOrCreateToken(): string {
  const tokenPath = join(homedir(), '.dsh', 'anthropic-bridge-token')
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim()
    if (existing.length >= 20) {
      // Tokens written by earlier versions may be world-readable; tighten them
      // in passing. Best effort only — a read-only home still works.
      try { chmodSync(tokenPath, 0o600) } catch {}
      return existing
    }
  } catch {}
  const token = randomBytes(24).toString('base64url')
  try {
    // Owner-only: on a multi-user host the default 0644 would let every local
    // account read the loopback bridge's credentials.
    writeFileSync(tokenPath, token, { mode: 0o600 })
  } catch {}
  return token
}

/** The auth token the user's own `~/.claude/settings.json` injects into every
 *  CLI session, if any. Accepted beside the bridge token: the CLI's settings
 *  cascade lets that file out-rank the spawn environment, so a pre-existing
 *  endpoint configuration would keep sending its key here no matter what the
 *  spawner injects. The socket is loopback-only, so this stays a local trust. */
function readHostAuthToken(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as {
      env?: { ANTHROPIC_AUTH_TOKEN?: unknown }
    }
    const value = parsed?.env?.ANTHROPIC_AUTH_TOKEN
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => typeof block === 'object' && block !== null && (block as AnthropicContentBlock).type === 'text'
      && typeof (block as AnthropicContentBlock).text === 'string'
      ? (block as AnthropicContentBlock).text as string
      : '')
    .filter(text => text.length > 0)
    .join('\n')
}

function toolResultContent(result: AnthropicContentBlock): ContentBlock[] {
  const raw = result.content
  if (typeof raw === 'string') return [{ type: 'text', text: raw }]
  if (Array.isArray(raw)) {
    const out: ContentBlock[] = []
    for (const block of raw) {
      if (typeof block === 'object' && block !== null && (block as AnthropicContentBlock).type === 'text'
        && typeof (block as AnthropicContentBlock).text === 'string') {
        out.push({ type: 'text', text: (block as AnthropicContentBlock).text as string })
      } else if (typeof block === 'object' && block !== null && (block as AnthropicContentBlock).type === 'image') {
        out.push({ type: 'text', text: '[image: image input is not supported through the bridge yet]' })
      }
    }
    if (out.length > 0) return out
  }
  return [{ type: 'text', text: '' }]
}

/** Translate an Anthropic Messages body into DSH generate options. Images are
 *  not yet forwardable: DSH image input needs an attachment reference the CLI
 *  protocol does not carry, so image blocks degrade to a text note. */
export function buildGenerateOptions(body: AnthropicRequestBody, target: ModelTarget): GenerateOptions {
  const messages: Message[] = []
  for (const item of body.messages ?? []) {
    const role = item?.role
    const raw = item?.content
    const blocks: readonly AnthropicContentBlock[] = typeof raw === 'string'
      ? [{ type: 'text', text: raw }]
      : Array.isArray(raw) ? raw as readonly AnthropicContentBlock[] : []
    if (role === 'user') {
      const textParts: string[] = []
      const toolResults: AnthropicContentBlock[] = []
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
        else if (block?.type === 'tool_result') toolResults.push(block)
        else if (block?.type === 'image') textParts.push('[image: image input is not supported through the bridge yet]')
      }
      // Tool results answer the previous assistant turn, so they lead the text.
      for (const result of toolResults) {
        messages.push(createToolResultMessage({
          callId: ToolCallId(typeof result.tool_use_id === 'string' && result.tool_use_id.length > 0 ? result.tool_use_id : `bridge_${randomUUID()}`),
          content: toolResultContent(result),
          isError: result.is_error === true,
        }))
      }
      const text = textParts.filter(part => part.length > 0).join('\n\n')
      if (text.length > 0) {
        messages.push(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      }
    } else if (role === 'assistant') {
      const out: (Extract<ContentBlock, { type: 'text' }> | Extract<ContentBlock, { type: 'tool-call' }>)[] = []
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          out.push({ type: 'text', text: block.text })
        } else if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          out.push({
            type: 'tool-call',
            id: ToolCallId(block.id),
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
          })
        }
      }
      if (out.length > 0) {
        messages.push(createAssistantMessage({
          content: out,
          // The helper fixes `kind` to 'model' itself; only the provenance is
          // caller-supplied.
          source: { provider: target.provider, model: target.model },
        }))
      }
    }
  }
  const systemText = blocksText(body.system)
  const tools: ToolSchema[] = (body.tools ?? [])
    .filter((tool): tool is { name: string, description?: unknown, input_schema?: unknown } => typeof tool?.name === 'string')
    .map(tool => ({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.input_schema !== null && typeof tool.input_schema === 'object'
        ? tool.input_schema as ToolSchema['parameters']
        : { type: 'object' },
    }))
  return {
    provider: target.provider,
    model: target.model,
    messages,
    ...(systemText.length > 0 ? { system: systemText } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0
      ? { stop: body.stop_sequences.filter((value): value is string => typeof value === 'string') }
      : {}),
  }
}

type AnthropicStopReason = 'end_turn' | 'tool_use' | 'max_tokens'

function stopReasonFor(kind: string | undefined): AnthropicStopReason {
  if (kind === 'tool-calls') return 'tool_use'
  if (kind === 'max-tokens') return 'max_tokens'
  return 'end_turn'
}

function usageOf(usage: TokenUsage | undefined, current: { input_tokens: number, output_tokens: number }): void {
  if (usage === undefined) return
  if (typeof usage.inputTokens === 'number') current.input_tokens = usage.inputTokens
  if (typeof usage.outputTokens === 'number') current.output_tokens = usage.outputTokens
}

interface SinkEntry {
  readonly anthropicIndex: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  id: string
  name: string
  text: string
  thinking: string
  args: string
}

/** Block accounting shared by the streaming and aggregate translations: DSH
 *  block indexes map to Anthropic content-block indexes in first-seen order. */
class BlockSink {
  readonly blocks = new Map<number, SinkEntry>()
  #nextIndex = 0

  announce(dshIndex: number, kind: SinkEntry['kind'], extra: { id?: string, name?: string } = {}): SinkEntry {
    const entry: SinkEntry = {
      anthropicIndex: this.#nextIndex++,
      kind,
      id: '',
      name: '',
      text: '',
      thinking: '',
      args: '',
      ...extra,
    }
    this.blocks.set(dshIndex, entry)
    return entry
  }

  entry(dshIndex: number): SinkEntry | undefined {
    return this.blocks.get(dshIndex)
  }

  get announced(): number {
    return this.#nextIndex
  }
}

function aggregatedContent(sink: BlockSink): AnthropicContentBlock[] {
  const content: AnthropicContentBlock[] = []
  for (const entry of sink.blocks.values()) {
    if (entry.kind === 'text' && entry.text.length > 0) content.push({ type: 'text', text: entry.text })
    else if (entry.kind === 'reasoning' && entry.thinking.length > 0) content.push({ type: 'thinking', thinking: entry.thinking })
    else if (entry.kind === 'tool-call') {
      let input: unknown = {}
      try {
        input = JSON.parse(entry.args.length > 0 ? entry.args : '{}') as unknown
      } catch {}
      content.push({ type: 'tool_use', id: entry.id.length > 0 ? entry.id : `toolu_${randomUUID()}`, name: entry.name, input })
    }
  }
  return content
}

/** One live bridge. Held module-side so the spawner can route composite models
 *  without threading the bridge through the supervisor. */
export interface AnthropicBridge {
  /** Loopback base URL requests should be pointed at. */
  readonly url: string
  /** Secret the spawned CLI authenticates with. */
  readonly token: string
  /** First DSH composite id, for the CLI's background utility calls. */
  fallbackModel(): string | undefined
  close(): Promise<void>
}

let activeBridge: AnthropicBridge | undefined

/** The bridge this Host process is serving, if it started cleanly. */
export function getActiveBridge(): AnthropicBridge | undefined {
  return activeBridge
}

function setActiveBridge(bridge: AnthropicBridge | undefined): void {
  activeBridge = bridge
}

export { setActiveBridge }

export interface CreateAnthropicBridgeOptions {
  readonly llm: DshModelCatalog
  /** Host-process log sink (the cordis logger); startup, fallbacks, 401s. */
  readonly log?: (message: string) => void
  /** Verbose per-request log under `~/.dsh/`; off by default. */
  readonly debug?: boolean
}

/** Start the loopback bridge and publish it for the spawner. */
export async function startAnthropicBridge(options: CreateAnthropicBridgeOptions): Promise<AnthropicBridge> {
  const { llm, debug = false } = options
  const log = options.log ?? (() => {})
  const token = readOrCreateToken()

  const appendDebug = (message: string): void => {
    if (!debug) return
    try {
      appendFileSync(join(homedir(), '.dsh', 'dsh-claude-bridge.log'), `${new Date().toISOString()} ${message}\n`)
    } catch {}
  }

  async function resolveTarget(bodyModel: unknown): Promise<ModelTarget | undefined> {
    const rows = await enumerateDshModels(llm).catch(() => [])
    if (typeof bodyModel === 'string' && bodyModel.includes('::')) {
      const at = bodyModel.indexOf('::')
      const provider = bodyModel.slice(0, at)
      const model = bodyModel.slice(at + 2)
      if (provider.length > 0 && model.length > 0) return { provider, model }
    }
    if (rows.length > 0) {
      log(`dsh-claude bridge: model ${JSON.stringify(bodyModel)} is not a DSH composite; falling back to ${rows[0]!.composite}`)
      return { provider: rows[0]!.provider, model: rows[0]!.model }
    }
    return undefined
  }

  function authorized(req: IncomingMessage): boolean {
    const hostKey = readHostAuthToken()
    const apiKey = req.headers['x-api-key']
    const authorization = req.headers.authorization
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined
    const matches = (value: string | undefined): boolean =>
      value !== undefined && (value === token || (hostKey.length > 10 && value === hostKey))
    return matches(typeof apiKey === 'string' ? apiKey : undefined) || matches(bearer)
  }

  /** An upstream stream that ends without a single block is never a useful
   *  answer — surfaced as a retryable api_error instead of an empty message
   *  the CLI can only report as `last_content_type=none`. */
  const EMPTY_UPSTREAM_RESPONSE = 'upstream model returned an empty response (no content blocks); the model endpoint may be degraded — retry, or switch models'

  function replyError(res: ServerResponse, status: number, type: string, message: string): void {
    if (res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type, message } }))
  }

  function sseSend(res: ServerResponse, event: string, data: unknown): void {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  async function handleStream(res: ServerResponse, body: AnthropicRequestBody, generate: GenerateOptions, signal: AbortSignal): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const usage = { input_tokens: 0, output_tokens: 0 }
    const sink = new BlockSink()
    let stopReason: AnthropicStopReason = 'end_turn'
    sseSend(res, 'message_start', {
      type: 'message_start',
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    const announce = (dshIndex: number, kind: SinkEntry['kind'], extra: { id?: string, name?: string } = {}): SinkEntry => {
      const entry = sink.announce(dshIndex, kind, extra)
      if (entry.kind === 'text') {
        sseSend(res, 'content_block_start', { type: 'content_block_start', index: entry.anthropicIndex, content_block: { type: 'text', text: '' } })
      } else if (entry.kind === 'reasoning') {
        sseSend(res, 'content_block_start', { type: 'content_block_start', index: entry.anthropicIndex, content_block: { type: 'thinking', thinking: '' } })
      } else {
        sseSend(res, 'content_block_start', {
          type: 'content_block_start',
          index: entry.anthropicIndex,
          content_block: { type: 'tool_use', id: entry.id, name: entry.name, input: {} },
        })
      }
      return entry
    }
    /** Tool calls announce on their first delta, where the id arrives; a
     *  block-end without deltas carries the complete call instead. */
    const toolStart = (dshIndex: number, id: string | undefined, name: string | undefined): SinkEntry => {
      return sink.entry(dshIndex)
        ?? announce(dshIndex, 'tool-call', { id: id ?? `toolu_${randomUUID()}`, name: name ?? 'tool' })
    }
    try {
      for await (const chunk of llm.stream({ ...generate, signal })) {
        if (res.writableEnded) return
        if (chunk.type === 'block-start') {
          if (chunk.blockType === 'text') announce(chunk.index, 'text')
          else if (chunk.blockType === 'reasoning') announce(chunk.index, 'reasoning')
        } else if (chunk.type === 'text-delta') {
          const entry = sink.entry(chunk.index)
          if (entry !== undefined) {
            entry.text += chunk.text
            sseSend(res, 'content_block_delta', { type: 'content_block_delta', index: entry.anthropicIndex, delta: { type: 'text_delta', text: chunk.text } })
          }
        } else if (chunk.type === 'reasoning-delta') {
          const entry = sink.entry(chunk.index)
          if (entry !== undefined) {
            entry.thinking += chunk.text
            sseSend(res, 'content_block_delta', { type: 'content_block_delta', index: entry.anthropicIndex, delta: { type: 'thinking_delta', thinking: chunk.text } })
          }
        } else if (chunk.type === 'tool-call-delta') {
          const entry = toolStart(chunk.index, chunk.id, chunk.name)
          if (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0) {
            entry.args += chunk.argumentsDelta
            sseSend(res, 'content_block_delta', { type: 'content_block_delta', index: entry.anthropicIndex, delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta } })
          }
        } else if (chunk.type === 'block-end') {
          const entry = sink.entry(chunk.index)
          const block = chunk.block
          if (entry === undefined && block?.type === 'tool-call') {
            const started = toolStart(chunk.index, block.id, block.name)
            started.args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
            sseSend(res, 'content_block_delta', { type: 'content_block_delta', index: started.anthropicIndex, delta: { type: 'input_json_delta', partial_json: started.args } })
          }
          if (entry !== undefined) sseSend(res, 'content_block_stop', { type: 'content_block_stop', index: entry.anthropicIndex })
        } else if (chunk.type === 'usage') {
          usageOf(chunk.usage, usage)
        } else if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error') {
            // An upstream failure is never a normal end of stream, whatever
            // already arrived: closing as `end_turn` would hand the CLI a
            // truncated message dressed up as a complete answer.
            sseSend(res, 'error', { type: 'error', error: { type: 'api_error', message: chunk.reason?.failure?.message ?? 'model call failed' } })
            res.end()
            return
          }
          stopReason = stopReasonFor(kind)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (sink.announced === 0) {
        replyError(res, 500, 'api_error', message)
        return
      }
      sseSend(res, 'error', { type: 'error', error: { type: 'api_error', message } })
    }
    if (sink.announced === 0) {
      // The upstream completed without yielding a single block. As a 200
      // message this would only become an empty assistant turn the CLI
      // reports as an opaque `last_content_type=none` diagnostic; an explicit
      // api_error is retryable by the CLI and names the real cause.
      sseSend(res, 'error', { type: 'error', error: { type: 'api_error', message: EMPTY_UPSTREAM_RESPONSE } })
      res.end()
      return
    }
    sseSend(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
    sseSend(res, 'message_stop', { type: 'message_stop' })
    res.end()
  }

  async function handleAggregate(res: ServerResponse, body: AnthropicRequestBody, generate: GenerateOptions, signal: AbortSignal): Promise<void> {
    const usage = { input_tokens: 0, output_tokens: 0 }
    const sink = new BlockSink()
    let stopReason: AnthropicStopReason = 'end_turn'
    try {
      for await (const chunk of llm.stream({ ...generate, signal })) {
        if (chunk.type === 'block-start') {
          sink.announce(chunk.index, chunk.blockType === 'text' ? 'text' : chunk.blockType === 'reasoning' ? 'reasoning' : 'tool-call')
        } else if (chunk.type === 'text-delta') {
          const entry = sink.entry(chunk.index)
          if (entry !== undefined) entry.text += chunk.text
        } else if (chunk.type === 'reasoning-delta') {
          const entry = sink.entry(chunk.index)
          if (entry !== undefined) entry.thinking += chunk.text
        } else if (chunk.type === 'tool-call-delta') {
          const entry = sink.entry(chunk.index)
            ?? sink.announce(chunk.index, 'tool-call', { id: chunk.id ?? `toolu_${randomUUID()}`, name: chunk.name ?? 'tool' })
          if (typeof chunk.argumentsDelta === 'string') entry.args += chunk.argumentsDelta
        } else if (chunk.type === 'block-end') {
          const entry = sink.entry(chunk.index)
          const block = chunk.block
          if (entry === undefined && block?.type === 'tool-call') {
            const created = sink.announce(chunk.index, 'tool-call', { id: block.id ?? `toolu_${randomUUID()}`, name: block.name ?? 'tool' })
            created.args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
          }
        } else if (chunk.type === 'usage') {
          usageOf(chunk.usage, usage)
        } else if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error') {
            // Same contract as the stream path: an upstream failure must not
            // degrade into a 200 message with `end_turn`.
            replyError(res, 500, 'api_error', chunk.reason.failure?.message ?? 'model call failed')
            return
          }
          stopReason = stopReasonFor(chunk.reason?.kind)
        }
      }
    } catch (error) {
      replyError(res, 500, 'api_error', error instanceof Error ? error.message : String(error))
      return
    }
    if (sink.announced === 0) {
      replyError(res, 500, 'api_error', EMPTY_UPSTREAM_RESPONSE)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: aggregatedContent(sink),
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    }))
  }

  const server: Server = createServer((req, res) => {
    appendDebug(`${req.method} ${req.url}`)
    if (req.method !== 'POST' || typeof req.url !== 'string'
      || !(req.url === '/v1/messages' || req.url.startsWith('/v1/messages?'))) {
      replyError(res, 404, 'not_found_error', 'use POST /v1/messages')
      return
    }
    if (!authorized(req)) {
      const apiKey = req.headers['x-api-key']
      const authorization = req.headers.authorization
      log(`dsh-claude bridge: 401 for ${req.url}; got ${
        typeof apiKey === 'string' ? `x-api-key ${apiKey.slice(0, 6)}…`
        : typeof authorization === 'string' ? `authorization ${authorization.slice(0, 10)}…`
        : 'no credentials'} (bridge token ${token.slice(0, 6)}…)`)
      replyError(res, 401, 'authentication_error', 'invalid bridge token')
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let clientGone = false
    // Disconnect lands before any await: a client that gives up while the
    // catalog resolves must not leave its model call running behind it.
    // `req` 'close' fires as soon as the body is fully read, so true aborts
    // are detected on the RESPONSE side — exactly how the route wrapper tells
    // a disconnect from a completed request.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true
        controller.abort(new Error('dsh-claude bridge: client disconnected'))
      }
    })
    req.on('data', chunk => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer)
    })
    req.on('error', () => {
      clientGone = true
    })
    req.on('end', () => {
      void (async () => {
        if (clientGone) return
        let body: AnthropicRequestBody
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AnthropicRequestBody
        } catch (error) {
          replyError(res, 400, 'invalid_request_error', `request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        const target = await resolveTarget(body.model).catch(() => undefined)
        if (target === undefined) {
          replyError(res, 400, 'invalid_request_error', `no DSH model is available for ${JSON.stringify(body.model)}`)
          return
        }
        appendDebug(`body.model=${JSON.stringify(body.model)} -> ${target.provider}::${target.model}`)
        const generate = buildGenerateOptions(body, target)
        if (clientGone) return
        if (body.stream === true) await handleStream(res, body, generate, controller.signal)
        else await handleAggregate(res, body, generate, controller.signal)
      })().catch(error => {
        replyError(res, 500, 'api_error', error instanceof Error ? error.message : String(error))
      })
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  // The CLI's background utility calls land on whatever ANTHROPIC_SMALL_FAST_MODEL
  // says; pre-warm the catalog so that fallback exists by the first spawn.
  void enumerateDshModels(llm, true).catch(() => {})
  const bridge: AnthropicBridge = {
    url: `http://127.0.0.1:${port}`,
    token,
    fallbackModel: () => catalogCache.rows[0]?.composite,
    close: () => new Promise((resolve, reject) => {
      // Keep-alive sockets (the CLI's fetch agent holds one) would hold
      // `close` open; the bridge is going away, so drop them all.
      server.closeAllConnections()
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
  setActiveBridge(bridge)
  return bridge
}
