import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  auxiliaryRuntimeTypertContribution,
  callRecordSchema,
  createAuxiliaryRuntimeRemote,
} from '../src/index.ts'
import type {
  AuxiliaryPrepareRequest,
  AuxiliaryRequestBuilder,
  AuxiliaryRunRequest,
  LlmCallConfig,
  Message,
} from '../src/types.ts'
import { createHarness, type TestHarness } from './helpers/harness.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(): string[] {
  return readdirSync(join(root, 'src')).filter((name) => name.endsWith('.ts') && !name.startsWith('._'))
}

function productionSource(): string {
  return sourceFiles().map((name) => readFileSync(join(root, 'src', name), 'utf8')).join('\n')
}

function readSrc(name: string): string {
  return readFileSync(join(root, 'src', name), 'utf8')
}

function builtMessage(text: string): Message {
  return {
    id: 'message-built',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function builderRequest(
  harness: TestHarness,
  buildRequest: AuxiliaryRequestBuilder,
  overrides: Partial<AuxiliaryRunRequest> = {},
): AuxiliaryRunRequest {
  const { system: _system, messages: _messages, ...base } = harness.request()
  return {
    ...base,
    buildRequest,
    ...overrides,
  } as AuxiliaryRunRequest
}

function preparedRequest(
  harness: TestHarness,
  prepareRequest: AuxiliaryPrepareRequest,
  overrides: Partial<AuxiliaryRunRequest> = {},
): AuxiliaryRunRequest {
  const { system: _system, messages: _messages, reservation: _reservation, ...base } = harness.request()
  return {
    ...base,
    prepareRequest,
    ...overrides,
  } as AuxiliaryRunRequest
}

function sequenced(events: readonly string[]): string[] {
  return events.filter((event) => event === 'persist' || event === 'prepare' || event === 'builder' || event === 'stream')
}

describe('same-process request builder', () => {
  it('atomically builds the request and reservation from detached prepared metadata', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run(preparedRequest(harness, (prepared) => {
      harness.events.push('builder')
      expect(prepared).toEqual({
        config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        context: { contextWindow: 64_000 },
        adapterDefaults: {},
      })
      expect(Object.isFrozen(prepared)).toBe(true)
      expect(Object.isFrozen(prepared.config)).toBe(true)
      expect(prepared).not.toHaveProperty('stream')
      expect(prepared).not.toHaveProperty('signal')
      expect(prepared).not.toHaveProperty('retryPolicy')
      return {
        system: 'prepared system',
        messages: [builtMessage('prepared hello')],
        reservation: {
          uncachedInputTokens: 20,
          outputTokens: 30,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }
    }))

    expect(result.status).toBe('succeeded')
    expect(sequenced(harness.events)).toEqual(['persist', 'prepare', 'builder', 'stream'])
    expect(harness.lastStreamOptions).toMatchObject({ system: 'prepared system' })
  })

  it('persists a failed row when the prepared reservation exceeds the live policy', async () => {
    const harness = createHarness()
    await harness.runtime.setPolicy('session-1', {
      maxConcurrentCalls: 4,
      maxCallsPerSession: 8,
      maxAuxiliaryTotalTokens: 10,
    })
    const result = await harness.runtime.run(preparedRequest(harness, () => ({
      messages: [builtMessage('must not stream')],
      reservation: {
        uncachedInputTokens: 11,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })))

    expect(result.status).toBe('failed')
    expect(result.failure).toEqual({ category: 'limit', code: 'MAX_AUXILIARY_TOTAL_TOKENS' })
    expect(harness.prepareCalls).toBe(1)
    expect(harness.streamCalls).toBe(0)
    expect(harness.calls.get('call-1')?.status).toBe('failed')
  })

  it('persists running, then prepare, then builder, then stream', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run(builderRequest(harness, () => {
      harness.events.push('builder')
      expect(harness.calls.get('call-1')?.status).toBe('running')
      expect(harness.prepareCalls).toBe(1)
      expect(harness.streamCalls).toBe(0)
      return { system: 'built system', messages: [builtMessage('built hello')] }
    }))

    expect(result.status).toBe('succeeded')
    expect(result.output).toBe('')
    expect(sequenced(harness.events)).toEqual(['persist', 'prepare', 'builder', 'stream'])
    expect(harness.lastStreamOptions).toMatchObject({
      system: 'built system',
      sessionId: 'session-1',
    })
    expect((harness.lastStreamOptions?.messages as Message[])[0]?.content).toEqual([{ type: 'text', text: 'built hello' }])
  })

  it('gives the builder a cloned materialized config and does not write back', async () => {
    const harness = createHarness()
    const config: LlmCallConfig = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    let seen: LlmCallConfig | undefined
    const inner = harness.host.llm!
    harness.host.llm = {
      async prepareCall(incoming, signal) {
        const prepared = await inner.prepareCall(incoming, signal)
        return {
          config: { ...prepared.config, maxTokens: 256 },
          stream: prepared.stream,
        }
      },
    }

    const result = await harness.runtime.run(builderRequest(harness, (preparedConfig) => {
      seen = preparedConfig
      preparedConfig.maxTokens = 1
      expect(preparedConfig).not.toHaveProperty('stream')
      expect(preparedConfig).not.toHaveProperty('signal')
      expect(preparedConfig).not.toHaveProperty('handle')
      expect(preparedConfig).not.toHaveProperty('llm')
      return { messages: [builtMessage('materialized')] }
    }, { config }))

    expect(result.status).toBe('succeeded')
    expect(seen?.maxTokens).toBe(1)
    expect(config.maxTokens).toBeUndefined()
    expect(harness.lastStreamOptions?.maxTokens).toBe(256)
    expect(harness.streamCalls).toBe(1)
  })

  it('terminalizes a throwing builder without streaming', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run(builderRequest(harness, () => {
      harness.events.push('builder')
      throw Object.assign(new Error('builder secret exploded'), { code: 'BUILDER_SECRET_CODE' })
    }))

    expect(result.status).toBe('failed')
    expect(result.output).toBeNull()
    expect(result.usageRecorded).toBe(false)
    expect(result.usage).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(result.failure).toEqual({ category: 'unavailable', code: 'REQUEST_BUILD_FAILED' })
    expect(harness.prepareCalls).toBe(1)
    expect(harness.streamCalls).toBe(0)
    expect(sequenced(harness.events)).toEqual(['persist', 'prepare', 'builder'])
    expect(harness.calls.get('call-1')?.status).toBe('failed')
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('builder secret exploded')
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('BUILDER_SECRET_CODE')
  })

  it('terminalizes an invalid builder result without streaming', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run(builderRequest(harness, () => {
      harness.events.push('builder')
      return { messages: 'not-an-array' } as never
    }))

    expect(result.status).toBe('failed')
    expect(result.output).toBeNull()
    expect(result.usageRecorded).toBe(false)
    expect(result.failure).toEqual({ category: 'error', code: 'INVALID_REQUEST' })
    expect(harness.prepareCalls).toBe(1)
    expect(harness.streamCalls).toBe(0)
    expect(sequenced(harness.events)).toEqual(['persist', 'prepare', 'builder'])
    expect(harness.calls.get('call-1')?.status).toBe('failed')
  })

  it('rejects builder messages without official source or content-block shape', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run(builderRequest(harness, () => ({
      messages: [{ id: 'bad', role: 'user', content: [{}] }] as never,
    })))

    expect(result.status).toBe('failed')
    expect(result.failure).toEqual({ category: 'error', code: 'INVALID_REQUEST' })
    expect(harness.streamCalls).toBe(0)
    expect(harness.calls.get('call-1')?.status).toBe('failed')
  })

  it('keeps the static system/messages path unchanged', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run(harness.request())
    expect(result.status).toBe('succeeded')
    expect(harness.streamCalls).toBe(1)
    expect(harness.lastStreamOptions).toMatchObject({
      system: 'system text',
    })
    expect(sequenced(harness.events)).toEqual(['persist', 'prepare', 'stream'])
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('hello')
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('system text')
  })

  it('rejects static fields mixed with buildRequest before prepare', async () => {
    const harness = createHarness()
    let built = false
    const result = await harness.runtime.run(harness.request({
      buildRequest: () => {
        built = true
        return { messages: [builtMessage('should-not-run')] }
      },
    }))
    expect(result.status).toBe('failed')
    expect(result.failure).toEqual({ category: 'error', code: 'INVALID_REQUEST' })
    expect(built).toBe(false)
    expect(harness.prepareCalls).toBe(0)
    expect(harness.streamCalls).toBe(0)
    expect(harness.calls.size).toBe(0)
  })

  it('rejects a request that has neither static messages nor buildRequest', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run(harness.request({
      system: undefined,
      messages: undefined,
    }))
    expect(result.status).toBe('failed')
    expect(result.failure).toEqual({ category: 'error', code: 'INVALID_REQUEST' })
    expect(harness.prepareCalls).toBe(0)
    expect(harness.calls.size).toBe(0)
  })

  it('never persists, remotes, or logs builders or their products', async () => {
    const harness = createHarness()
    const secret = 'builder-privacy-secret-prompt'
    const result = await harness.runtime.run(builderRequest(harness, () => ({
      system: secret,
      messages: [builtMessage(secret)],
    })))
    expect(result.status).toBe('succeeded')

    const row = harness.calls.get('call-1')
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(JSON.stringify(row)).not.toContain('buildRequest')
    expect(JSON.stringify(row)).not.toContain('prepareRequest')
    expect(callRecordSchema.safeParse({ ...row, buildRequest: () => ({ messages: [] }) }).success).toBe(false)
    expect(callRecordSchema.safeParse({ ...row, system: secret, messages: [builtMessage(secret)] }).success).toBe(false)

    const contribution = JSON.stringify(auxiliaryRuntimeTypertContribution())
    expect(contribution).not.toMatch(/buildRequest/)
    expect(contribution).not.toMatch(/prepareRequest/)
    expect(contribution).not.toMatch(/"run"/)
    expect(contribution).not.toContain(secret)

    const remote = createAuxiliaryRuntimeRemote(harness.runtime)
    expect(Object.getOwnPropertyNames(remote)).toEqual(['typertRemote', 'snapshot', 'cancel'])
    expect(Object.getOwnPropertyNames(remote)).not.toContain('buildRequest')
    expect(Object.getOwnPropertyNames(remote)).not.toContain('run')

    const source = productionSource()
    expect(source).not.toMatch(/console\.(log|info|debug|warn|error)/)
    expect(source).not.toMatch(/process\.stdout/)
    expect(readSrc('host.ts')).not.toMatch(/buildRequest/)
    expect(readSrc('host.ts')).not.toMatch(/prepareRequest/)
    expect(readSrc('store.ts')).not.toMatch(/buildRequest/)
    expect(readSrc('domain.ts')).not.toMatch(/buildRequest/)
    expect(readSrc('runtime.ts')).not.toMatch(/putCall\([\s\S]{0,200}buildRequest/)
    expect(readSrc('runtime.ts')).not.toMatch(/putCall\([\s\S]{0,200}\bmessages\b/)
    expect(readSrc('runtime.ts')).not.toMatch(/putCall\([\s\S]{0,80}\bsystem\b/)
  })
})
