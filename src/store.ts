import { CALLS_TABLE, DEFAULT_POLICY, POLICIES_TABLE } from './constants.ts'
import { AuxiliaryRuntimeError } from './errors.ts'
import { factFromCode, officialFailureCode } from './failures.ts'
import type {
  AuxiliaryPolicy,
  CallRecord,
  DomainHandle,
  FenceAggregate,
  PolicyRecord,
  UsageBuckets,
} from './types.ts'
import { addUsage, cloneUsage, zeroUsage } from './usage.ts'

export function fenceKey(sessionId: string, sessionCreatedAt: number): string {
  return `${sessionId}:${sessionCreatedAt}`
}

export function emptyAggregate(): FenceAggregate {
  return { usage: zeroUsage(), callCount: 0, runningCount: 0 }
}

export class AuxiliaryStore {
  private readonly aggregates = new Map<string, FenceAggregate>()

  constructor(private readonly domain: DomainHandle) {}

  get calls() {
    return this.domain.table(CALLS_TABLE)
  }

  get policies() {
    return this.domain.table(POLICIES_TABLE)
  }

  rebuild(): void {
    this.aggregates.clear()
    for (const [, row] of this.calls.entries()) {
      this.include(row)
    }
  }

  aggregate(sessionId: string, sessionCreatedAt: number): FenceAggregate {
    return cloneAggregate(this.aggregates.get(fenceKey(sessionId, sessionCreatedAt)) ?? emptyAggregate())
  }

  getCall(callId: string): CallRecord | undefined {
    return this.calls.get(callId)
  }

  rowCount(): number {
    return this.calls.size
  }

  async putCall(row: CallRecord): Promise<void> {
    await this.calls.put(row.callId, row)
    this.rebuild()
  }

  async updateCall(callId: string, fn: (current: CallRecord) => CallRecord): Promise<CallRecord> {
    const next = await this.calls.update(callId, fn)
    this.rebuild()
    return next
  }

  getPolicy(sessionId: string, sessionCreatedAt: number): AuxiliaryPolicy {
    const row = this.policies.get(fenceKey(sessionId, sessionCreatedAt))
    if (row === undefined) return { ...DEFAULT_POLICY }
    return {
      maxConcurrentCalls: row.maxConcurrentCalls,
      maxCallsPerSession: row.maxCallsPerSession,
      maxAuxiliaryTotalTokens: row.maxAuxiliaryTotalTokens,
    }
  }

  async putPolicy(row: PolicyRecord): Promise<void> {
    await this.policies.put(fenceKey(row.sessionId, row.sessionCreatedAt), row)
  }

  async recoverOrphans(now: number): Promise<number> {
    let recovered = 0
    for (const [callId, row] of this.calls.entries()) {
      if (row.status !== 'running') continue
      await this.calls.put(callId, {
        ...row,
        status: 'interrupted',
        failure: factFromCode('INTERRUPTED'),
        updatedAt: now,
      })
      recovered += 1
    }
    if (recovered > 0) this.rebuild()
    return recovered
  }

  private include(row: CallRecord): void {
    const key = fenceKey(row.sessionId, row.sessionCreatedAt)
    const current = this.aggregates.get(key) ?? emptyAggregate()
    this.aggregates.set(key, {
      usage: addUsage(current.usage, row.usage),
      callCount: current.callCount + 1,
      runningCount: current.runningCount + (row.status === 'running' ? 1 : 0),
    })
  }
}

export function cloneAggregate(value: FenceAggregate): FenceAggregate {
  return {
    usage: cloneUsage(value.usage),
    callCount: value.callCount,
    runningCount: value.runningCount,
  }
}

export function mapStorageFailure(error: unknown): AuxiliaryRuntimeError {
  const code = officialFailureCode(error)
  if (code === 'version-mismatch') {
    return new AuxiliaryRuntimeError('VERSION_MISMATCH', 'auxiliary_runtime domain version does not match the opened medium')
  }
  if (code === 'invalid-record') {
    return new AuxiliaryRuntimeError('INVALID_RECORD', 'auxiliary_runtime storage rejected an invalid record')
  }
  if (code === 'already-open') {
    return new AuxiliaryRuntimeError('DOMAIN_UNAVAILABLE', 'auxiliary_runtime domain is already open in this process')
  }
  return new AuxiliaryRuntimeError('STORAGE_UNAVAILABLE', 'auxiliary_runtime storageDomain write or open failed')
}

export interface HeldReservation {
  readonly sessionId: string
  readonly sessionCreatedAt: number
  readonly reservation: UsageBuckets
}

export function heldReservationTotal(
  reservations: Iterable<HeldReservation>,
  sessionId: string,
  sessionCreatedAt: number,
): number {
  let total = 0
  for (const held of reservations) {
    if (held.sessionId !== sessionId || held.sessionCreatedAt !== sessionCreatedAt) continue
    total += held.reservation.uncachedInputTokens
      + held.reservation.outputTokens
      + held.reservation.cacheReadTokens
      + held.reservation.cacheWriteTokens
  }
  return total
}
