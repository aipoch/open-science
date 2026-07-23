// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LifecycleToast } from './LifecycleToast'

describe('LifecycleToast', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('offers the external session action and dismisses automatically', async () => {
    const onDismiss = vi.fn()
    const onView = vi.fn()
    await act(async () =>
      root.render(
        <LifecycleToast
          notice={{ projectId: 'project-1', sessionId: 'session-1', title: 'External session' }}
          onDismiss={onDismiss}
          onView={onView}
        />
      )
    )

    const viewButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'View'
    )
    expect(container.textContent).toContain('External session')
    viewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onView).toHaveBeenCalledOnce()

    await act(async () => vi.advanceTimersByTime(6000))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
