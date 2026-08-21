import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isForbiddenPackEntry } from '../scripts/pack-policy.mjs'
import {
  PACKAGE_VERSION,
  PINNED_DSH_VERSION,
  PINNED_DSH_VERSION_LEGACY_RC8,
  PINNED_DSH_VERSIONS,
} from '../src/constants.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function parseMinimumReleaseAgeExclude(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === 'minimumReleaseAgeExclude:')
  if (start < 0) return []
  const values: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const match = /^[ \t]+-[ \t]+(.+)$/.exec(line)
    if (!match) break
    const raw = match[1].trim()
    const quoted = raw.match(/^(['"])(.*)\1$/)
    values.push(quoted ? quoted[2] : raw)
  }
  return values
}

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
    dshPlugin?: { testedHost?: string; testedHosts?: string[] }
  }

  it('is dsh-plugin-auxiliary-runtime@0.1.1 ESM with testedHost 0.1.1-rc.2 and exact dual host pins', () => {
    expect(pkg.name).toBe('dsh-plugin-auxiliary-runtime')
    expect(pkg.version).toBe('0.1.1')
    expect(pkg.type).toBe('module')
    expect(pkg.dsh?.host).toBeUndefined()
    expect(pkg.dshPlugin?.testedHost).toBe('0.1.1-rc.2')
    expect(pkg.dshPlugin?.testedHosts).toEqual(['0.1.0-rc.8', '0.1.1-rc.2'])
    expect(PACKAGE_VERSION).toBe(pkg.version)
    expect(PINNED_DSH_VERSION).toBe('0.1.1-rc.2')
    expect(PINNED_DSH_VERSION_LEGACY_RC8).toBe('0.1.0-rc.8')
    expect([...PINNED_DSH_VERSIONS]).toEqual([
      PINNED_DSH_VERSION_LEGACY_RC8,
      PINNED_DSH_VERSION,
    ])
    expect([...PINNED_DSH_VERSIONS]).toEqual(pkg.dshPlugin?.testedHosts)
    expect(pkg.dshPlugin?.testedHost).toBe(PINNED_DSH_VERSION)
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

  it('keeps host packages development-only and validates the official 0.1.1-rc.2 domain contract', () => {
    expect(pkg.dependencies).toEqual({ zod: '^4.4.3' })
    expect(pkg.peerDependencies).toBeUndefined()
    for (const name of [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-storage',
      '@deepseek-ai/dsh-storage-domain',
    ]) {
      expect(pkg.devDependencies?.[name]).toBe('0.1.1-rc.2')
    }
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(version).toBe('0.1.1-rc.2')
    }
    const domain = readFileSync(join(root, 'src/domain.ts'), 'utf8')
    expect(domain).toMatch(/import type \{ DomainSpec as OfficialDomainSpec \}/)
    expect(domain).toMatch(/satisfies OfficialDomainSpec/)
    expect(domain).not.toMatch(/defineDomain\(/)
    expect(domain).not.toMatch(/domainTable</)
    const types = readFileSync(join(root, 'src/types.ts'), 'utf8')
    expect(types).not.toMatch(/from '@deepseek-ai\/dsh-(?:llm|session|storage-domain)'/)
  })

  it('pins minimumReleaseAgeExclude to the exact official dsh- devDependency name@version set', () => {
    const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    const excluded = parseMinimumReleaseAgeExclude(yaml)
    const expected = Object.entries(pkg.devDependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([name, version]) => `${name}@${version}`)
      .sort()
    expect(yaml).not.toMatch(/minimumReleaseAgeExclude:[\s\S]*\*/)
    expect(excluded).toHaveLength(11)
    expect([...excluded].sort()).toEqual(expected)
  })

  it('rejects AppleDouble and Finder metadata pack entries', () => {
    expect(isForbiddenPackEntry('package/lib/._index.js')).toBe(true)
    expect(isForbiddenPackEntry('package/._README.md')).toBe(true)
    expect(isForbiddenPackEntry('package/.DS_Store')).toBe(true)
    expect(isForbiddenPackEntry('package/lib/.DS_Store')).toBe(true)
    expect(isForbiddenPackEntry('package/lib/index.js')).toBe(false)
    expect(isForbiddenPackEntry('package/README.md')).toBe(false)
    const packCheck = readFileSync(join(root, 'scripts/pack-check.mjs'), 'utf8')
    const packPolicy = readFileSync(join(root, 'scripts/pack-policy.mjs'), 'utf8')
    expect(packCheck).toMatch(/isForbiddenPackEntry/)
    expect(packPolicy).toMatch(/segment\.startsWith\('\._'\)/)
    expect(packPolicy).toMatch(/segment === '\.DS_Store'/)
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
