import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('published package contract', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    version: string
    type?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    files?: string[]
    engines?: { node?: string }
    dsh?: { bundle?: { patch?: string }; host?: string }
    dshPlugin?: { testedHost?: string }
  }

  it('is dsh-plugin-auxiliary-runtime@0.1.0 ESM with the pinned rc.8 host', () => {
    expect(pkg.name).toBe('dsh-plugin-auxiliary-runtime')
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.type).toBe('module')
    expect(pkg.dsh?.host).toBeUndefined()
    expect(pkg.dshPlugin?.testedHost).toBe('0.1.0-rc.8')
    expect(pkg.engines?.node).toBe('^22.19.0 || >=24')
  })

  it('declares official dsh.bundle.patch that inserts only this plugin', () => {
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/^- insert:/m)
    expect(patch).toMatch(/id: auxiliary-runtime/)
    expect(patch).toMatch(/name: dsh-plugin-auxiliary-runtime/)
    const ids = [...patch.matchAll(/id:\s*(\S+)/g)].map((match) => match[1])
    expect(ids).toEqual(['auxiliary-runtime'])
    expect(patch).not.toMatch(/tokenUsage/)
    expect(patch).not.toMatch(/workspace:/)
  })

  it('has a strict files allowlist', () => {
    expect(pkg.files).toEqual([
      'lib/**/*.js',
      'lib/**/*.d.ts',
      'cordis.patch.yml',
      'LICENSE',
      'README.md',
    ])
  })

  it('keeps the lockfile free of workspace protocol', () => {
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
    expect(lock).not.toMatch(/workspace:/)
  })

  it('keeps host packages development-only and validates the official rc.8 domain contract', () => {
    expect(pkg.dependencies).toEqual({ zod: '^4.4.3' })
    expect(pkg.peerDependencies).toBeUndefined()
    for (const name of [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-storage',
      '@deepseek-ai/dsh-storage-domain',
    ]) {
      expect(pkg.devDependencies?.[name]).toBe('0.1.0-rc.8')
    }
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(version).toBe('0.1.0-rc.8')
    }
    const domain = readFileSync(join(root, 'src/domain.ts'), 'utf8')
    expect(domain).toMatch(/import type \{ DomainSpec as OfficialDomainSpec \}/)
    expect(domain).toMatch(/satisfies OfficialDomainSpec/)
    expect(domain).not.toMatch(/defineDomain\(/)
    expect(domain).not.toMatch(/domainTable</)
    const types = readFileSync(join(root, 'src/types.ts'), 'utf8')
    expect(types).not.toMatch(/from '@deepseek-ai\/dsh-(?:llm|session|storage-domain)'/)
  })

  it('forbids workspace protocol in consumer-facing metadata', () => {
    const raw = readFileSync(join(root, 'package.json'), 'utf8')
    expect(raw).not.toMatch(/workspace:/)
    for (const block of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
      for (const spec of Object.values(block ?? {})) {
        expect(spec.startsWith('workspace:')).toBe(false)
      }
    }
  })
})
