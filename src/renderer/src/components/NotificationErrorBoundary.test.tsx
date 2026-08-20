// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

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

  expect(container.textContent).toBe('Task content remains available')
  act(() => root.unmount())
  consoleError.mockRestore()
})
