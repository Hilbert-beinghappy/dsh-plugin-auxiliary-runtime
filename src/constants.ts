export const PACKAGE_NAME = 'dsh-plugin-auxiliary-runtime'
export const PACKAGE_VERSION = '0.1.1'
export const PLUGIN_ID = 'auxiliary-runtime'
export const SERVICE_KEY = 'auxiliaryRuntime'
export const REMOTE_NAMESPACE = 'auxiliary-runtime'
export const DOMAIN_NAME = 'auxiliary_runtime'
export const DOMAIN_VERSION = 0
export const CALLS_TABLE = 'calls'
export const POLICIES_TABLE = 'policies'

export const PINNED_DSH_VERSION_LEGACY_RC8 = '0.1.0-rc.8'
export const PINNED_DSH_VERSION = '0.1.1-rc.2'
export const PINNED_DSH_VERSIONS = [PINNED_DSH_VERSION_LEGACY_RC8, PINNED_DSH_VERSION] as const

export const MAX_CALL_ROWS = 10_000
export const MAX_OUTPUT_CHARS = 65_536

export const PURPOSES = ['clarify', 'compaction', 'session-title'] as const
export const CALL_STATUSES = ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const
export const FAILURE_CATEGORIES = [
  'quota',
  'context_window',
  'aborted',
  'error',
  'conflict',
  'limit',
  'unavailable',
] as const

export const OFFICIAL_STREAM_PURPOSES = ['compaction', 'session-title'] as const

export const TYPERT_REMOTE_METHODS = ['snapshot', 'cancel'] as const

export const DEFAULT_POLICY = {
  maxConcurrentCalls: Number.MAX_SAFE_INTEGER,
  maxCallsPerSession: Number.MAX_SAFE_INTEGER,
  maxAuxiliaryTotalTokens: Number.MAX_SAFE_INTEGER,
} as const

export const ZERO_USAGE = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const

export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const QUOTA_EXCEEDED_CODE = 'QUOTA'
export const ABORTED_CODE = 'ABORTED'
