import { describe, expect, it } from 'vitest'
import { MAX_CALL_ROWS } from '../src/constants.ts'
import type { AuxiliaryRunRequest, Message } from '../src/types.ts'
import { createHarness, deferred, tokenUsage, usageChunks, waitUntil } from './helpers/harness.ts'

function dynamicRequest(callId: string, reservationTokens: number): AuxiliaryRunRequest {
  return {
    callId,
    sessionId: 'session-1',
    purpose: 'clarify',
    config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    prepareRequest: () => ({
      messages: [{
        id: `message-${callId}`,
        role: 'user',
        content: [{ type: 'text', text: callId }],
        source: { kind: 'plugin' },
      }] satisfies Message[],
      reservation: {
        uncachedInputTokens: reservationTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }),
  }
}

describe('limits, reservations, and concurrency', () => {
  it('serializes prepared token admission so only one concurrent reservation fits', async () => {
    const harness = createHarness()
    await harness.runtime.setPolicy('session-1', {
      maxConcurrentCalls: 4,
      maxCallsPerSession: 8,
      maxAuxiliaryTotalTokens: 15,
    })
    const streamGate = deferred()
    harness.setChunks(async function* () {
      await streamGate.promise
      yield* usageChunks(tokenUsage(1, 1))
    })

    const first = harness.runtime.run(dynamicRequest('dynamic-1', 10))
    await waitUntil(() => harness.streamCalls === 1)
    const second = await harness.runtime.run(dynamicRequest('dynamic-2', 10))
    expect(second.failure).toEqual({ category: 'limit', code: 'MAX_AUXILIARY_TOTAL_TOKENS' })
    expect(harness.prepareCalls).toBe(2)
    expect(harness.streamCalls).toBe(1)
    expect(harness.calls.get('dynamic-2')?.status).toBe('failed')

    streamGate.resolve()
    await first
  })

  it('rejects concurrent calls, recorded call count, and reserved totals', async () => {
    const harness = createHarness()
    await harness.runtime.setPolicy('session-1', {
      maxConcurrentCalls: 1,
      maxCallsPerSession: 2,
      maxAuxiliaryTotalTokens: 20,
    })
    const gate = deferred()
    harness.setChunks(async function* (signal) {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' })), { once: true })
        void gate.promise.then(() => resolve())
      })
      yield* usageChunks(tokenUsage(1, 1))
    })
    const first = harness.runtime.run(harness.request({ callId: 'c1' }))
    await waitUntil(() => harness.calls.get('c1')?.status === 'running')
    const concurrent = await harness.runtime.run(harness.request({ callId: 'c2' }))
    expect(concurrent.failure).toEqual({ category: 'limit', code: 'MAX_CONCURRENT_CALLS' })
    expect(harness.prepareCalls).toBe(1)
    gate.resolve()
    await first

    const second = await harness.runtime.run(harness.request({
      callId: 'c2',
      reservation: {
        uncachedInputTokens: 30,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    expect(second.failure).toEqual({ category: 'limit', code: 'MAX_AUXILIARY_TOTAL_TOKENS' })

    harness.setChunks(usageChunks(tokenUsage(1, 1)))
    const allowed = await harness.runtime.run(harness.request({
      callId: 'c2',
      reservation: {
        uncachedInputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    expect(allowed.status).toBe('succeeded')

    const third = await harness.runtime.run(harness.request({ callId: 'c3' }))
    expect(third.failure).toEqual({ category: 'limit', code: 'MAX_CALLS_PER_SESSION' })
  })

  it('lets provider usage exceed the reservation and uses the recorded total next', async () => {
    const harness = createHarness()
    await harness.runtime.setPolicy('session-1', {
      maxConcurrentCalls: 4,
      maxCallsPerSession: 8,
      maxAuxiliaryTotalTokens: 20,
    })
    harness.setChunks(usageChunks(tokenUsage(18, 0)))
    const first = await harness.runtime.run(harness.request({
      callId: 'over',
      reservation: {
        uncachedInputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    expect(first.status).toBe('succeeded')
    expect(first.usage.uncachedInputTokens).toBe(18)
    const second = await harness.runtime.run(harness.request({
      callId: 'next',
      reservation: {
        uncachedInputTokens: 5,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    expect(second.failure).toEqual({ category: 'limit', code: 'MAX_AUXILIARY_TOTAL_TOKENS' })
    expect(harness.prepareCalls).toBe(1)
  })

  it('refuses new calls at the 10000-row hard limit without deleting records', async () => {
    const harness = createHarness()
    await harness.runtime.start()
    for (let index = 0; index < MAX_CALL_ROWS; index += 1) {
      harness.calls.map.set(`seed-${index}`, {
        callId: `seed-${index}`,
        sessionId: 'other',
        sessionCreatedAt: 1,
        purpose: 'clarify',
        status: 'succeeded',
        usage: {
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        usageRecorded: true,
        createdAt: 1,
        updatedAt: 1,
      })
    }
    harness.runtime = harness.reopen()
    const result = await harness.runtime.run(harness.request())
    expect(result.failure).toEqual({ category: 'limit', code: 'ROW_LIMIT' })
    expect(harness.calls.size).toBe(MAX_CALL_ROWS)
    expect(harness.prepareCalls).toBe(0)
  })

  it('does not charge one Session reservation against another', async () => {
    const harness = createHarness()
    harness.addSession('session-2', 1_800_000_000_000)
    const tight = {
      maxConcurrentCalls: 4,
      maxCallsPerSession: 8,
      maxAuxiliaryTotalTokens: 20,
    }
    await harness.runtime.setPolicy('session-1', tight)
    await harness.runtime.setPolicy('session-2', tight)
    const gate = deferred()
    harness.setChunks(async function* (signal) {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }))
        }, { once: true })
        void gate.promise.then(() => resolve())
      })
      yield* usageChunks(tokenUsage(1, 1))
    })
    const first = harness.runtime.run(harness.request({
      callId: 's1',
      reservation: {
        uncachedInputTokens: 18,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    await waitUntil(() => harness.calls.get('s1')?.status === 'running')
    harness.setChunks(usageChunks(tokenUsage(1, 1)))
    const other = await harness.runtime.run(harness.request({
      callId: 's2',
      sessionId: 'session-2',
      reservation: {
        uncachedInputTokens: 18,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    expect(other.status).toBe('succeeded')
    expect(other.failure).toBeUndefined()
    gate.resolve()
    await first
  })

  it('rejects accumulated reservations on the same fence', async () => {
    const harness = createHarness()
    await harness.runtime.setPolicy('session-1', {
      maxConcurrentCalls: 4,
      maxCallsPerSession: 8,
      maxAuxiliaryTotalTokens: 20,
    })
    const gate = deferred()
    harness.setChunks(async function* (signal) {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }))
        }, { once: true })
        void gate.promise.then(() => resolve())
      })
      yield* usageChunks(tokenUsage(1, 1))
    })
    const first = harness.runtime.run(harness.request({
      callId: 'held',
      reservation: {
        uncachedInputTokens: 12,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    await waitUntil(() => harness.calls.get('held')?.status === 'running')
    const second = await harness.runtime.run(harness.request({
      callId: 'next',
      reservation: {
        uncachedInputTokens: 12,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    expect(second.failure).toEqual({ category: 'limit', code: 'MAX_AUXILIARY_TOTAL_TOKENS' })
    expect(harness.prepareCalls).toBe(1)
    gate.resolve()
    await first
  })

  it('does not inherit an in-flight reservation after Session id reuse', async () => {
    const harness = createHarness()
    await harness.runtime.setPolicy('session-1', {
      maxConcurrentCalls: 4,
      maxCallsPerSession: 8,
      maxAuxiliaryTotalTokens: 20,
    })
    const gate = deferred()
    harness.setChunks(async function* (signal) {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }))
        }, { once: true })
        void gate.promise.then(() => resolve())
      })
      yield* usageChunks(tokenUsage(1, 1))
    })
    const first = harness.runtime.run(harness.request({
      callId: 'old-fence',
      reservation: {
        uncachedInputTokens: 18,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    await waitUntil(() => harness.calls.get('old-fence')?.status === 'running')
    harness.addSession('session-1', 9_000)
    await harness.runtime.setPolicy('session-1', {
      maxConcurrentCalls: 4,
      maxCallsPerSession: 8,
      maxAuxiliaryTotalTokens: 20,
    })
    harness.setChunks(usageChunks(tokenUsage(1, 1)))
    const reused = await harness.runtime.run(harness.request({
      callId: 'new-fence',
      reservation: {
        uncachedInputTokens: 18,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }))
    expect(reused.status).toBe('succeeded')
    gate.resolve()
    await first
  })

  it('persists and reads fenced policy', async () => {
    const harness = createHarness()
    const policy = await harness.runtime.setPolicy('session-1', {
      maxConcurrentCalls: 3,
      maxCallsPerSession: 9,
      maxAuxiliaryTotalTokens: 100,
    })
    expect(policy).toEqual({
      maxConcurrentCalls: 3,
      maxCallsPerSession: 9,
      maxAuxiliaryTotalTokens: 100,
    })
    expect(await harness.runtime.getPolicy('session-1')).toEqual(policy)
    expect(harness.policies.size).toBe(1)
  })
})
