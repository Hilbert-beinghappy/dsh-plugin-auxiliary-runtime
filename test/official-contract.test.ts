import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  GenerateOptions as OfficialGenerateOptions,
  LlmCallConfig as OfficialLlmCallConfig,
  Message as OfficialMessage,
  StreamChunk as OfficialStreamChunk,
  TokenUsage as OfficialTokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Session as OfficialSession } from '@deepseek-ai/dsh-session'
import type {
  ProjectionSnapshot as OfficialProjectionSnapshot,
  SessionProjectionRegistry as OfficialSessionProjectionRegistry,
} from '@deepseek-ai/dsh-session-projection'
import type {
  DomainSpec as OfficialDomainSpec,
} from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'
import { auxiliaryRuntimeDomain } from '../src/domain.ts'
import type {
  GenerateOptions,
  LlmCallConfig,
  Message,
  ProjectionSnapshot,
  SessionLike,
  StreamChunk,
  TokenUsage,
} from '../src/types.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)

const COMPILE_PIN = '0.1.1-rc.2'
const COMPILED_OFFICIAL_PACKAGES = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-storage-domain',
] as const

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

type _OfficialConfigIsAccepted = Assert<Extends<OfficialLlmCallConfig, LlmCallConfig>>
type _OfficialMessageIsAccepted = Assert<Extends<OfficialMessage, Message>>
type _OfficialUsageIsAccepted = Assert<Extends<OfficialTokenUsage, TokenUsage>>
type _OfficialChunkIsAccepted = Assert<Extends<OfficialStreamChunk, StreamChunk>>
type _OfficialSessionIsAccepted = Assert<Extends<OfficialSession, SessionLike>>
type _OfficialSnapshotIsAccepted = Assert<Extends<OfficialProjectionSnapshot, ProjectionSnapshot>>
type _DomainSpecMatchesOfficial = Assert<Extends<typeof auxiliaryRuntimeDomain, OfficialDomainSpec>>

type OfficialSnapshotArgument = Parameters<OfficialSessionProjectionRegistry['snapshot']>[0]
type _ProjectionConsumesOfficialSession = Assert<Extends<OfficialSnapshotArgument, SessionLike>>

type _OfficialGenerateInput = Assert<
  Extends<OfficialGenerateOptions, Omit<GenerateOptions, 'messages'> & { messages: Message[] }>
>

function installedOfficialVersion(name: (typeof COMPILED_OFFICIAL_PACKAGES)[number]): string {
  const pkgPath = require.resolve(join(name, 'package.json'))
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  return pkg.version
}

// Compile-time Assert aliases above are the official type gate; they fire under `pnpm typecheck`.
describe('official 0.1.1-rc.2 compile-time seam contract', () => {
  it('pins installed official 0.1.1-rc.2 packages', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    for (const name of COMPILED_OFFICIAL_PACKAGES) {
      expect(manifest.devDependencies?.[name]).toBe(COMPILE_PIN)
      expect(installedOfficialVersion(name)).toBe(COMPILE_PIN)
    }
  })

  it('declares the official domain identity without importing its runtime', () => {
    expect(auxiliaryRuntimeDomain.name).toBe('auxiliary_runtime')
    expect(auxiliaryRuntimeDomain.version).toBe(0)
    expect(Object.keys(auxiliaryRuntimeDomain.tables)).toEqual(['calls', 'policies'])
  })
})
