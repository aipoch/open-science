// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

import { WorkspaceCollapsiblePanel } from './WorkspaceCollapsiblePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ResizeCallback = (entries: Array<{ borderBoxSize: Array<{ blockSize: number }> }>) => void

let container: HTMLDivElement
let root: Root
let resizeCallback: ResizeCallback | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // The shared jsdom polyfill stubs ResizeObserver as a no-op; this suite drives it explicitly.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeCallback) {
        resizeCallback = callback
      }
      observe(): void {
        /* measurements are delivered manually via resizeCallback */
      }
      unobserve(): void {
        /* no-op */
      }
      disconnect(): void {
        /* no-op */
      }
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  act(() => root.unmount())
  container.remove()
})

const renderPanel = (isOpen: boolean): void => {
  root.render(
    <WorkspaceCollapsiblePanel isOpen={isOpen}>
      <div data-testid="panel-content">details</div>
    </WorkspaceCollapsiblePanel>
  )
}

const panelElement = (): HTMLElement | null =>
  container.querySelector('[data-testid="panel-content"]')?.parentElement
    ?.parentElement as HTMLElement | null

describe('WorkspaceCollapsiblePanel', () => {
  it('tweens the outer height when inner content resizes after mount', async () => {
    act(() => renderPanel(true))
    expect(container.querySelector('[data-testid="panel-content"]')).not.toBeNull()

    // Initial observation: the panel settles at the measured content height.
    act(() => resizeCallback?.([{ borderBoxSize: [{ blockSize: 120 }] }]))
    await waitFor(() => expect(panelElement()?.style.height).toBe('120px'))

    // An inner input/output disclosure opens: content grows and the outer panel follows.
    act(() => resizeCallback?.([{ borderBoxSize: [{ blockSize: 320 }] }]))
    await waitFor(() => expect(panelElement()?.style.height).toBe('320px'))

    // …and shrinks back when it closes.
    act(() => resizeCallback?.([{ borderBoxSize: [{ blockSize: 120 }] }]))
    await waitFor(() => expect(panelElement()?.style.height).toBe('120px'))
  })

  it('keeps the exit collapse animation with measured heights', async () => {
    act(() => renderPanel(true))
    act(() => resizeCallback?.([{ borderBoxSize: [{ blockSize: 200 }] }]))
    await waitFor(() => expect(panelElement()?.style.height).toBe('200px'))

    act(() => renderPanel(false))
    await waitFor(() => expect(container.querySelector('[data-testid="panel-content"]')).toBeNull())
  })
})
