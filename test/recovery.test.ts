import { describe, expect, it } from 'vitest'
import { createHarness, tokenUsage, usageChunks } from './helpers/harness.ts'

describe('recovery, rebuild, and Session fence', () => {
  it('converts orphaned running rows to interrupted without adding usage', async () => {
    const harness = createHarness()
    await harness.runtime.start()
    await harness.calls.put('orphan', {
      callId: 'orphan',
      sessionId: 'session-1',
      sessionCreatedAt: 1_700_000_000_000,
      purpose: 'session-title',
      status: 'running',
      usage: {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      usageRecorded: false,
      createdAt: 1,
      updatedAt: 1,
    })
    const recovered = harness.reopen()
    await recovered.start()
    const row = harness.calls.get('orphan')
    expect(row?.status).toBe('interrupted')
    expect(row?.failure).toEqual({ category: 'unavailable', code: 'INTERRUPTED' })
    expect(row?.usage).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(row?.usageRecorded).toBe(false)
    const replay = await recovered.run(harness.request({
      callId: 'orphan',
      purpose: 'session-title',
    }))
    expect(replay.status).toBe('interrupted')
    expect(replay.replayed).toBe(true)
    expect(harness.prepareCalls).toBe(0)
    const snapshot = await recovered.snapshot('session-1')
    expect(snapshot.auxiliary).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('rebuilds in-memory aggregates from durable rows after restart', async () => {
    const harness = createHarness()
    harness.setChunks(usageChunks(tokenUsage(8, 2, 1, 0)))
    await harness.runtime.run(harness.request())
    const restarted = harness.reopen()
    const snapshot = await restarted.snapshot('session-1')
    expect(snapshot.auxiliary).toEqual({
      uncachedInputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
    })
  })

  it('does not inherit usage or policy when a Session id is reused with a new createdAt', async () => {
    const harness = createHarness()
    await harness.runtime.setPolicy('session-1', {
      maxConcurrentCalls: 1,
      maxCallsPerSession: 1,
      maxAuxiliaryTotalTokens: 5,
    })
    harness.setChunks(usageChunks(tokenUsage(8, 0)))
    await harness.runtime.run(harness.request())
    harness.addSession('session-1', 9_000)
    const policy = await harness.runtime.getPolicy('session-1')
    expect(policy.maxCallsPerSession).toBe(Number.MAX_SAFE_INTEGER)
    const snapshot = await harness.runtime.snapshot('session-1')
    expect(snapshot.auxiliary).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    const next = await harness.runtime.run(harness.request({ callId: 'fresh' }))
    expect(next.status).toBe('succeeded')
  })
})
