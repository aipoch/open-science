// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./PreviewFileSurface', () => ({
  PreviewFileSurface: ({ item, onClose }: { item: PreviewFileItem; onClose: () => void }) => (
    <button type="button" data-testid="preview-surface" onClick={onClose}>
      {item.title}
    </button>
  )
}))

import { FilePreviewDialog } from './FilePreviewDialog'

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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('FilePreviewDialog Escape dismissal', () => {
  it('closes the artifact preview when Escape is pressed from its content', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(<FilePreviewDialog item={item} onClose={onClose} />))

    const surface = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="preview-surface"]'
    )
    surface?.focus()
    await act(async () => {
      surface?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })

    expect(onClose).toHaveBeenCalledOnce()
  })
})
