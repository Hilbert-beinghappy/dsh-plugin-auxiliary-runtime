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

// The locally assembled request is intentionally structural: official Messages
// remain untouched, while the host owns the runtime implementation and brands.
type _OfficialGenerateInput = Assert<
  Extends<OfficialGenerateOptions, Omit<GenerateOptions, 'messages'> & { messages: Message[] }>
>

describe('official 0.1.0-rc.8 compile-time seam contract', () => {
  it('declares the official domain identity without importing its runtime', () => {
    expect(auxiliaryRuntimeDomain.name).toBe('auxiliary_runtime')
    expect(auxiliaryRuntimeDomain.version).toBe(0)
    expect(Object.keys(auxiliaryRuntimeDomain.tables)).toEqual(['calls', 'policies'])
  })
})
