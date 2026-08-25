# Agent Note：由本地 Codex 驱动的 Web 搜索

Status: implemented

[English](2026-08-18-local-codex-web-search.md) | 中文

## 问题

发行版 `web_search` 路由使用 DeepSeek 的 Anthropic 兼容 Messages 端点，因此无论对话模型为何，都单独要求 `DEEPSEEK_API_KEY`。已经拥有可用 Codex／ChatGPT 登录的用户，在 DeepSeek 凭证缺失或额度耗尽时仍会看到搜索失败。仓库已有加固过的单次 Codex app-server 集成，但它只服务于可选 subagent 提供方，并且只能选择最终助手文本；Web seam 无法复用它，也无法证明托管搜索确实执行过。

## 决策

`@deepseek-ai/dsh-web-search-codex` 以 `codex-local` 注册一个 `WebSearchProvider`。每次操作都会创建包含空 workspace 以及私有 user home、temp、XDG 和 Codex state 路径的临时根目录；该根目录在 POSIX 上使用 mode 0700，在 Windows 上使用平台目录访问控制。提供方会在派生子路径前通过 `realpath` 规范化已创建的根目录；在 macOS 上，这会使严格路径比较与 app-server 返回的规范临时路径保持一致。`env.CODEX_HOME`、环境中的 `CODEX_HOME` 与平台默认值依次选择绝对源 home；提供方只接受其中的普通 `auth.json`，以规范绝对文件符号链接或 Windows 同卷硬链接回退把该文件接入私有 Codex home，并在源验证或准备失败时于 spawn 前失败。Codex 使用文件凭据存储，因此原生 token 刷新会写穿桥接并更新选定的源 `auth.json`。随后，它通过 `ctx.subprocess` 以 `codex app-server --stdio --strict-config` 启动包内固定 Codex 0.149.1 payload。`model` 配置要求值含有非空白字符，派发时使用去除首尾空白的值，默认为 `gpt-5.5`；在该固定 payload 下，`gpt-5.6-sol` 使用 Responses Lite，不会暴露托管 Responses `web_search` 工具。启动配置会禁用 app、plugin、bundled skill，以及 0.149.1 中所有已知非搜索功能或工具，同时保留内建托管搜索。

共享 Codex 协议层公开一个有限的 `./app-server` 导出，而不是通用 JSON-RPC 逃生口。握手、线程／turn 关联、无人值守审批拒绝、取消、最终答案选择和整棵进程树释放仍只有一个实现。有限导出涵盖实验性初始化选项、有效配置与 requirement 读取、skill 与 MCP server 状态、空环境与 instruction source 断言、可选线程／turn 策略字段，以及已完成 `webSearch` 观察结果。Codex 0.149.1 无法在启动前排除 system 或 cloud managed 配置，因此这些状态可能进入进程；在发送任何用户查询前，提供方会检查 `config/read`、`configRequirements/read`、`skills/list` 与 `mcpServerStatus/list`，只要仍存在有效外部配置、requirement、skill 或 MCP server 就会失败。进程配置与线程配置都会设置 `orchestrator.mcp.enabled=false` 和 `orchestrator.skills.enabled=false`。搜索线程还要求 `environments: []`、空 `instructionSources`、空 workspace、`project_doc_max_bytes: 0`、`approvalPolicy: never` 与只读沙箱。Subagent 不带选项的调用会保留现有请求行为。

搜索向 Codex 提供 developer instructions：把查询视为不可信的研究数据、禁止命令／文件工作、要求使用内建 Web 搜索，并只返回受 schema 约束的 JSON。成功结果必须同时包含至少一个权威的已完成 `webSearch` item，以及可解析的 `{ content, sources[] }` 最终消息。该 item 能证明 turn 中运行过托管搜索；Codex 0.149.1 不公开该 item 与每个最终来源 URL 之间的可靠关联，因此提供方不声称逐条引用来源。来源必须使用 HTTP(S)，可选字段只保留非空字符串，重复 URL 以首次出现为准折叠，`maxResults` 会先成为 JSON Schema 的 `maxItems`，随后由提供方无关 seam 再强制一次。提供方绝不从纯文本中提取 URL，并且会拒绝没有托管搜索活动的 turn。

进程派发前，发起会话会用计划使用的 `developerInstructions`、`model`、`searchMode`、`prompt` 与 `outputSchema` 记录 `web/codex-search-llm-request`。这些字段可以重建提供方拥有的全部模型可见输入。该事件不含提供方凭据，但会把原始查询持久化在 `prompt` 中，因此用户提供的敏感文本会保留在会话日志里。它只记录一次尝试；不能证明进程或 turn 已启动，也不能证明查询已到达 Codex。`env.CODEX_HOME` 只选择认证源；提供方会移除子进程环境中的所有现有条目，把 `HOME`、`USERPROFILE`、`TMPDIR`、`TMP`、`TEMP`、XDG 路径、`CODEX_HOME` 与 `CODEX_SQLITE_HOME` 替换为私有根目录内的路径，并且只转发显式配置的 `OPENAI_BASE_URL`、`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY`。加载器与路径控制字段会被拒绝。`OPENAI_BASE_URL` 除 loopback HTTP 外必须使用 HTTPS，并会接收原生认证和查询；显式配置的代理可以观察或修改该流量，因此两类设置都是部署信任决策。源 home 中没有其他文件会被链接或复制到该根目录。

基础 bundle 选择 `searchProvider: codex-local`，以 `searchMode: live` 挂载 `web-search-codex`，为每次完整 `web_search` 调用配置共享的 120 秒 `dsh-tool-web` 预算，其中包括所有查询和认证队列等待时间，并保持与提供方无关的 base 设置 `fetch: false`。它也会挂载已加固的 `web-fetch-http` 提供方；已交付的 Web `cordis`、`ptc` 与 `standard` preset 会覆盖为 `fetch: true`，因此更换搜索提供方会保留它们现有的安全抓取能力。该 bundle 包含 `dsh-subagent-codex` 仅因为该包拥有公开 app-server 适配器；它不挂载 `codex` subagent 提供方，也不暴露 subagent 工具。本文负责提供方选择及其认证、工具、进程与超时实现；[已交付组合中的默认 Web 搜索](2026-07-31-web-default-search.zh.md)继续负责共享 base 位置与抓取默认值。

## 考虑过的替代方案

**使用 ChatGPT token 直接调用 OpenAI Responses API。** 否决，因为 Codex 认证由产品管理，并非 DSH 应读取、复制、刷新或模拟的 API Key 约定。官方 app-server 是受支持的集成边界，也已经负责解析登录状态。

**执行 `codex exec --json`。** 否决，因为结构化输出需要临时 schema 文件，事件关联与审批处理只能从 CLI 展示流推断，进程取消也会重复仓库中已有的 app-server 实现。

**把 Codex 模式放进 `web-search-deepseek`。** 否决，因为提供方包应命名实际后端。让一个配置表面在不相关的认证、协议与失败约定间切换，会使两种实现都更浅、更难测试。

**接受没有托管搜索活动的任意结构化最终回答。** 否决，因为输出 schema 只能证明响应字段，不能证明运行过托管搜索。要求已完成 `webSearch` item 能建立 turn 级搜索活动，但不能证明每个最终 URL 都来自该搜索。

**保留 DeepSeek 为发行默认搜索，让 Codex 仅供选择。** 针对本部署目标予以否决：用户已经认证的本地 Codex 权益就是预期搜索凭证。DeepSeek、Exa 和 Perplexity 提供方仍可用于自定义覆盖层。

## 后果

默认 DSH 搜索通过本地用户的 Codex 权益认证，不要求 `DEEPSEEK_API_KEY`。它会在认证文件不可用、登录过期、托管搜索不可用、额度耗尽，或查询前检查发现外部配置、requirement、skill 或 MCP server 时于操作阶段失败。加载插件不会执行进程或网络探测，使启动保持确定性，但也意味着同步提供方可用性无法预测账户状态。

每次搜索都会承担一次完整、隔离的 Codex turn 和一次进程生命周期。以 `Symbol.for` 为键的 `globalThis` 协调器会在整个 Host 进程内串行执行所有提供方实例，并且跨越源码 HMR，因为 Codex 0.149.1 没有跨进程刷新锁；排队中的取消会释放其 FIFO 位置，且不解析操作选项或 spawn。这样可以阻止单个 DSH Host 竞争自身的刷新写入，但无关 Codex 进程仍不在该所有权范围内。真实产品 Responses 哨兵会在 Codex 0.149.1 下固定默认模型的托管 `web_search` 为唯一出站工具，并证明环境中的 Node 预加载无法执行。返回会话的结果包含 Codex 生成摘要和规范化来源；0.149.1 app-server 事件不能确定这些来源的逐条出处。拆卸会关闭协议层、终止完整进程树，并只在证明退出后移除临时根目录；无法证明退出时会保留该根目录和仍有效的认证桥接，在进程内毒化 Codex 搜索，并产生清理失败。所有提供方实例会跨源码 HMR 保持不可用，直至重启 Host；`available()` 会返回 false，即使前序操作毒化进程协调器，排队中的取消仍保持为 `WEB_ABORTED`。与提供方无关的 base 仍仅启用搜索，已交付的 Web preset 则继续通过已加固的 `web-fetch-http` 提供方允许模型选择 URL 进行抓取；Codex 搜索本身既不授予也不移除抓取能力。

提供方协议测试使用内存 JSON-RPC app-server 边界，固定认证预检、POSIX 符号链接与 Windows 硬链接桥接、规范路径隔离、模型规范化与日志记录、进程和线程两级 orchestrator 关闭、严格启动配置、用户查询前拒绝外部状态、空线程环境与 instruction source、结构化映射、未搜索时的严格拒绝、错误结果拒绝、排队取消、跨实例且跨 HMR 的稳定串行、认证源毒化、取消与清理失败聚合、进程树完全停稳、HMR 释放与不变式所有权。真实产品测试固定默认模型在 0.149.1 下的 Responses 工具集合。现有 subagent 测试固定不带选项的行为。包 README 记录面向用户的配置与模型体验，生成的目录和模块图则纳入新提供方。
