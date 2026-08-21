# Auxiliary Runtime task book

## Objective

Ship `dsh-plugin-auxiliary-runtime@0.1.0`, a public DeepSeek Harness community plugin that runs cancelable, no-tools auxiliary model calls against an existing Session and records their usage outside the official Agent-loop `tokenUsage` projection. Clarify consumes the same-process service; SeekTTY reads a provenance-preserving usage snapshot.

## Ownership

- Official `tokenUsage`: Agent-loop usage only.
- Auxiliary runtime: durable auxiliary call records and per-Session limit policy.
- Combined usage: a derived view computed bucket-by-bucket from the two owners; it is never written back under the official projection key.
- Session transcript: unchanged by this plugin.

## Public vocabulary

Usage has four disjoint buckets: `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`.

Supported purposes are `clarify`, `compaction`, and `session-title`. Call states are `running`, `succeeded`, `failed`, `cancelled`, and `interrupted`. Stable failure categories are `quota`, `context_window`, `aborted`, `error`, `conflict`, `limit`, and `unavailable`; official provider-neutral codes remain available without exposing provider messages.

The same-process service provides:

- `run(request)`: require a caller-generated `callId`, existing `sessionId`, purpose, official config, optional caller signal, and exactly one of static messages plus reservation, `buildRequest(preparedConfig)` plus reservation, or atomic `prepareRequest({ config, context, adapterDefaults }) => { system?, messages, reservation }`. Write `running` durably before `llm.prepareCall`; for prepared requests, perform a second serialized token-limit admission before `prepared.stream`. Prepared callbacks receive only detached structural metadata and are never persisted, logged, or remoted.
- `cancel(callId)`: abort an active call and report its current stable state.
- `snapshot(sessionId)`: return `{ official, auxiliary, combined, capability }` for the current Session lifecycle.
- `getPolicy(sessionId)` and `setPolicy(sessionId, policy)`: read and durably replace auxiliary limit policy.

Typert exposes read-only `auxiliary-runtime/snapshot` and operational `auxiliary-runtime/cancel`. `run` remains same-process and is never offered over HTTP.

## Persistence and privacy

Use official `storageDomain` domain `auxiliary_runtime`, version `0`, with `calls` and `policies` tables. Call rows are authoritative; no aggregate table is persisted. In-memory per-Session aggregates rebuild from the rows on initialization and update only after durable writes succeed.

Records are fenced by Session id and `header.createdAt`, so a reused id cannot inherit prior usage or policy. No model-visible text, draft, prompt, message, output, credential, environment value, or path may be persisted. Uninstall leaves the official storage-domain file in place; reinstall resumes it. Version `0` provides no wipe API. The implementation refuses new calls at a bounded row limit rather than silently deleting audit records.

## Concurrency, recovery, and limits

One process owns a `callId` at a time. A retry with the same terminal record, Session fence, and purpose is idempotent; it replays durable status/usage but never model text. A conflicting reuse fails. A startup pass converts durable orphaned `running` rows to `interrupted` without adding usage.

Preflight limits may reject on concurrent calls, recorded call count, or `recorded usage + held reservations + current reservation`. Static reservations are admitted with the durable running row. Prepared requests admit call/concurrency first, derive the request and reservation from prepared metadata, then admit tokens before stream construction. Provider-reported usage always wins after dispatch, even when it exceeds the reservation; the next call sees the resulting total. Provider quota and context-window failures preserve official `LlmFailure.code`; cancellation composes caller and service signals through `AbortController`.

## Required acceptance

- No `tokenUsage` registration, Session append, hidden Session, core bundle-row override, transcript event, tool, MCP, Skill, or subagent path exists.
- A missing Session or required Host service fails before provider dispatch.
- Late `storageDomain` availability activates the runtime independent of bundle order; withdrawal deactivates it, and stale service references cannot restart a disposed runtime.
- `running` is durable before stream construction; one authoritative row keeps the last provider usage report, including an observed all-zero report, and survives a later error/abort finish.
- A live successful same-process call returns bounded ephemeral model text; failed/cancelled/replayed calls return no text, and no model text enters the durable domain or Typert.
- Same-call retries, conflicting reuse, concurrent calls, cancel races, storage failures, invalid records, version mismatch, restart recovery, Session-id reuse, and row-limit behavior have executable tests.
- `snapshot.combined` equals official plus auxiliary buckets, while the official projection remains byte-for-byte unchanged.
- Pack/install/boot/remove/reinstall and cross-project `/doctor` pass under isolated official dsh Profiles.
- Clarify produces dynamic context-grounded questions and evolving previews through this service; SeekTTY displays the three usage sources and keeps plugin absence silent.

## Git and delivery

Develop on `codex/auxiliary-runtime`. Publish only after joint Grok/Codex review, CI, real-user journeys, and cross-project acceptance. Release assets are the package tgz and `SHA256SUMS`; do not publish to npm.
