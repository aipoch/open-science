import type { AcpPermissionRequest, AcpPromptRequest, AcpRuntimeEvent } from '../../shared/acp'
import { ACP_PROMPT_FAILED_EVENT_TITLE } from '../../shared/acp'
import type { OpenSessionFromNotificationRequest } from '../../shared/notifications'
import type { ConnectorApprovalRequest } from '../../shared/settings'

// What the user sees when a task reaches a terminal state while the app is unfocused.
export type TaskNotification = {
  title: string
  body: string
}

export type TaskNotificationRequest = TaskNotification & {
  // Fires when the user clicks the notification (where the OS/desktop supports it).
  onClick: () => void
}

export type TaskNotificationServiceDeps = {
  // Fresh settings read, so the Settings toggle applies without a restart.
  isEnabled: () => Promise<boolean>
  // Notifications only make sense when the user has switched away; a focused app needs none.
  isAppFocused: () => boolean
  // OS-specific delivery (Electron Notification in production, a spy in tests).
  show: (request: TaskNotificationRequest) => void
  // Delivery failures are swallowed (the event stream must never be disturbed) but reported here
  // so they still reach the log file in production.
  onDeliveryError?: (error: unknown) => void
}

// Notification bodies are single-line and get truncated hard on some platforms (Windows toasts
// clip around 200 chars), so the task name and error text are kept short.
const MAX_SNIPPET_LENGTH = 80
const MAX_BODY_LENGTH = 200

// Bounds the sessionId -> prompt snippet map; entries are dropped when the turn terminates, the
// cap only guards against leaks from turns that never report a terminal event.
const MAX_TRACKED_PROMPTS = 100

const truncate = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text

// Collapses the prompt to its first line as a compact task name for the notification body.
const toPromptSnippet = (text: string): string | undefined => {
  const firstLine = text
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim()

  if (!firstLine) return undefined

  return truncate(firstLine, MAX_SNIPPET_LENGTH)
}

// Quotes the task name so a body like '"Plot the curve" finished.' stays readable.
const quoteSnippet = (snippet: string): string => `"${snippet}"`

// Plain-language phrasing for the stop reasons that mean "ended, but not cleanly": the raw ACP
// reasons (max_tokens, max_turn_requests, refusal) are developer jargon users shouldn't see.
const EARLY_STOP_BODY: Record<string, (taskName?: string) => string> = {
  max_tokens: (taskName) =>
    `${taskName ?? 'The agent'} stopped early — the answer hit the model's length limit.`,
  max_turn_requests: (taskName) =>
    `${taskName ?? 'The agent'} paused — send a message to keep it going.`,
  refusal: (taskName) =>
    taskName ? `${taskName} was declined by the agent.` : 'The agent declined the request.'
}

// Strips control characters, folds whitespace, and turns underscores into spaces so an arbitrary
// stop-reason text (or one from a future ACP extension) reads naturally and can't smuggle newlines
// or terminal escapes into a single-line OS-notification body — some platforms truncate hard or
// render control glyphs.
const sanitizeReason = (text: string): string => {
  let stripped = ''
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    // 0x00–0x1F (C0 control) and 0x7F (DEL) are non-printable; everything else keeps its shape.
    if (code >= 0x20 && code !== 0x7f) stripped += ch
  }
  return stripped.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

// Maps a terminal runtime event to the notification to show, or null when the event should stay
// silent: user-cancelled turns (deliberate), recoverable context overflows (the renderer
// auto-compacts and retries, so a failure banner would be a false alarm), and session-scoped error
// events that are not prompt failures (artifact cleanup, cancel timeout — only the shared
// ACP_PROMPT_FAILED_EVENT_TITLE marks a genuinely failed task).
export const describeTaskNotification = (
  event: AcpRuntimeEvent,
  promptSnippet?: string
): TaskNotification | null => {
  const taskName = promptSnippet ? quoteSnippet(promptSnippet) : undefined

  if (event.kind === 'stop') {
    const reason = event.text

    if (reason === 'cancelled') return null

    if (reason === 'max_tokens' || reason === 'max_turn_requests' || reason === 'refusal') {
      return {
        title: 'Task needs attention',
        body: truncate(EARLY_STOP_BODY[reason](taskName), MAX_BODY_LENGTH)
      }
    }

    // Only an explicit end_turn counts as a clean completion. Any other value — including an
    // absent text (defensive: the runtime always emits a stop reason in practice) and any future
    // ACP stop reason we don't yet know — is surfaced as needing attention.
    if (reason !== 'end_turn') {
      const cleaned = reason ? sanitizeReason(reason) : ''
      const suffix = cleaned ? ` (${cleaned})` : ''
      const body = taskName
        ? `${taskName} finished without a clean completion status${suffix}.`
        : `The agent finished without a clean completion status${suffix}.`

      return { title: 'Task needs attention', body: truncate(body, MAX_BODY_LENGTH) }
    }

    return {
      title: 'Task completed',
      body: truncate(
        taskName ? `${taskName} finished.` : 'The agent finished your request.',
        MAX_BODY_LENGTH
      )
    }
  }

  if (event.kind === 'error') {
    if (event.title !== ACP_PROMPT_FAILED_EVENT_TITLE) return null
    if (event.recoverable === 'context-overflow') return null

    const reason = event.text?.trim() || 'Unknown error.'

    return {
      title: 'Task failed',
      body: truncate(taskName ? `${taskName} failed: ${reason}` : reason, MAX_BODY_LENGTH)
    }
  }

  return null
}

// Maps a parked permission request to the notification to show. The turn hangs until the user
// answers, so this is the "requires user attention" case from the original feature request; the
// body names the task and the tool waiting for approval.
export const describePermissionNotification = (
  request: Pick<AcpPermissionRequest, 'title'>,
  promptSnippet?: string
): TaskNotification => {
  const taskName = promptSnippet ? quoteSnippet(promptSnippet) : undefined

  return {
    title: 'Approval needed',
    body: truncate(
      taskName
        ? `${taskName} needs your approval: ${request.title}`
        : `The agent needs your approval: ${request.title}`,
      MAX_BODY_LENGTH
    )
  }
}

// Maps a parked connector approval (the external data-egress gate) to the notification to show.
// The tool call blocks for up to five minutes waiting on the user, so this is the same "requires
// attention" case as an ACP permission request, over a separate mechanism.
export const describeConnectorApprovalNotification = (
  request: Pick<ConnectorApprovalRequest, 'connector' | 'method'>,
  promptSnippet?: string
): TaskNotification => {
  const taskName = promptSnippet ? quoteSnippet(promptSnippet) : undefined
  const call = `${request.connector} ${request.method.replaceAll('_', ' ')}`

  return {
    title: 'Approval needed',
    body: truncate(
      taskName
        ? `${taskName} needs your approval: ${call}`
        : `The agent needs your approval: ${call}`,
      MAX_BODY_LENGTH
    )
  }
}

// What trackPrompt returns so a rejected send can revert the session's tracking: a monotonic
// token that uniquely identifies THIS track call, and the previous token (the one it superseded,
// if any). Reverting is keyed on the token, not the snippet string, so concurrent pre-turn
// rejections cannot corrupt the still-running turn's name.
export type TrackedPrompt = {
  token: number
  previousToken?: number
}

// One chain entry per live prompt track on a session; the head is the active track. Track tokens
// are monotonic per service instance.
type ChainEntry = { token: number; snippet: string }

// Watches agent-turn lifecycle events and posts an OS notification when a turn ends while the app
// is unfocused. Kept free of Electron imports (delivery is injected) so the filtering rules are
// unit-testable; wiring lives in main/ipc.ts.
export class TaskNotificationService {
  private readonly tracks = new Map<string, ChainEntry[]>()
  // Tracks that have been reverted via untrackPrompt; consult these when popping the chain so a
  // superseded predecessor never resurrects as the active head.
  private readonly deadTokens = new Set<number>()
  private trackCounter = 0
  private activationHandler: ((sessionId: string) => void) | undefined
  // Click target held for the renderer to pull: a push sent before the renderer's listener exists
  // (window just recreated, React not mounted yet) is lost, so the payload lives here until the
  // renderer — once its sessions are hydrated — takes it. Consume-once.
  private pendingOpenSession: OpenSessionFromNotificationRequest | undefined

  // Active snippet for a session, or undefined when there is none.
  private snippetFor(sessionId: string): string | undefined {
    const chain = this.tracks.get(sessionId)

    return chain && chain.length > 0 ? chain[chain.length - 1].snippet : undefined
  }

  constructor(private readonly deps: TaskNotificationServiceDeps) {}

  // Bound once the window lifecycle exists (index.ts, after installAppLifecycle): clicking a
  // notification surfaces the main window (always) and opens the conversation when the notification
  // belonged to a known session.
  setActivationHandler(handler: (sessionId?: string) => void): void {
    this.activationHandler = handler
  }

  // Records the conversation a notification click should open, so a renderer that misses the push
  // nudge (still loading, sessions not yet hydrated) can pull it when ready.
  setPendingOpenSession(sessionId: string): void {
    this.pendingOpenSession = { sessionId }
  }

  // Returns and clears the pending click target; the renderer calls this once its session store is
  // hydrated (and on every push nudge). Null when there is nothing to open.
  takePendingOpenSession(): OpenSessionFromNotificationRequest | null {
    const pending = this.pendingOpenSession

    this.pendingOpenSession = undefined

    return pending ?? null
  }

  // Remembers the prompt's first line so the terminal event can name the task. Called when a
  // prompt is sent; the entry is dropped when the turn terminates. Returns the token the caller
  // can later pass to untrackPrompt when the runtime rejects before the turn starts.
  trackPrompt(request: Pick<AcpPromptRequest, 'sessionId' | 'text'>): TrackedPrompt | undefined {
    const snippet = toPromptSnippet(request.text)

    if (!snippet) return undefined

    const token = ++this.trackCounter
    const previousChain = this.tracks.get(request.sessionId) ?? []
    const previousToken =
      previousChain.length > 0 ? previousChain[previousChain.length - 1].token : undefined

    this.tracks.set(request.sessionId, [...previousChain, { token, snippet }])

    // Cap tracked sessions: an unbounded map could leak if turns never report a terminal event.
    if (this.tracks.size > MAX_TRACKED_PROMPTS) {
      const oldest = this.tracks.keys().next().value

      if (oldest !== undefined) this.tracks.delete(oldest)
    }

    return { token, previousToken }
  }

  // Reverts a trackPrompt whose send never became a turn (the runtime rejected it before the turn
  // started). Marks the token dead, then pops any dead entries from the head of the chain until it
  // finds a live one. Dead tokens are removed from the set as they're popped so it can't grow
  // unbounded across a long session. Only proceeds with the revert when the caller's token is the
  // live head — so concurrent rejections on the same session (B then C, both dead) cannot resurrect
  // a stale entry and overwrite a still-running turn's name.
  untrackPrompt(sessionId: string, tracked: TrackedPrompt): void {
    this.deadTokens.add(tracked.token)

    let chain = this.tracks.get(sessionId)

    if (!chain || chain.length === 0) return

    while (chain.length > 0 && this.deadTokens.has(chain[chain.length - 1].token)) {
      const popped = chain[chain.length - 1]
      this.deadTokens.delete(popped.token)
      chain = chain.slice(0, -1)
    }

    if (chain.length === 0 || chain[chain.length - 1].token !== tracked.token) {
      // A newer track superseded this one; the chain is already correct.
      if (chain.length === 0) this.tracks.delete(sessionId)
      else this.tracks.set(sessionId, chain)
      return
    }

    // Our token was the live head; pop it (the chain may still hold an older live track).
    this.deadTokens.delete(tracked.token)
    chain = chain.slice(0, -1)

    if (chain.length === 0) {
      this.tracks.delete(sessionId)
    } else {
      this.tracks.set(sessionId, chain)
    }
  }

  // Observes every runtime event (wired next to the 'acp:event' broadcast); only terminal events
  // for a session can produce a notification, and never while the user is looking at the app.
  handleRuntimeEvent = async (event: AcpRuntimeEvent): Promise<void> => {
    if (event.kind !== 'stop' && event.kind !== 'error') return

    const { sessionId } = event

    if (!sessionId) return

    const snippet = this.snippetFor(sessionId)

    // Only genuinely turn-terminal events settle the prompt tracking: a stop (any reason) or a
    // prompt failure. Ancillary session-scoped errors (artifact cleanup, cancel timeout) leave the
    // snippet in place for the turn's own terminal event. Clearing the chain also reaps the dead
    // tokens those entries carried so the set can't grow unbounded.
    if (event.kind === 'stop' || event.title === ACP_PROMPT_FAILED_EVENT_TITLE) {
      const chain = this.tracks.get(sessionId)

      if (chain) for (const entry of chain) this.deadTokens.delete(entry.token)
      this.tracks.delete(sessionId)
    }

    // Eligibility = a user-initiated turn. Internal turns (e.g. the reviewer's auditor-correction,
    // injected via runtime.sendPrompt directly) never pass through trackPrompt, so their terminal
    // events stay silent — the background reviewer must never notify.
    if (!snippet) return

    const notification = describeTaskNotification(event, snippet)

    if (!notification) return

    await this.deliver(notification, sessionId)
  }

  // Observes permission requests (wired next to the 'acp:permission-request' broadcast): a pending
  // approval parks the turn until the user answers, so an unfocused user needs a nudge. Same
  // eligibility rule as terminal events — internal turns never notify.
  handlePermissionRequest = async (request: AcpPermissionRequest): Promise<void> => {
    const snippet = this.snippetFor(request.sessionId)

    if (!snippet) return

    await this.deliver(describePermissionNotification(request, snippet), request.sessionId)
  }

  // Observes connector approvals (wired next to the 'connectors:approval-request' broadcast): the
  // tool call blocks for up to five minutes waiting on the user. Unlike turn notifications there
  // is no tracked-prompt eligibility gate — the approval blocks work regardless of which turn
  // triggered it, and the modal needs an answer either way. The triggering turn's session, when
  // the connector call carried one through, names the task and targets the click.
  handleConnectorApproval = async (
    request: Pick<ConnectorApprovalRequest, 'connector' | 'method'>,
    sessionId?: string
  ): Promise<void> => {
    const snippet = sessionId ? this.snippetFor(sessionId) : undefined

    await this.deliver(describeConnectorApprovalNotification(request, snippet), sessionId)
  }

  // Shared gates and delivery: a focused app and a disabled preference stay silent (and a settings
  // read failure fails closed), and a throwing Notification can never surface as an unhandled
  // rejection on the broadcast path that callers void. Clicks route through the activation handler
  // only when the notification belongs to a known session.
  private async deliver(notification: TaskNotification, sessionId?: string): Promise<void> {
    if (this.deps.isAppFocused()) return

    let enabled = false

    try {
      enabled = await this.deps.isEnabled()
    } catch {
      // A settings read failure must not break the event flow; fail closed rather than spam.
      return
    }

    if (!enabled) return

    // Delivery is best-effort: a throwing Notification must never surface as an unhandled
    // rejection on the broadcast path that callers void.
    try {
      this.deps.show({
        ...notification,
        // Clicks always surface the window; the handler opens the conversation when there is one.
        onClick: () => this.activationHandler?.(sessionId)
      })
    } catch (error) {
      this.deps.onDeliveryError?.(error)
    }
  }
}
