import type { AcpPermissionRequest, AcpPromptRequest, AcpRuntimeEvent } from '../../shared/acp'
import { ACP_PROMPT_FAILED_EVENT_TITLE } from '../../shared/acp'
import type { ComputeApprovalRequest } from '../../shared/compute'
import type {
  NotificationActionState,
  NotificationAttentionReason,
  NotificationKind,
  NotificationSource,
  OpenSessionFromNotificationRequest
} from '../../shared/notifications'
import type {
  ConnectorApprovalRequest,
  ConnectorCredentialRequest,
  ConversationSkillImportApprovalRequest
} from '../../shared/settings'
import { englishNativeTranslator, type NativeTranslator } from '../locale/main-process-messages'
import {
  agentQuestionDedupeKey,
  type NotificationInboxController
} from './notification-inbox-controller'

export type TaskNotification = {
  title: string
  body: string
  attention?: boolean
  genericBody?: string
  alwaysGeneric?: boolean
}

export type TaskNotificationRequest = TaskNotification & {
  // Fires when the user clicks the notification (where the OS/desktop supports it).
  onClick: () => void
}

export type TaskNotificationServiceDeps = {
  // Fresh settings read, so the Settings toggle applies without a restart.
  isEnabled: () => Promise<boolean>
  // Detailed native copy is a separate privacy opt-in. Absence fails closed to generic copy.
  showContent?: () => Promise<boolean>
  // Notifications only make sense when the user has switched away; a focused app needs none.
  isAppFocused: () => boolean
  // OS-specific delivery (Electron Notification in production, a spy in tests).
  show: (request: TaskNotificationRequest) => void
  // Live main-process translator. Tests and non-desktop compositions inject the English translator.
  translate: NativeTranslator
  // Delivery failures are swallowed (the event stream must never be disturbed) but reported here
  // so they still reach the log file in production.
  onDeliveryError?: (error: unknown) => void
  // Native Dock/taskbar calls are isolated from OS banner delivery and reported separately.
  onAttentionError?: (error: unknown) => void
  // Durable inbox recording is shared by desktop, Web, and headless clients. Failures are reported
  // without changing the underlying task or approval lifecycle.
  inbox?: Pick<NotificationInboxController, 'record' | 'settleAction' | 'settleAuthorization'>
  onInboxError?: (error: unknown) => void
  // A clean foreground turn is not a completed workflow while its remote Compute Jobs can still
  // trigger an automatic analysis turn.
  hasNonTerminalComputeJobs?: (sessionId: string) => Promise<boolean>
}

export type TaskNotificationAttentionHandlers = {
  request: () => void
  clear: () => void
}

const reportTaskNotificationError = (
  reporter: ((error: unknown) => void) | undefined,
  error: unknown
): void => {
  try {
    reporter?.(error)
  } catch {
    // Diagnostics are best-effort and must never escape a notification boundary.
  }
}

// Electron event callbacks cannot await notification work. This final boundary catches both a
// synchronous handler failure and a rejected Promise so fire-and-forget callers stay isolated.
export const runTaskNotificationInBackground = (
  operation: () => Promise<void>,
  onError?: (error: unknown) => void
): void => {
  const report = (error: unknown): void => reportTaskNotificationError(onError, error)

  try {
    void operation().catch(report)
  } catch (error) {
    report(error)
  }
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
const EARLY_STOP_BODY: Record<string, (translate: NativeTranslator, taskName?: string) => string> =
  {
    max_tokens: (translate, taskName) =>
      taskName
        ? translate(`{{taskName}} stopped early — the answer hit the model's length limit.`, {
            taskName
          })
        : translate(`The agent stopped early — the answer hit the model's length limit.`),
    max_turn_requests: (translate, taskName) =>
      taskName
        ? translate('{{taskName}} paused — send a message to keep it going.', { taskName })
        : translate('The agent paused — send a message to keep it going.'),
    refusal: (translate, taskName) =>
      taskName
        ? translate('{{taskName}} was declined by the agent.', { taskName })
        : translate('The agent declined the request.')
  }

// Inbox rows cross surface and process boundaries and outlive the originating request. Keep their
// presentation text fixed so prompts, provider errors, connector arguments, and approval payloads
// remain confined to the transient native notification and the live approval UI.
const TASK_INBOX_SUMMARY = {
  'task.completed': 'A task completed.',
  'task.needs-attention': 'A task needs attention. Open the conversation for details.',
  'task.failed': 'A task failed. Open the conversation for details.'
} as const satisfies Record<Exclude<NotificationKind, 'authorization.required'>, string>

const AUTHORIZATION_INBOX_SUMMARY = {
  'agent-tool': 'A tool request needs your approval.',
  connector: 'A connector request needs your approval.',
  compute: 'A compute request needs your approval.',
  'skill-import': 'A Skill import needs your approval.',
  'session-plan': 'A plan needs your approval.'
} as const satisfies Record<Exclude<NotificationSource, 'agent-question' | 'agent-runtime'>, string>

const AGENT_QUESTION_INBOX_SUMMARY = 'The agent is waiting for your response.'

const GENERIC_NATIVE_BODY_BY_TITLE: Readonly<Record<string, string>> = {
  'Task completed': 'A task completed. Open the app to view it.',
  'Task needs attention': 'A task needs attention. Open the app for details.',
  'Task failed': 'A task failed. Open the app for details.',
  'Approval needed': 'A task needs your approval. Open the app to review it.',
  'Response needed': 'A task needs your response. Open the app to continue.',
  'Plan approval needed': 'A plan is ready for approval. Open the app to review it.'
}

const genericNativeNotification = (notification: TaskNotification): TaskNotification => ({
  ...notification,
  body:
    notification.genericBody ??
    GENERIC_NATIVE_BODY_BY_TITLE[notification.title] ??
    'Open the app for details.'
})

const connectorCredentialDedupeKey = (originId: string): string =>
  `input:connector-credential:${originId}`

const TASK_ATTENTION_REASON_BY_STOP: Readonly<Record<string, NotificationAttentionReason>> = {
  max_tokens: 'task-max-tokens',
  max_turn_requests: 'task-max-turn-requests',
  refusal: 'task-refusal'
}

// Strips control characters, folds whitespace, and turns underscores into spaces so an arbitrary
// stop-reason text (or one from a future ACP extension) reads naturally and can't smuggle newlines
// or terminal escapes into a single-line OS-notification body — some platforms truncate hard or
// render control glyphs. Control characters (including \n, \r, \t) become spaces first, then
// whitespace folds, so "budget\nexceeded" reads as "budget exceeded" rather than "budgetexceeded".
const sanitizeReason = (text: string): string => {
  let stripped = ''
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    // 0x00–0x1F (C0 control) and 0x7F (DEL) become spaces; everything else keeps its shape.
    if (code < 0x20 || code === 0x7f) stripped += ' '
    else stripped += ch
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
  promptSnippet?: string,
  translate: NativeTranslator = englishNativeTranslator
): TaskNotification | null => {
  const taskName = promptSnippet ? quoteSnippet(promptSnippet) : undefined

  if (event.kind === 'stop') {
    const reason = event.text

    if (reason === 'cancelled') return null

    if (reason === 'max_tokens' || reason === 'max_turn_requests' || reason === 'refusal') {
      return {
        title: translate('Task needs attention'),
        body: truncate(EARLY_STOP_BODY[reason](translate, taskName), MAX_BODY_LENGTH)
      }
    }

    // Only an explicit end_turn counts as a clean completion. Any other value — including an
    // absent text (defensive: the runtime always emits a stop reason in practice) and any future
    // ACP stop reason we don't yet know — is surfaced as needing attention.
    if (reason !== 'end_turn') {
      const cleaned = reason ? sanitizeReason(reason) : ''
      const body = taskName
        ? cleaned
          ? translate('{{taskName}} finished without a clean completion status ({{reason}}).', {
              taskName,
              reason: cleaned
            })
          : translate('{{taskName}} finished without a clean completion status.', { taskName })
        : cleaned
          ? translate('The agent finished without a clean completion status ({{reason}}).', {
              reason: cleaned
            })
          : translate('The agent finished without a clean completion status.')

      return {
        title: translate('Task needs attention'),
        body: truncate(body, MAX_BODY_LENGTH)
      }
    }

    return {
      title: translate('Task completed'),
      body: truncate(
        taskName
          ? translate('The agent finished responding to {{taskName}}.', { taskName })
          : translate('The agent finished responding.'),
        MAX_BODY_LENGTH
      )
    }
  }

  if (event.kind === 'error') {
    if (event.title !== ACP_PROMPT_FAILED_EVENT_TITLE) return null
    if (event.recoverable === 'context-overflow') return null

    const reason = event.text?.trim() || translate('Unknown error.')

    return {
      title: translate('Task failed'),
      genericBody: translate('A task failed. Open the app for details.'),
      alwaysGeneric: true,
      body: truncate(
        taskName ? translate('{{taskName}} failed: {{reason}}', { taskName, reason }) : reason,
        MAX_BODY_LENGTH
      )
    }
  }

  return null
}

// Formats every blocking approval surface with the same task-aware wording.
const describeApprovalNotification = (
  detail: string,
  promptSnippet?: string,
  translate: NativeTranslator = englishNativeTranslator
): TaskNotification => {
  const taskName = promptSnippet ? quoteSnippet(promptSnippet) : undefined

  return {
    title: translate('Approval needed'),
    body: truncate(
      taskName
        ? translate('{{taskName}} needs your approval: {{detail}}', { taskName, detail })
        : translate('The agent needs your approval: {{detail}}', { detail }),
      MAX_BODY_LENGTH
    ),
    attention: true
  }
}

// Maps a parked permission request to the notification to show. The turn hangs until the user
// answers, so this is the "requires user attention" case from the original feature request.
export const describePermissionNotification = (
  request: Pick<AcpPermissionRequest, 'title'>,
  promptSnippet?: string,
  translate: NativeTranslator = englishNativeTranslator
): TaskNotification => describeApprovalNotification(request.title, promptSnippet, translate)

const describeAgentQuestionNotification = (
  promptSnippet?: string,
  translate: NativeTranslator = englishNativeTranslator
): TaskNotification => ({
  title: translate('Response needed'),
  body: promptSnippet
    ? translate('{{taskName}} needs your response.', { taskName: quoteSnippet(promptSnippet) })
    : translate('The agent needs your response.'),
  attention: true
})

// Maps a parked connector approval (the external data-egress gate) to the notification to show.
// The tool call blocks for up to five minutes waiting on the user, so this is the same "requires
// attention" case as an ACP permission request, over a separate mechanism.
export const describeConnectorApprovalNotification = (
  request: Pick<ConnectorApprovalRequest, 'connector' | 'method'>,
  promptSnippet?: string,
  translate: NativeTranslator = englishNativeTranslator
): TaskNotification => {
  const call = `${request.connector} ${request.method.replaceAll('_', ' ')}`

  return describeApprovalNotification(call, promptSnippet, translate)
}

// A monotonic token lets a rejected send revert exactly its own tracking entry.
export type TrackedPrompt = {
  token: number
}

// One chain entry per live prompt track on a session; the head is the active track. Track tokens
// are monotonic per service instance.
type ChainEntry = { token: number; snippet?: string }

// Watches agent-turn lifecycle and structured-input events and posts an OS notification when the
// app is unfocused. Kept free of Electron imports (delivery is injected) so the filtering rules are
// unit-testable; wiring lives in main/ipc.ts.
export class TaskNotificationService {
  private readonly tracks = new Map<string, ChainEntry[]>()
  private readonly pendingAgentQuestions = new Map<string, Set<string>>()
  private trackCounter = 0
  private activationHandler: ((sessionId?: string) => void) | undefined
  private attentionHandlers: TaskNotificationAttentionHandlers | undefined
  // Click target held for the renderer to pull: a push sent before the renderer's listener exists
  // (window just recreated, React not mounted yet) is lost, so the payload lives here until the
  // renderer — once its sessions are hydrated — takes it. Consume-once.
  private pendingOpenSession: OpenSessionFromNotificationRequest | undefined
  private pendingOpenSessionToken = 0

  // Active user-initiated turn for a session. Its display snippet is optional for attachment-only
  // prompts; entry existence, not text content, is the notification eligibility signal.
  private trackedFor(sessionId: string): ChainEntry | undefined {
    const chain = this.tracks.get(sessionId)

    return chain && chain.length > 0 ? chain[chain.length - 1] : undefined
  }

  constructor(private readonly deps: TaskNotificationServiceDeps) {}

  // A destroyed native window can throw while Electron reports focus. Suppress delivery when focus
  // is unknown, which avoids showing a background notification over a potentially focused app.
  private isAppFocused(): boolean {
    try {
      return this.deps.isAppFocused()
    } catch (error) {
      reportTaskNotificationError(this.deps.onDeliveryError, error)
      return true
    }
  }

  private async hasNonTerminalComputeJobs(sessionId: string): Promise<boolean> {
    if (!this.deps.hasNonTerminalComputeJobs) return false
    try {
      return await this.deps.hasNonTerminalComputeJobs(sessionId)
    } catch (error) {
      // Preserve notification delivery when the activity projection is temporarily unavailable.
      reportTaskNotificationError(this.deps.onDeliveryError, error)
      return false
    }
  }

  // Bound once the window lifecycle exists (index.ts, after installAppLifecycle): clicking a
  // notification surfaces the main window (always) and opens the conversation when the notification
  // belonged to a known session.
  setActivationHandler(handler: (sessionId?: string) => void): void {
    this.activationHandler = handler
  }

  // Bound after the main-window lifecycle exists. Keeping this late-bound lets the notification
  // service remain Electron-free while attention can still inspect the current native window.
  setAttentionHandlers(handlers: TaskNotificationAttentionHandlers): void {
    this.attentionHandlers = handlers
  }

  // Records the conversation a notification click should open, so a renderer that misses the push
  // nudge (still loading, sessions not yet hydrated) can pull it when ready.
  setPendingOpenSession(sessionId: string): void {
    this.pendingOpenSession = { sessionId, token: ++this.pendingOpenSessionToken }
  }

  // Lets the renderer check whether the target already exists in a partially hydrated store without
  // losing it when the remaining persistence scan still needs to be retried.
  peekPendingOpenSession(): OpenSessionFromNotificationRequest | null {
    return this.pendingOpenSession ?? null
  }

  // Clears the pending click target only when it is still the one the renderer inspected. A newer
  // notification may replace it while the renderer awaits IPC, and must not be consumed by the
  // older attempt.
  takePendingOpenSession(expectedToken: number): OpenSessionFromNotificationRequest | null {
    const pending = this.pendingOpenSession

    if (!pending || pending.token !== expectedToken) return null

    this.pendingOpenSession = undefined

    return pending
  }

  // Records every renderer-originated prompt, including attachment-only turns. A first-line snippet
  // is retained only when available; the token lets a rejected pre-turn send restore its predecessor.
  trackPrompt(request: Pick<AcpPromptRequest, 'sessionId' | 'text'>): TrackedPrompt {
    const snippet = toPromptSnippet(request.text)
    const token = ++this.trackCounter
    const previousChain = this.tracks.get(request.sessionId) ?? []

    this.tracks.set(request.sessionId, [
      ...previousChain,
      { token, ...(snippet ? { snippet } : {}) }
    ])

    // Cap tracked sessions: an unbounded map could leak if turns never report a terminal event.
    if (this.tracks.size > MAX_TRACKED_PROMPTS) {
      const oldest = this.tracks.keys().next().value

      if (oldest !== undefined) this.tracks.delete(oldest)
    }

    return { token }
  }

  // Reverts exactly the prompt whose send never became a turn. Removing by token preserves every
  // older or newer live entry regardless of rejection order.
  untrackPrompt(sessionId: string, tracked: TrackedPrompt): void {
    const chain = this.tracks.get(sessionId)

    if (!chain) return
    const updated = chain.filter((entry) => entry.token !== tracked.token)

    if (updated.length === 0) {
      this.tracks.delete(sessionId)
    } else {
      this.tracks.set(sessionId, updated)
    }
  }

  // Observes every runtime event (wired next to the 'acp:event' broadcast); terminal events and
  // pending questions can produce a notification, never while the user is looking at the app.
  handleRuntimeEvent = async (event: AcpRuntimeEvent): Promise<void> => {
    if (event.elicitation && event.sessionId) {
      await this.handleElicitationEvent(event)
      return
    }
    if (event.kind !== 'stop' && event.kind !== 'error') return

    const { sessionId } = event

    if (!sessionId) return

    // App-owned choice turns finish normally while the durable card waits. Keep the original prompt
    // tracked so the post-answer continuation owns the eventual completion notification.
    if (
      event.kind === 'stop' &&
      event.text === 'end_turn' &&
      (this.pendingAgentQuestions.get(sessionId)?.size ?? 0) > 0
    ) {
      return
    }

    const tracked = this.trackedFor(sessionId)
    const snippet = tracked?.snippet

    // Only genuinely turn-terminal events settle the prompt tracking: a stop (any reason) or a
    // prompt failure. Ancillary session-scoped errors (artifact cleanup, cancel timeout) leave the
    // snippet in place for the turn's own terminal event.
    if (event.kind === 'stop' || event.title === ACP_PROMPT_FAILED_EVENT_TITLE) {
      this.tracks.delete(sessionId)
    }

    // Eligibility = a user-initiated turn. Internal turns (e.g. the reviewer's auditor-correction,
    // injected via runtime.sendPrompt directly) never pass through trackPrompt, so their terminal
    // events stay silent — the background reviewer must never notify.
    if (!tracked) return

    if (
      event.kind === 'stop' &&
      event.text === 'end_turn' &&
      this.deps.hasNonTerminalComputeJobs &&
      (await this.hasNonTerminalComputeJobs(sessionId))
    ) {
      return
    }

    const notification = describeTaskNotification(event, snippet, this.deps.translate)

    if (!notification) return

    const kind =
      event.kind === 'error'
        ? 'task.failed'
        : event.text === 'end_turn'
          ? 'task.completed'
          : 'task.needs-attention'
    const inboxUpdate = this.recordInbox({
      dedupeKey: `task:${event.id}`,
      kind,
      source: 'agent-runtime',
      ...(kind === 'task.needs-attention'
        ? {
            attentionReason: TASK_ATTENTION_REASON_BY_STOP[event.text ?? ''] ?? 'task-unclean-stop'
          }
        : {}),
      sessionId,
      originId: event.id,
      title:
        kind === 'task.completed'
          ? 'Task completed'
          : kind === 'task.failed'
            ? 'Task failed'
            : 'Task needs attention',
      summary: TASK_INBOX_SUMMARY[kind],
      createdAt: event.timestamp
    })

    await this.deliver(notification, sessionId)
    await inboxUpdate
  }

  private async handleElicitationEvent(event: AcpRuntimeEvent): Promise<void> {
    const { elicitation, sessionId } = event
    if (!elicitation || !sessionId) return
    const originId = elicitation.durable?.requestId ?? event.toolCallId ?? event.id
    const dedupeKey = agentQuestionDedupeKey(originId)

    if (elicitation.state !== 'pending') {
      const pending = this.pendingAgentQuestions.get(sessionId)
      pending?.delete(originId)
      if (pending?.size === 0) this.pendingAgentQuestions.delete(sessionId)
      const state: NotificationActionState =
        elicitation.state === 'answered'
          ? 'resolved'
          : elicitation.state === 'declined'
            ? 'rejected'
            : 'cancelled'
      try {
        await this.deps.inbox?.settleAction(dedupeKey, state)
      } catch (error) {
        reportTaskNotificationError(this.deps.onInboxError, error)
      }
      return
    }

    const tracked = this.trackedFor(sessionId)
    if (!tracked) return
    const pending = this.pendingAgentQuestions.get(sessionId) ?? new Set<string>()
    if (pending.has(originId)) return
    pending.add(originId)
    this.pendingAgentQuestions.set(sessionId, pending)

    const notification = describeAgentQuestionNotification(tracked.snippet, this.deps.translate)
    const inboxUpdate = this.recordInbox({
      dedupeKey,
      kind: 'task.needs-attention',
      source: 'agent-question',
      attentionReason: 'waiting-for-user',
      sessionId,
      originId,
      title: 'Response needed',
      summary: AGENT_QUESTION_INBOX_SUMMARY,
      actionState: 'pending'
    })
    await this.deliver(notification, sessionId)
    await inboxUpdate
  }

  // Observes permission requests (wired next to the 'acp:permission-request' broadcast): a pending
  // approval parks the turn until the user answers, so an unfocused user needs a nudge. Same
  // eligibility rule as terminal events — internal turns never notify.
  handlePermissionRequest = async (request: AcpPermissionRequest): Promise<void> => {
    const tracked = this.trackedFor(request.sessionId)

    if (!tracked) return

    const notification = describePermissionNotification(
      request,
      tracked.snippet,
      this.deps.translate
    )
    const inboxUpdate = this.recordInbox({
      dedupeKey: `authorization:agent-tool:${request.requestId}`,
      kind: 'authorization.required',
      source: 'agent-tool',
      attentionReason: 'waiting-permission',
      sessionId: request.sessionId,
      originId: request.requestId,
      title: 'Approval needed',
      summary: AUTHORIZATION_INBOX_SUMMARY['agent-tool'],
      actionState: 'pending'
    })
    await this.deliver(notification, request.sessionId)
    await inboxUpdate
  }

  // Observes connector approvals (wired next to the 'connectors:approval-request' broadcast): the
  // tool call blocks for up to five minutes waiting on the user. Session-scoped approvals retain the
  // user-turn eligibility gate so internal work stays silent; a sessionless approval still needs a
  // notification because it can independently block a call. A tracked session names and targets it.
  handleConnectorApproval = async (
    request: Pick<ConnectorApprovalRequest, 'connector' | 'method'> &
      Partial<Pick<ConnectorApprovalRequest, 'id'>>,
    sessionId?: string
  ): Promise<void> => {
    const tracked = sessionId ? this.trackedFor(sessionId) : undefined

    // A session-scoped approval without a tracked user prompt belongs to an internal turn. Keep
    // sessionless connector approvals visible because they can still block an independent tool call.
    if (sessionId && !tracked) return

    const notification = describeConnectorApprovalNotification(
      request,
      tracked?.snippet,
      this.deps.translate
    )
    const inboxUpdate = request.id
      ? this.recordInbox({
          dedupeKey: `authorization:connector:${request.id}`,
          kind: 'authorization.required',
          source: 'connector',
          attentionReason: 'waiting-permission',
          ...(sessionId ? { sessionId } : {}),
          originId: request.id,
          title: 'Approval needed',
          summary: AUTHORIZATION_INBOX_SUMMARY.connector,
          actionState: 'pending'
        })
      : Promise.resolve()
    await this.deliver(notification, sessionId)
    await inboxUpdate
  }

  // Session-bound credential recovery lives in the owning Composer, so the durable inbox provides
  // the app-wide path back to it. Sessionless requests keep their existing global dialog instead.
  handleConnectorCredentialRequest = async (request: ConnectorCredentialRequest): Promise<void> => {
    if (!request.sessionId) return
    const tracked = this.trackedFor(request.sessionId)
    if (!tracked) return

    const notification = describeAgentQuestionNotification(tracked.snippet, this.deps.translate)
    const inboxUpdate = this.recordInbox({
      dedupeKey: connectorCredentialDedupeKey(request.id),
      kind: 'task.needs-attention',
      source: 'connector',
      attentionReason: 'waiting-for-user',
      sessionId: request.sessionId,
      originId: request.id,
      title: 'Response needed',
      summary: AGENT_QUESTION_INBOX_SUMMARY,
      actionState: 'pending'
    })
    await this.deliver(notification, request.sessionId)
    await inboxUpdate
  }

  // Compute approvals carry their conversation separately from the renderer payload. Keep the same
  // internal-turn gate as other session-scoped approvals; legacy sessionless calls still surface.
  handleComputeApproval = async (
    request: ComputeApprovalRequest,
    sessionId?: string
  ): Promise<void> => {
    const tracked = sessionId ? this.trackedFor(sessionId) : undefined

    if (sessionId && !tracked) return

    const notification = describeApprovalNotification(
      `${request.provider_name} — ${request.intent}`,
      tracked?.snippet,
      this.deps.translate
    )
    const inboxUpdate = this.recordInbox({
      dedupeKey: `authorization:compute:${request.id}`,
      kind: 'authorization.required',
      source: 'compute',
      attentionReason: 'waiting-permission',
      ...(sessionId ? { sessionId } : {}),
      originId: request.id,
      title: 'Approval needed',
      summary: AUTHORIZATION_INBOX_SUMMARY.compute,
      actionState: 'pending'
    })
    await this.deliver(notification, sessionId)
    await inboxUpdate
  }

  // Conversation Skill imports always belong to an active user turn and can target that same
  // conversation when the notification is clicked.
  handleSkillImportApproval = async (
    request: ConversationSkillImportApprovalRequest
  ): Promise<void> => {
    const tracked = this.trackedFor(request.sessionId)

    if (!tracked) return

    const notification = describeApprovalNotification(
      this.deps.translate('Import {{source}}', { source: request.source.label }),
      tracked.snippet,
      this.deps.translate
    )
    const inboxUpdate = this.recordInbox({
      dedupeKey: `authorization:skill-import:${request.id}`,
      kind: 'authorization.required',
      source: 'skill-import',
      attentionReason: 'waiting-permission',
      sessionId: request.sessionId,
      originId: request.id,
      title: 'Approval needed',
      summary: AUTHORIZATION_INBOX_SUMMARY['skill-import'],
      actionState: 'pending'
    })
    await this.deliver(notification, request.sessionId)
    await inboxUpdate
  }

  handlePlanApproval = async (request: {
    projectId: string
    sessionId: string
    artifactVersionId: string
    summary: string
  }): Promise<void> => {
    const tracked = this.trackedFor(request.sessionId)
    if (!tracked) return
    const notification: TaskNotification = {
      title: this.deps.translate('Plan approval needed'),
      body: truncate(
        tracked.snippet
          ? this.deps.translate('{{taskName}} has a plan ready for review.', {
              taskName: quoteSnippet(tracked.snippet)
            })
          : this.deps.translate('Review the proposed plan: {{summary}}', {
              summary: request.summary
            }),
        MAX_BODY_LENGTH
      ),
      attention: true
    }
    const inboxUpdate = this.recordInbox({
      dedupeKey: `authorization:session-plan:${request.artifactVersionId}`,
      kind: 'authorization.required',
      source: 'session-plan',
      attentionReason: 'waiting-plan-approval',
      projectId: request.projectId,
      sessionId: request.sessionId,
      originId: request.artifactVersionId,
      title: 'Plan approval needed',
      summary: AUTHORIZATION_INBOX_SUMMARY['session-plan'],
      actionState: 'pending'
    })
    await this.deliver(notification, request.sessionId)
    await inboxUpdate
  }

  settleAuthorization = async (
    source: NotificationSource,
    originId: string,
    state: NotificationActionState
  ): Promise<void> => {
    try {
      await this.deps.inbox?.settleAuthorization(source, originId, state)
    } catch (error) {
      reportTaskNotificationError(this.deps.onInboxError, error)
    }
  }

  settleConnectorCredentialRequest = async (
    originId: string,
    configured: boolean
  ): Promise<void> => {
    try {
      await this.deps.inbox?.settleAction(
        connectorCredentialDedupeKey(originId),
        configured ? 'resolved' : 'cancelled'
      )
    } catch (error) {
      reportTaskNotificationError(this.deps.onInboxError, error)
    }
  }

  private async recordInbox(
    input: Parameters<NonNullable<TaskNotificationServiceDeps['inbox']>['record']>[0]
  ): Promise<void> {
    try {
      await this.deps.inbox?.record(input)
    } catch (error) {
      reportTaskNotificationError(this.deps.onInboxError, error)
    }
  }

  // Shared gates and delivery: a focused app and a disabled preference stay silent (and a settings
  // read failure fails closed), and a throwing Notification can never surface as an unhandled
  // rejection on the broadcast path that callers void. Clicks route through the activation handler
  // only when the notification belongs to a known session. Focus is checked both before and after
  // the settings read so a user who switches back during the async gap doesn't get a spurious banner.
  private async deliver(notification: TaskNotification, sessionId?: string): Promise<void> {
    if (this.isAppFocused()) return

    let enabled = false
    let showContent = false

    try {
      ;[enabled, showContent] = await Promise.all([
        this.deps.isEnabled(),
        this.deps.showContent?.().catch(() => false) ?? Promise.resolve(false)
      ])
    } catch {
      // A settings read failure must not break the event flow; fail closed rather than spam.
      return
    }

    if (!enabled) return

    // Re-check focus after the async settings read: the user may have switched back during the gap.
    if (this.isAppFocused()) return

    const onClick = (): void => {
      try {
        this.attentionHandlers?.clear()
      } catch (error) {
        reportTaskNotificationError(this.deps.onAttentionError, error)
      }

      try {
        this.activationHandler?.(sessionId)
      } catch (error) {
        reportTaskNotificationError(this.deps.onDeliveryError, error)
      }
    }

    // Banner delivery and native attention are independent best-effort channels. Either one may be
    // unavailable on a platform without preventing the other from reaching the user.
    try {
      this.deps.show({
        ...(showContent && !notification.alwaysGeneric
          ? notification
          : genericNativeNotification(notification)),
        // Clicks always surface the window; the handler opens the conversation when there is one.
        onClick
      })
    } catch (error) {
      reportTaskNotificationError(this.deps.onDeliveryError, error)
    }

    if (notification.attention) {
      try {
        this.attentionHandlers?.request()
      } catch (error) {
        reportTaskNotificationError(this.deps.onAttentionError, error)
      }
    }
  }
}
