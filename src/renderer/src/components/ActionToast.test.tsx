// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActionToast } from './ActionToast'

describe('ActionToast', () => {
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

  it('runs its action and pauses automatic dismissal while focused', async () => {
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    await act(async () =>
      root.render(
        <ActionToast
          title="Connector needs sign-in"
          detail="OAuth MCP"
          actionLabel="Open Connectors"
          dismissLabel="Dismiss"
          onAction={onAction}
          onDismiss={onDismiss}
          autoDismissMs={6000}
        />
      )
    )

    const action = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open Connectors'
    )
    act(() => action?.focus())
    action?.click()
    expect(onAction).toHaveBeenCalledOnce()

    await act(async () => vi.advanceTimersByTime(6000))
    expect(onDismiss).not.toHaveBeenCalled()

    act(() => action?.blur())
    await act(async () => vi.advanceTimersByTime(6000))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('keeps its dismissal deadline when a parent passes a new callback', async () => {
    const onDismiss = vi.fn()
    const renderToast = (): void => {
      root.render(
        <ActionToast
          title="Connector needs sign-in"
          actionLabel="Open Connectors"
          dismissLabel="Dismiss"
          onAction={vi.fn()}
          onDismiss={() => onDismiss()}
          autoDismissMs={6000}
        />
      )
    }
    await act(async () => renderToast())

    await act(async () => vi.advanceTimersByTime(3000))
    await act(async () => renderToast())
    await act(async () => vi.advanceTimersByTime(3000))

    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
