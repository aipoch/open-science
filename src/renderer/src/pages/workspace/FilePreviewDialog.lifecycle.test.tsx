// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('radix-ui', () => ({
  Dialog: {
    Root: ({ open, children }: PropsWithChildren<{ open?: boolean }>) => (
      <div data-testid="dialog-root" data-open={String(open)}>
        {children}
      </div>
    ),
    Portal: ({ children }: PropsWithChildren) => <>{children}</>,
    Overlay: () => <div />,
    Content: ({ children }: PropsWithChildren) => <div role="dialog">{children}</div>,
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
  container = document.createElement('div')
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
})
