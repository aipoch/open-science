// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const contentSpy = vi.fn()
const rootSpy = vi.fn()
const focusScopeSpy = vi.fn()

vi.mock('@radix-ui/react-focus-scope', () => ({
  FocusScope: ({
    children,
    trapped
  }: PropsWithChildren<{ trapped?: boolean }>): React.JSX.Element => {
    focusScopeSpy({ trapped })
    return <div data-testid="focus-scope">{children}</div>
  }
}))

vi.mock('radix-ui', () => ({
  Dialog: {
    Root: ({ open, modal, children }: PropsWithChildren<{ open?: boolean; modal?: boolean }>) => {
      rootSpy({ open, modal })
      return (
        <div data-testid="dialog-root" data-open={String(open)}>
          {children}
        </div>
      )
    },
    Portal: ({ children }: PropsWithChildren) => <>{children}</>,
    Content: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
      contentSpy(props)
      return (
        <div role="dialog" {...props}>
          {children}
        </div>
      )
    },
    Title: ({ children }: PropsWithChildren) => <h2>{children}</h2>
  }
}))

vi.mock('./PreviewFileSurface', () => ({
  PreviewFileSurface: ({ item }: { item: PreviewFileItem }) => (
    <div data-testid="preview-surface">{item.title}</div>
  )
}))

import { FilePreviewDialog } from './FilePreviewDialog'

let container: HTMLDivElement
let root: Root

const item: PreviewFileItem = {
  id: 'preview-1',
  sessionId: 'session-1',
  type: 'file',
  title: 'report.pdf',
  name: 'report.pdf',
  path: '/workspace/report.pdf',
  format: 'pdf',
  source: 'artifact'
}

beforeEach(() => {
  contentSpy.mockClear()
  rootSpy.mockClear()
  focusScopeSpy.mockClear()
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('FilePreviewDialog closing lifecycle', () => {
  it('retains the last file surface while the controlled dialog closes', () => {
    act(() => root.render(<FilePreviewDialog item={item} onClose={vi.fn()} />))
    act(() => root.render(<FilePreviewDialog item={undefined} onClose={vi.fn()} />))

    expect(container.querySelector('[data-testid="dialog-root"]')?.getAttribute('data-open')).toBe(
      'false'
    )
    expect(container.querySelector('[data-testid="preview-surface"]')?.textContent).toBe(
      'report.pdf'
    )
  })

  it('keeps the fullscreen chrome modal behavior without outside dismissal', () => {
    act(() => root.render(<FilePreviewDialog item={item} onClose={vi.fn()} />))

    expect(rootSpy).toHaveBeenCalledWith(expect.objectContaining({ modal: false }))
    expect(focusScopeSpy).toHaveBeenCalledWith({ trapped: true })

    const onInteractOutside = contentSpy.mock.calls[0]?.[0].onInteractOutside as
      ((event: { preventDefault: () => void }) => void) | undefined
    const preventDefault = vi.fn()
    onInteractOutside?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('releases its focus trap while a nested Streamdown fullscreen is open', async () => {
    act(() => root.render(<FilePreviewDialog item={item} onClose={vi.fn()} />))

    const nestedOverlay = document.createElement('div')
    nestedOverlay.dataset.streamdown = 'table-fullscreen'
    await act(async () => {
      document.body.appendChild(nestedOverlay)
      await Promise.resolve()
    })

    expect(focusScopeSpy).toHaveBeenLastCalledWith({ trapped: false })
    nestedOverlay.remove()
  })

  it('isolates the background until the closing animation finishes', () => {
    act(() => root.render(<FilePreviewDialog item={item} onClose={vi.fn()} />))
    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(container.inert).toBe(true)

    act(() => root.render(<FilePreviewDialog item={undefined} onClose={vi.fn()} />))
    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(container.inert).toBe(true)

    const onAnimationEnd = contentSpy.mock.calls.at(-1)?.[0].onAnimationEnd as
      ((event: { currentTarget: EventTarget; target: EventTarget }) => void) | undefined
    const content = container.querySelector('[role="dialog"]')
    act(() => onAnimationEnd?.({ currentTarget: content!, target: content! }))

    expect(container.hasAttribute('aria-hidden')).toBe(false)
    expect(container.inert).toBe(false)
  })

  it('keeps the background isolated until every open preview finishes closing', () => {
    const renderDialogs = (firstOpen: boolean, secondOpen: boolean): void => {
      act(() =>
        root.render(
          <>
            <FilePreviewDialog item={firstOpen ? item : undefined} onClose={vi.fn()} />
            <FilePreviewDialog
              item={secondOpen ? { ...item, id: 'preview-2' } : undefined}
              onClose={vi.fn()}
            />
          </>
        )
      )
    }

    renderDialogs(true, true)
    renderDialogs(false, true)

    const contents = container.querySelectorAll('[role="dialog"]')
    const firstOnAnimationEnd = contentSpy.mock.calls.at(-2)?.[0].onAnimationEnd as
      ((event: { currentTarget: EventTarget; target: EventTarget }) => void) | undefined
    act(() => firstOnAnimationEnd?.({ currentTarget: contents[0]!, target: contents[0]! }))

    expect(container.inert).toBe(true)
    expect(container.getAttribute('aria-hidden')).toBe('true')
  })
})
