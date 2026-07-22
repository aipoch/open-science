import type { AcpPermissionRequest, AcpPromptRequest, AcpRuntimeEvent } from '../../shared/acp'
import { ACP_PROMPT_FAILED_EVENT_TITLE } from '../../shared/acp'
import type { OpenSessionFromNotificationRequest } from '../../shared/notifications'

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
    // 'stop' events carry the ACP stop reason in `text`; absent means an ordinary end of turn.
    const stopReason = event.text ?? 'end_turn'

    switch (stopReason) {
      case 'cancelled':
        return null
      case 'max_tokens':
      case 'max_turn_requests':
      case 'refusal':
        return {
          title: 'Task needs attention',
          body: truncate(
            taskName
              ? `${taskName} stopped early: ${stopReason.replaceAll('_', ' ')}.`
              : `The agent stopped early: ${stopReason.replaceAll('_', ' ')}.`,
            MAX_BODY_LENGTH
          )
        }
      default:
        return {
          title: 'Task completed',
          body: truncate(
            taskName ? `${taskName} finished.` : 'The agent finished your request.',
            MAX_BODY_LENGTH
          )
        }
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
        ? `${taskName} is waiting for approval: ${request.title}`
        : `The agent is waiting for approval: ${request.title}`,
      MAX_BODY_LENGTH
    )
  }
}

// Watches agent-turn lifecycle events and posts an OS notification when a turn ends while the app
// is unfocused. Kept free of Electron imports (delivery is injected) so the filtering rules are
// unit-testable; wiring lives in main/ipc.ts.
export class TaskNotificationService {
  private readonly promptSnippets = new Map<string, string>()
  private activationHandler: ((sessionId: string) => void) | undefined
  // Click target held for the renderer to pull: a push sent before the renderer's listener exists
  // (window just recreated, React not mounted yet) is lost, so the payload lives here until the
  // renderer — once its sessions are hydrated — takes it. Consume-once.
  private pendingOpenSession: OpenSessionFromNotificationRequest | undefined

  constructor(private readonly deps: TaskNotificationServiceDeps) {}

  // Bound once the window lifecycle exists (index.ts, after installAppLifecycle): clicking a
  // notification surfaces the main window and opens the conversation.
  setActivationHandler(handler: (sessionId: string) => void): void {
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
  // prompt is sent; the entry is dropped when the turn terminates.
  trackPrompt(request: Pick<AcpPromptRequest, 'sessionId' | 'text'>): void {
    const snippet = toPromptSnippet(request.text)

    if (!snippet) return

    // Map preserves insertion order: re-insert to refresh, evict the oldest beyond the cap.
    this.promptSnippets.delete(request.sessionId)
    this.promptSnippets.set(request.sessionId, snippet)

    if (this.promptSnippets.size > MAX_TRACKED_PROMPTS) {
      const oldest = this.promptSnippets.keys().next().value

      if (oldest !== undefined) this.promptSnippets.delete(oldest)
    }
  }

  // Observes every runtime event (wired next to the 'acp:event' broadcast); only terminal events
  // for a session can produce a notification, and never while the user is looking at the app.
  handleRuntimeEvent = async (event: AcpRuntimeEvent): Promise<void> => {
    if (event.kind !== 'stop' && event.kind !== 'error') return

    const { sessionId } = event

    if (!sessionId) return

    const snippet = this.promptSnippets.get(sessionId)

    // Only genuinely turn-terminal events settle the prompt tracking: a stop (any reason) or a
    // prompt failure. Ancillary session-scoped errors (artifact cleanup, cancel timeout) leave the
    // snippet in place for the turn's own terminal event.
    if (event.kind === 'stop' || event.title === ACP_PROMPT_FAILED_EVENT_TITLE) {
      this.promptSnippets.delete(sessionId)
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
    const snippet = this.promptSnippets.get(request.sessionId)

    if (!snippet) return

    await this.deliver(describePermissionNotification(request, snippet), request.sessionId)
  }

  // Shared gates and delivery: a focused app and a disabled preference stay silent (and a settings
  // read failure fails closed), and a throwing Notification can never surface as an unhandled
  // rejection on the broadcast path that callers void.
  private async deliver(notification: TaskNotification, sessionId: string): Promise<void> {
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
        onClick: () => this.activationHandler?.(sessionId)
      })
    } catch (error) {
      this.deps.onDeliveryError?.(error)
    }
  }
}
