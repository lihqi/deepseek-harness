---
description: "The local-Codex search provider for ctx.web: how deployments use an existing Codex login for isolated hosted search without a search API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-codex

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-codex`, the harness searches the web through the package-local Codex 0.149.1 app-server and the user's existing Codex or ChatGPT authentication. Choose it when a deployment wants hosted search without adding a DeepSeek, Exa, Perplexity, or OpenAI API key to DSH and accepts that every search consumes one complete Codex turn. Each operation uses a private temporary home and empty workspace, with the user's regular `auth.json` as its only file bridge. Each result requires a completed hosted-search item and schema-constrained JSON; the item proves that hosted search ran during the turn but does not prove that every final source URL came from that search. The provider fails closed on prose, malformed sources, or a turn with no hosted-search activity. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web and subprocess services; it registers as the `codex-local` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: codex-local`.

### When to choose it

Choose this backend when the configured Codex home contains a regular `auth.json` for a logged-in account with hosted-search access. The package supplies the fixed Codex 0.149.1 payload. No search-provider API key enters DSH, but each search starts a separate Codex model turn and process, so a dedicated retrieval API remains a better fit when throughput, latency, or entitlement use dominates.

### Minimal configuration

Load the web service and subprocess provider before this package. The shipped base bundle uses the default `model: gpt-5.5`, sets `searchMode: live`, and gives each complete `web_search` invocation—including all queries and authentication-queue waiting—a shared 120-second tool budget.

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

| Field | Default | Meaning |
|---|---|---|
| `model` | `gpt-5.5` | Non-blank native Codex model; surrounding whitespace is trimmed before the ephemeral thread starts |
| `searchMode` | `live` | Codex hosted-search freshness: `cached`, `indexed`, or `live` |
| `disposeGraceMs` | `3000` | Positive finite milliseconds before subprocess termination escalates |
| `env` | `{}` | Explicit child-environment allowlist: `CODEX_HOME` selects the absolute source home without entering the child; `OPENAI_BASE_URL`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` are the only forwarded entries. Other names fail plugin loading |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-codex) is the exhaustive source for every accepted field and its JSDoc. Loading the package starts and probes nothing. At operation time, the provider requires the selected source home and its `auth.json` to be absolute and the file to be regular, then creates the private directories and authentication bridge before spawn. POSIX uses an absolute file symlink; Windows first tries that symlink and falls back to a hard link, which requires the temporary directory and source file to be on the same volume. A missing or non-file source or any setup failure starts no Codex process. Hosted-search access and account quota remain runtime checks after app-server starts.

### What a search returns

`content` carries Codex's generated summary. `sources[]` contains only absolute HTTP(S) URLs plus non-empty optional titles, snippets, and publication dates. Duplicate URLs collapse first-wins. The provider puts the caller's positive integer `maxResults` into the structured-output schema as `maxItems`, and the provider-neutral web service enforces the same bound on the returned result.

A successful turn must emit at least one authoritative completed `webSearch` item and a final message that parses as `{ content, sources[] }`. Plain prose, malformed JSON, non-HTTP(S) source URLs, or a turn that completes without hosted search fails rather than producing a result.

### Request logging

Before process dispatch, a search running under an initiating agent appends the log-only `web/codex-search-llm-request` session event. It records the intended `developerInstructions`, `model`, `searchMode`, `prompt`, and `outputSchema`, without provider credentials. The prompt persists the original query and can therefore contain user-supplied sensitive text. The event records the attempt and does not prove that a process or turn started or that the query reached Codex. A direct programmatic provider call outside an agent has no initiating session to log.

### Failures and recovery

Caller cancellation throws `WebError` `WEB_ABORTED`, including when teardown also fails; that error's cause retains both cancellation and teardown failures. Authentication-source, isolation setup, external-configuration preflight, protocol, process, entitlement, hosted-search, quota, hosted-search-activity, and structured-output failures surface as `WEB_PROVIDER_ERROR`. A non-cancellation operation failure and cleanup failure are retained together. The provider closes the JSON-RPC wire, terminates the complete child process tree, and deletes the private root only after process-tree exit is proven. If teardown cannot prove exit, it retains the root and live authentication bridge, marks Codex search unavailable throughout the Host process, and reports the cleanup failure. `available()` then returns false and the Web service reports the configured provider unavailable; only a Host-process restart clears this fail-closed state.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is built on three commitments:

- **Authentication is the only file bridge.** Each search creates a temporary root with an empty workspace, mode 0700 on POSIX, and private values for `HOME`, `USERPROFILE`, `TMPDIR`, `TMP`, `TEMP`, the XDG paths, `CODEX_HOME`, and `CODEX_SQLITE_HOME`; Windows uses the platform's directory access controls. The provider resolves the created root through `realpath` before deriving child paths; on macOS this makes those paths exactly match the canonical temporary paths returned by app-server. `env.CODEX_HOME`, the ambient `CODEX_HOME`, or the platform default selects an absolute source home in that order; only its regular `auth.json` enters the private Codex home through a canonical absolute file symlink or the Windows same-volume hard-link fallback. Codex's file credential store refreshes that bridged file in place, so a token refresh updates the selected source `auth.json`.
- **Only hosted search may reach the query.** The child starts without ambient environment entries; only an explicitly configured OpenAI base URL and proxy settings can be forwarded, while loader and path controls such as `NODE_OPTIONS`, `NODE_PATH`, and TLS configuration paths are rejected. The package-local Codex 0.149.1 process starts with `--strict-config`; launch config disables apps, plugins, bundled skills, and every known non-search feature or tool. Process and thread config both set `orchestrator.mcp.enabled=false` and `orchestrator.skills.enabled=false`. Before it sends user query text, the provider checks `config/read`, `configRequirements/read`, `skills/list`, and `mcpServerStatus/list` and fails if any effective external config, requirement, skill, or MCP server remains. The ephemeral thread also requires `environments: []`, empty instruction sources, an empty workspace, `project_doc_max_bytes: 0`, `approvalPolicy: never`, and a read-only sandbox. A real-product Responses sentinel verifies that hosted `web_search` is the only outbound tool, and a result is accepted only when the wire observes hosted-search activity and the final JSON passes strict mapping.
- **One search owns one lifecycle.** Each operation owns one private root, process, ephemeral thread, and turn. The shared Codex app-server adapter owns handshake, notification association, cancellation, and final-answer selection; the provider removes the authentication bridge and private root only after whole-tree exit is proven. Process-wide coordination outlives provider source HMR.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration, session-event recording |
| [`src/provider.ts`](src/provider.ts) | The `CodexSearchProvider`: per-operation isolation, external-state preflight, app-server lifecycle, hosted-search activity check, structured schema and result mapping |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion for the provider's session-event ownership |

### Request flow

Each search resolves one option snapshot, records the credential-free intended auxiliary request, prepares its authentication-only private root, and starts Codex through `ctx.subprocess` in the empty workspace. The recorded prompt contains the original query and therefore can contain user-supplied sensitive text. After the handshake, the wire rejects effective external config, requirements, skills, and MCP servers before it starts an ephemeral, instruction-free thread with the selected hosted-search mode. It runs one read-only turn with adapter-only developer instructions, the query prompt, and the result schema. After turn completion, it verifies that a `webSearch` item completed, parses the selected final answer, drops empty optional source fields, deduplicates sources by URL, proves process-tree exit, and then removes the private root before returning or throwing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tool, and the shared local Codex adapter.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the seven-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's answer and sources.
- [dsh-subagent-codex](../../subagent/subagent-codex/README.md) — the package that owns the bounded shared app-server adapter.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-codex) — every accepted config field and its source declaration.
- [Local Codex web search](../../../.agents/notes/implemented/feature/2026-08-18-local-codex-web-search.md) — the provider and shipped-composition decision.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary Codex search request

#### What the model sees

A separate local Codex turn receives no workspace content, project documents, environment context, external config, requirements, skills, MCP tools, or non-search tools. It receives only adapter developer instructions, the exact user-text template `Research this query with built-in web search and summarize the findings with sources. Return at most <maxResults> sources.\n\nQuery:\n<JSON-encoded query>`, the hosted `web_search` tool, and the provider's `{ content, sources[] }` output schema; the result-count sentence is omitted when no bound exists.

#### Token effect

Each search consumes a separate Codex model turn plus hosted-search usage under the user's logged-in Codex entitlement. Its input includes the adapter instructions, query, and output schema; output scales with the summary and bounded sources.

#### KV Cache effect

Independent of the conversation model request. The stable adapter instructions may form a reusable prefix for the auxiliary Codex route, while the query and result bound vary after that prefix.

### Conversation tool result, indirectly

#### What the model sees

Through [`dsh-tool-web`](../tool-web/README.md), the conversation model sees Codex's normalized summary, deduplicated HTTP(S) sources, titles, snippets, and optional publication dates. The consumer owns the final tool-result envelope and provider-error presentation.

#### Token effect

Zero direct conversation tokens from provider registration. Tool-result tokens scale with the returned summary and sources, capped by the consumer's result bound.

#### KV Cache effect

Append-only after the tool call; the returned search result follows the already assembled conversation prefix and does not replace earlier request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit. They are current package constraints.

- **A search costs a complete Codex turn** — it is slower and consumes more entitlement than a dedicated retrieval API.
- **Availability is intentionally local-only** — `available()` validates configuration without starting Codex, so a missing binary or expired login fails on the first operation rather than hiding the tool at startup.
- **Authentication must be a local regular file and is shared read/write** — the provider does not copy native configuration or accept a directory or symlink as the source `auth.json`. POSIX uses an absolute file symlink; Windows falls back to a same-volume hard link when symlink privilege is unavailable. Failure to create either bridge prevents spawn. Native token refresh writes through the private bridge to the selected source file.
- **One process per search, serialized throughout the Host process** — a process-lifetime coordinator shared across provider instances and source HMR runs only one app-server lifecycle at a time because native token refresh has no cross-process lock. A queued caller can cancel without resolving operation options or spawning, and all queries in one tool call share its deadline while waiting. There is no long-lived shared app-server pool. When process-tree exit cannot be proven, the coordinator permanently rejects every local Codex search until Host restart because a surviving process may still hold an authentication bridge. Codex processes outside this Host remain outside the coordinator and can still race the same source authentication file.
- **Model compatibility is version-specific** — the default is `gpt-5.5` because the fixed Codex 0.149.1 payload routes `gpt-5.6-sol` through Responses Lite, which does not expose the hosted Responses `web_search` tool; an override must expose that tool.
- **Tool confinement is version-pinned** — the disable set covers the known non-search features and tools of the fixed Codex 0.149.1 payload; an upgrade requires a new config and outbound-tool audit before changing that pin.
- **Endpoint and proxy overrides are trust decisions** — `OPENAI_BASE_URL` receives the native credentials read from the selected `auth.json` and the search query; it must use HTTPS except for loopback HTTP. Explicit proxy settings can observe or alter the same traffic. Configure only endpoints and proxies controlled by the deployment.
- **Hosted-search activity does not verify individual citations** — Codex 0.149.1 reports that a `webSearch` item completed but does not expose a reliable relation between that item and every URL in the final structured message. The provider validates URL syntax and result structure, not whether each URL came from the observed search.
- **Results depend on Codex structured-output compliance** — the provider fails closed instead of scraping prose when the final JSON is invalid or no hosted-search item was observed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
