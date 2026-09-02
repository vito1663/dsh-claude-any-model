/** Contract tests for the Anthropic bridge: what the CLI sends is what a DSH
 *  model receives, and what the model streams is what the CLI parses. The
 *  SSE shapes here are the ones Claude Code's SDK client actually keys on. */
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildGenerateOptions, enumerateDshModels, startAnthropicBridge, type DshModelCatalog } from '../src/anthropic-bridge.ts'
import { createManagedClaudeSpawner } from '../src/spawn.ts'
import { setActiveBridge, getActiveBridge } from '../src/anthropic-bridge.ts'

const PROVIDERS = [
  { id: 'ark', name: 'Volcano Ark' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'ark-vision', name: 'Ark Vision twin' },
  { id: 'kimi', name: 'Kimi' },
]

const MODELS: Record<string, readonly LlmModelInfo[]> = {
  ark: [
    { provider: 'ark', id: 'ark-code-latest', name: 'Ark Code Latest', inputModalities: ['text', 'image'] },
    { provider: 'ark', id: 'ark-image-only', name: 'Image Only', inputModalities: ['image'] },
  ],
  kimi: [{ provider: 'kimi', id: 'k3', name: 'Kimi K3' }],
  // The vision twin re-advertises the base route's models; enumerateDshModels
  // drops the whole route so the selector does not list them twice.
  'ark-vision': [{ provider: 'ark-vision', id: 'ark-code-latest', name: 'Ark Code Latest' }],
}

function catalog(stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> = async function* () {}): DshModelCatalog {
  return {
    listProviders: () => PROVIDERS,
    listModels: provider => Promise.resolve(MODELS[provider] ?? []),
    stream,
  }
}

describe('enumerateDshModels', () => {
  it('lists every text model as a composite, dropping the claude route, vision twins, and non-text models', async () => {
    const rows = await enumerateDshModels(catalog(), true)
    expect(rows.map(row => row.composite)).toEqual(['ark::ark-code-latest', 'kimi::k3'])
  })

  it('names a model after the model id when the registry omits a name, with the provider as description', async () => {
    const rows = await enumerateDshModels(catalog(), true)
    expect(rows.find(row => row.composite === 'kimi::k3')).toMatchObject({ name: 'Kimi K3', description: 'Kimi' })
  })
})

describe('buildGenerateOptions', () => {
  const target = { provider: 'ark', model: 'ark-code-latest' }

  it('maps a plain user string, the system prompt, and tool schemas', () => {
    const generate = buildGenerateOptions({
      model: 'ark::ark-code-latest',
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: {} } }],
      stop_sequences: ['STOP'],
      temperature: 0.5,
    }, target)
    expect(generate.provider).toBe('ark')
    expect(generate.model).toBe('ark-code-latest')
    expect(generate.system).toBe('you are helpful')
    expect(generate.messages).toHaveLength(1)
    expect(generate.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    expect(generate.tools).toEqual([{ name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: {} } }])
    expect(generate.stop).toEqual(['STOP'])
    expect(generate.temperature).toBe(0.5)
  })

  it('turns an assistant tool_use round-trip into tool-call blocks and tool_result messages, results leading', () => {
    const generate = buildGenerateOptions({
      model: 'ark::ark-code-latest',
      messages: [
        { role: 'user', content: 'weather in Beijing?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Beijing' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny 25C' }, { type: 'text', text: 'and now?' }] },
      ],
    }, target)
    expect(generate.messages).toHaveLength(4)
    expect(generate.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Beijing"}' }],
      source: { kind: 'model', provider: 'ark', model: 'ark-code-latest' },
    })
    expect(generate.messages[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'toolu_1', content: [{ type: 'text', text: 'sunny 25C' }] }],
      source: { kind: 'tool', callId: 'toolu_1' },
    })
    expect(generate.messages[2]!.content[0]).toMatchObject({ type: 'tool-result' })
    expect(generate.messages[3]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'and now?' }] })
  })

  it('keeps a trailing user text message after its tool results', () => {
    const generate = buildGenerateOptions({
      model: 'ark::ark-code-latest',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }, { type: 'text', text: 'continue' }] },
      ],
    }, target)
    expect(generate.messages).toHaveLength(2)
    expect(generate.messages[0]).toMatchObject({ role: 'user', source: { kind: 'tool' } })
    expect(generate.messages[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'continue' }] })
  })

  it('marks errored tool results and degrades images to a text note', () => {
    const generate = buildGenerateOptions({
      model: 'ark::ark-code-latest',
      messages: [
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
          { type: 'image', source: { type: 'base64' } },
        ] },
      ],
    }, target)
    expect(generate.messages[0]!.content[0]).toMatchObject({ type: 'tool-result', isError: true })
    expect(generate.messages[1]!.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(generate.messages[1]!.content[0])).toContain('image input is not supported')
  })
})

describe('bridge over the wire', () => {
  const bridges: { close(): Promise<void> }[] = []
  afterEach(async () => {
    setActiveBridge(undefined)
    await Promise.all(bridges.splice(0).map(bridge => bridge.close()))
  })

  function scriptedaStream(script: readonly StreamChunk[]): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
    return async function* (options) {
      seenRequests.push(options)
      yield* script
    }
  }
  const seenRequests: GenerateOptions[] = []

  it('translates a DSH stream into Anthropic SSE, including a tool_use round', async () => {
    seenRequests.length = 0
    const bridge = await startAnthropicBridge({ llm: catalog(scriptedaStream([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Let me check. ' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Let me check. ' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'toolu_9', name: 'get_weather', argumentsDelta: '{"city":"Be' },
      { type: 'tool-call-delta', index: 1, id: 'toolu_9', argumentsDelta: 'ijing"}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'toolu_9', name: 'get_weather', arguments: '{"city":"Beijing"}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])) })
    bridges.push(bridge)
    const response = await fetch(`${bridge.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ark::ark-code-latest', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'weather?' }] }),
    })
    expect(response.status).toBe(200)
    const events = (await response.text()).split('\n\n').filter(Boolean).map(chunk => {
      const [eventLine, dataLine] = chunk.split('\n')
      return { event: eventLine!.slice('event: '.length), data: JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown> }
    })
    expect(events[0]).toMatchObject({ event: 'message_start', data: { message: { role: 'assistant', model: 'ark::ark-code-latest' } } })
    expect(events.map(event => event.event)).toEqual([
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ])
    expect(events[5]).toMatchObject({ data: { delta: { type: 'input_json_delta', partial_json: '{"city":"Be' } } })
    expect(events[8]).toMatchObject({ data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } })
    expect(seenRequests[0]).toMatchObject({ provider: 'ark', model: 'ark-code-latest' })
  })

  it('aggregates a non-streaming answer and falls back for non-composite models', async () => {
    seenRequests.length = 0
    const bridge = await startAnthropicBridge({ llm: catalog(scriptedaStream([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'OK' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])) })
    bridges.push(bridge)
    const response = await fetch(`${bridge.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-something', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const message = await response.json() as { content: { type: string, text: string }[], stop_reason: string, usage: { input_tokens: number, output_tokens: number } }
    expect(message.content).toEqual([{ type: 'text', text: 'OK' }])
    expect(message.stop_reason).toBe('end_turn')
    expect(message.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
    expect(seenRequests[0]).toMatchObject({ provider: 'ark', model: 'ark-code-latest' })
  })

  it('rejects wrong credentials but accepts the bridge token over either header', async () => {
    const bridge = await startAnthropicBridge({ llm: catalog() })
    bridges.push(bridge)
    const bad = await fetch(`${bridge.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(bad.status).toBe(401)
    const unauthenticated = await fetch(`${bridge.url}/v1/messages`, { method: 'POST', body: '{}' })
    expect(unauthenticated.status).toBe(401)
    const probe = await fetch(`${bridge.url}/v1/other`, { method: 'POST', headers: { 'x-api-key': bridge.token }, body: '{}' })
    expect(probe.status).toBe(404)
  })
})

function fakeHandle(): { handle: SubprocessHandle } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const handle: SubprocessHandle = {
    pid: 42,
    stdin,
    stdout,
    stderr: undefined,
    collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
    done: new Promise(() => {}),
    terminate: () => true,
    waitForExit: async () => true,
  }
  return { handle }
}

describe('spawner routing', () => {
  function fakeRuntime() {
    const specs: { argv: string[], env?: Record<string, string> }[] = []
    return {
      specs,
      spawn: (spec: { argv: string[], env?: Record<string, string> }) => {
        specs.push(spec)
        return fakeHandle().handle as never
      },
    }
  }

  it('appends bridge --settings and env only for composite models', async () => {
    const bridge = await startAnthropicBridge({ llm: catalog() })
    try {
      const runtime = fakeRuntime()
      const spawn = createManagedClaudeSpawner(runtime, '/local/claude')
      spawn({ command: '/local/claude', args: ['--model', 'ark::ark-code-latest', '--print'], env: { PATH: '/usr/bin' } } as never)
      spawn({ command: '/local/claude', args: ['--model', 'claude-sonnet-4', '--print'], env: { PATH: '/usr/bin' } } as never)
      expect(runtime.specs[0]!.argv.at(-2)).toBe('--settings')
      const settings = JSON.parse(runtime.specs[0]!.argv.at(-1)!) as { env: Record<string, string> }
      expect(settings.env.ANTHROPIC_BASE_URL).toBe(bridge.url)
      expect(settings.env.ANTHROPIC_MODEL).toBe('ark::ark-code-latest')
      expect(settings.env.ANTHROPIC_SMALL_FAST_MODEL).toContain('::')
      expect(runtime.specs[0]!.env).toMatchObject({ ANTHROPIC_BASE_URL: bridge.url, PATH: '/usr/bin' })
      // A session on one of Claude's own models keeps the user's endpoint.
      expect(runtime.specs[1]!.argv).toEqual(['/local/claude', '--model', 'claude-sonnet-4', '--print'])
      expect(runtime.specs[1]!.env).toEqual({ PATH: '/usr/bin' })
    } finally {
      setActiveBridge(undefined)
      await bridge.close()
    }
  })

  it('leaves the spawn untouched when no bridge is running', () => {
    expect(getActiveBridge()).toBeUndefined()
    const runtime = fakeRuntime()
    const spawn = createManagedClaudeSpawner(runtime, '/local/claude')
    spawn({ command: '/local/claude', args: ['--model', 'ark::ark-code-latest'], env: { PATH: '/usr/bin' } } as never)
    expect(runtime.specs[0]!.argv).toEqual(['/local/claude', '--model', 'ark::ark-code-latest'])
    expect(runtime.specs[0]!.env).toEqual({ PATH: '/usr/bin' })
  })
})
