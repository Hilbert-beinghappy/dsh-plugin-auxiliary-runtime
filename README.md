# dsh-plugin-auxiliary-runtime

Community auxiliary-model runtime for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `0.1.0-rc.8`.

The plugin runs cancelable, no-tools auxiliary model calls against an already-live Session and records their usage in a dedicated ledger. Official Agent-loop usage stays in the Host `tokenUsage` projection. Consumers such as Clarify (same-process `run`) and SeekTTY (read-only snapshot) receive provenance-preserving `official`, `auxiliary`, and `combined` values.

This package is **0.1.0**. Release assets are the tarball and `SHA256SUMS`; it is not published to npm.

## Ownership

| Surface | Owner |
|---|---|
| Official `tokenUsage` | Agent-loop only. This plugin never registers, replaces, or writes that projection. |
| Auxiliary ledger | This plugin, domain `auxiliary_runtime` version `0`. |
| Combined usage | Derived bucket-by-bucket at read time. Never written back. |
| Session transcript | Unchanged. No `append`, no hidden Session, no fabricated assistant events. |

Usage buckets are disjoint: `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`.

## Same-process service

`run` is same-process only. It is not a Typert Remote method and is never offered over HTTP.

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

- static `system`/`messages` plus a mandatory four-bucket `reservation`;
- legacy same-process `buildRequest(preparedConfig)` plus a mandatory reservation; or
- `prepareRequest({ config, context, adapterDefaults })`, which atomically returns `{ system?, messages, reservation }` from the same prepared metadata.

The prepared callbacks run only after `llm.prepareCall`. They receive detached, frozen structural data and never receive the prepared stream handle, signal, Host Context, credentials, or services. Callback functions and their products are never persisted, logged, or remoted. Callback failures are normalized to `REQUEST_BUILD_FAILED`; caller exception text and codes are not stored.

`run` writes a durable `running` row **before** `llm.prepareCall` / `prepared.stream`. The latest provider usage chunk replaces the four buckets on that one authoritative row; `usageRecorded` distinguishes an observed all-zero report from no report. Usage survives a later `error` or `aborted` finish.

Live successful calls return model text ephemerally as `output: string` to the same-process caller. Text deltas are joined in stream order without trimming and bounded to 65,536 UTF-16 code units. The text is never written to storage, logs, Session state, or Typert; failed and cancelled calls return `output: null`. A terminal replay returns the durable status and usage with `replayed: true` and `output: null`, so a caller that lost the original live response must use a new `callId`. Reusing an active `callId`, a terminal id across Session fences, or an id for a different purpose is a conflict.

Also same-process: `getPolicy(sessionId)` and `setPolicy(sessionId, policy)` for `maxConcurrentCalls`, `maxCallsPerSession`, and `maxAuxiliaryTotalTokens`. The same-process object is provided as `auxiliaryRuntime` and is not the Typert receiver.

## Typert Host

Typert receives a separate `auxiliary-runtime` object whose callable surface is only `snapshot` and `cancel`. Only two Host endpoints are registered:

- `auxiliary-runtime/snapshot` — read-only `{ official, auxiliary, combined, capability }`
- `auxiliary-runtime/cancel` — abort an active call and report its stable state

## Persistence and privacy

Durable state uses official `storageDomain`:

- domain `auxiliary_runtime`
- version `0`
- tables `calls` and `policies`

Call rows are authoritative. There is no aggregate table. In-memory per-Session aggregates rebuild from rows on initialization and update only after durable writes succeed.

Records are fenced by Session id **and** `session.header.createdAt`, so a reused Session id cannot inherit prior usage or policy.

Durable rows contain only identifiers, purpose, status, token buckets, `usageRecorded`, normalized failure `{ category, code }`, and timestamps. They never contain prompts, messages, system text, model output, custom answers, credentials, environment values, or filesystem paths. Official `LlmFailure.message` is not stored.

Uninstall leaves the official storage-domain file in place; reinstall resumes it. Version `0` has no wipe API. New calls are refused at **10 000** rows rather than deleting audit records.

## Limits, cancellation, and recovery

Limits are honest reservations over **recorded** auxiliary usage plus process-local reservations of in-flight calls. Static requests reserve during the first serialized admission. Prepared requests use two serialized admissions: durable call/concurrency admission before `llm.prepareCall`, then token-limit admission with the request and reservation derived atomically from prepared provider metadata, still before `prepared.stream`. After dispatch, provider-reported usage always wins, even when it exceeds the reservation.

Cancellation composes the caller signal and the service signal through `AbortController`. Provider failures preserve official codes such as `QUOTA` and `CONTEXT_WINDOW_EXCEEDED`.

Orphaned durable `running` rows become `interrupted` on the next initialization, without adding usage.

Active calls, `callId` ownership, and reservations are process-local. Official `storageDomain` is a single-process medium: **one Host process per `DSH_HOME`**. This plugin does not claim multi-process safety.

Missing required Host services, a missing live Session, a domain version mismatch, or an invalid stored record fail closed **before** provider dispatch. A known Host version outside rc.8 is rejected. When the Host exposes no version value, capability probing may allow the call but reports `hostConfirmed: false` and a compatibility warning; unknown is never presented as tested rc.8.

The plugin waits for official `storageDomain` through Cordis child-context injection, so bundle order does not decide whether the service starts. Withdrawing the service removes `auxiliaryRuntime`, cancels active work, and permanently disposes stale service references; restoring it creates a fresh runtime.

## Compatibility

Tested against DeepSeek Harness **`0.1.0-rc.8`** public services:

- `storageDomain.open` / `KvTable`
- `sessions.get` and `header.createdAt`
- `llm.prepareCall` / `prepared.stream`
- `sessionProjections.snapshot` (read-only)
- Typert Host `register` for snapshot/cancel only

Node `^22.19.0 || >=24`. Consumer-facing metadata has no `workspace:` dependencies.
The published package has one runtime dependency, `zod`; official Harness packages are exact rc.8 development/type-contract fixtures, not consumer dependencies or peers. Runtime services come only from the loaded Host Context.

`package.json#dshPlugin.testedHost` records this project's test claim only. It is not an official Harness compatibility gate; runtime capability probing and the published install matrix are authoritative.

## Install

Install the packed tarball into an isolated Profile with unmodified official dsh. The bundle patch inserts only `id: auxiliary-runtime` / `name: dsh-plugin-auxiliary-runtime`.

```bash
dsh plugin --profile <profile> add ./dsh-plugin-auxiliary-runtime-0.1.0.tgz
```

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm pack:check
```
