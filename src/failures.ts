import {
  ABORTED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
} from './constants.ts'
import type { FailureCategory, FailureFact, FinishReason, LlmFailure } from './types.ts'

export function failureFact(category: FailureCategory, code: string): FailureFact {
  return { category, code }
}

export function categoryForCode(code: string): FailureCategory {
  if (code === QUOTA_EXCEEDED_CODE || code === 'QUOTA_EXCEEDED') return 'quota'
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE) return 'context_window'
  if (code === ABORTED_CODE) return 'aborted'
  if (
    code === 'CALL_ID_ACTIVE'
    || code === 'CALL_ID_SESSION_CONFLICT'
    || code === 'CALL_ID_PURPOSE_CONFLICT'
  ) return 'conflict'
  if (
    code === 'RESERVATION_REQUIRED'
    || code === 'MAX_CONCURRENT_CALLS'
    || code === 'MAX_CALLS_PER_SESSION'
    || code === 'MAX_AUXILIARY_TOTAL_TOKENS'
    || code === 'ROW_LIMIT'
  ) return 'limit'
  if (
    code === 'SESSION_NOT_FOUND'
    || code === 'STORAGE_UNAVAILABLE'
    || code === 'LLM_UNAVAILABLE'
    || code === 'DOMAIN_UNAVAILABLE'
    || code === 'HOST_UNSUPPORTED'
    || code === 'VERSION_MISMATCH'
    || code === 'INVALID_RECORD'
    || code === 'CALL_NOT_FOUND'
    || code === 'INTERRUPTED'
    || code === 'PROJECTION_UNAVAILABLE'
  ) return 'unavailable'
  return 'error'
}

export function factFromCode(code: string): FailureFact {
  return failureFact(categoryForCode(code), code)
}

export function factFromLlmFailure(failure: LlmFailure): FailureFact {
  return failureFact(categoryForCode(failure.code), failure.code)
}

export function factFromUnknown(value: unknown, fallbackCode = 'UNKNOWN'): FailureFact {
  const code = officialFailureCode(value) ?? fallbackCode
  return factFromCode(code)
}

export function officialFailureCode(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as { code?: unknown; failure?: { code?: unknown } }
  if (typeof record.failure?.code === 'string' && record.failure.code.length > 0) {
    return record.failure.code
  }
  if (typeof record.code === 'string' && record.code.length > 0) {
    return record.code
  }
  return undefined
}

export function factFromFinish(reason: FinishReason): FailureFact | undefined {
  if (reason.kind === 'aborted' || reason.kind === 'error') {
    return factFromLlmFailure(reason.failure)
  }
  if (reason.kind === 'tool-calls') {
    return failureFact('error', 'UNEXPECTED_TOOL_CALLS')
  }
  return undefined
}

export function isAbortError(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const record = value as { name?: unknown; code?: unknown }
  return record.name === 'AbortError' || record.code === ABORTED_CODE
}
