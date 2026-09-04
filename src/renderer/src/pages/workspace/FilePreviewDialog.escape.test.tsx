// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  type PreviewFileItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const previewSurfaceHarness = vi.hoisted(() => ({
  requestLeave: vi.fn<(action: () => void) => boolean>()
}))

vi.mock('./PreviewFileSurface', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  const MockPreviewFileSurface = React.forwardRef<
    { requestLeave: (action: () => void) => boolean },
    { item: PreviewFileItem; onClose: () => void }
  >(({ item, onClose }, ref) => {
    React.useImperativeHandle(ref, () => ({ requestLeave: previewSurfaceHarness.requestLeave }))
    return (
      <button
        type="button"
        data-testid="preview-surface"
        onClick={() => {
          previewSurfaceHarness.requestLeave(onClose)
        }}
      >
        {item.title}
      </button>
    )
  })
  MockPreviewFileSurface.displayName = 'MockPreviewFileSurface'
  return {
    PreviewFileSurface: MockPreviewFileSurface
  }
})

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
  previewSurfaceHarness.requestLeave.mockReset()
  previewSurfaceHarness.requestLeave.mockImplementation((action) => {
    action()
    return true
  })
  previewLeaveGuards.clear()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  previewLeaveGuards.clear()
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

  it('keeps the dialog open when its dirty surface refuses Escape dismissal', async () => {
    previewSurfaceHarness.requestLeave.mockReturnValue(false)
    const onClose = vi.fn()
    await act(async () => root.render(<FilePreviewDialog item={item} onClose={onClose} />))
    const surface = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="preview-surface"]'
    )

    await act(async () => {
      surface?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })

    expect(onClose).not.toHaveBeenCalled()
  })

  it.each([
    ['header', 'click'],
    ['Escape', 'escape']
  ] as const)(
    'uses the real store close chain with one accepted guard for %s dismissal',
    async (_label, action) => {
      const dialogItem = { ...item, projectId: 'project-1' }
      usePreviewWorkbenchStore.getState().openFileDialog(dialogItem)
      await act(async () =>
        root.render(
          <FilePreviewDialog
            item={dialogItem}
            onClose={usePreviewWorkbenchStore.getState().closeFileDialog}
          />
        )
      )
      const surface = document.body.querySelector<HTMLButtonElement>(
        '[data-testid="preview-surface"]'
      )

      await act(async () => {
        if (action === 'click') surface?.click()
        else {
          surface?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
          )
        }
      })

      expect(previewSurfaceHarness.requestLeave).toHaveBeenCalledOnce()
      expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
    }
  )
})
