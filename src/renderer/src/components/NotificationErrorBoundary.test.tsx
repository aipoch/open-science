// @vitest-environment jsdom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { NotificationErrorBoundary } from './NotificationErrorBoundary'

it('isolates notification render failures from sibling app content', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const BrokenNotification = (): React.JSX.Element => {
    throw new Error('damaged notification')
  }

  act(() => {
    root.render(
      <>
        <span>Task content remains available</span>
        <NotificationErrorBoundary>
          <BrokenNotification />
        </NotificationErrorBoundary>
      </>
    )
  })

  expect(container.textContent).toContain('Task content remains available')
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'This message could not be displayed.'
  )
  expect(container.querySelector('button')?.textContent).toBe('Retry')
  act(() => root.unmount())
  consoleError.mockRestore()
})

it('allows retry after a refresh failure', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const refresh = vi.fn().mockRejectedValueOnce(new Error('refresh failed'))
  const getState = vi.spyOn(useNotificationInboxStore, 'getState').mockReturnValue({
    refresh
  } as ReturnType<typeof useNotificationInboxStore.getState>)
  const BrokenNotification = (): React.JSX.Element => {
    throw new Error('damaged notification')
  }
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  act(() => {
    root.render(
      <NotificationErrorBoundary>
        <BrokenNotification />
      </NotificationErrorBoundary>
    )
  })

  await act(async () => {
    fireEvent.click(container.querySelector('button')!)
  })
  expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(false)
  await act(async () => {
    fireEvent.click(container.querySelector('button')!)
  })
  expect(refresh).toHaveBeenCalledTimes(2)

  getState.mockRestore()
  consoleError.mockRestore()
  act(() => root.unmount())
})
