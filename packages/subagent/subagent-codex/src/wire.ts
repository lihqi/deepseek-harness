/**
 * Minimal Codex app-server 0.149.1 protocol adapter. The shared JSON-RPC
 * transport owns framing and request correlation; this module owns only the
 * product methods, current thread/turn association, unattended approval
 * responses, and terminal-answer selection.
 *
 * @module @deepseek-ai/dsh-subagent-codex/wire
 */

import type { Readable, Writable } from 'node:stream'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { CodexPermissionMode } from './run.ts'

type JsonObject = Record<string, unknown>

/** Product facts owned by the Codex wire after publication. */
export interface CodexWireFailureFacts {
  readonly stage: 'turn-start' | 'turn'
  readonly category:
    | 'limit'
    | 'access-policy'
    | 'service'
    | 'transport'
    | 'product-error'
    | 'invalid-result'
    | 'unknown'
  readonly httpStatus?: number | undefined
}

/** Optional config and narrower permission fields for one ephemeral Codex thread. */
export interface CodexThreadOptions {
  /** Session-scoped Codex config overrides. */
  readonly config?: Readonly<Record<string, unknown>>
  /** Additional developer instructions for this private thread. */
  readonly developerInstructions?: string
  /** Unattended approval request; the constructor permission mode remains authoritative. */
  readonly approvalPolicy?: 'never'
  /** Read-only sandbox request; the constructor permission mode remains authoritative. */
  readonly sandbox?: 'read-only'
  /** Explicitly disable every execution environment for this thread. */
  readonly environments?: readonly []
  /** Reject instruction files loaded by the product for this private thread. */
  readonly requireNoInstructionSources?: true
}

/** Optional capabilities declared during the app-server handshake. */
export interface CodexInitializeOptions {
  /** Opt into app-server fields marked experimental by Codex 0.149.1. */
  readonly experimentalApi?: true
}

/** Optional controls for the single turn owned by this wire. */
export interface CodexTurnOptions {
  /** JSON Schema constraining the final agent message. */
  readonly outputSchema?: unknown
  /** Unattended approval policy; integrations use `never`. */
  readonly approvalPolicy?: 'never'
  /** Exact app-server sandbox policy for the turn. */
  readonly sandboxPolicy?: {
    readonly type: 'readOnly'
    readonly networkAccess: false
  }
}

/** One authoritative completed hosted-Web-search item observed in the turn. */
export interface CodexWebSearchItem {
  readonly query: string
  readonly action?: Readonly<Record<string, unknown>>
  readonly results?: readonly unknown[]
}

const THREAD_PERMISSION_PARAMS: Readonly<Record<CodexPermissionMode, JsonObject>> = {
  never: { approvalPolicy: 'never' },
  'approve-for-me': {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  },
  'dangerously-bypass-approvals-and-sandbox': {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  },
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`subagent-codex: app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`subagent-codex: app-server returned invalid ${label}`)
  }
  return value
}

function unattendedDecision(params: JsonObject): 'cancel' | 'decline' {
  const available = params.availableDecisions
  if (available === undefined || available === null) return 'decline'
  if (Array.isArray(available)) {
    if (available.includes('cancel')) return 'cancel'
    if (available.includes('decline')) return 'decline'
  }
  throw new Error('subagent-codex: app-server offered no unattended approval decision')
}

function numericHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 65_535
    ? value
    : undefined
}

interface ParsedFailureInfo {
  readonly category: CodexWireFailureFacts['category']
  readonly httpStatus?: number | undefined
  readonly maxTokens?: true
  readonly sandboxFailure?: true
}

function objectFailureInfo(value: JsonObject): ParsedFailureInfo {
  const keys = Object.keys(value)
  const category = keys[0]
  if (keys.length !== 1 || category === undefined) {
    return { category: 'unknown' }
  }
  const detail = value[category]
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    return { category: 'unknown' }
  }
  const fields = detail as JsonObject
  switch (category) {
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
    {
      const httpStatus = numericHttpStatus(fields.httpStatusCode)
      return httpStatus === undefined
        ? { category: 'transport' }
        : { category: 'transport', httpStatus }
    }
    case 'activeTurnNotSteerable':
      return { category: 'product-error' }
    default:
      return { category: 'unknown' }
  }
}

function failureInfo(turn: JsonObject): ParsedFailureInfo {
  if (turn.status !== 'failed') return { category: 'unknown' }
  const error = turn.error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) {
    return { category: 'unknown' }
  }
  const info = (error as JsonObject).codexErrorInfo
  if (typeof info === 'string') {
    switch (info) {
      case 'contextWindowExceeded':
        return { category: 'limit', maxTokens: true }
      case 'sessionBudgetExceeded':
      case 'usageLimitExceeded':
        return { category: 'limit' }
      case 'serverOverloaded':
      case 'internalServerError':
        return { category: 'service' }
      case 'cyberPolicy':
      case 'misalignmentPolicyViolation':
      case 'unauthorized':
        return { category: 'access-policy' }
      case 'badRequest':
      case 'threadRollbackFailed':
      case 'other':
        return { category: 'product-error' }
      case 'sandboxError':
        return { category: 'access-policy', sandboxFailure: true }
      default:
        return { category: 'unknown' }
    }
  }
  return info !== null && typeof info === 'object' && !Array.isArray(info)
    ? objectFailureInfo(info as JsonObject)
    : { category: 'unknown' }
}

function unattendedDiagnostic(
  mode: CodexPermissionMode,
  request: 'command approval' | 'file approval' | 'permission grant' | 'user input' | 'MCP elicitation' | 'command execution' | 'file change' | 'sandbox execution',
  decision: 'cancelled' | 'declined' | 'denied' | 'empty response' | 'failed',
  reason: string,
): string {
  return `Codex unattended decision (mode: ${mode}; request: ${request}; decision: ${decision}): ${reason}`
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`subagent-codex: app-server request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One app-server connection and its single ephemeral thread/turn.
 *
 * The class deliberately exposes no generic request surface. Supporting
 * another product method must first become part of the provider contract.
 */
export class CodexAppServerWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private threadId: string | undefined
  private turnId: string | undefined
  private pendingTurnId: string | undefined
  private turnCompleted: PromiseWithResolvers<{
    readonly params: JsonObject
    readonly order: number
  }> | undefined
  private readonly earlyTurnNotifications: Array<{
    readonly method: string
    readonly params: JsonObject
    readonly order: number
  }> = []
  private lastFinalAnswer: string | undefined
  private lastUnphasedAnswer: string | undefined
  private readonly webSearches: CodexWebSearchItem[] = []
  private diagnostic: string | undefined
  private failure: CodexWireFailureFacts | undefined
  private diagnosticOrder = 0
  private observationOrder = 0
  private pendingDiagnostic: {
    readonly order: number
    readonly request: Parameters<typeof unattendedDiagnostic>[1]
    readonly decision: Parameters<typeof unattendedDiagnostic>[2]
    readonly reason: string
  } | undefined
  private inputEnded = false
  private terminalObserved = false
  private closed = false

  constructor(
    private readonly input: Readable,
    output: Writable,
    private readonly permissionMode: CodexPermissionMode,
    private readonly model?: string,
  ) {
    this.transport = new JsonRpcLineTransport(input, output)
    // Fatal protocol state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleServerRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.fail(thrown(error))
      }
    })
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    // Pipe errors can race protocol closure and process teardown. Retain both
    // error listeners for the lifetime of their per-run streams so no late
    // EPIPE or read failure becomes an unhandled EventEmitter error.
    output.on('error', this.onOutputError)
  }

  /** Start reading app-server frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Whether protocol output ended before a terminal turn notification.
   * @returns `true` only for an early protocol close without a terminal turn.
   */
  endedBeforeTerminal(): boolean {
    return this.inputEnded && !this.terminalObserved
  }

  /**
   * Perform the required app-server initialize/initialized handshake.
   * @param signal - unpublished-start cancellation.
   * @param options - optional initialization capabilities for this client.
   */
  async initialize(
    signal: AbortSignal,
    options: CodexInitializeOptions = {},
  ): Promise<void> {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: options.experimentalApi === true,
        requestAttestation: false,
      },
    }, signal), signal), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
  }

  /**
   * Check whether any global MCP server is configured before publishing a query.
   * @param signal - unpublished-start cancellation.
   * @returns `true` when Codex reports at least one configured MCP server.
   */
  async hasMcpServers(signal: AbortSignal): Promise<boolean> {
    const response = object(await this.guarded(this.transport.request('mcpServerStatus/list', {
      limit: 1,
      detail: 'toolsAndAuthOnly',
    }, signal), signal), 'mcpServerStatus/list response')
    if (!Array.isArray(response.data)) {
      throw new Error('subagent-codex: app-server returned invalid mcpServerStatus/list data')
    }
    if (
      response.nextCursor !== undefined
      && response.nextCursor !== null
      && typeof response.nextCursor !== 'string'
    ) {
      throw new Error('subagent-codex: app-server returned invalid mcpServerStatus/list cursor')
    }
    return response.data.length > 0 || typeof response.nextCursor === 'string'
  }

  /**
   * Check whether managed requirements can override private search settings.
   * @param signal - unpublished-start cancellation.
   * @returns `true` when Codex reports any managed requirements.
   */
  async hasConfigRequirements(signal: AbortSignal): Promise<boolean> {
    const response = object(await this.guarded(this.transport.request(
      'configRequirements/read',
      undefined,
      signal,
    ), signal), 'configRequirements/read response')
    if (response.requirements === null) return false
    if (
      response.requirements === undefined
      || typeof response.requirements !== 'object'
      || Array.isArray(response.requirements)
    ) {
      throw new Error('subagent-codex: app-server returned invalid config requirements')
    }
    return true
  }

  /**
   * Check whether the isolated workspace exposes any skill or skill-load error.
   * @param cwd - isolated working directory scanned by Codex.
   * @param signal - unpublished-start cancellation.
   * @returns `true` when Codex reports a skill or load error.
   */
  async hasSkills(cwd: string, signal: AbortSignal): Promise<boolean> {
    const response = object(await this.guarded(this.transport.request('skills/list', {
      cwds: [cwd],
      forceReload: true,
    }, signal), signal), 'skills/list response')
    if (!Array.isArray(response.data) || response.data.length !== 1) {
      throw new Error('subagent-codex: app-server returned invalid skills/list data')
    }
    const entry = object(response.data[0], 'skills/list entry')
    if (!Array.isArray(entry.skills) || !Array.isArray(entry.errors)) {
      throw new Error('subagent-codex: app-server returned invalid skills/list entry')
    }
    return entry.skills.length > 0 || entry.errors.length > 0
  }

  /**
   * Check whether config outside the pinned package, empty system/user
   * sentinels, or one command-line session layer can affect an unpublished
   * search thread.
   * @param cwd - isolated working directory used to resolve project layers.
   * @param userConfigPath - sole private user config path accepted by the caller.
   * @param signal - unpublished-start cancellation.
   * @returns `true` when Codex reports a nonempty external, duplicate session,
   * managed, project, or unknown layer.
   */
  async hasUnsafeConfigLayers(
    cwd: string,
    userConfigPath: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const response = object(await this.guarded(this.transport.request('config/read', {
      includeLayers: true,
      cwd,
    }, signal), signal), 'config/read response')
    if (!Array.isArray(response.layers)) {
      throw new Error('subagent-codex: app-server omitted config/read layers')
    }
    let sessionFlagsSeen = false
    for (const [index, value] of response.layers.entries()) {
      const layer = object(value, `config/read layers[${String(index)}]`)
      const name = object(layer.name, `config/read layers[${String(index)}] name`)
      const config = object(layer.config, `config/read layers[${String(index)}] config`)
      if (
        layer.disabledReason !== undefined
        && layer.disabledReason !== null
        && typeof layer.disabledReason !== 'string'
      ) {
        throw new Error(
          `subagent-codex: app-server returned invalid config/read layers[${String(index)}] disabled reason`,
        )
      }
      if (name.type === 'packagedDefaults') continue
      if (name.type === 'sessionFlags') {
        if (sessionFlagsSeen || Object.keys(config).length === 0) return true
        sessionFlagsSeen = true
        continue
      }
      if (
        name.type === 'user'
        && name.file === userConfigPath
        && (name.profile === undefined || name.profile === null)
        && Object.keys(config).length === 0
      ) continue
      if (name.type === 'system' && Object.keys(config).length === 0) continue
      return true
    }
    return !sessionFlagsSeen
  }

  /**
   * Create the run's private ephemeral thread and retain its identity.
   * @param cwd - working directory for the private thread.
   * @param signal - unpublished-start cancellation.
   * @param options - optional config and permission-narrowing integration fields.
   */
  async startThread(
    cwd: string,
    signal: AbortSignal,
    options: CodexThreadOptions = {},
  ): Promise<void> {
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd,
      ephemeral: true,
      ...this.model === undefined ? {} : { model: this.model },
      ...options.config !== undefined ? { config: options.config } : {},
      ...options.developerInstructions !== undefined
        ? { developerInstructions: options.developerInstructions }
        : {},
      ...options.approvalPolicy !== undefined
        ? { approvalPolicy: options.approvalPolicy }
        : {},
      ...options.sandbox !== undefined ? { sandbox: options.sandbox } : {},
      ...options.environments !== undefined ? { environments: options.environments } : {},
      ...THREAD_PERMISSION_PARAMS[this.permissionMode],
    }, signal), signal), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    const id = string(thread.id, 'thread/start thread id')
    if (thread.ephemeral !== true) {
      throw new Error('subagent-codex: app-server did not create an ephemeral thread')
    }
    if (options.requireNoInstructionSources === true) {
      if (!Array.isArray(response.instructionSources)) {
        throw new Error('subagent-codex: app-server omitted thread instruction sources')
      }
      if (response.instructionSources.length > 0) {
        throw new Error('subagent-codex: app-server loaded thread instruction sources')
      }
    }
    this.threadId = id
  }

  /**
   * Submit the one text-only task and wait for this thread/turn's authoritative
   * terminal notification.
   * @param texts - already validated task text blocks.
   * @param signal - local cancellation for the published run.
   * @param options - optional output schema and unattended turn policy.
   * @returns the shared subagent result.
   */
  async runTurn(
    texts: readonly string[],
    signal: AbortSignal,
    options: CodexTurnOptions = {},
  ): Promise<SubagentResult> {
    const completion = Promise.withResolvers<{
      readonly params: JsonObject
      readonly order: number
    }>()
    this.turnCompleted = completion
    const threadId = this.threadId as string
    try {
      const response = object(await this.guarded(this.transport.request('turn/start', {
        threadId,
        input: texts.map(text => ({ type: 'text', text, text_elements: [] })),
        ...options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {},
        ...options.approvalPolicy !== undefined
          ? { approvalPolicy: options.approvalPolicy }
          : {},
        ...options.sandboxPolicy !== undefined
          ? { sandboxPolicy: options.sandboxPolicy }
          : {},
      }, signal), signal), 'turn/start response')
      const turn = object(response.turn, 'turn/start turn')
      this.commitTurnId(string(turn.id, 'turn/start turn id'))
    } catch (error: unknown) {
      this.recordFailure({ stage: 'turn-start', category: 'unknown' })
      throw error
    }

    let completed: {
      readonly params: JsonObject
      readonly order: number
    }
    let terminal: JsonObject
    try {
      completed = await this.guarded(completion.promise, signal)
      terminal = object(completed.params.turn, 'turn/completed turn')
    } catch (error: unknown) {
      this.recordFailure({ stage: 'turn', category: 'unknown' })
      throw error
    }
    const status = terminal.status
    if (status !== 'completed') {
      const parsed = failureInfo(terminal)
      this.recordFailure(parsed.httpStatus === undefined
        ? { stage: 'turn', category: parsed.category }
        : {
          stage: 'turn',
          category: parsed.category,
          httpStatus: parsed.httpStatus,
        })
      if (parsed.sandboxFailure) {
        this.recordDiagnostic(
          'sandbox execution',
          'failed',
          'Codex reported a sandbox failure',
          completed.order,
        )
      }
      if (parsed.maxTokens) {
        return { output: this.collectOutput(), stopReason: 'max-tokens' }
      }
      const detail = status === 'failed' ? `: ${parsed.category}` : ''
      throw new Error(`subagent-codex: Codex turn ended with status ${String(status)}${detail}`)
    }
    const output = this.collectOutput()
    if (output.length === 0) {
      this.recordFailure({ stage: 'turn', category: 'invalid-result' })
      throw new Error('subagent-codex: Codex completed without a final answer')
    }
    return { output, stopReason: 'completed' }
  }

  /**
   * Best-effort remote cancellation. Local settlement and process teardown
   * remain authoritative when the child no longer accepts protocol requests.
   */
  interrupt(): void {
    if (this.threadId === undefined || this.turnId === undefined || this.closed) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    }).catch(() => {})
  }

  /**
   * The best non-commentary answer observed so far, preserving exact bytes.
   * @returns the selected final or nullable-phase text block, if any.
   */
  collectOutput(): ContentBlock[] {
    const selected = this.lastFinalAnswer ?? this.lastUnphasedAnswer
    return selected !== undefined && selected.trim().length > 0
      ? [{ type: 'text', text: selected }]
      : []
  }

  /**
   * The latest safe unattended permission fact observed for this run.
   * @returns provider-authored diagnostic text, when one was observed.
   */
  collectDiagnostic(): string | undefined {
    return this.diagnostic
  }

  /**
   * The structured failure fact observed for this published turn.
   * Call only after a non-completed return or rejection from {@link runTurn}.
   * @returns the fixed stage/category pair and optional HTTP status.
   */
  collectFailure(): CodexWireFailureFacts {
    return this.failure as CodexWireFailureFacts
  }

  /**
   * Completed hosted-Web-search items observed for the active turn.
   * @returns a detached snapshot in observation order.
   */
  collectWebSearches(): readonly CodexWebSearchItem[] {
    return structuredClone(this.webSearches)
  }

  /** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    const withFatal = Promise.race([this.fatal.promise, pending])
    return raceAbort(withFatal, signal)
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.inputEnded = true
    this.fail(new Error('subagent-codex: app-server protocol stream closed'))
  }

  private observePendingTurnId(id: string): void {
    if (this.turnCompleted === undefined) {
      throw new Error('subagent-codex: app-server referenced a turn before turn/start')
    }
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('subagent-codex: app-server referenced conflicting turns')
    }
    this.pendingTurnId = id
  }

  private commitTurnId(id: string): void {
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('subagent-codex: turn/start response did not match the active turn')
    }
    this.turnId = id
    const pendingDiagnostic = this.pendingDiagnostic
    this.pendingDiagnostic = undefined
    if (pendingDiagnostic !== undefined) {
      this.recordDiagnostic(
        pendingDiagnostic.request,
        pendingDiagnostic.decision,
        pendingDiagnostic.reason,
        pendingDiagnostic.order,
      )
    }
    const notifications = this.earlyTurnNotifications.splice(0)
    for (const notification of notifications) {
      this.handleNotification(
        notification.method,
        notification.params,
        notification.order,
      )
    }
  }

  /**
   * Validate the request's thread and turn association.
   * @returns `true` when the matching turn is still provisional, so the caller
   * defers its diagnostic until `commitTurnId()`.
   */
  private validateRunIds(
    params: JsonObject,
    nullableTurn = false,
  ): boolean {
    if (params.threadId !== this.threadId) {
      throw new Error('subagent-codex: app-server request referenced another thread')
    }
    if (nullableTurn && params.turnId === null) return false
    const id = string(params.turnId, 'server request turn id')
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      return true
    }
    if (id !== this.turnId) {
      throw new Error('subagent-codex: app-server request referenced another turn')
    }
    return false
  }

  private recordRequestDiagnostic(
    provisional: boolean,
    request: Parameters<typeof unattendedDiagnostic>[1],
    decision: Parameters<typeof unattendedDiagnostic>[2],
    reason: string,
  ): void {
    const order = this.nextObservationOrder()
    if (provisional) {
      this.pendingDiagnostic = {
        order,
        request,
        decision,
        reason,
      }
      return
    }
    this.recordDiagnostic(request, decision, reason, order)
  }

  private recordDiagnostic(
    request: Parameters<typeof unattendedDiagnostic>[1],
    decision: Parameters<typeof unattendedDiagnostic>[2],
    reason: string,
    order = this.nextObservationOrder(),
  ): void {
    if (order < this.diagnosticOrder) return
    this.diagnosticOrder = order
    this.diagnostic = unattendedDiagnostic(
      this.permissionMode,
      request,
      decision,
      reason,
    )
  }

  private recordFailure(facts: CodexWireFailureFacts): void {
    this.failure = facts
  }

  private nextObservationOrder(): number {
    this.observationOrder += 1
    return this.observationOrder
  }

  private recordDeclinedItem(item: JsonObject, order?: number): boolean {
    if (item.type === 'commandExecution' && item.status === 'declined') {
      this.recordDiagnostic(
        'command execution',
        'declined',
        'Codex declined the command under the selected permission mode',
        order,
      )
      return true
    }
    if (item.type === 'fileChange' && item.status === 'declined') {
      this.recordDiagnostic(
        'file change',
        'declined',
        'Codex declined the file change under the selected permission mode',
        order,
      )
      return true
    }
    return false
  }

  private handleServerRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
        {
          const provisional = this.validateRunIds(params)
          const decision = unattendedDecision(params)
          this.recordRequestDiagnostic(
            provisional,
            'command approval',
            decision === 'cancel' ? 'cancelled' : 'declined',
            'the provider does not grant interactive approval',
          )
          return Promise.resolve({ decision })
        }
        case 'item/fileChange/requestApproval':
        {
          const provisional = this.validateRunIds(params)
          const decision = unattendedDecision(params)
          this.recordRequestDiagnostic(
            provisional,
            'file approval',
            decision === 'cancel' ? 'cancelled' : 'declined',
            'the provider does not grant interactive approval',
          )
          return Promise.resolve({ decision })
        }
        case 'item/permissions/requestApproval':
          this.recordRequestDiagnostic(
            this.validateRunIds(params),
            'permission grant',
            'denied',
            'the provider grants no additional turn permissions',
          )
          return Promise.resolve({ permissions: {}, scope: 'turn' })
        case 'item/tool/requestUserInput':
          this.recordRequestDiagnostic(
            this.validateRunIds(params),
            'user input',
            'empty response',
            'the provider does not collect interactive answers',
          )
          return Promise.resolve({ answers: {} })
        case 'mcpServer/elicitation/request':
          this.recordRequestDiagnostic(
            this.validateRunIds(params, true),
            'MCP elicitation',
            'declined',
            'the provider does not collect interactive MCP input',
          )
          return Promise.resolve({ action: 'decline', content: null, _meta: null })
        default:
          throw new Error(`subagent-codex: unsupported app-server request ${JSON.stringify(method)}`)
      }
    } catch (error: unknown) {
      const normalized = thrown(error)
      this.fail(normalized)
      return Promise.reject(normalized)
    }
  }

  private handleNotification(
    method: string,
    params: JsonObject,
    order?: number,
  ): void {
    if (method === 'turn/started') {
      const threadId = string(params.threadId, 'turn/started thread id')
      if (threadId !== this.threadId) return
      const turn = object(params.turn, 'turn/started turn')
      if (this.turnCompleted !== undefined && this.turnId === undefined) {
        this.observePendingTurnId(string(turn.id, 'turn/started turn id'))
      }
      return
    }
    if (method === 'item/completed') {
      const threadId = string(params.threadId, 'item/completed thread id')
      if (threadId !== this.threadId) return
      const id = string(params.turnId, 'item/completed turn id')
      if (this.turnId === undefined) {
        if (this.turnCompleted !== undefined) {
          this.observePendingTurnId(id)
          this.earlyTurnNotifications.push({
            method,
            params,
            order: this.nextObservationOrder(),
          })
        }
        return
      }
      if (id !== this.turnId) return
      const item = object(params.item, 'item/completed item')
      if (this.recordDeclinedItem(item, order)) return
      if (item.type === 'webSearch') {
        const query = typeof item.query === 'string'
          ? item.query
          : (() => { throw new Error('subagent-codex: app-server returned invalid webSearch query') })()
        const action = item.action === null || item.action === undefined
          ? undefined
          : object(item.action, 'webSearch action')
        const results = item.results === null || item.results === undefined
          ? undefined
          : Array.isArray(item.results)
            ? item.results
            : (() => { throw new Error('subagent-codex: app-server returned invalid webSearch results') })()
        this.webSearches.push({
          query,
          ...action !== undefined ? { action } : {},
          ...results !== undefined ? { results } : {},
        })
        return
      }
      if (item.type !== 'agentMessage') return
      const text = typeof item.text === 'string'
        ? item.text
        : (() => { throw new Error('subagent-codex: app-server returned an invalid agent message') })()
      if (item.phase === 'final_answer') {
        this.lastFinalAnswer = text
      } else if (item.phase === null) {
        this.lastUnphasedAnswer = text
      } else if (item.phase !== 'commentary') {
        throw new Error(`subagent-codex: app-server returned an unknown agent message phase ${JSON.stringify(item.phase)}`)
      }
      return
    }
    if (method !== 'turn/completed') return
    const threadId = string(params.threadId, 'turn/completed thread id')
    if (threadId !== this.threadId) return
    const turn = object(params.turn, 'turn/completed turn')
    const id = string(turn.id, 'turn/completed turn id')
    const turnCompleted = this.turnCompleted
    if (turnCompleted === undefined) return
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      this.earlyTurnNotifications.push({
        method,
        params,
        order: this.nextObservationOrder(),
      })
      return
    }
    if (id !== this.turnId) return
    this.terminalObserved = true
    if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) {
      throw new Error(`subagent-codex: app-server returned invalid terminal turn status ${String(turn.status)}`)
    }
    turnCompleted.resolve({
      params,
      order: order ?? this.nextObservationOrder(),
    })
  }
}
