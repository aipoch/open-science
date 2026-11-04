import { createHash } from 'node:crypto'
import { createLogger } from '@aipoch/diagnostics/node'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'

const log = createLogger('pi-permission-correlation')

// Experimental host-side seam. This module is not registered with a framework or the permission
// broker. Its caller must supply exclusively Main-owned session, capability and interaction facts.
// It binds one observed Pi tool_call to one later request_permission; it does not grant permission.
type PiPermissionState = Readonly<{
  appSessionId: string
  providerSessionId: string
  promptMessageId: string
  interactionSequence: number
  // A Main-owned identity of the immutable capability provision, replaced on re-provision.
  capabilityRevision: object
  mcpServerNames: readonly string[]
  // Exact identities of app-owned tools admitted by that provision, never provider supplied.
  allowedToolIdentities: ReadonlySet<string>
  cancelled: boolean
}>

type PiPermissionContext = PiPermissionState &
  Readonly<{
    // Read current Main-owned state, never an ACP-supplied snapshot. Return undefined if detached.
    readCurrent: () => PiPermissionState | undefined
  }>

type PiObservedCall = Readonly<{
  appSessionId: string
  providerSessionId: string
  promptMessageId: string
  interactionSequence: number
  capabilityRevision: object
  capabilityHash: string
  name: string
  identity: string
  inputHash: string
  state: 'waiting' | 'pending' | 'spent' | 'poisoned'
}>

type PiBoundCall = Readonly<{
  identity: string
  providerToolName: string
  rawInput: Readonly<Record<string, unknown>>
  // Must be checked again after asynchronous approval and immediately before releasing the reply.
  isCurrent: () => boolean
}>

type PiWaitReason =
  | 'invalid'
  | 'duplicate'
  | 'capacity'
  | 'timeout'
  | 'cancelled'
  | 'stale'
  | 'event_mismatch'
  | 'session_closed'

type PiWaitResult =
  | Readonly<{ status: 'bound'; call: PiBoundCall }>
  | Readonly<{ status: 'denied'; reason: PiWaitReason }>

type PiWaiter = Readonly<{
  finish: (outcome: 'ready' | PiWaitReason) => void
}>

const MAX_CALLS_PER_SESSION = 256
const MAX_WAITERS_PER_SESSION = 32
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_NESTING = 64
const DEFAULT_WAIT_MS = 2000
const MAX_WAIT_MS = 10000
const WAIT_POLL_MS = 25

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Inputs arrive over JSON-RPC. Reject values that cannot be represented without changing meaning,
// rather than treating a lossy serialization as evidence that two tool calls have equal inputs.
const canonicalJson = (value: unknown, depth = 0): string => {
  if (depth > MAX_NESTING) throw new Error('Input nesting limit exceeded')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`
  }
  if (!isRecord(value)) throw new Error('Input is not JSON')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Input is not JSON')
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`)
    .join(',')}}`
}

const inputEvidence = (
  value: unknown
): { hash: string; rawInput: Readonly<Record<string, unknown>> } | undefined => {
  if (!isRecord(value)) return undefined
  try {
    const json = canonicalJson(value)
    if (Buffer.byteLength(json, 'utf8') > MAX_INPUT_BYTES) return undefined
    const freeze = (item: unknown): unknown => {
      if (Array.isArray(item)) return Object.freeze(item.map(freeze))
      if (!isRecord(item)) return item
      for (const key of Object.keys(item)) item[key] = freeze(item[key])
      return Object.freeze(item)
    }
    const rawInput = freeze(JSON.parse(json)) as Readonly<Record<string, unknown>>
    return { hash: createHash('sha256').update(json).digest('hex'), rawInput }
  } catch {
    return undefined
  }
}

const validState = (state: PiPermissionState): boolean => {
  try {
    return Boolean(
      state.appSessionId &&
      state.providerSessionId &&
      state.promptMessageId &&
      state.capabilityRevision &&
      typeof state.capabilityRevision === 'object' &&
      Number.isSafeInteger(state.interactionSequence) &&
      state.interactionSequence >= 0 &&
      state.cancelled === false
    )
  } catch {
    return false
  }
}

const sameState = (left: PiPermissionState, right: PiPermissionState): boolean =>
  left.appSessionId === right.appSessionId &&
  left.providerSessionId === right.providerSessionId &&
  left.promptMessageId === right.promptMessageId &&
  left.interactionSequence === right.interactionSequence &&
  left.capabilityRevision === right.capabilityRevision

const readValidCurrent = (context: PiPermissionContext): PiPermissionState | undefined => {
  try {
    const current = context.readCurrent()
    return current && validState(current) && sameState(context, current) ? current : undefined
  } catch {
    return undefined
  }
}

const sameObservation = (seen: PiObservedCall, state: PiPermissionState): boolean =>
  seen.appSessionId === state.appSessionId &&
  seen.providerSessionId === state.providerSessionId &&
  seen.promptMessageId === state.promptMessageId &&
  seen.interactionSequence === state.interactionSequence &&
  seen.capabilityRevision === state.capabilityRevision

// Copy the complete app-owned inventories into a fingerprint so even in-place mutation of the
// Set/array while a decision is pending fails closed. This is separate from a provision identity.
const capabilityHash = (state: PiPermissionState): string | undefined => {
  try {
    const servers = [...state.mcpServerNames]
    const identities = [...state.allowedToolIdentities]
    if (
      servers.length > 256 ||
      identities.length > 4096 ||
      servers.some((name) => typeof name !== 'string') ||
      identities.some((name) => typeof name !== 'string')
    )
      return undefined
    const json = canonicalJson({ servers: servers.sort(), identities: identities.sort() })
    if (Buffer.byteLength(json, 'utf8') > MAX_INPUT_BYTES) return undefined
    return createHash('sha256').update(json).digest('hex')
  } catch {
    return undefined
  }
}

const identityFor = (name: string, context: PiPermissionState): string | undefined => {
  if (!name.startsWith('mcp__')) return undefined
  const identity = resolveCanonicalMcpToolIdentity(name, context.mcpServerNames)
  return identity && context.allowedToolIdentities.has(identity) ? identity : undefined
}

class PiPermissionCorrelation {
  private readonly sessions = new Map<string, Map<string, PiObservedCall>>()
  private readonly waiters = new Map<string, Map<string, PiWaiter>>()
  private readonly retiredProvisions = new WeakSet<object>()
  private readonly retiredTurns = new WeakMap<object, Set<string>>()
  private readonly quarantinedSessions = new Set<string>()

  private turnKey(state: PiPermissionState): string {
    return JSON.stringify([
      state.appSessionId,
      state.providerSessionId,
      state.promptMessageId,
      state.interactionSequence
    ])
  }

  private isLive(state: PiPermissionState): boolean {
    return (
      !this.quarantinedSessions.has(state.appSessionId) &&
      !this.retiredProvisions.has(state.capabilityRevision) &&
      !this.retiredTurns.get(state.capabilityRevision)?.has(this.turnKey(state))
    )
  }

  // Ending a prompt retires only that interaction, not the committed Session capability. Main may
  // still briefly expose the old prompt during finalization; its late events must remain denied.
  clearTurn(state: PiPermissionState): void {
    const retired = this.retiredTurns.get(state.capabilityRevision) ?? new Set<string>()
    retired.add(this.turnKey(state))
    this.retiredTurns.set(state.capabilityRevision, retired)
    const calls = this.sessions.get(state.appSessionId)
    for (const [toolCallId, call] of calls ?? []) {
      if (!sameObservation(call, state)) continue
      this.notifyWaiter(state.appSessionId, toolCallId, 'stale')
      calls!.delete(toolCallId)
    }
    if (calls?.size === 0) this.sessions.delete(state.appSessionId)
  }

  private poison(appSessionId: string, toolCallId: string): void {
    const calls = this.sessions.get(appSessionId)
    const seen = calls?.get(toolCallId)
    if (seen) calls!.set(toolCallId, { ...seen, state: 'poisoned' })
  }

  private notifyWaiter(
    appSessionId: string,
    toolCallId: string,
    outcome: 'ready' | PiWaitReason
  ): void {
    this.waiters.get(appSessionId)?.get(toolCallId)?.finish(outcome)
  }

  // This accepts the provider's top-level Pi `name` only on the Pi-specific path; no common ACP
  // name extraction or policy of the four existing frameworks changes.
  observe(
    notification: { sessionId: unknown; update: unknown },
    context: PiPermissionContext
  ): boolean {
    const current = readValidCurrent(context)
    if (!current || !this.isLive(current) || notification.sessionId !== current.providerSessionId)
      return false
    const update = notification.update
    if (
      isRecord(update) &&
      update.sessionUpdate === 'tool_call_update' &&
      typeof update.toolCallId === 'string'
    ) {
      return this.observeArguments(
        context.appSessionId,
        update.toolCallId,
        update.rawInput,
        current
      )
    }
    if (
      !isRecord(update) ||
      update.sessionUpdate !== 'tool_call' ||
      typeof update.toolCallId !== 'string' ||
      !update.toolCallId ||
      typeof update.name !== 'string'
    )
      return false
    if (
      isRecord(update._meta) &&
      isRecord(update._meta.pi) &&
      update._meta.pi.parentToolCallId !== undefined
    ) {
      this.poison(context.appSessionId, update.toolCallId)
      this.notifyWaiter(context.appSessionId, update.toolCallId, 'event_mismatch')
      return false
    }
    const seen = this.sessions.get(context.appSessionId) ?? new Map<string, PiObservedCall>()
    const previous = seen.get(update.toolCallId)
    if (previous) {
      if (previous.state === 'waiting') {
        const identity = identityFor(update.name, current)
        const evidence = inputEvidence(update.rawInput)
        if (
          sameObservation(previous, current) &&
          capabilityHash(current) === previous.capabilityHash &&
          update.name === previous.name &&
          identity === previous.identity
        ) {
          // Streamed calls announce partial arguments first; keep waiting for the matching update.
          if (evidence?.hash !== previous.inputHash) return true
          seen.set(update.toolCallId, { ...previous, state: 'pending' })
          this.notifyWaiter(context.appSessionId, update.toolCallId, 'ready')
          return true
        }
      }
      seen.set(update.toolCallId, { ...previous, state: 'poisoned' })
      this.notifyWaiter(context.appSessionId, update.toolCallId, 'event_mismatch')
      return false
    }
    if (seen.size >= MAX_CALLS_PER_SESSION) return false
    const identity = identityFor(update.name, current)
    const capabilities = capabilityHash(current)
    const evidence = inputEvidence(update.rawInput)
    if (!identity || !capabilities || !evidence) return false
    seen.set(update.toolCallId, {
      appSessionId: context.appSessionId,
      providerSessionId: context.providerSessionId,
      promptMessageId: context.promptMessageId,
      interactionSequence: context.interactionSequence,
      capabilityRevision: context.capabilityRevision,
      capabilityHash: capabilities,
      name: update.name,
      identity,
      inputHash: evidence.hash,
      state: 'pending'
    })
    this.sessions.set(context.appSessionId, seen)
    return true
  }

  // Pi streams tool arguments: tool_call carries the first partial input and later tool_call_update
  // events carry the growing input. Only an unbound call from the same turn may take new evidence.
  private observeArguments(
    appSessionId: string,
    toolCallId: string,
    rawInput: unknown,
    current: PiPermissionState
  ): boolean {
    const calls = this.sessions.get(appSessionId)
    const previous = calls?.get(toolCallId)
    const evidence = inputEvidence(rawInput)
    if (!previous || !evidence || !sameObservation(previous, current)) return false
    if (capabilityHash(current) !== previous.capabilityHash) return false
    if (previous.state === 'pending') {
      calls!.set(toolCallId, { ...previous, inputHash: evidence.hash })
      return true
    }
    if (previous.state === 'waiting' && evidence.hash === previous.inputHash) {
      calls!.set(toolCallId, { ...previous, state: 'pending' })
      this.notifyWaiter(appSessionId, toolCallId, 'ready')
      return true
    }
    return false
  }

  // Wait for a preceding Pi tool_call that may arrive after request_permission due to independent
  // ACP dispatch queues. A waiting record never grants authority. Only observe() may promote it.
  async waitFor(
    request: { sessionId: unknown; toolCall: unknown },
    context: PiPermissionContext,
    options: Readonly<{ timeoutMs?: number; signal?: AbortSignal }> = {}
  ): Promise<PiWaitResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_WAIT_MS) {
      return { status: 'denied', reason: 'invalid' }
    }
    const current = readValidCurrent(context)
    const call = request.toolCall
    if (
      !current ||
      !this.isLive(current) ||
      request.sessionId !== current.providerSessionId ||
      !isRecord(call) ||
      typeof call.toolCallId !== 'string' ||
      !call.toolCallId ||
      typeof call.name !== 'string'
    ) {
      log.warn('Pi permission request invalid', {
        currentStateValid: Boolean(current),
        stateLive: Boolean(current && this.isLive(current)),
        sessionMatches: Boolean(current && request.sessionId === current.providerSessionId),
        callRecord: isRecord(call),
        callIdValid: Boolean(
          isRecord(call) && typeof call.toolCallId === 'string' && call.toolCallId
        ),
        nameValid: Boolean(isRecord(call) && typeof call.name === 'string')
      })
      return { status: 'denied', reason: 'invalid' }
    }
    const toolCallId = call.toolCallId
    const identity = identityFor(call.name, current)
    const evidence = inputEvidence(call.rawInput)
    const capabilities = capabilityHash(current)
    if (!identity || !evidence || !capabilities) {
      log.warn('Pi permission evidence invalid', {
        identityRecognized: Boolean(identity),
        configuredIdentityResolved: Boolean(
          resolveCanonicalMcpToolIdentity(call.name, current.mcpServerNames)
        ),
        isSkillLoad: call.name === 'mcp__skills__load_skill',
        skillServerConfigured: current.mcpServerNames.includes('skills'),
        skillLoadOwned: current.allowedToolIdentities.has('skills/load_skill'),
        inputValid: Boolean(evidence),
        capabilityInventoryValid: Boolean(capabilities)
      })
      return { status: 'denied', reason: 'invalid' }
    }
    const calls = this.sessions.get(context.appSessionId) ?? new Map<string, PiObservedCall>()
    const waiters = this.waiters.get(context.appSessionId) ?? new Map<string, PiWaiter>()
    // Retain the original waiter's ownership until it actually consumes the observed event. The
    // event notification can resolve its promise before that continuation gets a turn to run.
    if (waiters.has(toolCallId)) return { status: 'denied', reason: 'duplicate' }
    const previous = calls.get(toolCallId)
    if (previous) {
      if (previous.state !== 'pending') return { status: 'denied', reason: 'duplicate' }
      if (options.signal?.aborted) {
        calls.set(toolCallId, { ...previous, state: 'poisoned' })
        return { status: 'denied', reason: 'cancelled' }
      }
      const bound = this.take(request, context)
      return bound
        ? { status: 'bound', call: this.bindSignal(bound, options.signal) }
        : { status: 'denied', reason: 'event_mismatch' }
    }
    if (calls.size >= MAX_CALLS_PER_SESSION || waiters.size >= MAX_WAITERS_PER_SESSION) {
      return { status: 'denied', reason: 'capacity' }
    }

    const waiting: PiObservedCall = {
      appSessionId: context.appSessionId,
      providerSessionId: context.providerSessionId,
      promptMessageId: context.promptMessageId,
      interactionSequence: context.interactionSequence,
      capabilityRevision: context.capabilityRevision,
      capabilityHash: capabilities,
      name: call.name,
      identity,
      inputHash: evidence.hash,
      state: 'waiting'
    }
    calls.set(toolCallId, waiting)
    this.sessions.set(context.appSessionId, calls)
    let owner: PiWaiter | undefined
    const releaseWaiter = (): void => {
      if (owner && waiters.get(toolCallId) === owner) waiters.delete(toolCallId)
      if (waiters.size === 0 && this.waiters.get(context.appSessionId) === waiters) {
        this.waiters.delete(context.appSessionId)
      }
    }
    const outcome = await new Promise<'ready' | PiWaitReason>((resolve) => {
      let finished = false
      const finish = (value: 'ready' | PiWaitReason): void => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        clearInterval(poll)
        options.signal?.removeEventListener('abort', abort)
        if (value !== 'ready') {
          releaseWaiter()
          if (this.sessions.get(context.appSessionId) === calls) {
            this.poison(context.appSessionId, toolCallId)
          }
        }
        resolve(value)
      }
      const abort = (): void => finish('cancelled')
      const timeout = setTimeout(() => finish('timeout'), timeoutMs)
      const poll = setInterval(() => {
        const latest = readValidCurrent(context)
        const liveCall = this.sessions.get(context.appSessionId)?.get(toolCallId)
        const latestTool = request.toolCall
        if (
          !latest ||
          !this.isLive(latest) ||
          !sameObservation(waiting, latest) ||
          capabilityHash(latest) !== waiting.capabilityHash ||
          identityFor(waiting.name, latest) !== waiting.identity ||
          this.sessions.get(context.appSessionId) !== calls ||
          liveCall !== waiting ||
          request.sessionId !== latest.providerSessionId ||
          !isRecord(latestTool) ||
          latestTool.toolCallId !== toolCallId ||
          latestTool.name !== waiting.name ||
          inputEvidence(latestTool.rawInput)?.hash !== waiting.inputHash
        )
          finish('stale')
      }, WAIT_POLL_MS)
      owner = { finish }
      waiters.set(toolCallId, owner)
      this.waiters.set(context.appSessionId, waiters)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) finish('cancelled')
    })
    try {
      if (outcome !== 'ready') return { status: 'denied', reason: outcome }
      if (options.signal?.aborted) {
        if (this.sessions.get(context.appSessionId) === calls) {
          this.poison(context.appSessionId, toolCallId)
        }
        return { status: 'denied', reason: 'cancelled' }
      }
      if (!owner) return { status: 'denied', reason: 'stale' }
      const bound = this.takeOwned(request, context, owner)
      return bound
        ? { status: 'bound', call: this.bindSignal(bound, options.signal) }
        : { status: 'denied', reason: 'stale' }
    } finally {
      releaseWaiter()
    }
  }

  private bindSignal(call: PiBoundCall, signal: AbortSignal | undefined): PiBoundCall {
    return { ...call, isCurrent: () => !signal?.aborted && call.isCurrent() }
  }

  // A successful bind is one-shot. Denial, cancellation, a mismatch or a duplicate may never be
  // replayed as a later approval. Main still owns the actual approval decision and cancellation.
  take(
    request: { sessionId: unknown; toolCall: unknown },
    context: PiPermissionContext
  ): PiBoundCall | undefined {
    return this.takeOwned(request, context)
  }

  private takeOwned(
    request: { sessionId: unknown; toolCall: unknown },
    context: PiPermissionContext,
    owner?: PiWaiter
  ): PiBoundCall | undefined {
    if (!isRecord(request.toolCall) || typeof request.toolCall.toolCallId !== 'string')
      return undefined
    const seenCallId = request.toolCall.toolCallId
    const calls = this.sessions.get(context.appSessionId)
    const seen = calls?.get(seenCallId)
    if (!seen || seen.state !== 'pending' || !sameObservation(seen, context)) return undefined
    const activeWaiter = this.waiters.get(context.appSessionId)?.get(seenCallId)
    if (activeWaiter && activeWaiter !== owner) return undefined
    calls!.set(seenCallId, { ...seen, state: 'spent' })
    const current = readValidCurrent(context)
    if (
      !current ||
      !this.isLive(current) ||
      request.sessionId !== current.providerSessionId ||
      !sameObservation(seen, current) ||
      capabilityHash(current) !== seen.capabilityHash ||
      request.toolCall.name !== seen.name ||
      identityFor(seen.name, current) !== seen.identity
    )
      return undefined
    const evidence = inputEvidence(request.toolCall.rawInput)
    if (!evidence || evidence.hash !== seen.inputHash) return undefined

    let invalidated = false
    return {
      identity: seen.identity,
      providerToolName: seen.name,
      rawInput: evidence.rawInput,
      isCurrent: () => {
        if (invalidated) return false
        const current = readValidCurrent(context)
        const stillCurrent = Boolean(
          current &&
          this.isLive(current) &&
          sameObservation(seen, current) &&
          this.sessions.get(context.appSessionId) === calls &&
          calls?.get(seenCallId)?.state === 'spent' &&
          capabilityHash(current) === seen.capabilityHash &&
          identityFor(seen.name, current) === seen.identity &&
          request.sessionId === current.providerSessionId &&
          isRecord(request.toolCall) &&
          request.toolCall.toolCallId === seenCallId &&
          request.toolCall.name === seen.name &&
          inputEvidence(request.toolCall.rawInput)?.hash === seen.inputHash
        )
        if (!stillCurrent) invalidated = true
        return stillCurrent
      }
    }
  }

  // Capture the committed revision before SessionCapabilityOwner.revokeSession removes it. A late
  // ACP event must not become valid again merely because Main is still observing that old revision.
  // A fresh provision has a different descriptor identity and can start a new correlation. If the
  // caller lost the old revision, quarantine the app Session instead of guessing that it is new.
  clearSession(appSessionId: string, capabilityRevision: object | undefined): void {
    if (capabilityRevision && typeof capabilityRevision === 'object') {
      this.retiredProvisions.add(capabilityRevision)
    } else {
      this.quarantinedSessions.add(appSessionId)
    }
    for (const call of this.sessions.get(appSessionId)?.values() ?? []) {
      this.retiredProvisions.add(call.capabilityRevision)
    }
    for (const waiter of [...(this.waiters.get(appSessionId)?.values() ?? [])]) {
      waiter.finish('session_closed')
    }
    this.waiters.delete(appSessionId)
    this.sessions.delete(appSessionId)
  }
}

export { PiPermissionCorrelation }
export type { PiBoundCall, PiPermissionContext, PiPermissionState, PiWaitResult }
