/**
 * Narrow reusable surface for one private Codex app-server process. Product
 * adapters may configure one ephemeral thread/turn, observe authoritative
 * hosted-search items, and then return process-tree ownership to the shared
 * subprocess seam.
 *
 * @module @deepseek-ai/dsh-subagent-codex/app-server
 */

export {
  CodexAppServerWire,
  type CodexInitializeOptions,
  type CodexThreadOptions,
  type CodexTurnOptions,
  type CodexWebSearchItem,
} from './wire.ts'
export {
  codexAppServerArgv,
  DEFAULT_DISPOSE_GRACE_MS,
  disposeCodexChild,
} from './run.ts'
