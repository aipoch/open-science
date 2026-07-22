import type { AcpPromptRequest, AcpRuntimeEvent } from '../../shared/acp'

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
// silent: user-cancelled turns (deliberate) and recoverable context overflows (the renderer
// auto-compacts and retries, so a failure banner would be a false alarm).
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
    if (event.recoverable === 'context-overflow') return null

    const reason = event.text?.trim() || 'Unknown error.'

    return {
      title: 'Task failed',
      body: truncate(taskName ? `${taskName} failed: ${reason}` : reason, MAX_BODY_LENGTH)
    }
  }

  return null
}

// Watches agent-turn lifecycle events and posts an OS notification when a turn ends while the app
// is unfocused. Kept free of Electron imports (delivery is injected) so the filtering rules are
// unit-testable; wiring lives in main/ipc.ts.
export class TaskNotificationService {
  private readonly promptSnippets = new Map<string, string>()
  private activationHandler: ((sessionId: string) => void) | undefined

  constructor(private readonly deps: TaskNotificationServiceDeps) {}

  // Bound once the window lifecycle exists (index.ts, after installAppLifecycle): clicking a
  // notification surfaces the main window and opens the conversation.
  setActivationHandler(handler: (sessionId: string) => void): void {
    this.activationHandler = handler
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

    const notification = describeTaskNotification(event, this.promptSnippets.get(sessionId))

    // The turn has settled regardless of whether it produced a notification.
    this.promptSnippets.delete(sessionId)

    if (!notification) return
    if (this.deps.isAppFocused()) return

    let enabled = false

    try {
      enabled = await this.deps.isEnabled()
    } catch {
      // A settings read failure must not break the event flow; fail closed rather than spam.
      return
    }

    if (!enabled) return

    this.deps.show({
      ...notification,
      onClick: () => this.activationHandler?.(sessionId)
    })
  }
}
