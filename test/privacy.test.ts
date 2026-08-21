import { describe, expect, it } from 'vitest'
import { callRecordSchema, policyRecordSchema } from '../src/domain.ts'

describe('privacy schema rejection', () => {
  const legalCall = {
    callId: 'c1',
    sessionId: 's1',
    sessionCreatedAt: 1,
    purpose: 'clarify',
    status: 'succeeded',
    usage: {
      uncachedInputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    usageRecorded: true,
    createdAt: 1,
    updatedAt: 1,
  }

  it('rejects model-visible text, paths, and credentials on call rows', () => {
    for (const extra of [
      { prompt: 'secret prompt' },
      { messages: [{ role: 'user', content: 'hi' }] },
      { system: 'system text' },
      { buildRequest: () => ({ messages: [] }) },
      { output: 'model output' },
      { cwd: '/tmp/project' },
      { path: '/Users/name/.dsh' },
      { apiKey: 'sk-test' },
    ]) {
      expect(callRecordSchema.safeParse({ ...legalCall, ...extra }).success).toBe(false)
    }
  })

  it('rejects provider failure messages on stored failure facts', () => {
    expect(callRecordSchema.safeParse({
      ...legalCall,
      status: 'failed',
      failure: { category: 'error', code: 'SERVER', message: 'provider exploded' },
    }).success).toBe(false)
  })

  it('rejects path-bearing policy extras', () => {
    expect(policyRecordSchema.safeParse({
      sessionId: 's1',
      sessionCreatedAt: 1,
      maxConcurrentCalls: 1,
      maxCallsPerSession: 1,
      maxAuxiliaryTotalTokens: 1,
      updatedAt: 1,
      cwd: '/tmp',
    }).success).toBe(false)
  })

  it('accepts the identifier-only durable shape', () => {
    expect(callRecordSchema.safeParse(legalCall).success).toBe(true)
    expect(callRecordSchema.safeParse({
      ...legalCall,
      status: 'failed',
      failure: { category: 'quota', code: 'QUOTA' },
    }).success).toBe(true)
    expect(callRecordSchema.safeParse({
      ...legalCall,
      usageRecorded: false,
    }).success).toBe(false)
  })
})
