<div align="center">

<h1>Auxiliary Runtime</h1>

<p>为 DeepSeek Harness 提供可取消的辅助模型调用、持久限额和来源清晰的用量账本。</p>

<p>
  <a href="https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/releases"><img src="https://img.shields.io/badge/Version-0.1.1-orange" alt="Version 0.1.1"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.1--rc.2-5B5BD6" alt="DeepSeek Harness 0.1.1-rc.2">
  <img src="https://img.shields.io/badge/Host%20still%20supported-0.1.0--rc.8-0A7EA4" alt="仍支持 Host 0.1.0-rc.8">
  <img src="https://img.shields.io/badge/Usage-Official%20%7C%20Auxiliary%20%7C%20Combined-0A7EA4" alt="Official, Auxiliary, Combined usage">
  <a href="https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/actions/workflows/ci.yml"><img src="https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License"></a>
</p>

<p>
  <a href="#项目概览">项目概览</a>
  ·
  <a href="#三种来源清晰的用量视图">用量视图</a>
  ·
  <a href="#运行时设计">运行时设计</a>
  ·
  <a href="#快速开始">快速开始</a>
  ·
  <a href="#服务合同">服务合同</a>
  ·
  <a href="#兼容与验证">验证</a>
</p>

<p><a href="README.md">English</a> · 中文</p>

</div>

---

## 项目概览

`dsh-plugin-auxiliary-runtime@0.1.1` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的社区 Host 插件。它把可取消、无工具的辅助模型调用绑定到已有 Session，执行每个 Session 的用量策略，并通过官方 `storageDomain` 将用量写入独立账本。当前编译与元数据目标是官方 Host `0.1.1-rc.2`；精确 Host `0.1.0-rc.8` 仍受支持。

[Clarify](https://github.com/Hilbert-beinghappy/dsh-plugin-clarify) 使用同进程 `run` 服务，在主 Session transcript 之外生成上下文问题、选项和持续演进的 Draft preview。[SeekTTY](https://github.com/Hilbert-beinghappy/seektty) 读取快照，并在能力健康时通过 `/status` 展示 Official、Auxiliary 和 Combined。

```text
                       +----------------------+
                       | DeepSeek Harness     |
                       | 已有 Session         |
                       | 官方模型路由         |
                       +----------+-----------+
                                  |
                           llm.prepareCall
                                  |
                                  v
+----------------+       +----------------------+       +----------------+
| Clarify        | ----> | Auxiliary Runtime    | ----> | Provider stream|
| 同进程调用     | run   | 准入 / 限额 / 取消   |       | usage chunks   |
| Draft preview  | <---- | 有界实时输出         | <---- | 终态           |
+----------------+       +----------+-----------+       +----------------+
                                  |
                                  | 持久调用行
                                  v
                       +----------------------+
                       | storageDomain        |
                       | auxiliary_runtime v0 |
                       | calls / policies     |
                       +----------+-----------+
                                  |
                                  | 只读快照
                                  v
                       +----------------------+
                       | SeekTTY /status      |
                       | Official / Auxiliary |
                       | Combined             |
                       +----------------------+
```

## 三种来源清晰的用量视图

| 视图 | 来源与含义 |
| --- | --- |
| **Official** | 官方 Host `tokenUsage` 投影，由 Agent 循环拥有。 |
| **Auxiliary** | 本插件的 `auxiliary_runtime` 账本，从权威调用行聚合。 |
| **Combined** | 读取时逐桶相加 Official 与 Auxiliary 得到的派生值。 |

四个互不重叠的桶是 `uncachedInputTokens`、`outputTokens`、`cacheReadTokens` 和 `cacheWriteTokens`。Combined 面向消费者动态计算，官方投影保持原有归属。

### 主 Session 对话记录

辅助调用使用已有 Session 作为身份和路由围栏。用户通过常规 Session 流程发送采用后的 Draft 时，正式消息才进入主 transcript；Clarify 的问题、回答和 Draft preview 留在它的临时 Host 状态中。

### 持久辅助账本

持久行保存标识、purpose、状态、四个 Token 桶、`usageRecorded`、规范化失败 `{ category, code }` 和时间戳。prompt、消息、system 文本、模型输出、自定义答案、凭据、环境值和文件路径保留在存储之外。失败记录只包含规范化后的 `{ category, code }`，官方 `LlmFailure.message` 保留在存储之外。

## 运行时设计

### 准入、用量与重放

`run` 在 `llm.prepareCall` 和 `prepared.stream` 之前写入持久 `running` 行。prepared 请求在 Provider 元数据物化后、流开始前完成 Token 限额准入。最新 Provider usage chunk 会替换权威行中的四个桶；`usageRecorded` 用来区分真实的全零报告与没有报告。后续进入 `error` 或 `aborted` 时，已经记录的用量继续保留。

成功的实时调用将模型文本临时返回给同进程调用方，按流顺序拼接，并限制在 65,536 个 UTF-16 code unit。终态重放返回持久状态、用量、`replayed: true` 和 `output: null`；需要新文本时使用新的 `callId`。活跃 id 重用、跨 Session 重用和 purpose 变化都会返回冲突。

### 限额与取消

每个 Session 的策略包括 `maxConcurrentCalls`、`maxCallsPerSession` 和 `maxAuxiliaryTotalTokens`。限额由已记录用量与进程内在途预留共同计算。调用发出后，Provider 报告成为权威值，包括超出初始预留的情况。

取消通过 `AbortController` 组合调用方 signal 与服务 signal。Provider 失败保留 `QUOTA`、`CONTEXT_WINDOW_EXCEEDED` 等官方分类。下次初始化发现的持久 `running` 行会转为 `interrupted`，并保持原用量。

### 持久化与 Session 围栏

官方存储域为 `auxiliary_runtime` version `0`，包含 `calls` 和 `policies` 表。调用行是权威来源；聚合值在初始化时从行重建，并在持久写入成功后更新。

记录同时使用 Session id 与 `session.header.createdAt` 作为围栏，因此复用的 id 会获得新的用量和策略身份。移除 Bundle 后，官方 storage-domain 文件仍可由重装版本继续使用。version `0` 保留审计行，达到 10,000 行时拒绝新调用。支持的部署形态是每个 `DSH_HOME` 运行一个 Host 进程。

### 服务生命周期

插件通过 Cordis 子上下文等待官方 `storageDomain`。服务撤回会取消活跃工作并释放旧引用；恢复后创建新的运行时。缺少 Host 服务、缺少活跃 Session、域版本不匹配或存储记录无效时，请求会在 Provider 调用前闭包失败。

## 快速开始

最近一次已发布 Release 仍是 Auxiliary Runtime `0.1.0`。用官方 `dsh plugin` 把该预构建 tarball 装进隔离 Profile：

```sh
pnpm add --global @deepseek-ai/dsh@0.1.0-rc.8
dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/releases/download/v0.1.0/dsh-plugin-auxiliary-runtime-0.1.0.tgz
```

当前源码 `0.1.1` 面向官方 Host `0.1.1-rc.2`，尚无 GitHub Release。不要编造 `v0.1.1` 下载 URL。请本地打包后再 add：

```sh
pnpm add --global @deepseek-ai/dsh@0.1.1-rc.2
pnpm pack
dsh plugin --profile tui add ./dsh-plugin-auxiliary-runtime-0.1.1.tgz
```

Host `0.1.0-rc.8` 仍接纳这份本地打出的候选 tarball。当前兄弟 Release SeekTTY `1.2.0` 与 Clarify `0.2.1` 仍是精确 Host `0.1.0-rc.8` 上最近一次已发布联合验收组合。这不是它们已在 `0.1.1-rc.2` 上的声明。未发布 Auxiliary `0.1.1` 与 SeekTTY `1.2.1`、Clarify `0.2.2` 已有 Lane A 无 key PTY 证据；live-provider Lane B 仍阻断。不是 Release。仍可将这些已发布 tarball 与本候选一起 add：

```sh
dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/seektty/releases/download/v1.2.0/seektty-1.2.0.tgz
dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/dsh-plugin-clarify/releases/download/v0.2.1/dsh-plugin-clarify-0.2.1.tgz
dsh --profile tui
```

Bundle patch 只插入 `id: auxiliary-runtime` / `name: dsh-plugin-auxiliary-runtime`。消费者包没有 `workspace:` 依赖，Harness 服务全部来自官方 Host Context。

## 服务合同

### 同进程服务

`run` 仅供同一 Host 进程内的插件调用：

```ts
const runtime = ctx.get('auxiliaryRuntime')

const result = await runtime.run({
  callId,          // 调用方生成
  sessionId,       // 已有的活跃 Session
  purpose,         // 'clarify' | 'compaction' | 'session-title'
  config,          // 官方 LlmCallConfig
  prepareRequest,  // 可选：prepared 元数据 => request + reservation
  signal,          // 可选：调用方 AbortSignal
})
```

`run` 接受三种请求模式之一：

- 静态 `system` / `messages` 与必填的四桶 reservation；
- 旧版同进程 `buildRequest(preparedConfig)` 与必填 reservation；
- `prepareRequest({ config, context, adapterDefaults })`，从同一份 prepared 元数据原子返回 `{ system?, messages, reservation }`。

prepared 回调在 `llm.prepareCall` 后接收已经分离、冻结的结构数据。回调函数与产物留在进程内。`getPolicy(sessionId)` 和 `setPolicy(sessionId, policy)` 管理三个 Session 限额。

### Typert Host

独立的 `auxiliary-runtime` Typert receiver 提供两个方法：

- `auxiliary-runtime/snapshot` — 只读 `{ official, auxiliary, combined, capability }`
- `auxiliary-runtime/cancel` — 取消活跃调用并返回稳定状态

模型执行保留为同进程能力；HTTP 消费者可以读取用量快照和执行取消。

## 兼容与验证

当前编译与元数据目标是官方 DeepSeek Harness **`0.1.1-rc.2`**，Node `^22.19.0 || >=24`。精确 Host **`0.1.0-rc.8`** 仍受支持。运行时使用以下公开 Host 服务：

- `storageDomain.open` / `KvTable`
- `sessions.get` 与 `header.createdAt`
- `llm.prepareCall` / `prepared.stream`
- `sessionProjections.snapshot`，只读 Official 用量
- Typert Host `register`，仅注册 snapshot 与 cancel

已发布回滚联合基线仍是精确 Host **`0.1.0-rc.8`**。Auxiliary Runtime `0.1.1` 针对并接纳精确 `0.1.1-rc.2`。Lane A（2026-08-21，未修改 stock `0.1.1-rc.2`、隔离 `DSH_HOME`、真实 PTY、未发布 Auxiliary `0.1.1` + Clarify `0.2.2` + SeekTTY `1.2.1`）：`/doctor` 0 error / 0 warning、99 plugins running；`/status` 健康；`/clarify` 路由到 Auxiliary 后无 key 返回 `MISSING_CREDENTIAL` 且保留 composer；Vision-Exp 可见且可选择；PNG 附件 `/restart` 成功恢复。丢失源文件恢复：单测保证失败文案只用 basename、覆盖两种通知顺序、绝对路径不进文案；真实 PTY hardcopy/可见区扫描只检出 ASCII basename `vision-logo.png`，未检出 `private/tmp`、`/tmp`、`Users`、`Volumes`。不能证明关闭无 key onboarding modal 后该 restore error 仍持续显示（Esc 也会清 notice）。Lane B 因缺少 `DEEPSEEK_API_KEY` 仍阻断（Clarify 成功动态多轮、accept 回 composer 且不自动发送、PNG/JPEG 视觉理解、成功发送后清除附件）。不是 Release，也不是完整联合验收。Clarify `0.2.1` 保持 `0.2.0` 的六方法 Remote、`clarify.wire/1` 和兼容边界。

Clarify `0.2.0` live-provider 联合验收覆盖真实模型动态澄清、多轮 Draft 演进、用户自主发送、中断恢复、用量来源和账本隐私。Clarify `0.2.1` 发布后无 Key 验收重新下载并核对三包 Release 资产，在精确 `0.1.0-rc.8` 的 stock Profile 完成 add／boot／remove／re-add，`/doctor` 为 0 错误／0 警告、99 个插件运行，随后进入 `running`、路由到 Auxiliary，并按隔离环境预期返回 `MISSING_CREDENTIAL`。`0.2.1` 尚未重跑 live-provider 动态多轮，也没有 cache／cost A/B。

已发布回滚栈是官方 `@deepseek-ai/dsh@0.1.0-rc.8`、Auxiliary Runtime `0.1.0`、Clarify `0.2.1` 和 SeekTTY `1.2.0`。

`package.json#dshPlugin.testedHost` 是编译钉 `0.1.1-rc.2`。`dshPlugin.testedHosts` 列出两个精确准入钉 `0.1.0-rc.8` 与 `0.1.1-rc.2`。Host 没有暴露版本值时，能力探测可以启动并报告 `hostConfirmed: false`；已知版本位于这两个钉之外时会被拒绝。

## 开发

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm pack:check
```

`pnpm typecheck` 是官方类型门。official-contract 的运行时测试只钉住所安装包版本；该文件顶部的编译期 `Assert` 由 `pnpm typecheck` 检查。

未来 GitHub Release 才会附带 tarball 与 `SHA256SUMS`。

## 许可

[MIT](LICENSE)
