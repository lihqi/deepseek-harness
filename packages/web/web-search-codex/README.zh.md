---
description: "ctx.web 的本地 Codex 搜索提供方：部署方如何通过现有 Codex 登录进行隔离的托管搜索，无需搜索 API 密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-codex

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-codex`，harness 可以通过包内固定的 Codex 0.149.1 app-server 和用户现有的 Codex 或 ChatGPT 认证搜索 web。当部署希望使用托管搜索、不向 DSH 添加 DeepSeek、Exa、Perplexity 或 OpenAI API 密钥，并接受每次搜索消耗一个完整 Codex turn 时选择它。每次操作都使用私有临时 home 与空 workspace，并且仅把用户的普通文件 `auth.json` 桥接进去。每个结果都要求已完成托管搜索 item 和受 schema 约束的 JSON；该 item 能证明 turn 中运行过托管搜索，但不能证明最终消息中的每个来源 URL 都来自该搜索。纯文本、格式错误的来源，或没有托管搜索活动的 turn 都会封闭失败。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 与 subprocess 服务的组合中挂载本提供方；它以 `codex-local` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: codex-local` 固定。

### 何时选择

当配置的 Codex home 中存在已登录且拥有托管搜索权限的账户所用普通文件 `auth.json` 时，选择此后端。包会提供固定的 Codex 0.149.1 payload。搜索提供方 API 密钥不会进入 DSH，但每次搜索都会启动独立的 Codex 模型 turn 与进程，因此当吞吐量、延迟或权益消耗占主导时，专用检索 API 更合适。

### 最小配置

在本包之前加载 web 服务与 subprocess 提供方。已交付的 base bundle 使用默认的 `model: gpt-5.5`，设置 `searchMode: live`，并为每次完整 `web_search` 调用配置共享的 120 秒工具预算；其中包括所有查询和认证队列等待时间。

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: codex-local

- id: web-search-codex
  name: '@deepseek-ai/dsh-web-search-codex'
  config:
    searchMode: live
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `model` | `gpt-5.5` | 非空白的 Codex 原生模型；启动临时线程前会去除首尾空白 |
| `searchMode` | `live` | Codex 托管搜索的新鲜度：`cached`、`indexed` 或 `live` |
| `disposeGraceMs` | `3000` | subprocess 终止升级前的正有限毫秒数 |
| `env` | `{}` | 显式子进程环境白名单：`CODEX_HOME` 选择绝对源 home 但不进入子进程；只有 `OPENAI_BASE_URL`、`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 会被转发。其他名称会使插件加载失败 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-codex)是每个受支持字段及其 JSDoc 的穷尽式真源。加载包时不会启动或探测任何内容。操作开始后，提供方会要求选定的源 home 及其 `auth.json` 使用绝对路径且该文件是普通文件，再于 spawn 前创建私有目录和认证桥接。POSIX 使用绝对文件符号链接；Windows 会先尝试该符号链接，并在失败时回退到硬链接，因此临时目录与源文件必须位于同一卷。源文件缺失、不是文件或任何设置失败时都不会启动 Codex 进程。托管搜索权限与账户配额仍在 app-server 启动后于运行时检查。

### 搜索返回什么

`content` 携带 Codex 生成的摘要。`sources[]` 只包含绝对 HTTP(S) URL，以及非空的可选标题、snippet 和发布日期。重复 URL 以首次出现为准折叠。提供方会把调用方的正整数 `maxResults` 作为 `maxItems` 写入结构化输出 schema，提供方无关的 web 服务会对返回结果强制执行同一上限。

成功 turn 必须发出至少一个权威的已完成 `webSearch` item，并且最终消息可解析为 `{ content, sources[] }`。纯文本、错误 JSON、非 HTTP(S) 来源 URL，或未运行托管搜索就结束的 turn 都会失败，而不会产生结果。

### 请求日志

进程派发前，由发起 agent 运行的搜索会追加仅用于日志的 `web/codex-search-llm-request` 会话事件。它会记录计划使用的 `developerInstructions`、`model`、`searchMode`、`prompt` 与 `outputSchema`，不包含提供方凭据。prompt 会持久化原始查询，因此可能包含用户提供的敏感文本。该事件记录一次尝试，不能证明进程或 turn 已启动，也不能证明查询已到达 Codex。agent 之外的直接编程调用没有可记录的发起会话。

### 失败与恢复

调用方取消会抛出 `WebError` `WEB_ABORTED`，即使清理也失败；该错误的 cause 会同时保留取消与清理失败。认证源、隔离设置、外部配置预检、协议、进程、权益、托管搜索、配额、托管搜索活动与结构化输出失败都以 `WEB_PROVIDER_ERROR` 呈现。非取消的操作失败与清理失败会一同保留。提供方会关闭 JSON-RPC 协议层、终止完整子进程树，并且只在证明进程树完全停稳后删除私有根目录。如果清理无法证明退出，则会保留根目录和仍有效的认证桥接，在整个 Host 进程内把 Codex 搜索标记为不可用，并报告清理失败。此后 `available()` 返回 false，Web 服务会报告所配提供方不可用；只有重启 Host 进程才能清除此封闭失败状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本提供方建立在三项承诺之上：

- **认证是唯一文件桥接。** 每次搜索都会创建包含空 workspace 的临时根目录，在 POSIX 上使用 mode 0700，在 Windows 上使用平台目录访问控制，并为 `HOME`、`USERPROFILE`、`TMPDIR`、`TMP`、`TEMP`、XDG 路径、`CODEX_HOME` 与 `CODEX_SQLITE_HOME` 提供私有值。提供方会在派生子路径前通过 `realpath` 规范化已创建的根目录；在 macOS 上，这会使这些路径与 app-server 返回的规范临时路径严格相等。`env.CODEX_HOME`、环境中的 `CODEX_HOME` 与平台默认值按此顺序选择绝对源 home；只有其中作为普通文件存在的 `auth.json` 会通过规范绝对文件符号链接或 Windows 同卷硬链接回退进入私有 Codex home。Codex 的文件凭据存储会原地刷新这个桥接文件，因此 token 刷新会更新选定的源 `auth.json`。
- **只有托管搜索可以接触查询。** 子进程启动时不包含环境中的任何条目；只有显式配置的 OpenAI 基础 URL 与代理设置能够转发，`NODE_OPTIONS`、`NODE_PATH` 和 TLS 配置路径等加载器与路径控制会被拒绝。包内固定的 Codex 0.149.1 进程使用 `--strict-config` 启动；启动配置会关闭 apps、plugins、bundled skills，以及所有已知非搜索功能或工具。进程与线程配置都会设置 `orchestrator.mcp.enabled=false` 和 `orchestrator.skills.enabled=false`。发送用户查询文本前，提供方会检查 `config/read`、`configRequirements/read`、`skills/list` 与 `mcpServerStatus/list`；若仍存在任何有效外部配置、requirement、skill 或 MCP server，操作就会失败。临时线程还要求 `environments: []`、空 instruction sources、空 workspace、`project_doc_max_bytes: 0`、`approvalPolicy: never` 与只读 sandbox。真实产品的 Responses 哨兵会验证托管 `web_search` 是唯一出站工具；只有协议层观察到托管搜索活动，且最终 JSON 通过严格映射时，结果才会被接受。
- **一次搜索拥有一个生命周期。** 每个操作拥有一个私有根目录、一个进程、一个临时线程和一个 turn。共享 Codex app-server 适配器负责握手、通知关联、取消与最终答案选择；提供方只在证明整棵进程树退出后移除认证桥接和私有根目录。进程级协调状态会跨越提供方源码 HMR。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、提供方注册、会话事件记录 |
| [`src/provider.ts`](src/provider.ts) | `CodexSearchProvider`：逐次操作隔离、外部状态预检、app-server 生命周期、托管搜索活动检查、结构化 schema 与结果映射 |
| [`src/invariant.ts`](src/invariant.ts) | 提供方会话事件所有权的不变式伴生插件 |

### 请求流程

每次搜索都会解析一份完整选项快照，记录不含提供方凭据的计划辅助请求，准备仅桥接认证的私有根目录，再通过 `ctx.subprocess` 在空 workspace 中启动 Codex。记录的 prompt 含有原始查询，因此可能包含用户提供的敏感文本。握手完成后，协议层会在启动不含 instruction 的临时线程前拒绝有效外部配置、requirement、skill 与 MCP server，并为线程选择托管搜索模式。它使用仅适配器 developer instructions、查询 prompt 与结果 schema 运行一个只读 turn。turn 完成后，它验证 `webSearch` item 已完成，解析选定的最终答案，删除空的可选来源字段，按 URL 对来源去重，证明进程树退出，再于返回或抛错前移除私有根目录。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与共享本地 Codex 适配器。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——七包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方答案与来源的面向模型 `web_search` 工具。
- [dsh-subagent-codex](../../subagent/subagent-codex/README.zh.md)——拥有有限共享 app-server 适配器的包。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-codex)——每个受支持配置字段及其源声明。
- [本地 Codex web 搜索](../../../.agents/notes/implemented/feature/2026-08-18-local-codex-web-search.zh.md)——提供方与已交付组合的决策。

-----

<a id="model-experience"></a>
## 模型体验

### 辅助 Codex 搜索请求

#### 模型看到的内容

独立的本地 Codex turn 不会收到 workspace 内容、项目文档、环境上下文、外部配置、requirement、skill、MCP 工具或非搜索工具。它只会收到适配器 developer instructions、精确用户文本模板 `Research this query with built-in web search and summarize the findings with sources. Return at most <maxResults> sources.\n\nQuery:\n<JSON 编码的查询>`、托管 `web_search` 工具，以及提供方的 `{ content, sources[] }` 输出 schema；没有上限时省略结果数量句。

#### Token 影响

每次搜索都会在用户已登录的 Codex 权益下消耗一个独立 Codex 模型 turn 和托管搜索用量。输入包含适配器指令、查询与输出 schema；输出随摘要与受限来源数量增长。

#### KV Cache 影响

与会话模型请求相互独立。稳定的适配器指令可以构成辅助 Codex 路由的可复用前缀，查询与结果上限在该前缀之后变化。

### 间接的会话工具结果

#### 模型看到的内容

通过 [`dsh-tool-web`](../tool-web/README.zh.md)，会话模型会看到 Codex 规范化后的摘要、去重的 HTTP(S) 来源、标题、snippet 和可选发布日期。最终工具结果封装与提供方错误展示由消费方负责。

#### Token 影响

提供方注册不产生直接会话 token。工具结果 token 随返回的摘要与来源增长，并受消费方结果上限约束。

#### KV Cache 影响

工具调用后仅追加；返回的搜索结果位于已组装的会话前缀之后，不会替换更早的请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **一次搜索会消耗完整 Codex turn**——相比专用检索 API，它更慢，也会消耗更多权益。
- **可用性刻意只做本地检查**——`available()` 只验证配置，不启动 Codex，因此二进制缺失或登录过期会在第一次操作时失败，而不是启动时隐藏工具。
- **认证必须是本地普通文件并且会共享读写**——提供方不会复制原生配置，也不接受目录或符号链接作为源 `auth.json`。POSIX 使用绝对文件符号链接；Windows 在没有符号链接权限时会回退到同卷硬链接。无法创建任一桥接都会阻止 spawn。原生 token 刷新会通过私有桥接写入选定的源文件。
- **每次搜索一个进程，并在整个 Host 进程内串行执行**——跨提供方实例与源码 HMR 共享的进程生命周期协调器一次只运行一个 app-server 生命周期，因为原生 token 刷新没有跨进程锁。排队的调用方可以取消且不会解析操作选项或 spawn；同一次工具调用中的所有查询会在等待期间共享调用期限。系统没有长期运行的共享 app-server 进程池。无法证明进程树退出时，协调器会永久拒绝所有本地 Codex 搜索直至重启 Host，因为存活进程可能仍持有认证桥接。该 Host 之外的 Codex 进程不受协调器管理，仍可能竞争同一个源认证文件。
- **模型兼容性因版本而异**——默认值为 `gpt-5.5`，因为固定的 Codex 0.149.1 payload 会通过 Responses Lite 路由 `gpt-5.6-sol`，而 Responses Lite 不会暴露托管 Responses `web_search` 工具；覆盖的模型必须暴露该工具。
- **工具限制与版本绑定**——关闭集合覆盖固定 Codex 0.149.1 payload 的已知非搜索功能与工具；升级前必须重新审计配置与出站工具集合，才能改动该版本 pin。
- **端点与代理覆盖是信任决策**——`OPENAI_BASE_URL` 会收到从选定 `auth.json` 读取的原生凭据与搜索查询；除 loopback HTTP 外，它必须使用 HTTPS。显式代理设置可以观察或修改同一流量。只能配置由部署方控制的端点与代理。
- **托管搜索活动不能验证单条引用**——Codex 0.149.1 会报告 `webSearch` item 已完成，但不会公开该 item 与最终结构化消息中每个 URL 之间的可靠关联。提供方会验证 URL 语法与结果结构，但不会验证每个 URL 是否来自观察到的搜索。
- **结果依赖 Codex 遵守结构化输出**——最终 JSON 无效或未观察到托管搜索 item 时，提供方会封闭失败，不会抓取纯文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
