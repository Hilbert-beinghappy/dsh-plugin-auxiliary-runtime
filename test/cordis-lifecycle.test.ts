import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, SERVICE_KEY } from '../src/index.ts'
import type { AuxiliaryRuntimeHost } from '../src/host.ts'
import type { HostContext } from '../src/types.ts'
import { createHarness } from './helpers/harness.ts'

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function service<T>(ctx: Context, name: string): T | undefined {
  return ctx.get(name, false) as T | undefined
}

describe('Cordis storage-domain child lifecycle', () => {
  it('waits for late storage, withdraws atomically, then remounts a fresh runtime', async () => {
    const harness = createHarness()
    const root = new Context()
    root.provide('sessions', harness.host.sessions)
    root.provide('llm', harness.host.llm)
    root.provide('sessionProjections', harness.host.sessionProjections)
    root.provide('dshVersion', harness.host.dshVersion)
    const plugin = root.plugin((ctx) => apply(ctx as unknown as HostContext))
    await plugin

    expect(service(root, SERVICE_KEY)).toBeUndefined()

    const withdrawStorage = root.provide('storageDomain', harness.host.storageDomain)
    await settle()
    const first = service<AuxiliaryRuntimeHost>(root, SERVICE_KEY)
    expect(first).toBeDefined()
    await expect(first!.snapshot('session-1')).resolves.toMatchObject({ capability: { domain: true } })

    await withdrawStorage()
    await settle()
    expect(service(root, SERVICE_KEY)).toBeUndefined()
    await expect(first!.run(harness.request({ callId: 'after-withdraw' }))).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'DOMAIN_UNAVAILABLE' },
    })

    root.provide('storageDomain', harness.host.storageDomain)
    await settle()
    const second = service<AuxiliaryRuntimeHost>(root, SERVICE_KEY)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    await expect(second!.snapshot('session-1')).resolves.toMatchObject({ capability: { domain: true } })
    await expect(first!.run(harness.request({ callId: 'stale-after-remount' }))).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'DOMAIN_UNAVAILABLE' },
    })

    await root.fiber.dispose()
  })

  it('retries a poisoned fallback start after storage appears', async () => {
    const missing = createHarness({ omit: ['storageDomain'] })
    await missing.runtime.start()
    expect((await missing.runtime.snapshot('session-1')).capability.domain).toBe(false)

    const ready = createHarness()
    missing.host.storageDomain = ready.host.storageDomain
    expect((await missing.runtime.snapshot('session-1')).capability.domain).toBe(true)
    await missing.runtime.stop()
  })
})
