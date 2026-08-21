import type {
  CALL_STATUSES,
  FAILURE_CATEGORIES,
  PINNED_DSH_VERSIONS,
  PURPOSES,
} from './constants.ts'
import type { ZodType } from 'zod'

export type AuxiliaryPurpose = (typeof PURPOSES)[number]
export type AuxiliaryCallStatus = (typeof CALL_STATUSES)[number]
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number]
export type PinnedDshVersion = (typeof PINNED_DSH_VERSIONS)[number]

export interface UsageBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export interface FailureFact {
  readonly category: FailureCategory
  readonly code: string
}

export interface AuxiliaryPolicy {
  readonly maxConcurrentCalls: number
  readonly maxCallsPerSession: number
  readonly maxAuxiliaryTotalTokens: number
}

export interface CallRecord {
  readonly callId: string
  readonly sessionId: string
  readonly sessionCreatedAt: number
  readonly purpose: AuxiliaryPurpose
  readonly status: AuxiliaryCallStatus
  readonly usage: UsageBuckets
  readonly usageRecorded: boolean
  readonly failure?: FailureFact
  readonly createdAt: number
  readonly updatedAt: number
}

export interface PolicyRecord extends AuxiliaryPolicy {
  readonly sessionId: string
  readonly sessionCreatedAt: number
  readonly updatedAt: number
}

/** Structural copies of the exact rc.8 seams consumed at runtime. */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}

export type FinishReason =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted'; readonly failure: LlmFailure }
  | { readonly kind: 'error'; readonly failure: LlmFailure }

export type StreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: unknown }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'finish'; readonly reason: FinishReason; readonly replayState?: unknown }

export interface Message {
  readonly id: string
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: readonly unknown[]
  readonly source: unknown
}

export interface GenerateOptions extends LlmCallConfig {
  messages: Message[]
  system?: string
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  signal?: AbortSignal
  sessionId?: string
  purpose?: 'compaction' | 'session-title'
}

export interface PreparedLlmCall {
  readonly config: LlmCallConfig
  readonly context?: { readonly contextWindow: number }
  readonly adapterDefaults?: {
    readonly reasoningEffort?: true
    readonly maxTokens?: true
  }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface LlmService {
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>
}

export interface SessionLike {
  readonly id: string
  readonly header: {
    readonly id: string
    readonly createdAt: number
    readonly version: number
  }
  readonly seq: number
}

export interface SessionsService {
  get(sessionId: string): SessionLike | undefined
}

export interface ProjectionSnapshot {
  readonly asOfSeq: number
  readonly values: Readonly<Record<string, unknown>>
}

export interface SessionProjectionsService {
  snapshot(session: SessionLike): ProjectionSnapshot
}

export interface KvTable<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V) => V): Promise<V>
}

export interface DomainSpec {
  readonly name: string
  readonly version: number
  readonly tables: {
    readonly calls: { readonly valueSchema: ZodType<CallRecord> }
    readonly policies: { readonly valueSchema: ZodType<PolicyRecord> }
  }
}

export interface DomainTables {
  readonly calls: CallRecord
  readonly policies: PolicyRecord
}

export interface DomainHandle {
  readonly name: string
  table<N extends keyof DomainTables>(name: N): KvTable<string, DomainTables[N]>
  close(): Promise<void>
}

export interface StorageDomainService {
  open(spec: DomainSpec): Promise<DomainHandle>
  get?(name: string): DomainHandle | undefined
}

export interface TypertLike {
  register?(contribution: unknown): unknown
}

export interface HostContext {
  get?(name: string, strict?: boolean): unknown
  provide?(name: string, value: unknown): unknown
  inject?(
    deps: readonly string[] | Record<string, unknown>,
    callback: (ctx: HostContext) => void | Promise<void>,
  ): unknown
  effect?(factory: () => void | (() => void) | Promise<void> | (() => Promise<void>)): void
  storageDomain?: StorageDomainService
  sessions?: SessionsService
  llm?: LlmService
  sessionProjections?: SessionProjectionsService
  typert?: TypertLike
  dshVersion?: string
}

export interface AuxiliaryBuiltRequest {
  readonly system?: string
  readonly messages: readonly Message[]
}

export type AuxiliaryRequestBuilder = (preparedConfig: LlmCallConfig) => AuxiliaryBuiltRequest

export interface AuxiliaryPreparedView {
  readonly config: Readonly<LlmCallConfig>
  readonly context?: { readonly contextWindow: number }
  readonly adapterDefaults: {
    readonly reasoningEffort?: true
    readonly maxTokens?: true
  }
}

export interface AuxiliaryPreparedRequest extends AuxiliaryBuiltRequest {
  readonly reservation: UsageBuckets
}

export type AuxiliaryPrepareRequest = (prepared: AuxiliaryPreparedView) => AuxiliaryPreparedRequest

interface AuxiliaryRunRequestBase {
  readonly callId: string
  readonly sessionId: string
  readonly purpose: AuxiliaryPurpose
  readonly config: LlmCallConfig
  readonly signal?: AbortSignal
}

export type AuxiliaryRunRequest = AuxiliaryRunRequestBase & (
  | {
      readonly system?: string
      readonly messages: readonly Message[]
      readonly buildRequest?: never
      readonly prepareRequest?: never
      readonly reservation: UsageBuckets
    }
  | {
      readonly system?: never
      readonly messages?: never
      readonly buildRequest: AuxiliaryRequestBuilder
      readonly prepareRequest?: never
      readonly reservation: UsageBuckets
    }
  | {
      readonly system?: never
      readonly messages?: never
      readonly buildRequest?: never
      readonly prepareRequest: AuxiliaryPrepareRequest
      readonly reservation?: never
    }
)

export interface AuxiliaryCallResult {
  readonly callId: string
  readonly sessionId: string
  readonly purpose: AuxiliaryPurpose
  readonly status: AuxiliaryCallStatus
  readonly usage: UsageBuckets
  readonly usageRecorded: boolean
  readonly failure?: FailureFact
  readonly output: string | null
  readonly replayed: boolean
}

export interface AuxiliaryCancelResult {
  readonly callId: string
  readonly status?: AuxiliaryCallStatus
  readonly failure?: FailureFact
}

export interface AuxiliaryCapability {
  readonly ok: boolean
  readonly reason?: string
  readonly compatibilityWarning?: string
  readonly pinnedHostRange: readonly PinnedDshVersion[]
  readonly hostVersion: string
  readonly hostConfirmed: boolean
  readonly singleProcess: true
  readonly storageDomain: boolean
  readonly sessions: boolean
  readonly llm: boolean
  readonly sessionProjections: boolean
  readonly officialProjection: boolean
  readonly domain: boolean
}

export interface AuxiliarySnapshot {
  readonly official: UsageBuckets
  readonly auxiliary: UsageBuckets
  readonly combined: UsageBuckets
  readonly capability: AuxiliaryCapability
}

export interface FenceAggregate {
  usage: UsageBuckets
  callCount: number
  runningCount: number
}
