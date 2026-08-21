import { PACKAGE_NAME, REMOTE_NAMESPACE, TYPERT_REMOTE_METHODS } from './constants.ts'
import { peekHost } from './capability.ts'
import type { AuxiliaryRuntime } from './runtime.ts'
import type { HostContext, TypertLike } from './types.ts'

export interface AuxiliaryRuntimeHost {
  snapshot(sessionId: string): ReturnType<AuxiliaryRuntime['snapshot']>
  cancel(callId: string): ReturnType<AuxiliaryRuntime['cancel']>
  run: AuxiliaryRuntime['run']
  getPolicy: AuxiliaryRuntime['getPolicy']
  setPolicy: AuxiliaryRuntime['setPolicy']
}

export interface AuxiliaryRuntimeRemote {
  readonly typertRemote: {
    readonly service: AuxiliaryRuntimeRemote
    readonly serviceKey: string
    readonly namespace: string
  }
  snapshot(sessionId: string): ReturnType<AuxiliaryRuntime['snapshot']>
  cancel(callId: string): ReturnType<AuxiliaryRuntime['cancel']>
}

export interface HostRegistration {
  status: 'registered' | 'degraded'
  mode: 'typert.register' | 'service-only'
  namespace: string
  methods: readonly string[]
  endpoints: readonly string[]
  liveService: {
    provided: boolean
    reflected: boolean
    sameIdentity: boolean
  }
  reason?: string
}

export function createAuxiliaryRuntimeHost(runtime: AuxiliaryRuntime): AuxiliaryRuntimeHost {
  const host: AuxiliaryRuntimeHost = {
    snapshot: (sessionId) => runtime.snapshot(sessionId),
    cancel: (callId) => runtime.cancel(callId),
    run: (request) => runtime.run(request),
    getPolicy: (sessionId) => runtime.getPolicy(sessionId),
    setPolicy: (sessionId, policy) => runtime.setPolicy(sessionId, policy),
  }
  return Object.freeze(host)
}

export function createAuxiliaryRuntimeRemote(runtime: AuxiliaryRuntime): AuxiliaryRuntimeRemote {
  const remote = Object.create(null) as AuxiliaryRuntimeRemote
  Object.defineProperties(remote, {
    typertRemote: {
      enumerable: true,
      get: () => binding,
    },
    snapshot: {
      enumerable: true,
      value: (sessionId: string) => runtime.snapshot(sessionId),
    },
    cancel: {
      enumerable: true,
      value: (callId: string) => runtime.cancel(callId),
    },
  })
  const binding = Object.freeze({
    service: remote,
    serviceKey: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
  })
  return Object.freeze(remote)
}

export function auxiliaryRuntimeTypertContribution(): Record<string, unknown> {
  return {
    package: PACKAGE_NAME,
    face: 'host',
    schemas: [],
    model: {
      services: [{
        key: REMOTE_NAMESPACE,
        exportName: 'AuxiliaryRuntimeRemote',
        members: TYPERT_REMOTE_METHODS.map((method) => ({
          kind: 'method',
          name: method,
          signature: `${method}(...)`,
        })),
        types: [],
      }],
      events: [],
      objects: [],
    },
    invocations: [
      descriptor('snapshot', [param('sessionId')]),
      descriptor('cancel', [param('callId')]),
    ],
  }
}

let lastRegistration: HostRegistration | undefined

export function lastAuxiliaryRuntimeRegistration(): HostRegistration | undefined {
  return lastRegistration
}

export function registerAuxiliaryRuntimeHost(ctx: HostContext, runtime: AuxiliaryRuntime): HostRegistration {
  const remote = createAuxiliaryRuntimeRemote(runtime)
  const endpoints = TYPERT_REMOTE_METHODS.map((method) => `${REMOTE_NAMESPACE}/${method}`)
  const liveService = { provided: false, reflected: false, sameIdentity: false }
  const remember = (result: HostRegistration): HostRegistration => {
    lastRegistration = result
    return result
  }
  try {
    ctx.provide?.(REMOTE_NAMESPACE, remote)
    liveService.provided = true
  } catch (error) {
    return remember({
      status: 'degraded',
      mode: 'service-only',
      namespace: REMOTE_NAMESPACE,
      methods: TYPERT_REMOTE_METHODS,
      endpoints,
      liveService,
      reason: error instanceof Error ? error.message : 'ctx.provide(auxiliaryRuntime) failed',
    })
  }

  const reflected = peekHost(ctx, REMOTE_NAMESPACE)
  liveService.reflected = reflected !== undefined
  liveService.sameIdentity = reflected === remote

  const typert = callerTypert(ctx)
  if (typeof typert?.register !== 'function') {
    return remember({
      status: 'degraded',
      mode: 'service-only',
      namespace: REMOTE_NAMESPACE,
      methods: TYPERT_REMOTE_METHODS,
      endpoints,
      liveService,
      reason: 'ctx.typert.register is unavailable',
    })
  }
  if (!liveService.sameIdentity) {
    return remember({
      status: 'degraded',
      mode: 'service-only',
      namespace: REMOTE_NAMESPACE,
      methods: TYPERT_REMOTE_METHODS,
      endpoints,
      liveService,
      reason: 'ctx.provide(auxiliary-runtime) did not reflect the same narrow Remote service',
    })
  }
  try {
    typert.register(auxiliaryRuntimeTypertContribution())
    return remember({
      status: 'registered',
      mode: 'typert.register',
      namespace: REMOTE_NAMESPACE,
      methods: TYPERT_REMOTE_METHODS,
      endpoints,
      liveService,
    })
  } catch (error) {
    return remember({
      status: 'degraded',
      mode: 'service-only',
      namespace: REMOTE_NAMESPACE,
      methods: TYPERT_REMOTE_METHODS,
      endpoints,
      liveService,
      reason: error instanceof Error ? error.message : 'ctx.typert.register rejected the Host contribution',
    })
  }
}

function callerTypert(ctx: HostContext): TypertLike | undefined {
  try {
    if (typeof ctx.typert?.register === 'function') return ctx.typert
  } catch {
    // undeclared Cordis access throws
  }
  const peeked = peekHost(ctx, 'typert') as TypertLike | undefined
  return typeof peeked?.register === 'function' ? peeked : undefined
}

function descriptor(method: string, parameters: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: { mode: 'src-json' },
  }
}

function param(name: string): Record<string, unknown> {
  return {
    name,
    wire: name,
    source: 'json',
    codec: { mode: 'src-json' },
  }
}
