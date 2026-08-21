import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT_CHARS } from '../src/index.ts'
import { createHarness, deferred, tokenUsage, usageChunks, waitUntil } from './helpers/harness.ts'

describe('auxiliary runtime calls', () => {
  it('persists running before prepare/dispatch and records provider usage on success', async () => {
    const harness = createHarness()
    let streamOptions: Record<string, unknown> | undefined
    harness.host.llm = {
      async prepareCall(config) {
        expect(harness.calls.get('call-1')?.status).toBe('running')
        return {
          config,
          stream: async function* (options) {
            streamOptions = options as unknown as Record<string, unknown>
            expect(harness.calls.get('call-1')?.status).toBe('running')
            yield* usageChunks(tokenUsage(5, 7, 1, 2))
          },
        }
      },
    }
    const result = await harness.runtime.run(harness.request())
    expect(result).toMatchObject({
      callId: 'call-1',
      sessionId: 'session-1',
      purpose: 'clarify',
      status: 'succeeded',
      usage: {
        uncachedInputTokens: 5,
        outputTokens: 7,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
      },
      usageRecorded: true,
      output: '',
      replayed: false,
    })
    expect(result.failure).toBeUndefined()
    expect(harness.calls.get('call-1')?.status).toBe('succeeded')
    expect(harness.events[0]).toBe('open')
    expect(streamOptions).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      sessionId: 'session-1',
      system: 'system text',
    })
    expect(streamOptions).not.toHaveProperty('purpose')
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('hello')
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('system text')
  })

  it('passes official compaction purpose and never tools', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run(harness.request({
      callId: 'call-compact',
      purpose: 'compaction',
    }))
    expect(result.status).toBe('succeeded')
    expect(harness.lastStreamOptions).toMatchObject({ purpose: 'compaction' })
    expect(harness.lastStreamOptions).not.toHaveProperty('tools')
  })

  it('returns live model text in memory without persisting it', async () => {
    const harness = createHarness()
    harness.setChunks([
      { type: 'text-delta', index: 0, text: '{"question":' },
      { type: 'text-delta', index: 1, text: '"dynamic"}' },
      ...usageChunks(tokenUsage(2, 3)),
    ])
    const result = await harness.runtime.run(harness.request())
    expect(result.status).toBe('succeeded')
    expect(result.output).toBe('{"question":"dynamic"}')
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('dynamic')

    const replay = await harness.runtime.run(harness.request())
    expect(replay.status).toBe('succeeded')
    expect(replay.replayed).toBe(true)
    expect(replay.output).toBeNull()
  })

  it('fails closed when ephemeral output exceeds the bounded buffer', async () => {
    const harness = createHarness()
    harness.setChunks([
      { type: 'usage', usage: tokenUsage(8, 2) },
      { type: 'text-delta', index: 0, text: 'x'.repeat(MAX_OUTPUT_CHARS + 1) },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const result = await harness.runtime.run(harness.request())
    expect(result.status).toBe('failed')
    expect(result.failure).toEqual({ category: 'error', code: 'OUTPUT_TOO_LARGE' })
    expect(result.output).toBeNull()
    expect(result.usageRecorded).toBe(true)
    expect(result.usage.uncachedInputTokens).toBe(8)
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('xxxxx')
  })

  it('keeps a usage chunk when a later finish is error', async () => {
    const harness = createHarness()
    harness.setChunks(usageChunks(tokenUsage(9, 1), {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'quota gone', code: 'QUOTA' } },
    }))
    const result = await harness.runtime.run(harness.request())
    expect(result.status).toBe('failed')
    expect(result.usage).toEqual({
      uncachedInputTokens: 9,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(result.failure).toEqual({ category: 'quota', code: 'QUOTA' })
    expect(result.output).toBeNull()
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('quota gone')
  })

  it('keeps a usage chunk when a later finish is aborted', async () => {
    const harness = createHarness()
    harness.setChunks(usageChunks(tokenUsage(3, 4), {
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'provider abort', code: 'ABORTED' } },
    }))
    const result = await harness.runtime.run(harness.request())
    expect(result.status).toBe('cancelled')
    expect(result.usage).toEqual({
      uncachedInputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(result.failure).toEqual({ category: 'aborted', code: 'ABORTED' })
    expect(result.output).toBeNull()
    expect(JSON.stringify(harness.calls.get('call-1'))).not.toContain('provider abort')
  })

  it('records a no-usage provider failure with official context-window code', async () => {
    const harness = createHarness()
    harness.setChunks([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'too long', code: 'CONTEXT_WINDOW_EXCEEDED' } },
    }])
    const result = await harness.runtime.run(harness.request())
    expect(result.status).toBe('failed')
    expect(result.usage).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(result.failure).toEqual({ category: 'context_window', code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(result.usageRecorded).toBe(false)
  })

  it('distinguishes an observed all-zero usage chunk and keeps the last usage chunk', async () => {
    const harness = createHarness()
    harness.setChunks([
      { type: 'usage', usage: tokenUsage(0, 0, 0, 0) },
      { type: 'usage', usage: tokenUsage(9, 3, 2, 1) },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const result = await harness.runtime.run(harness.request())
    expect(result.usageRecorded).toBe(true)
    expect(result.usage).toEqual({
      uncachedInputTokens: 9,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    })
    expect(harness.calls.get('call-1')?.usageRecorded).toBe(true)
  })

  it('marks a provider-observed all-zero usage as recorded', async () => {
    const harness = createHarness()
    harness.setChunks(usageChunks(tokenUsage(0, 0, 0, 0)))
    const result = await harness.runtime.run(harness.request())
    expect(result.usage).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(result.usageRecorded).toBe(true)
  })

  it('replays a terminal record idempotently with output null', async () => {
    const harness = createHarness()
    const first = await harness.runtime.run(harness.request())
    const second = await harness.runtime.run(harness.request())
    expect(first.replayed).toBe(false)
    expect(second).toEqual({ ...first, replayed: true, output: null })
    expect(second.output).toBeNull()
    expect(harness.prepareCalls).toBe(1)
    expect(harness.calls.size).toBe(1)
  })

  it('conflicts when an active callId is reused', async () => {
    const harness = createHarness()
    const gate = deferred()
    harness.setChunks(async function* (signal) {
      await gate.promise
      if (signal.aborted) return
      yield* usageChunks()
    })
    const first = harness.runtime.run(harness.request())
    await waitUntil(() => harness.calls.get('call-1')?.status === 'running')
    const second = await harness.runtime.run(harness.request())
    expect(second.status).toBe('failed')
    expect(second.failure).toEqual({ category: 'conflict', code: 'CALL_ID_ACTIVE' })
    expect(second.replayed).toBe(false)
    gate.resolve()
    await first
  })

  it('conflicts when a terminal callId is reused across sessions', async () => {
    const harness = createHarness()
    await harness.runtime.run(harness.request())
    harness.addSession('session-2', 1_800_000_000_000)
    const result = await harness.runtime.run(harness.request({ sessionId: 'session-2' }))
    expect(result.failure).toEqual({ category: 'conflict', code: 'CALL_ID_SESSION_CONFLICT' })
    expect(harness.prepareCalls).toBe(1)
  })

  it('conflicts when a terminal callId is reused for a different purpose', async () => {
    const harness = createHarness()
    await harness.runtime.run(harness.request())
    const result = await harness.runtime.run(harness.request({ purpose: 'session-title' }))
    expect(result.failure).toEqual({ category: 'conflict', code: 'CALL_ID_PURPOSE_CONFLICT' })
    expect(result.replayed).toBe(false)
    expect(harness.prepareCalls).toBe(1)
  })

  it('cancels an in-flight call through the service AbortController', async () => {
    const harness = createHarness()
    const gate = deferred()
    harness.setChunks(async function* (signal) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }))
          return
        }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }))
        }, { once: true })
        void gate.promise.then(() => resolve())
      })
      yield* usageChunks()
    })
    const run = harness.runtime.run(harness.request())
    await waitUntil(() => harness.calls.get('call-1')?.status === 'running')
    const cancelled = await harness.runtime.cancel('call-1')
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.failure).toEqual({ category: 'aborted', code: 'ABORTED' })
    const result = await run
    expect(result.status).toBe('cancelled')
    expect(result.failure).toEqual({ category: 'aborted', code: 'ABORTED' })
  })

  it('honors a caller AbortSignal', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    harness.setChunks(async function* (signal) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }))
        }, { once: true })
      })
    })
    const run = harness.runtime.run(harness.request({ signal: controller.signal }))
    await waitUntil(() => harness.calls.get('call-1')?.status === 'running')
    controller.abort()
    const result = await run
    expect(result.status).toBe('cancelled')
    expect(result.failure).toEqual({ category: 'aborted', code: 'ABORTED' })
  })

  it('derives combined from official plus auxiliary and never writes projections', async () => {
    const harness = createHarness()
    const officialBefore = structuredClone(harness.official.tokenUsage)
    await harness.runtime.run(harness.request())
    const snapshot = await harness.runtime.snapshot('session-1')
    expect(snapshot.official).toEqual(officialBefore)
    expect(snapshot.auxiliary).toEqual({
      uncachedInputTokens: 4,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(snapshot.combined).toEqual({
      uncachedInputTokens: (officialBefore?.uncachedInputTokens ?? 0) + 4,
      outputTokens: (officialBefore?.outputTokens ?? 0) + 6,
      cacheReadTokens: (officialBefore?.cacheReadTokens ?? 0) + 0,
      cacheWriteTokens: (officialBefore?.cacheWriteTokens ?? 0) + 0,
    })
    expect(harness.official.tokenUsage).toEqual(officialBefore)
    expect(harness.host.sessionProjections).toBeDefined()
  })

  it('treats a missing official projection as zeros without mutating Host state', async () => {
    const harness = createHarness()
    harness.official.tokenUsage = undefined
    const snapshot = await harness.runtime.snapshot('session-1')
    expect(snapshot.official).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(snapshot.capability.officialProjection).toBe(false)
    expect(snapshot.capability.reason).toMatch(/tokenUsage/)
  })

  it('fails closed before dispatch when the Session is missing', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run(harness.request({ sessionId: 'missing' }))
    expect(result.status).toBe('failed')
    expect(result.failure).toEqual({ category: 'unavailable', code: 'SESSION_NOT_FOUND' })
    expect(harness.prepareCalls).toBe(0)
    expect(harness.calls.size).toBe(0)
  })

  it('fails closed before dispatch when storage writes fail', async () => {
    const harness = createHarness()
    await harness.runtime.start()
    harness.calls.failNext = true
    const result = await harness.runtime.run(harness.request())
    expect(result.failure).toEqual({ category: 'unavailable', code: 'STORAGE_UNAVAILABLE' })
    expect(harness.prepareCalls).toBe(0)
  })

  it('closes a pending domain open that resolves after stop', async () => {
    const harness = createHarness()
    const hold = deferred()
    let opened = false
    let closes = 0
    const original = harness.host.storageDomain!.open!.bind(harness.host.storageDomain)
    harness.host.storageDomain!.open = async (spec) => {
      harness.events.push('open-start')
      await hold.promise
      if (opened) {
        throw Object.assign(new Error('already-open'), { code: 'already-open' })
      }
      const handle = await original(spec)
      opened = true
      return {
        ...handle,
        async close() {
          opened = false
          closes += 1
          await handle.close()
        },
      }
    }
    const starting = harness.runtime.start()
    await waitUntil(() => harness.events.includes('open-start'))
    const stopping = harness.runtime.stop()
    hold.resolve()
    await starting
    await stopping
    expect(closes).toBe(1)
    expect(opened).toBe(false)
    const result = await harness.runtime.run(harness.request({ callId: 'after-pending-open' }))
    expect(result.status).toBe('succeeded')
    expect(harness.calls.get('after-pending-open')?.status).toBe('succeeded')
  })

  it('aborts admission before close and leaves no running row', async () => {
    const harness = createHarness()
    const hold = deferred()
    const originalPut = harness.calls.put.bind(harness.calls)
    harness.calls.put = async (key, value) => {
      harness.events.push('put-start')
      await hold.promise
      return originalPut(key, value)
    }
    const run = harness.runtime.run(harness.request())
    await waitUntil(() => harness.events.includes('put-start'))
    const stopping = harness.runtime.stop()
    hold.resolve()
    const [result] = await Promise.all([run, stopping])
    expect(result.status).toMatch(/cancelled|failed/)
    expect(harness.calls.get('call-1')?.status).not.toBe('running')
    expect(harness.prepareCalls).toBe(0)
  })

  it('aborts an in-flight stream on stop and awaits the terminal row', async () => {
    const harness = createHarness()
    harness.setChunks(async function* (signal) {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }))
          return
        }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }))
        }, { once: true })
      })
    })
    const run = harness.runtime.run(harness.request())
    await waitUntil(() => harness.calls.get('call-1')?.status === 'running')
    await harness.runtime.stop()
    const result = await run
    expect(result.status).toBe('cancelled')
    expect(result.failure).toEqual({ category: 'aborted', code: 'ABORTED' })
    expect(harness.calls.get('call-1')?.status).toBe('cancelled')
  })

  it('accepts start and run after stop', async () => {
    const harness = createHarness()
    const first = await harness.runtime.run(harness.request())
    expect(first.status).toBe('succeeded')
    await harness.runtime.stop()
    const second = await harness.runtime.run(harness.request({ callId: 'after-stop' }))
    expect(second.status).toBe('succeeded')
    expect(second.replayed).toBe(false)
    expect(harness.calls.get('after-stop')?.status).toBe('succeeded')
  })

  it('rejects a missing reservation before dispatch', async () => {
    const harness = createHarness()
    const result = await harness.runtime.run({
      ...harness.request(),
      reservation: undefined as never,
    })
    expect(result.failure).toEqual({ category: 'limit', code: 'RESERVATION_REQUIRED' })
    expect(harness.prepareCalls).toBe(0)
  })
})
