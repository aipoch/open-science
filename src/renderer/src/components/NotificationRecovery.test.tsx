// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { NotificationBell } from './NotificationBell'
import { NotificationErrorBoundary } from './NotificationErrorBoundary'
import type { NotificationInboxItem } from '../../../shared/notifications'

let broken = true
vi.mock('./NotificationEventIcon', () => ({
  NotificationEventIcon: ({ notification }: { notification: NotificationInboxItem }) => {
    if (notification.id === 'broken' && broken)
      throw new Error('private notification body / credential')
    return null
  }
}))
const pending: NotificationInboxItem = {
  id: 'pending',
  sequence: 2,
  dedupeKey: 'approval:2',
  kind: 'authorization.required',
  source: 'connector',
  originId: 'request-2',
  title: 'Approval needed',
  summary: 'Pending request',
  createdAt: 100,
  actionState: 'pending',
  readAt: 101
}
const refresh = vi.fn(async () => undefined)
const replay = vi.fn(async () => null)
const markRead = vi.fn(async () => undefined)
const original = useNotificationInboxStore.getState()

beforeEach(() => {
  broken = true
  refresh.mockClear()
  replay.mockClear()
  markRead.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  window.api = { settings: { replayConnectorApproval: replay } } as unknown as Window['api']
  useNotificationInboxStore.setState({
    ...original,
    status: 'ready',
    items: [
      { ...pending, id: 'broken', readAt: undefined, title: 'Damaged row' },
      pending,
      { ...pending, id: 'invalid', title: 'Invalid target', targetInvalidatedAt: 102 }
    ],
    unreadCount: 1,
    refresh,
    markRead
  })
})
afterEach(() => {
  cleanup()
  useNotificationInboxStore.setState(original)
  vi.restoreAllMocks()
})

it('isolates a failing row while a read pending approval and invalidated history remain reachable', async () => {
  render(<NotificationBell />)
  fireEvent.click(screen.getByRole('button', { name: 'Messages, 1 unread' }))
  expect(screen.getByRole('alert').textContent).toContain('This message could not be displayed.')
  const approval = screen.getByRole('button', { name: /Approval needed.*Needs approval/ })
  expect(approval).toBeTruthy()
  expect(screen.getByRole('button', { name: /Invalid target/ }).hasAttribute('disabled')).toBe(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(refresh).toHaveBeenCalledTimes(2) // opening and one explicit retry
  expect(replay).not.toHaveBeenCalled()
  expect(markRead).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(approval))
  expect(replay).toHaveBeenCalledExactlyOnceWith('request-2')
})

it('recovers repaired row data on explicit retry without replaying approval', async () => {
  render(<NotificationBell />)
  fireEvent.click(screen.getByRole('button', { name: 'Messages, 1 unread' }))
  broken = false
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: /Damaged row/ })).toBeTruthy()
  expect(replay).not.toHaveBeenCalled()
  expect(markRead).not.toHaveBeenCalled()
})

it('keeps stale notifications accessible after snapshot failure with a read-only retry', async () => {
  broken = false
  useNotificationInboxStore.setState({ status: 'error', error: 'private raw error' })
  render(<NotificationBell />)
  fireEvent.click(screen.getByRole('button', { name: 'Messages, 1 unread' }))
  expect(screen.getByRole('alert').textContent).toContain('Showing previously loaded messages.')
  expect(screen.queryByText('private raw error')).toBeNull()
  expect(screen.getByRole('button', { name: /Approval needed.*Needs approval/ })).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(replay).not.toHaveBeenCalled()
})

it.each(['center', 'toast'] as const)(
  'retains a recoverable %s surface and logs only a fixed category',
  async (surface) => {
    const Broken = (): React.JSX.Element => {
      throw new Error('private notification body / credential')
    }
    render(
      <>
        <button>App action</button>
        <NotificationErrorBoundary surface={surface}>
          <Broken />
        </NotificationErrorBoundary>
      </>
    )
    if (surface === 'center')
      fireEvent.click(screen.getByRole('button', { name: 'Messages unavailable' }))
    expect(screen.getByRole('button', { name: 'App action' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Messages could not be displayed.')
    expect(console.warn).toHaveBeenCalledWith('[notifications] render-failed')
    expect(vi.mocked(console.warn).mock.calls.every((args) => args.length === 1)).toBe(true)
    const count = vi.mocked(console.warn).mock.calls.length
    await act(async () => {
      await Promise.resolve()
    })
    expect(console.warn).toHaveBeenCalledTimes(count)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(replay).not.toHaveBeenCalled()
  }
)

it('returns desktop keyboard focus to the trigger after Escape', async () => {
  broken = false
  render(<NotificationBell />)
  const trigger = screen.getByRole('button', { name: 'Messages, 1 unread' })
  trigger.focus()
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  await act(async () => fireEvent.keyDown(document, { key: 'Escape' }))
  expect(document.activeElement).toBe(trigger)
})
