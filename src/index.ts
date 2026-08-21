import { PACKAGE_NAME, SERVICE_KEY } from './constants.ts'
import { createAuxiliaryRuntimeHost, registerAuxiliaryRuntimeHost } from './host.ts'
import { AuxiliaryRuntime } from './runtime.ts'
import type { HostContext } from './types.ts'

export const name = PACKAGE_NAME
export const provide = SERVICE_KEY
export const inject = {}

export function apply(ctx: HostContext): void {
  const runtime = new AuxiliaryRuntime(ctx)
  ctx.provide?.(SERVICE_KEY, createAuxiliaryRuntimeHost(runtime))
  void runtime.start()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      return () => runtime.stop()
    })
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['typert', 'typertGateway'], (ready) => {
      registerAuxiliaryRuntimeHost(ready, runtime)
    })
  } else {
    registerAuxiliaryRuntimeHost(ctx, runtime)
  }
}

Object.assign(apply, { inject, provide })
export default apply

export { AuxiliaryRuntime } from './runtime.ts'
export { AuxiliaryRuntimeError } from './errors.ts'
export {
  CALLS_TABLE,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  MAX_CALL_ROWS,
  MAX_OUTPUT_CHARS,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PINNED_DSH_VERSION,
  PINNED_DSH_VERSIONS,
  PLUGIN_ID,
  POLICIES_TABLE,
  REMOTE_NAMESPACE,
  SERVICE_KEY,
  TYPERT_REMOTE_METHODS,
} from './constants.ts'
export { auxiliaryRuntimeDomain, callRecordSchema, policyRecordSchema } from './domain.ts'
export {
  auxiliaryRuntimeTypertContribution,
  createAuxiliaryRuntimeHost,
  createAuxiliaryRuntimeRemote,
  lastAuxiliaryRuntimeRegistration,
  registerAuxiliaryRuntimeHost,
} from './host.ts'
export type { AuxiliaryRuntimeHost, AuxiliaryRuntimeRemote, HostRegistration } from './host.ts'
export { addUsage, bucketsFromTokenUsage, totalTokens, zeroUsage } from './usage.ts'
export type {
  AuxiliaryCallResult,
  AuxiliaryCancelResult,
  AuxiliaryCapability,
  AuxiliaryPolicy,
  AuxiliaryRunRequest,
  AuxiliarySnapshot,
  CallRecord,
  FailureFact,
  HostContext,
  UsageBuckets,
} from './types.ts'
