import {
  ABORTED_CODE,
  MAX_CALL_ROWS,
  MAX_OUTPUT_CHARS,
  OFFICIAL_STREAM_PURPOSES,
  PURPOSES,
} from './constants.ts'
import {
  asLlm,
  asSessionProjections,
  asSessions,
  asStorageDomain,
  capabilityOf,
  dispatchBlockReason,
  hostServices,
  peekHost,
} from './capability.ts'
import { auxiliaryRuntimeDomain, policyInputSchema, reservationSchema } from './domain.ts'
import { AuxiliaryRuntimeError } from './errors.ts'
import {
  factFromCode,
  factFromFinish,
  factFromUnknown,
  failureFact,
  isAbortError,
} from './failures.ts'
import { AuxiliaryStore, heldReservationTotal, mapStorageFailure, type HeldReservation } from './store.ts'
import type {
  AuxiliaryCallResult,
  AuxiliaryCancelResult,
  AuxiliaryCapability,
  AuxiliaryPolicy,
  AuxiliaryRunRequest,
  AuxiliarySnapshot,
  CallRecord,
  DomainHandle,
  FailureFact,
  FinishReason,
  HostContext,
  LlmCallConfig,
  Message,
  GenerateOptions,
  SessionLike,
  UsageBuckets,
} from './types.ts'
import { addUsage, bucketsFromTokenUsage, cloneUsage, isUsageBuckets, totalTokens, zeroUsage } from './usage.ts'

interface ActiveCall {
  readonly controller: AbortController
  readonly abortListeners: Array<{ target: AbortSignal; listener: () => void }>
  done: Promise<AuxiliaryCallResult>
}

export class AuxiliaryRuntime {
  private domain: DomainHandle | undefined
  private store: AuxiliaryStore | undefined
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private domainOpen = false
  private lastOpenError: string | undefined
  private lastOpenFailure: FailureFact | undefined
  private readonly active = new Map<string, ActiveCall>()
  private readonly reservations = new Map<string, HeldReservation>()
  private admission: Promise<void> = Promise.resolve()
  private generation = 0

  constructor(private readonly ctx: HostContext) {}

  start(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.startPromise ??= this.openDomain(this.generation)
    return this.startPromise
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.generation += 1
    const stopping = this.performStop().finally(() => {
      this.domain = undefined
      this.store = undefined
      this.domainOpen = false
      this.startPromise = undefined
      this.stopPromise = undefined
    })
    this.stopPromise = stopping
    return stopping
  }

  async run(request: AuxiliaryRunRequest): Promise<AuxiliaryCallResult> {
    if (this.stopPromise !== undefined) return this.rejectStopped(request)
    await this.start()
    let validated: ValidatedRun
    try {
      validated = validateRunRequest(request)
    } catch (error) {
      if (error instanceof AuxiliaryRuntimeError) {
        return {
          callId: typeof request.callId === 'string' ? request.callId : '',
          sessionId: typeof request.sessionId === 'string' ? request.sessionId : '',
          purpose: PURPOSES.includes(request.purpose) ? request.purpose : 'clarify',
          status: 'failed',
          usage: zeroUsage(),
          usageRecorded: false,
          failure: error.toFact(),
          output: null,
          replayed: false,
        }
      }
      throw error
    }
    if (this.stopPromise !== undefined || !this.domainOpen) {
      return this.failed(validated, this.lastOpenFailure ?? factFromCode('DOMAIN_UNAVAILABLE'))
    }
    if (this.active.has(validated.callId)) {
      return this.failed(validated, factFromCode('CALL_ID_ACTIVE'))
    }

    const existing = this.store?.getCall(validated.callId)
    if (existing !== undefined && existing.status !== 'running') {
      return this.replayOrConflict(validated, existing)
    }
    if (existing?.status === 'running') {
      return this.failed(validated, factFromCode('CALL_ID_ACTIVE'))
    }

    const controller = new AbortController()
    const abortListeners = composeAbort(controller, validated.signal)
    const active: ActiveCall = {
      controller,
      abortListeners,
      done: Promise.resolve(this.failed(validated, factFromCode('UNKNOWN'))),
    }
    this.active.set(validated.callId, active)
    const done = this.execute(validated, active)
    active.done = done
    try {
      return await done
    } finally {
      this.active.delete(validated.callId)
      this.reservations.delete(validated.callId)
      releaseAbort(abortListeners)
    }
  }

  async cancel(callId: string): Promise<AuxiliaryCancelResult> {
    await this.start()
    if (typeof callId !== 'string' || callId.length === 0) {
      return { callId, failure: factFromCode('CALL_NOT_FOUND') }
    }
    const active = this.active.get(callId)
    if (active !== undefined) {
      active.controller.abort()
      const result = await active.done
      return { callId, status: result.status, ...result.failure === undefined ? {} : { failure: result.failure } }
    }
    const row = this.store?.getCall(callId)
    if (row === undefined) {
      return { callId, failure: factFromCode('CALL_NOT_FOUND') }
    }
    return { callId, status: row.status, ...row.failure === undefined ? {} : { failure: row.failure } }
  }

  async snapshot(sessionId: string): Promise<AuxiliarySnapshot> {
    await this.start()
    const official = this.readOfficial(sessionId)
    const session = this.requireSession(sessionId, false)
    const auxiliary = session === undefined || this.store === undefined
      ? zeroUsage()
      : this.store.aggregate(session.id, session.header.createdAt).usage
    return {
      official: official.usage,
      auxiliary,
      combined: addUsage(official.usage, auxiliary),
      capability: this.capability(official.present, this.snapshotReason(session, official.present)),
    }
  }

  async getPolicy(sessionId: string): Promise<AuxiliaryPolicy> {
    await this.start()
    const session = this.requireSession(sessionId, true)
    this.assertReady()
    return this.store!.getPolicy(session.id, session.header.createdAt)
  }

  async setPolicy(sessionId: string, policy: AuxiliaryPolicy): Promise<AuxiliaryPolicy> {
    await this.start()
    const session = this.requireSession(sessionId, true)
    this.assertReady()
    const parsed = policyInputSchema.safeParse(policy)
    if (!parsed.success) {
      throw new AuxiliaryRuntimeError('INVALID_REQUEST', 'policy must include non-negative integer limit fields')
    }
    const next: AuxiliaryPolicy = {
      maxConcurrentCalls: parsed.data.maxConcurrentCalls,
      maxCallsPerSession: parsed.data.maxCallsPerSession,
      maxAuxiliaryTotalTokens: parsed.data.maxAuxiliaryTotalTokens,
    }
    try {
      await this.store!.putPolicy({
        sessionId: session.id,
        sessionCreatedAt: session.header.createdAt,
        ...next,
        updatedAt: Date.now(),
      })
    } catch (error) {
      throw mapStorageFailure(error)
    }
    return next
  }

  capability(officialProjection = false, reason?: string): AuxiliaryCapability {
    return capabilityOf({
      ctx: this.ctx,
      domainOpen: this.domainOpen,
      officialProjection,
      reason: reason ?? this.lastOpenError,
    })
  }

  private async performStop(): Promise<void> {
    if (this.startPromise !== undefined) {
      await this.startPromise.catch(() => undefined)
    }
    const calls = [...this.active.values()]
    for (const active of calls) active.controller.abort()
    await Promise.allSettled(calls.map((active) => active.done))
    if (this.domain !== undefined) await this.domain.close()
  }

  private async openDomain(generation: number): Promise<void> {
    const storage = asStorageDomain(peekHost(this.ctx, 'storageDomain'))
    if (storage === undefined) {
      this.domainOpen = false
      this.lastOpenError = 'ctx.storageDomain.open is unavailable'
      this.lastOpenFailure = factFromCode('STORAGE_UNAVAILABLE')
      return
    }
    let opened: DomainHandle | undefined
    try {
      opened = await storage.open(auxiliaryRuntimeDomain)
      if (generation !== this.generation || this.stopPromise !== undefined) {
        await opened.close()
        return
      }
      const store = new AuxiliaryStore(opened)
      await store.recoverOrphans(Date.now())
      store.rebuild()
      if (generation !== this.generation || this.stopPromise !== undefined) {
        await opened.close()
        return
      }
      this.domain = opened
      this.store = store
      this.domainOpen = true
      this.lastOpenError = undefined
      this.lastOpenFailure = undefined
    } catch (error) {
      if (opened !== undefined && opened !== this.domain) {
        await opened.close().catch(() => undefined)
      }
      this.domain = undefined
      this.store = undefined
      this.domainOpen = false
      const failure = mapStorageFailure(error)
      this.lastOpenError = failure.message
      this.lastOpenFailure = failure.toFact()
    }
  }

  private async execute(request: ValidatedRun, active: ActiveCall): Promise<AuxiliaryCallResult> {
    const admitted = await this.withAdmission(async () => {
      if (active.controller.signal.aborted || this.stopPromise !== undefined) {
        return { kind: 'result', result: this.cancelled(request) } as const
      }
      return await this.admit(request)
    })
    if (admitted.kind === 'result') return admitted.result
    return await this.dispatch(request, admitted.row, admitted.session, active.controller)
  }

  private async admit(request: ValidatedRun): Promise<
    | { kind: 'result'; result: AuxiliaryCallResult }
    | { kind: 'admitted'; row: CallRecord; session: SessionLike }
  > {
    const existing = this.store?.getCall(request.callId)
    if (existing !== undefined && existing.status !== 'running') {
      return { kind: 'result', result: this.replayOrConflict(request, existing) }
    }
    if (existing?.status === 'running') {
      return { kind: 'result', result: this.failed(request, factFromCode('CALL_ID_ACTIVE')) }
    }

    const blocked = this.dispatchGate()
    if (blocked !== undefined) {
      return { kind: 'result', result: this.failed(request, blocked) }
    }
    const session = this.requireSession(request.sessionId, false)
    if (session === undefined) {
      return { kind: 'result', result: this.failed(request, factFromCode('SESSION_NOT_FOUND')) }
    }

    const limit = this.preflight(session, request)
    if (limit !== undefined) {
      return { kind: 'result', result: this.failed(request, limit) }
    }

    const now = Date.now()
    const row: CallRecord = {
      callId: request.callId,
      sessionId: session.id,
      sessionCreatedAt: session.header.createdAt,
      purpose: request.purpose,
      status: 'running',
      usage: zeroUsage(),
      usageRecorded: false,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.store!.putCall(row)
    } catch (error) {
      return { kind: 'result', result: this.failed(request, mapStorageFailure(error).toFact()) }
    }
    this.reservations.set(request.callId, {
      sessionId: session.id,
      sessionCreatedAt: session.header.createdAt,
      reservation: request.reservation,
    })
    return { kind: 'admitted', row, session }
  }

  private async dispatch(
    request: ValidatedRun,
    row: CallRecord,
    session: SessionLike,
    controller: AbortController,
  ): Promise<AuxiliaryCallResult> {
    if (controller.signal.aborted) {
      return await this.terminalize(row, {
        status: 'cancelled',
        failure: factFromCode(ABORTED_CODE),
        usage: row.usage,
        usageRecorded: row.usageRecorded,
      })
    }

    const llm = hostServices(this.ctx).llm
    if (llm === undefined) {
      return await this.terminalize(row, {
        status: 'failed',
        failure: factFromCode('LLM_UNAVAILABLE'),
        usage: row.usage,
        usageRecorded: row.usageRecorded,
      })
    }

    let usage = cloneUsage(row.usage)
    let usageRecorded = row.usageRecorded
    let output = ''
    let outputTooLarge = false
    try {
      const prepared = await llm.prepareCall(cloneConfig(request.config), controller.signal)
      if (controller.signal.aborted) {
        return await this.terminalize(row, {
          status: 'cancelled',
          failure: factFromCode(ABORTED_CODE),
          usage,
          usageRecorded,
        })
      }
      const options = streamOptions(prepared.config, request, session, controller.signal)
      let finish: FinishReason | undefined
      for await (const chunk of prepared.stream(options)) {
        if (chunk.type === 'text-delta') {
          if (output.length + chunk.text.length > MAX_OUTPUT_CHARS) {
            outputTooLarge = true
            controller.abort()
            break
          }
          output += chunk.text
        }
        if (chunk.type === 'usage') {
          usage = bucketsFromTokenUsage(chunk.usage)
          usageRecorded = true
          await this.persistUsage(row.callId, usage, usageRecorded)
        }
        if (chunk.type === 'finish') finish = chunk.reason
      }
      if (outputTooLarge) {
        return await this.terminalize(row, {
          status: 'failed',
          failure: factFromCode('OUTPUT_TOO_LARGE'),
          usage,
          usageRecorded,
        })
      }
      return await this.terminalize(
        row,
        outcomeFromFinish(finish, usage, usageRecorded, controller.signal.aborted),
        output,
      )
    } catch (error) {
      if (outputTooLarge) {
        return await this.terminalize(row, {
          status: 'failed',
          failure: factFromCode('OUTPUT_TOO_LARGE'),
          usage,
          usageRecorded,
        })
      }
      if (controller.signal.aborted || isAbortError(error)) {
        return await this.terminalize(row, {
          status: 'cancelled',
          failure: factFromCode(ABORTED_CODE),
          usage,
          usageRecorded,
        })
      }
      return await this.terminalize(row, {
        status: 'failed',
        failure: factFromUnknown(error),
        usage,
        usageRecorded,
      })
    }
  }

  private async persistUsage(callId: string, usage: UsageBuckets, usageRecorded: boolean): Promise<void> {
    if (this.store === undefined) return
    try {
      await this.store.updateCall(callId, (current) => ({
        ...current,
        usage: cloneUsage(usage),
        usageRecorded,
        updatedAt: Date.now(),
      }))
    } catch {
      // Keep the in-memory usage so a later terminal write can still record it.
    }
  }

  private async terminalize(
    row: CallRecord,
    outcome: {
      status: CallRecord['status']
      failure?: FailureFact
      usage: UsageBuckets
      usageRecorded: boolean
    },
    output?: string,
  ): Promise<AuxiliaryCallResult> {
    const next: CallRecord = {
      ...row,
      status: outcome.status,
      usage: cloneUsage(outcome.usage),
      usageRecorded: outcome.usageRecorded,
      updatedAt: Date.now(),
      ...outcome.failure === undefined ? {} : { failure: outcome.failure },
    }
    if (this.store !== undefined) {
      try {
        await this.store.putCall(next)
      } catch (error) {
        return {
          callId: row.callId,
          sessionId: row.sessionId,
          purpose: row.purpose,
          status: 'failed',
          usage: next.usage,
          usageRecorded: next.usageRecorded,
          failure: mapStorageFailure(error).toFact(),
          output: null,
          replayed: false,
        }
      }
    }
    const result = resultOf(next, false)
    return result.status === 'succeeded' && output !== undefined
      ? { ...result, output }
      : result
  }

  private replayOrConflict(request: ValidatedRun, existing: CallRecord): AuxiliaryCallResult {
    const session = this.requireSession(request.sessionId, false)
    if (
      existing.sessionId !== request.sessionId
      || session === undefined
      || existing.sessionCreatedAt !== session.header.createdAt
    ) {
      return this.failed(request, factFromCode('CALL_ID_SESSION_CONFLICT'))
    }
    if (existing.purpose !== request.purpose) {
      return this.failed(request, factFromCode('CALL_ID_PURPOSE_CONFLICT'))
    }
    return resultOf(existing, true)
  }

  private preflight(session: SessionLike, request: ValidatedRun): FailureFact | undefined {
    const store = this.store
    if (store === undefined) return factFromCode('DOMAIN_UNAVAILABLE')
    if (store.rowCount() >= MAX_CALL_ROWS) return factFromCode('ROW_LIMIT')

    const policy = store.getPolicy(session.id, session.header.createdAt)
    const aggregate = store.aggregate(session.id, session.header.createdAt)
    if (aggregate.runningCount >= policy.maxConcurrentCalls) {
      return factFromCode('MAX_CONCURRENT_CALLS')
    }
    if (aggregate.callCount >= policy.maxCallsPerSession) {
      return factFromCode('MAX_CALLS_PER_SESSION')
    }
    const reserved = heldReservationTotal(
      this.reservations.values(),
      session.id,
      session.header.createdAt,
    )
    if (totalTokens(aggregate.usage) + reserved + totalTokens(request.reservation) > policy.maxAuxiliaryTotalTokens) {
      return factFromCode('MAX_AUXILIARY_TOTAL_TOKENS')
    }
    return undefined
  }

  private dispatchGate(): FailureFact | undefined {
    const capability = this.capability()
    const reason = dispatchBlockReason(capability)
    if (reason === undefined) return undefined
    if (!capability.storageDomain || !capability.domain) return factFromCode('STORAGE_UNAVAILABLE')
    if (!capability.sessions) return factFromCode('SESSION_NOT_FOUND')
    if (!capability.llm) return factFromCode('LLM_UNAVAILABLE')
    if (capability.hostVersion !== 'unknown' && !capability.ok) return factFromCode('HOST_UNSUPPORTED')
    return factFromCode('HOST_UNSUPPORTED')
  }

  private requireSession(sessionId: string, required: true): SessionLike
  private requireSession(sessionId: string, required: false): SessionLike | undefined
  private requireSession(sessionId: string, required: boolean): SessionLike | undefined {
    const sessions = asSessions(peekHost(this.ctx, 'sessions'))
    const session = sessions?.get(sessionId)
    if (session === undefined || typeof session.header?.createdAt !== 'number') {
      if (required) {
        throw new AuxiliaryRuntimeError('SESSION_NOT_FOUND', `session ${sessionId} is not live`)
      }
      return undefined
    }
    return session
  }

  private readOfficial(sessionId: string): { usage: UsageBuckets; present: boolean } {
    const sessions = asSessions(peekHost(this.ctx, 'sessions'))
    const projections = asSessionProjections(peekHost(this.ctx, 'sessionProjections'))
    const session = sessions?.get(sessionId)
    if (session === undefined || projections === undefined) {
      return { usage: zeroUsage(), present: false }
    }
    const values = projections.snapshot(session).values
    const tokenUsage = values.tokenUsage
    if (!isUsageBuckets(tokenUsage)) {
      return { usage: zeroUsage(), present: false }
    }
    return { usage: cloneUsage(tokenUsage), present: true }
  }

  private snapshotReason(session: SessionLike | undefined, officialPresent: boolean): string | undefined {
    if (session === undefined) return 'session is not live'
    if (!officialPresent) return 'official tokenUsage projection is unavailable'
    return undefined
  }

  private assertReady(): void {
    if (this.store === undefined || !this.domainOpen) {
      throw new AuxiliaryRuntimeError('DOMAIN_UNAVAILABLE', this.lastOpenError ?? 'auxiliary_runtime domain is not open')
    }
    if (asLlm(peekHost(this.ctx, 'llm')) === undefined) {
      throw new AuxiliaryRuntimeError('LLM_UNAVAILABLE', 'ctx.llm.prepareCall is unavailable')
    }
  }

  private rejectStopped(request: AuxiliaryRunRequest): AuxiliaryCallResult {
    return {
      callId: typeof request.callId === 'string' ? request.callId : '',
      sessionId: typeof request.sessionId === 'string' ? request.sessionId : '',
      purpose: PURPOSES.includes(request.purpose) ? request.purpose : 'clarify',
      status: 'failed',
      usage: zeroUsage(),
      usageRecorded: false,
      failure: factFromCode('DOMAIN_UNAVAILABLE'),
      output: null,
      replayed: false,
    }
  }

  private cancelled(request: ValidatedRun): AuxiliaryCallResult {
    return {
      callId: request.callId,
      sessionId: request.sessionId,
      purpose: request.purpose,
      status: 'cancelled',
      usage: zeroUsage(),
      usageRecorded: false,
      failure: factFromCode(ABORTED_CODE),
      output: null,
      replayed: false,
    }
  }

  private failed(request: ValidatedRun, failure: FailureFact): AuxiliaryCallResult {
    return {
      callId: request.callId,
      sessionId: request.sessionId,
      purpose: request.purpose,
      status: 'failed',
      usage: zeroUsage(),
      usageRecorded: false,
      failure,
      output: null,
      replayed: false,
    }
  }

  private async withAdmission<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.admission
    let release!: () => void
    this.admission = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

interface ValidatedRun {
  readonly callId: string
  readonly sessionId: string
  readonly purpose: AuxiliaryRunRequest['purpose']
  readonly config: LlmCallConfig
  readonly system?: string
  readonly messages: readonly Message[]
  readonly reservation: UsageBuckets
  readonly signal?: AbortSignal
}

function validateRunRequest(request: AuxiliaryRunRequest): ValidatedRun {
  if (typeof request.callId !== 'string' || request.callId.length === 0) {
    throw new AuxiliaryRuntimeError('INVALID_REQUEST', 'callId is required')
  }
  if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
    throw new AuxiliaryRuntimeError('INVALID_REQUEST', 'sessionId is required')
  }
  if (!PURPOSES.includes(request.purpose)) {
    throw new AuxiliaryRuntimeError('INVALID_REQUEST', 'purpose must be clarify, compaction, or session-title')
  }
  if (request.config === undefined || typeof request.config.provider !== 'string' || typeof request.config.model !== 'string') {
    throw new AuxiliaryRuntimeError('INVALID_REQUEST', 'config.provider and config.model are required')
  }
  if (!Array.isArray(request.messages)) {
    throw new AuxiliaryRuntimeError('INVALID_REQUEST', 'messages must be an array')
  }
  if (request.reservation === undefined) {
    throw new AuxiliaryRuntimeError('RESERVATION_REQUIRED', 'a mandatory usage reservation is required')
  }
  const reservation = reservationSchema.safeParse(request.reservation)
  if (!reservation.success) {
    throw new AuxiliaryRuntimeError('INVALID_REQUEST', 'reservation must be four non-negative integer buckets')
  }
  return {
    callId: request.callId,
    sessionId: request.sessionId,
    purpose: request.purpose,
    config: cloneConfig(request.config),
    ...request.system === undefined ? {} : { system: request.system },
    messages: request.messages,
    reservation: reservation.data,
    ...request.signal === undefined ? {} : { signal: request.signal },
  }
}

function cloneConfig(config: LlmCallConfig): LlmCallConfig {
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    ...config.temperature === undefined ? {} : { temperature: config.temperature },
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
    ...config.stop === undefined ? {} : { stop: [...config.stop] },
  }
}

function streamOptions(
  config: LlmCallConfig,
  request: ValidatedRun,
  session: SessionLike,
  signal: AbortSignal,
): GenerateOptions {
  const officialPurpose = (OFFICIAL_STREAM_PURPOSES as readonly string[]).includes(request.purpose)
    ? request.purpose as 'compaction' | 'session-title'
    : undefined
  return {
    ...cloneConfig(config),
    messages: [...request.messages],
    signal,
    sessionId: session.id,
    ...request.system === undefined ? {} : { system: request.system },
    ...officialPurpose === undefined ? {} : { purpose: officialPurpose },
  }
}

function outcomeFromFinish(
  finish: FinishReason | undefined,
  usage: UsageBuckets,
  usageRecorded: boolean,
  aborted: boolean,
): {
  status: CallRecord['status']
  failure?: FailureFact
  usage: UsageBuckets
  usageRecorded: boolean
} {
  if (aborted) {
    return { status: 'cancelled', failure: factFromCode(ABORTED_CODE), usage, usageRecorded }
  }
  if (finish === undefined) {
    return { status: 'failed', failure: failureFact('error', 'EMPTY_RESPONSE'), usage, usageRecorded }
  }
  if (finish.kind === 'stop' || finish.kind === 'max-tokens') {
    return { status: 'succeeded', usage, usageRecorded }
  }
  if (finish.kind === 'aborted') {
    return { status: 'cancelled', failure: factFromFinish(finish), usage, usageRecorded }
  }
  return { status: 'failed', failure: factFromFinish(finish), usage, usageRecorded }
}

function resultOf(row: CallRecord, replayed: boolean): AuxiliaryCallResult {
  return {
    callId: row.callId,
    sessionId: row.sessionId,
    purpose: row.purpose,
    status: row.status,
    usage: cloneUsage(row.usage),
    usageRecorded: row.usageRecorded,
    ...row.failure === undefined ? {} : { failure: row.failure },
    output: null,
    replayed,
  }
}

function composeAbort(
  controller: AbortController,
  signal: AbortSignal | undefined,
): Array<{ target: AbortSignal; listener: () => void }> {
  const listeners: Array<{ target: AbortSignal; listener: () => void }> = []
  if (signal === undefined) return listeners
  const listener = () => {
    controller.abort()
  }
  if (signal.aborted) {
    controller.abort()
    return listeners
  }
  signal.addEventListener('abort', listener, { once: true })
  listeners.push({ target: signal, listener })
  return listeners
}

function releaseAbort(listeners: Array<{ target: AbortSignal; listener: () => void }>): void {
  for (const item of listeners) {
    item.target.removeEventListener('abort', item.listener)
  }
}
