import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

function productionSource(): string {
  return readdirSync(join(root, 'src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(root, 'src', name), 'utf8'))
    .join('\n')
}

describe('forbidden Host and persistence APIs', () => {
  const source = productionSource()

  it('never registers or replaces the official tokenUsage projection', () => {
    expect(source).not.toMatch(/sessionProjections\.register/)
    expect(source).not.toMatch(/key:\s*['"]tokenUsage['"]/)
    expect(source).not.toMatch(/tokenUsageProjectionDefinition/)
  })

  it('never appends Session events or creates Sessions', () => {
    expect(source).not.toMatch(/\.append\s*\(/)
    expect(source).not.toMatch(/sessions\.create/)
    expect(source).not.toMatch(/session\.prompt/)
  })

  it('never marks Agent-loop requests or writes combined usage back', () => {
    expect(source).not.toMatch(/markAgentLoopRequest/)
    expect(source).not.toMatch(/isAgentLoopRequest/)
    expect(source).not.toMatch(/values\.tokenUsage\s*=/)
    expect(source).not.toMatch(/combined.*=.*sessionProjections/)
  })

  it('never patches official packages or uses workspace protocol', () => {
    expect(source).not.toMatch(/node_modules/)
    expect(source).not.toMatch(/workspace:/)
    expect(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).not.toMatch(/@deepseek-ai\/dsh-/)
  })
})
