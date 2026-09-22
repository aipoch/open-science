import { abortableDelay } from './abortable-delay'

// Zotero-specific transport state belongs to one engine, never to the process.
// It contains only a cooldown deadline, not credentials or response data.
export class ZoteroRequestPolicy {
  private nextRequestAt = 0

  matches(connector: string, url: string): boolean {
    if (connector !== 'zotero') return false
    const target = new URL(url)
    return target.origin === 'https://api.zotero.org' && !target.username && !target.password
  }

  requestInit(): {
    headers: Record<string, string>
    redirect: 'error'
  } {
    return {
      headers: {
        'Zotero-API-Version': '3'
      },
      redirect: 'error'
    }
  }

  async wait(deadline: number, signal: AbortSignal): Promise<void> {
    while (this.nextRequestAt > Date.now()) {
      signal.throwIfAborted()
      const delay = this.nextRequestAt - Date.now()
      if (delay >= deadline - Date.now()) {
        throw new Error(`Zotero requested backoff. Retry after ${Math.ceil(delay / 1000)}s.`)
      }
      await abortableDelay(delay, signal)
    }
  }

  observe(response: Response): void {
    const now = Date.now()
    const backoff = secondsDeadline(response.headers.get('Backoff'), now)
    // Capture before body reads/retry decisions: final errors and cancellation must not allow
    // another call to bypass the server's deadline. Successful responses can also carry Backoff.
    const retryAfter =
      response.status === 429 || response.status === 503
        ? retryAfterDeadline(response.headers.get('Retry-After'), now)
        : undefined
    this.nextRequestAt = Math.max(this.nextRequestAt, backoff ?? 0, retryAfter ?? 0)
  }

  errorHint(status: number): string {
    return status === 401 || status === 403
      ? ' Access denied. This connector supports public Zotero libraries only; private-library authentication is not available.'
      : ''
  }
}

const secondsDeadline = (value: string | null, now: number): number | undefined => {
  const seconds = value?.trim()
  if (!seconds || !/^\d+$/.test(seconds)) return undefined
  const deadline = now + Number(seconds) * 1000
  // Validate after conversion too: even a finite seconds value can overflow when multiplied.
  return Number.isSafeInteger(deadline) ? deadline : undefined
}

const retryAfterDeadline = (value: string | null, now: number): number | undefined => {
  const seconds = secondsDeadline(value, now)
  if (seconds !== undefined) return seconds
  // Accept the standard HTTP-date form, not Date.parse's permissive numeric/date shortcuts.
  const date = value?.trim()
  if (!date || !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(date))
    return undefined
  const deadline = Date.parse(date)
  return Number.isSafeInteger(deadline) ? deadline : undefined
}
