/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-web-search-codex`.
 * @module @deepseek-ai/dsh-web-search-codex/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-search-codex'

/** Cordis companion plugin name. */
export const name = 'web-search-codex-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: provider protocol tests own this single-operation boundary. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
