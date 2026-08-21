import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import {
  auxiliaryRuntimeTypertContribution,
  REMOTE_NAMESPACE,
  SERVICE_KEY,
  TYPERT_REMOTE_METHODS,
} from '../src/index.ts'
import type { AuxiliaryRuntimeHost, AuxiliaryRuntimeRemote } from '../src/host.ts'
import { createHarness } from './helpers/harness.ts'

function callableSurface(value: object): string[] {
  const names = new Set<string>()
  let current: object | null = value
  while (current !== null && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === 'constructor') continue
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (typeof descriptor?.value === 'function') names.add(key)
    }
    current = Object.getPrototypeOf(current)
  }
  return [...names].sort()
}

describe('plugin and Typert Host surface', () => {
  it('registers snapshot and cancel only', () => {
    const contribution = auxiliaryRuntimeTypertContribution()
    const invocations = contribution.invocations as Array<{ method: string }>
    expect(invocations.map((item) => item.method)).toEqual(['snapshot', 'cancel'])
    expect(TYPERT_REMOTE_METHODS).toEqual(['snapshot', 'cancel'])
    expect(JSON.stringify(contribution)).not.toMatch(/"run"/)
    expect(JSON.stringify(contribution)).not.toMatch(/getPolicy|setPolicy/)
    expect(JSON.stringify(contribution)).not.toMatch(/"auxiliaryRuntime"/)
  })

  it('provides a same-process host and a separate narrow Typert object', async () => {
    const harness = createHarness()
    const injected: string[] = []
    let disposer: (() => unknown) | undefined
    harness.host.inject = (deps, callback) => {
      injected.push(...(deps as string[]))
      callback(harness.host)
    }
    harness.host.effect = (factory) => {
      const cleanup = factory()
      if (typeof cleanup === 'function') disposer = cleanup
    }

    expect(apply(harness.host)).toBeUndefined()
    expect(injected).toEqual(['typert', 'typertGateway'])

    const processHost = harness.provided.get(SERVICE_KEY) as AuxiliaryRuntimeHost
    const remote = harness.provided.get(REMOTE_NAMESPACE) as AuxiliaryRuntimeRemote
    expect(processHost).toBeDefined()
    expect(remote).toBeDefined()
    expect(processHost).not.toBe(remote)
    expect(callableSurface(processHost)).toEqual(['cancel', 'getPolicy', 'run', 'setPolicy', 'snapshot'])
    expect(callableSurface(remote)).toEqual(['cancel', 'snapshot'])
    expect(remote.typertRemote.service).toBe(remote)
    expect(remote.typertRemote.serviceKey).toBe('auxiliary-runtime')
    expect(Object.getPrototypeOf(remote)).toBeNull()
    expect(harness.typertContributions).toHaveLength(1)

    const snapshot = await processHost.snapshot('session-1')
    expect(snapshot.capability.singleProcess).toBe(true)
    expect(snapshot.capability.pinnedHostRange).toEqual(['0.1.0-rc.8'])
    expect(snapshot.capability.hostConfirmed).toBe(true)

    expect(disposer).toEqual(expect.any(Function))
    const stopped = disposer!()
    expect(stopped).toBeInstanceOf(Promise)
    await stopped
  })
})
