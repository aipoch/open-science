// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ComposerNoticeSlot } from './ComposerNoticeSlot'
import { useComposerNotices } from '@/lib/composer-notice/use-composer-notices'
import type { ComposerNotice, NoticeActionHandlers } from '@/lib/composer-notice/catalog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const notice: ComposerNotice = {
  id: 'failure',
  source: 'turn',
  occurredAt: 1,
  failure: {
    category: 'service',
    reason: 'service/unavailable',
    responseMessage: 'API Error: service unavailable',
    diagnostics: {
      status: 503,
      raw: 'API Error: service unavailable',
      requestId: 'private-request-id'
    }
  }
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const button = (action: string): HTMLButtonElement =>
  container.querySelector(`[data-notice-action="${action}"]`)!
const render = (notices: ComposerNotice[], handlers: NoticeActionHandlers): void => {
  act(() => root.render(<ComposerNoticeSlot notices={notices} handlers={handlers} />))
}

it('localizes the first layer and keeps deduplicated provider prose outside its live region', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const exportDiagnostics = vi.fn(),
    report = vi.fn()
  render([notice], {
    retry: { run: vi.fn() },
    'export-diagnostics': { run: exportDiagnostics },
    report: { run: report }
  })
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "The model service couldn't respondTry again in a moment."
  )
  const disclosure = container.querySelector('details')!
  expect(disclosure.open).toBe(false)
  expect(disclosure.closest('[role="status"]')).toBeNull()
  expect(disclosure.textContent?.match(/API Error: service unavailable/g)).toHaveLength(1)
  expect(disclosure.textContent).not.toContain('private-request-id')
  expect(container.querySelector('pre')).toBeNull()
  act(() => disclosure.querySelector('summary')!.click())
  await act(async () => button('copy-error').click())
  expect(writeText).toHaveBeenCalledWith('Status: 503\nError: API Error: service unavailable')
  await act(async () => {
    button('export-diagnostics').click()
  })
  expect(button('report')).toBeNull()
  expect(exportDiagnostics).toHaveBeenCalledWith(notice)
  const reportNotice = { ...notice, failure: { ...notice.failure, responseMessage: undefined } }
  render([reportNotice], { report: { run: report } })
  await act(async () => {
    button('report').click()
  })
  expect(report).toHaveBeenCalledWith(reportNotice)
})

it('uses one Retry label for resume and publication and suppresses duplicate pending dispatch', async () => {
  let finish!: () => void
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  render(
    [
      { ...notice, failure: { category: 'session', diagnostics: { raw: 'Raw session mechanism' } } }
    ],
    { resume: { run } }
  )
  expect(button('resume').textContent).toBe('Retry')
  act(() => {
    button('resume').click()
    button('resume').click()
  })
  expect(run).toHaveBeenCalledTimes(1)
  expect(button('resume').textContent).toBe('Retrying…')
  expect(button('resume').disabled).toBe(true)
  await act(async () => finish())
  render([{ ...notice, recovery: 'retry-artifact-publication' }], { retry: { run: vi.fn() } })
  expect(container.querySelector('h2')?.textContent).toBe("Couldn't save the results")
  expect(button('retry').textContent).toBe('Retry')
})

it('retains verified-ready retry failure through dismissal/restoration and accepts fresh auth evidence', async () => {
  const run = vi
    .fn()
    .mockRejectedValue(new Error('The retry failed without fresh authentication evidence'))
  const fixture = (resolved: boolean, settledAt: number): React.JSX.Element => (
    <AuthFixture resolved={resolved} settledAt={settledAt} />
  )
  function AuthFixture({
    resolved,
    settledAt
  }: {
    resolved: boolean
    settledAt: number
  }): React.JSX.Element {
    const notices = useComposerNotices({
      sessionId: 'session',
      authenticationResolved: resolved,
      operations: [],
      turn: {
        promptMessageId: 'prompt',
        outcome: {
          kind: 'failed',
          settledAt,
          failure: {
            category: 'configuration',
            reason: 'configuration/auth-failed',
            diagnostics: { raw: 'Authentication required' }
          }
        }
      }
    })
    return (
      <ComposerNoticeSlot
        notices={notices.notices}
        dismissedNotices={notices.dismissedNotices}
        onDismiss={notices.dismiss}
        onRestore={notices.restore}
        onRecoveryFailure={notices.recoveryFailed}
        handlers={{ retry: { run } }}
      />
    )
  }
  act(() => root.render(fixture(false, 1)))
  expect(container.querySelector('h2')?.textContent).toBe('Model authentication failed')
  act(() => root.render(fixture(true, 1)))
  expect(container.querySelector('h2')?.textContent).toBe('Ready to retry')
  await act(async () => button('retry').click())
  expect(container.querySelector('h2')?.textContent).toBe('Retry failed')
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click())
  expect(container.querySelector('[data-testid="composer-notice-slot"]')).toBeNull()
  const entry = container.querySelector('[data-testid="composer-notice-recovery-entry"]')!
  expect(entry.textContent).toContain('Retry failed')
  expect(button('retry').disabled).toBe(false)
  act(() =>
    [...entry.querySelectorAll('button')]
      .find((button) => button.textContent === 'Details')!
      .click()
  )
  expect(container.querySelector('h2')?.textContent).toBe('Retry failed')
  act(() => root.render(fixture(true, 2)))
  expect(container.querySelector('h2')?.textContent).toBe('Model authentication failed')
})

it('shares pending recovery across dismissal and restoration without duplicate dispatch', async () => {
  let finish!: () => void
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  function PendingFixture(): React.JSX.Element {
    const notices = useComposerNotices({
      sessionId: 'pending',
      operations: [],
      turn: {
        promptMessageId: 'prompt',
        outcome: { kind: 'failed', settledAt: 1, failure: notice.failure }
      }
    })
    return (
      <ComposerNoticeSlot
        notices={notices.notices}
        dismissedNotices={notices.dismissedNotices}
        onDismiss={notices.dismiss}
        onRestore={notices.restore}
        handlers={{ retry: { run } }}
      />
    )
  }
  act(() => root.render(<PendingFixture />))
  act(() => button('retry').click())
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click())
  expect(button('retry').textContent).toBe('Retrying…')
  expect(button('retry').disabled).toBe(true)
  act(() => button('retry').click())
  const entry = container.querySelector('[data-testid="composer-notice-recovery-entry"]')!
  act(() =>
    [...entry.querySelectorAll('button')]
      .find((button) => button.textContent === 'Details')!
      .click()
  )
  expect(button('retry').textContent).toBe('Retrying…')
  expect(button('retry').disabled).toBe(true)
  expect(run).toHaveBeenCalledTimes(1)
  await act(async () => finish())
  expect(button('retry').textContent).toBe('Retry')
  expect(button('retry').disabled).toBe(false)
})
