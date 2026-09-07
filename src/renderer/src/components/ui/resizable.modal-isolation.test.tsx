// @vitest-environment jsdom
import { act, createRef, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './resizable'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-separator') ? 1 : this.hasAttribute('data-panel') ? 500 : 1000
  })
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.id === 'right' || this.hasAttribute('data-separator') ? 500 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const x = this.id === 'right' || this.hasAttribute('data-separator') ? 500 : 0
    return new DOMRect(x, 0, this.hasAttribute('data-separator') ? 1 : 500, 800)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const renderPanels = (props: ComponentProps<typeof ResizablePanelGroup> = {}): void => {
  root.render(
    <ResizablePanelGroup orientation="horizontal" {...props}>
      <ResizablePanel id="left" defaultSize="50%" />
      <ResizableHandle />
      <ResizablePanel id="right" defaultSize="50%" />
    </ResizablePanelGroup>
  )
}

const hoverDivider = (): void => {
  // Native inert retargets pointer events outside the isolated subtree, including to body.
  document.body.dispatchEvent(
    new MouseEvent('pointermove', {
      bubbles: true,
      clientX: 500,
      clientY: 799
    })
  )
}

it('ignores background divider hover while inert and restores resizing after isolation ends', async () => {
  await act(async () => renderPanels())
  await act(async () => hoverDivider())
  expect(container.querySelector('[data-separator]')?.getAttribute('data-separator')).toBe('hover')

  await act(async () => container.setAttribute('inert', ''))
  await act(async () => hoverDivider())
  expect(container.querySelector('[data-separator]')?.getAttribute('data-separator')).not.toBe(
    'hover'
  )
  await act(async () => {
    document.body.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        clientX: 500,
        clientY: 799,
        buttons: 1
      })
    )
  })
  expect(container.querySelector('[data-separator]')?.getAttribute('data-separator')).not.toBe(
    'active'
  )
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
  })

  await act(async () => container.removeAttribute('inert'))
  await act(async () => hoverDivider())
  expect(container.querySelector('[data-separator]')?.getAttribute('data-separator')).toBe('hover')
})

it('preserves an explicit disabled prop after initial inert isolation ends and forwards the element ref', async () => {
  const elementRef = createRef<HTMLDivElement>()
  container.setAttribute('inert', '')
  await act(async () => renderPanels({ disabled: true, elementRef }))
  expect(elementRef.current).toBe(container.querySelector('[data-group]'))
  await act(async () => container.removeAttribute('inert'))
  await act(async () => hoverDivider())
  expect(container.querySelector('[data-separator]')?.getAttribute('data-separator')).not.toBe(
    'hover'
  )

  await act(async () => renderPanels({ elementRef }))
  await act(async () => hoverDivider())
  expect(container.querySelector('[data-separator]')?.getAttribute('data-separator')).toBe('hover')
})

it('keeps a group inside a modal interactive', async () => {
  container.setAttribute('role', 'dialog')
  container.setAttribute('aria-modal', 'true')
  await act(async () => renderPanels())
  await act(async () => hoverDivider())
  expect(container.querySelector('[data-separator]')?.getAttribute('data-separator')).toBe('hover')
})

it('ignores background divider hover while an inline preview is expanded as a modal', async () => {
  await act(async () => renderPanels())
  const dialog = document.createElement('section')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  await act(async () => container.querySelector('#right')!.appendChild(dialog))
  await act(async () => hoverDivider())
  expect(container.querySelector('[data-separator]')?.getAttribute('data-separator')).not.toBe(
    'hover'
  )

  await act(async () => dialog.removeAttribute('aria-modal'))
  await act(async () => hoverDivider())
  expect(container.querySelector('[data-separator]')?.getAttribute('data-separator')).toBe('hover')
})
