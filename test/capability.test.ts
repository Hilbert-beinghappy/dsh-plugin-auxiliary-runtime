import { describe, expect, it } from 'vitest'
import { AuxiliaryRuntime } from '../src/runtime.ts'
import type { HostContext } from '../src/types.ts'
import { createHarness } from './helpers/harness.ts'

describe('capability and fail-closed Host seams', () => {
  it('keeps an unknown Host version unconfirmed without pretending it is rc.8', async () => {
    const harness = createHarness({ omitHostVersion: true })
    const snapshot = await harness.runtime.snapshot('session-1')
    expect(snapshot.capability.ok).toBe(true)
    expect(snapshot.capability.hostVersion).toBe('unknown')
    expect(snapshot.capability.hostConfirmed).toBe(false)
    expect(snapshot.capability.compatibilityWarning).toMatch(/unconfirmed.*rc\.8/i)
    const result = await harness.runtime.run(harness.request())
    expect(result.status).toBe('succeeded')
  })

  it('fails closed before dispatch when required services are missing', async () => {
    const harness = createHarness({ omit: ['llm', 'storageDomain'] })
    const result = await harness.runtime.run(harness.request())
    expect(result.status).toBe('failed')
    expect(result.failure?.category).toBe('unavailable')
    expect(harness.prepareCalls).toBe(0)
    expect(harness.calls.size).toBe(0)
  })

  it('fails closed on a host version outside the pinned rc.8 range', async () => {
    const harness = createHarness({ dshVersion: '0.1.0-rc.7' })
    const result = await harness.runtime.run(harness.request())
    expect(result.failure).toEqual({ category: 'unavailable', code: 'HOST_UNSUPPORTED' })
    expect(harness.prepareCalls).toBe(0)
    const capability = (await harness.runtime.snapshot('session-1')).capability
    expect(capability.ok).toBe(false)
    expect(capability.pinnedHostRange).toEqual(['0.1.0-rc.8'])
    expect(capability.singleProcess).toBe(true)
  })

  it('fails closed on domain version mismatch without dispatch', async () => {
    const harness = createHarness({ versionMismatch: true })
    const result = await harness.runtime.run(harness.request())
    expect(result.failure?.code).toMatch(/STORAGE_UNAVAILABLE|VERSION_MISMATCH/)
    expect(harness.prepareCalls).toBe(0)
  })

  it('fails closed when stored records are invalid', async () => {
    const harness = createHarness()
    await harness.runtime.start()
    harness.calls.map.set('bad', { prompt: 'leak' } as never)
    const runtime = harness.reopen()
    const result = await runtime.run(harness.request({ callId: 'fresh' }))
    expect(result.failure?.code).toMatch(/STORAGE_UNAVAILABLE|INVALID_RECORD/)
    expect(harness.prepareCalls).toBe(0)
  })

  it('reports missing Session on snapshot without creating one', async () => {
    const harness = createHarness()
    const snapshot = await harness.runtime.snapshot('no-such-session')
    expect(snapshot.capability.reason).toMatch(/session/i)
    expect(snapshot.combined).toEqual(snapshot.official)
    expect(Object.getOwnPropertyNames(harness.host.sessions ?? {})).not.toContain('create')
  })

  it('uses Context reflection when undeclared direct service reads throw', async () => {
    const harness = createHarness({ omitHostVersion: true })
    const guarded = new Proxy(harness.host, {
      get(target, property, receiver) {
        if (typeof property === 'string' && [
          'dshVersion',
          'storageDomain',
          'sessions',
          'llm',
          'sessionProjections',
        ].includes(property)) {
          throw new Error(`cannot get property "${property}" without inject`)
        }
        return Reflect.get(target, property, receiver)
      },
    }) as HostContext
    const runtime = new AuxiliaryRuntime(guarded)

    const snapshot = await runtime.snapshot('session-1')
    expect(snapshot.capability.ok).toBe(true)
    expect(snapshot.capability.hostVersion).toBe('unknown')
    const result = await runtime.run(harness.request())
    expect(result.status).toBe('succeeded')
  })
})
