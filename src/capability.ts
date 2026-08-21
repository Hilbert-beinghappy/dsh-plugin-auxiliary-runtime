import { PINNED_DSH_VERSIONS } from './constants.ts'
import type {
  AuxiliaryCapability,
  HostContext,
  LlmService,
  SessionProjectionsService,
  SessionsService,
  StorageDomainService,
} from './types.ts'

export function peekHost(ctx: object | undefined, name: string): unknown {
  if (ctx === undefined || ctx === null || typeof ctx !== 'object') return undefined
  const record = ctx as HostContext
  if (typeof record.get === 'function') {
    try {
      const loose = record.get(name, false)
      if (loose !== undefined) return loose
    } catch {
      // declared-but-waiting Cordis services throw
    }
    try {
      const value = record.get(name)
      if (value !== undefined) return value
    } catch {
      // fall through
    }
  }
  try {
    return (record as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

export function readHostVersion(ctx: HostContext | undefined): string {
  const fromPeek = peekHost(ctx, 'dshVersion')
  if (typeof fromPeek === 'string' && fromPeek.length > 0) return fromPeek
  const fromEnv = process.env.DSH_VERSION
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return 'unknown'
}

export function isPinnedHostVersion(version: string): boolean {
  return (PINNED_DSH_VERSIONS as readonly string[]).includes(version)
}

export function asStorageDomain(value: unknown): StorageDomainService | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const open = (value as StorageDomainService).open
  return typeof open === 'function' ? value as StorageDomainService : undefined
}

export function asSessions(value: unknown): SessionsService | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const get = (value as SessionsService).get
  return typeof get === 'function' ? value as SessionsService : undefined
}

export function asLlm(value: unknown): LlmService | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const prepareCall = (value as LlmService).prepareCall
  return typeof prepareCall === 'function' ? value as LlmService : undefined
}

export function asSessionProjections(value: unknown): SessionProjectionsService | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const snapshot = (value as SessionProjectionsService).snapshot
  return typeof snapshot === 'function' ? value as SessionProjectionsService : undefined
}

export function hostServices(ctx: HostContext | undefined): {
  storageDomain?: StorageDomainService
  sessions?: SessionsService
  llm?: LlmService
  sessionProjections?: SessionProjectionsService
} {
  return {
    storageDomain: asStorageDomain(peekHost(ctx, 'storageDomain')),
    sessions: asSessions(peekHost(ctx, 'sessions')),
    llm: asLlm(peekHost(ctx, 'llm')),
    sessionProjections: asSessionProjections(peekHost(ctx, 'sessionProjections')),
  }
}

export function capabilityOf(input: {
  ctx?: HostContext
  domainOpen: boolean
  officialProjection: boolean
  reason?: string
}): AuxiliaryCapability {
  const services = hostServices(input.ctx)
  const hostVersion = readHostVersion(input.ctx)
  const storageDomain = services.storageDomain !== undefined
  const sessions = services.sessions !== undefined
  const llm = services.llm !== undefined
  const sessionProjections = services.sessionProjections !== undefined
  const hostConfirmed = isPinnedHostVersion(hostVersion)
  const hostRejected = hostVersion !== 'unknown' && !hostConfirmed
  const ok = !hostRejected && storageDomain && sessions && llm && input.domainOpen
  const reason = input.reason
    ?? (hostRejected ? `host ${hostVersion} is outside the tested range ${PINNED_DSH_VERSIONS.join(', ')}` : undefined)
    ?? (!storageDomain ? 'ctx.storageDomain.open is unavailable' : undefined)
    ?? (!sessions ? 'ctx.sessions.get is unavailable' : undefined)
    ?? (!llm ? 'ctx.llm.prepareCall is unavailable' : undefined)
    ?? (!input.domainOpen ? 'auxiliary_runtime domain is not open' : undefined)
  return {
    ok,
    ...reason === undefined ? {} : { reason },
    ...hostVersion === 'unknown'
      ? { compatibilityWarning: `host version is unconfirmed; tested range is ${PINNED_DSH_VERSIONS.join(', ')} only` }
      : {},
    pinnedHostRange: PINNED_DSH_VERSIONS,
    hostVersion,
    hostConfirmed,
    singleProcess: true,
    storageDomain,
    sessions,
    llm,
    sessionProjections,
    officialProjection: input.officialProjection,
    domain: input.domainOpen,
  }
}

export function dispatchBlockReason(capability: AuxiliaryCapability): string | undefined {
  if (capability.ok) return undefined
  return capability.reason ?? 'required Host capability is missing'
}
