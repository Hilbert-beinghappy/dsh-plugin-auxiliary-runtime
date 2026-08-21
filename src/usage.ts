import { ZERO_USAGE } from './constants.ts'
import type { TokenUsage, UsageBuckets } from './types.ts'

export function zeroUsage(): UsageBuckets {
  return { ...ZERO_USAGE }
}

export function cloneUsage(usage: UsageBuckets): UsageBuckets {
  return {
    uncachedInputTokens: usage.uncachedInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  }
}

export function addUsage(left: UsageBuckets, right: UsageBuckets): UsageBuckets {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
}

export function totalTokens(usage: UsageBuckets): number {
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

export function bucketsFromTokenUsage(usage: TokenUsage): UsageBuckets {
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

export function isUsageBuckets(value: unknown): value is UsageBuckets {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return isNonNegativeInt(record.uncachedInputTokens)
    && isNonNegativeInt(record.outputTokens)
    && isNonNegativeInt(record.cacheReadTokens)
    && isNonNegativeInt(record.cacheWriteTokens)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
