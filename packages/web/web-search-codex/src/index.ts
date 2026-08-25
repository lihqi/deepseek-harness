/**
 * Register local Codex as a `WebSearchProvider`. The provider uses the
 * package-fixed Codex payload with the user's existing ChatGPT authentication;
 * no search-provider API key enters DSH.
 *
 * @module @deepseek-ai/dsh-web-search-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { DEFAULT_DISPOSE_GRACE_MS } from '@deepseek-ai/dsh-subagent-codex/app-server'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import {
  CodexSearchProvider,
  type CodexSearchMode,
  type CodexSearchProviderOptions,
  validateCodexSearchEnvironment,
} from './provider.ts'

export {
  CODEX_PROVIDER_ID,
  CodexSearchProvider,
  codexSearchOutputSchema,
  codexSearchPrompt,
  mapCodexSearchResult,
} from './provider.ts'
export type {
  CodexSearchLlmRequest,
  CodexSearchMode,
  CodexSearchProviderOptions,
} from './provider.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'web-search-codex'

/** Capability seams required by this provider. */
export const inject = ['web', 'subprocess']

/** Deployment-owned local Codex process settings. */
export interface Config {
  /**
   * Explicit child-environment allowlist; defaults to `{}`. `CODEX_HOME`
   * selects the source `auth.json` without entering the child;
   * `OPENAI_BASE_URL`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and
   * `NO_PROXY` are forwarded. The provider removes every ambient entry and
   * supplies private child paths.
   */
  readonly env?: Record<string, string>
  /** Native Codex model used for hosted Web search; defaults to `gpt-5.5`. */
  readonly model?: string
  /** Whole-app-server process-tree termination grace; defaults to 3000 milliseconds. */
  readonly disposeGraceMs?: number
  /** Hosted-Web-search freshness mode; defaults to `live`. */
  readonly searchMode?: CodexSearchMode
}

export const Config: z<Config> = z.object({
  env: z.dict(z.string()).default({}),
  model: z.string().pattern(/\S/).default('gpt-5.5'),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  searchMode: z.union(['cached', 'indexed', 'live'] as const).default('live'),
})

type ResolvedConfig = Required<Config>

function validateConfig(config: ResolvedConfig): void {
  validateCodexSearchEnvironment(config.env)
  if (!Number.isFinite(config.disposeGraceMs) || config.disposeGraceMs <= 0) {
    throw new Error('web-search-codex: disposeGraceMs must be a positive finite number')
  }
  if (config.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `web-search-codex: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
}

/** Register the local Codex search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  validateConfig(resolved)
  const resolveOptions = (): CodexSearchProviderOptions => {
    const initiator = ctx.get('agents')?.currentInitiator()
    return {
      env: resolved.env,
      model: resolved.model.trim(),
      disposeGraceMs: resolved.disposeGraceMs,
      searchMode: resolved.searchMode,
      spawn: spec => ctx.subprocess.spawn(spec),
      recordRequest: (request) => {
        initiator?.session.append('web/codex-search-llm-request', request)
      },
    }
  }
  ctx.web.registerSearchProvider(new CodexSearchProvider(resolveOptions))
}
