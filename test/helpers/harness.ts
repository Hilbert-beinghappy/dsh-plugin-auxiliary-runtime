import { AuxiliaryRuntime } from '../../src/runtime.ts'
import { auxiliaryRuntimeDomain } from '../../src/domain.ts'
import type {
  AuxiliaryRunRequest,
  CallRecord,
  DomainHandle,
  DomainSpec,
  HostContext,
  LlmCallConfig,
  Message,
  PolicyRecord,
  PreparedLlmCall,
  SessionLike,
  StreamChunk,
  TokenUsage,
  UsageBuckets,
} from '../../src/types.ts'

export class MemoryTable<V> {
  readonly map = new Map<string, V>()
  failNext = false

  get(key: string): V | undefined {
    return this.map.get(key)
  }

  get size(): number {
    return this.map.size
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries()
  }

  keys(): IterableIterator<string> {
    return this.map.keys()
  }

  async put(key: string, value: V): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw Object.assign(new Error('storage write failed'), { code: 'backend-failed' })
    }
    this.map.set(key, structuredClone(value))
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }

  async update(key: string, fn: (current: V) => V): Promise<V> {
    if (!this.map.has(key)) {
      throw Object.assign(new Error('missing-key'), { code: 'missing-key' })
    }
    const next = fn(structuredClone(this.map.get(key) as V))
    await this.put(key, next)
    return structuredClone(this.map.get(key) as V)
  }
}

export interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export const defaultConfig: LlmCallConfig = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
}

export const defaultReservation: UsageBuckets = {
  uncachedInputTokens: 10,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

export function tokenUsage(input = 4, output = 6, cacheRead = 0, cacheWrite = 0): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

export function usageChunks(usage: TokenUsage = tokenUsage(), finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }): StreamChunk[] {
  return [{ type: 'usage', usage }, finish]
}

export interface HarnessOptions {
  dshVersion?: string
  omitHostVersion?: boolean
  versionMismatch?: boolean
  omit?: Array<'storageDomain' | 'sessions' | 'llm' | 'sessionProjections'>
}

export interface TestHarness {
  runtime: AuxiliaryRuntime
  host: HostContext
  calls: MemoryTable<CallRecord>
  policies: MemoryTable<PolicyRecord>
  sessions: Map<string, SessionLike>
  official: { tokenUsage?: UsageBuckets }
  prepareCalls: number
  streamCalls: number
  lastStreamOptions: Record<string, unknown> | undefined
  events: string[]
  provided: Map<string, unknown>
  typertContributions: unknown[]
  addSession(sessionId: string, createdAt?: number): SessionLike
  setChunks(chunks: StreamChunk[] | ((signal: AbortSignal) => AsyncIterable<StreamChunk>)): void
  request(overrides?: Partial<AuxiliaryRunRequest>): AuxiliaryRunRequest
  reopen(): AuxiliaryRuntime
}

export function createHarness(options: HarnessOptions = {}): TestHarness {
  const calls = new MemoryTable<CallRecord>()
  const policies = new MemoryTable<PolicyRecord>()
  const sessions = new Map<string, SessionLike>()
  const official: { tokenUsage?: UsageBuckets } = {
    tokenUsage: {
      uncachedInputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    },
  }
  const events: string[] = []
  const provided = new Map<string, unknown>()
  const typertContributions: unknown[] = []
  let prepareCalls = 0
  let streamCalls = 0
  let lastStreamOptions: Record<string, unknown> | undefined
  let chunkFactory: (signal: AbortSignal) => AsyncIterable<StreamChunk> = async function* () {
    yield* usageChunks()
  }

  function table(name: 'calls'): typeof calls
  function table(name: 'policies'): typeof policies
  function table(name: string): typeof calls | typeof policies
  function table(name: string) {
    if (name === 'calls') return calls
    if (name === 'policies') return policies
    throw new Error(`unknown table ${name}`)
  }

  const domain: DomainHandle = {
    name: 'auxiliary_runtime',
    table,
    async close() {},
  }

  const host: HostContext = {
    get(name) {
      if (provided.has(name)) return provided.get(name)
      return (host as Record<string, unknown>)[name]
    },
    provide(name, value) {
      provided.set(name, value)
      return value
    },
    typert: {
      register(contribution) {
        typertContributions.push(contribution)
        return () => {}
      },
    },
  }
  if (!options.omitHostVersion) host.dshVersion = options.dshVersion ?? '0.1.0-rc.8'

  if (!options.omit?.includes('storageDomain')) {
    host.storageDomain = {
      async open(spec: DomainSpec) {
        events.push('open')
        if (options.versionMismatch) {
          throw Object.assign(new Error('version-mismatch'), { code: 'version-mismatch' })
        }
        for (const name of ['calls', 'policies'] as const) {
          const table = name === 'calls' ? calls : policies
          for (const [key, value] of table.entries()) {
            const parsed = spec.tables[name].valueSchema.safeParse(value)
            if (!parsed.success) {
              throw Object.assign(new Error('invalid-record'), {
                code: 'invalid-record',
                detail: { table: name, key },
              })
            }
          }
        }
        expectOpenSpec(spec)
        return domain
      },
    }
  }
  if (!options.omit?.includes('sessions')) {
    host.sessions = {
      get(sessionId) {
        return sessions.get(sessionId)
      },
    }
  }
  if (!options.omit?.includes('llm')) {
    host.llm = {
      async prepareCall(config, signal) {
        events.push('prepare')
        prepareCalls += 1
        if (signal?.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' })
        }
        const prepared: PreparedLlmCall = {
          config,
          context: { contextWindow: 64_000 },
          adapterDefaults: {},
          stream(streamOptions) {
            events.push('stream')
            streamCalls += 1
            lastStreamOptions = streamOptions as unknown as Record<string, unknown>
            return chunkFactory(streamOptions.signal ?? new AbortController().signal)
          },
        }
        return prepared
      },
    }
  }
  if (!options.omit?.includes('sessionProjections')) {
    host.sessionProjections = {
      snapshot(session) {
        return {
          asOfSeq: (session.seq ?? 1) - 1,
          values: official.tokenUsage === undefined ? {} : { tokenUsage: official.tokenUsage },
        }
      },
    }
  }

  const originalPut = calls.put.bind(calls)
  calls.put = async (key, value) => {
    if (value.status === 'running' && !calls.map.has(key)) {
      events.push('persist')
    }
    return originalPut(key, value)
  }

  const addSession = (sessionId: string, createdAt = 1_700_000_000_000): SessionLike => {
    const session: SessionLike = {
      id: sessionId,
      header: { id: sessionId, createdAt, version: 1 },
      seq: 1,
    }
    sessions.set(sessionId, session)
    return session
  }

  const request = (overrides: Partial<AuxiliaryRunRequest> = {}): AuxiliaryRunRequest => {
    return {
      callId: 'call-1',
      sessionId: 'session-1',
      purpose: 'clarify',
      config: defaultConfig,
      system: 'system text',
      messages: [{
        id: 'message-test' as Message['id'],
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }],
      reservation: defaultReservation,
      ...overrides,
    } as AuxiliaryRunRequest
  }

  const reopen = (): AuxiliaryRuntime => new AuxiliaryRuntime(host)

  addSession('session-1')

  return {
    runtime: new AuxiliaryRuntime(host),
    host,
    calls,
    policies,
    sessions,
    official,
    get prepareCalls() { return prepareCalls },
    get streamCalls() { return streamCalls },
    get lastStreamOptions() { return lastStreamOptions },
    events,
    provided,
    typertContributions,
    addSession,
    setChunks(chunks) {
      if (typeof chunks === 'function') {
        chunkFactory = chunks
        return
      }
      chunkFactory = async function* () {
        yield* chunks
      }
    },
    request,
    reopen,
  }
}

function expectOpenSpec(spec: DomainSpec): void {
  if (spec !== auxiliaryRuntimeDomain && spec.name !== 'auxiliary_runtime') {
    throw new Error('opened unexpected domain')
  }
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
