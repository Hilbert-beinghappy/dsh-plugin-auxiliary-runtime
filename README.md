<div align="center">

<h1>Auxiliary Runtime</h1>

<p>Cancelable auxiliary model calls, durable limits, and provenance-preserving usage for DeepSeek Harness.</p>

<p>
  <a href="https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/releases"><img src="https://img.shields.io/badge/Version-0.1.1-orange" alt="Version 0.1.1"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.1--rc.2-5B5BD6" alt="DeepSeek Harness 0.1.1-rc.2">
  <img src="https://img.shields.io/badge/Host%20still%20supported-0.1.0--rc.8-0A7EA4" alt="Host 0.1.0-rc.8 still supported">
  <img src="https://img.shields.io/badge/Usage-Official%20%7C%20Auxiliary%20%7C%20Combined-0A7EA4" alt="Official, Auxiliary, Combined usage">
  <a href="https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/actions/workflows/ci.yml"><img src="https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License"></a>
</p>

<p>
  <a href="#project-overview">Project overview</a>
  ·
  <a href="#three-sourced-usage-views">Usage views</a>
  ·
  <a href="#runtime-design">Runtime design</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#service-contracts">Contracts</a>
  ·
  <a href="#compatibility-and-verification">Verification</a>
</p>

<p>English · <a href="README.zh.md">中文</a></p>

</div>

---

## Project overview

`dsh-plugin-auxiliary-runtime@0.1.1` is a community Host plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It binds cancelable, no-tools auxiliary model calls to an already-live Session, applies per-Session policy, and records usage in a dedicated ledger backed by the official `storageDomain` service. The current compile and metadata target is official Host `0.1.1-rc.2`; exact Host `0.1.0-rc.8` remains supported.

[Clarify](https://github.com/Hilbert-beinghappy/dsh-plugin-clarify) uses Auxiliary Runtime's same-process `run` service to generate contextual questions, options, and evolving Draft previews outside the main Session transcript. [SeekTTY](https://github.com/Hilbert-beinghappy/seektty) consumes the read-only snapshot and shows Official, Auxiliary, and Combined values in `/status` while the capability is healthy.

```text
                       +----------------------+
                       | DeepSeek Harness     |
                       | live Session         |
                       | official model route |
                       +----------+-----------+
                                  |
                           llm.prepareCall
                                  |
                                  v
+----------------+       +----------------------+       +----------------+
| Clarify        | ----> | Auxiliary Runtime    | ----> | Provider stream|
| same-process   | run   | admission / cancel   |       | usage chunks   |
| Draft preview  | <---- | bounded live output  | <---- | final status   |
+----------------+       +----------+-----------+       +----------------+
                                  |
                                  | durable rows
                                  v
                       +----------------------+
                       | storageDomain        |
                       | auxiliary_runtime v0 |
                       | calls / policies     |
                       +----------+-----------+
                                  |
                           read-only snapshot
                                  v
                       +----------------------+
                       | SeekTTY /status      |
                       | Official / Auxiliary |
                       | Combined             |
                       +----------------------+
```

## Three sourced usage views

| View | Source and meaning |
| --- | --- |
| **Official** | The official Host `tokenUsage` projection, owned by the Agent loop. |
| **Auxiliary** | This plugin's `auxiliary_runtime` ledger, aggregated from authoritative call rows. |
| **Combined** | A read-time, bucket-by-bucket sum of Official and Auxiliary values. |

The four disjoint buckets are `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. Combined values are derived for consumers and stay outside the official projection.

### Main Session transcript

Auxiliary calls use the existing Session as an identity and routing fence. The main transcript receives formal messages through the normal Session flow, after the user submits an accepted Draft. Clarify questions, answers, and Draft previews remain in Clarify's temporary Host state.

### Durable auxiliary ledger

Durable rows contain identifiers, purpose, status, the four token buckets, `usageRecorded`, normalized failure `{ category, code }`, and timestamps. Prompts, messages, system text, model output, custom answers, credentials, environment values, and filesystem paths remain outside storage. Failure records contain only the normalized `{ category, code }`; the official `LlmFailure.message` stays outside storage.

## Runtime design

### Admission, usage, and replay

`run` writes a durable `running` row before `llm.prepareCall` and `prepared.stream`. Prepared requests complete token-limit admission after provider metadata has been materialized and before streaming begins. The latest provider usage chunk replaces the four buckets on the authoritative row; `usageRecorded` distinguishes an observed all-zero report from a missing report. Recorded usage survives a later `error` or `aborted` finish.

Successful live calls return model text ephemerally to the same-process caller, joined in stream order and bounded to 65,536 UTF-16 code units. Terminal replay returns the durable status and usage with `replayed: true` and `output: null`; a caller that needs new text uses a new `callId`. Active-id reuse, cross-Session reuse, and purpose changes are reported as conflicts.

### Limits and cancellation

Per-Session policy covers `maxConcurrentCalls`, `maxCallsPerSession`, and `maxAuxiliaryTotalTokens`. Limits combine recorded usage with process-local reservations for in-flight calls. Provider-reported usage becomes authoritative after dispatch, including values above the initial reservation.

Cancellation composes the caller signal and service signal through `AbortController`. Provider failures preserve official categories such as `QUOTA` and `CONTEXT_WINDOW_EXCEEDED`. Durable `running` rows found during the next initialization become `interrupted` without additional usage.

### Persistence and Session fencing

The official storage domain is `auxiliary_runtime`, version `0`, with `calls` and `policies` tables. Call rows are authoritative; aggregates rebuild from rows during initialization and update after durable writes succeed.

Records are fenced by Session id and `session.header.createdAt`, so a reused id starts with a new usage and policy identity. Uninstalling the Bundle leaves the official storage-domain file available for a later reinstall. Version `0` preserves its audit rows and refuses new calls at 10,000 rows. The supported deployment shape is one Host process per `DSH_HOME`.

### Service lifecycle

The plugin waits for official `storageDomain` through Cordis child-context injection. Service withdrawal cancels active work and disposes stale references; restoration creates a fresh runtime. Missing Host services, a missing live Session, a domain version mismatch, and invalid stored records fail closed before provider dispatch.

## Quick start

The last published Release remains Auxiliary Runtime `0.1.0`. Install that prebuilt tarball into an isolated Profile with the native `dsh plugin` command:

```sh
pnpm add --global @deepseek-ai/dsh@0.1.0-rc.8
dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/releases/download/v0.1.0/dsh-plugin-auxiliary-runtime-0.1.0.tgz
```

Source `0.1.1` targets official Host `0.1.1-rc.2` and is not a GitHub Release yet. Do not invent a `v0.1.1` download URL. Pack the local tree and add that tarball:

```sh
pnpm add --global @deepseek-ai/dsh@0.1.1-rc.2
pnpm pack
dsh plugin --profile tui add ./dsh-plugin-auxiliary-runtime-0.1.1.tgz
```

Host `0.1.0-rc.8` still admits this candidate tarball when you pack it locally. Current sibling Releases SeekTTY `1.2.0` and Clarify `0.2.1` remain the last published jointly accepted trio on exact Host `0.1.0-rc.8`. They are not a `0.1.1-rc.2` claim. Unpublished Auxiliary `0.1.1` with SeekTTY `1.2.1` and Clarify `0.2.2` has Lane A no-key PTY evidence; live-provider Lane B is still blocked. Not a Release. You can still add those published tarballs beside this candidate:

```sh
dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/seektty/releases/download/v1.2.0/seektty-1.2.0.tgz
dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/dsh-plugin-clarify/releases/download/v0.2.1/dsh-plugin-clarify-0.2.1.tgz
dsh --profile tui
```

The Bundle patch inserts `id: auxiliary-runtime` / `name: dsh-plugin-auxiliary-runtime`. The consumer package contains no `workspace:` dependency and uses the official Host Context for Harness services.

## Service contracts

### Same-process service

`run` is available only to plugins in the same Host process:

```ts
const runtime = ctx.get('auxiliaryRuntime')

const result = await runtime.run({
  callId,          // caller-generated
  sessionId,       // already-live Session
  purpose,         // 'clarify' | 'compaction' | 'session-title'
  config,          // official LlmCallConfig
  prepareRequest,  // optional atomic prepared metadata => request + reservation
  signal,          // optional caller AbortSignal
})
```

`run` accepts exactly one request mode:

- static `system` / `messages` with a mandatory four-bucket reservation;
- legacy same-process `buildRequest(preparedConfig)` with a mandatory reservation; or
- `prepareRequest({ config, context, adapterDefaults })`, atomically returning `{ system?, messages, reservation }` from the same prepared metadata.

Prepared callbacks receive detached, frozen structural data after `llm.prepareCall`. Callback functions and products remain process-local. `getPolicy(sessionId)` and `setPolicy(sessionId, policy)` manage the three per-Session limits.

### Typert Host

The separate `auxiliary-runtime` Typert receiver exposes two methods:

- `auxiliary-runtime/snapshot` — read-only `{ official, auxiliary, combined, capability }`
- `auxiliary-runtime/cancel` — abort an active call and report its stable state

Model execution remains a same-process capability; HTTP consumers receive usage snapshots and cancellation only.

## Compatibility and verification

The current compile and metadata target is official DeepSeek Harness **`0.1.1-rc.2`** with Node `^22.19.0 || >=24`. Exact Host **`0.1.0-rc.8`** remains supported. Runtime integration uses these public Host services:

- `storageDomain.open` / `KvTable`
- `sessions.get` and `header.createdAt`
- `llm.prepareCall` / `prepared.stream`
- `sessionProjections.snapshot` for read-only Official usage
- Typert Host `register` for snapshot and cancel

The published rollback joint baseline remains exact Host **`0.1.0-rc.8`**. Auxiliary Runtime `0.1.1` compiles against and admits exact `0.1.1-rc.2`. Lane A (2026-08-21, unmodified stock `0.1.1-rc.2`, isolated `DSH_HOME`, real PTY, unpublished Auxiliary `0.1.1` + Clarify `0.2.2` + SeekTTY `1.2.1`): `/doctor` 0 error / 0 warning, 99 plugins running; `/status` healthy; `/clarify` routed through Auxiliary, returned `MISSING_CREDENTIAL` without a key, and kept the composer; Vision-Exp was visible and selectable; a PNG attachment restored after `/restart`. Missing-source restore: unit tests keep the failure copy to a basename, cover both notice orders, and keep absolute paths out of the text; a real-PTY hardcopy/visible scan found only the ASCII basename `vision-logo.png` and none of `private/tmp`, `/tmp`, `Users`, or `Volumes`. That does not prove the restore error stayed visible after dismissing the no-key onboarding modal (Esc also clears notices). Lane B is blocked without `DEEPSEEK_API_KEY` (live Clarify multi-round success, accept into the composer without auto-send, PNG/JPEG visual understanding, clear attachments after send). Not a Release or complete joint acceptance. Clarify `0.2.1` preserves the six-method Remote, `clarify.wire/1`, and compatibility boundary of `0.2.0`.

Clarify `0.2.0` live-provider joint acceptance covered model-generated clarification, multi-round Draft evolution, user-controlled submission, interruption recovery, usage provenance, and ledger privacy. Clarify `0.2.1` post-release no-key acceptance re-downloaded and verified all three Release assets, passed stock add/boot/remove/re-add and `/doctor` with 0 errors, 0 warnings, and 99 plugins on exact `0.1.0-rc.8`, then reached `running`, routed through Auxiliary, and returned the expected isolated-environment `MISSING_CREDENTIAL` result. Version `0.2.1` has not rerun live-provider multi-round acceptance or a cache/cost A/B.

The published rollback stack is official `@deepseek-ai/dsh@0.1.0-rc.8`, Auxiliary Runtime `0.1.0`, Clarify `0.2.1`, and SeekTTY `1.2.0`.

`package.json#dshPlugin.testedHost` is the compile pin `0.1.1-rc.2`. `dshPlugin.testedHosts` lists the two exact admission pins `0.1.0-rc.8` and `0.1.1-rc.2`. Capability probing can boot when the Host exposes no version value and reports `hostConfirmed: false`; a known version outside those two pins is rejected.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm pack:check
```

`pnpm typecheck` is the official type gate. The official-contract runtime test only pins installed package versions; the compile-time `Assert` aliases in that file are checked by `pnpm typecheck`.

When a GitHub Release is published, assets include the tarball and `SHA256SUMS`.

## License

[MIT](LICENSE)
