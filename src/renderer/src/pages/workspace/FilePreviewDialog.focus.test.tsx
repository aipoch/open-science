// @vitest-environment jsdom
import { act, useState, useImperativeHandle, type Ref } from 'react'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { PreviewFileSurfaceHandle } from './PreviewFileSurface'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('./PreviewFileSurface', () => ({
  PreviewFileSurface: ({
    ref,
    onClose
  }: {
    ref: Ref<PreviewFileSurfaceHandle>
    onClose: () => void
  }) => {
    useImperativeHandle(ref, () => ({
      requestLeave: (action: () => void) => {
        action()
        return true
      }
    }))
    return (
      <>
        <input aria-label="Preview text" />
        <button id="close" onClick={onClose}>
          Close preview
        </button>
      </>
    )
  }
}))
import { FilePreviewDialog } from './FilePreviewDialog'
const item: PreviewFileItem = {
  id: 'p1',
  projectId: 'p1',
  sessionId: 's1',
  type: 'file',
  title: 'report.pdf',
  name: 'report.pdf',
  path: '/audit/report.pdf',
  format: 'pdf',
  source: 'artifact'
}
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
function App({
  triggerState = 'normal'
}: {
  triggerState?: 'normal' | 'removed' | 'disabled'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      {triggerState !== 'removed' && (
        <button id="card" disabled={triggerState === 'disabled'} onClick={() => setOpen(true)}>
          Preview report.pdf
        </button>
      )}
      <button id="fallback">Files</button>
      <FilePreviewDialog
        onFocusFallback={() => container.querySelector<HTMLButtonElement>('#fallback')?.focus()}
        item={open ? item : undefined}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
it.each(['normal', 'removed', 'disabled'] as const)(
  'close restoration with %s original card',
  async (triggerState) => {
    await act(async () => root.render(<App />))
    const original = container.querySelector<HTMLButtonElement>('#card')!
    await act(async () => {
      original.focus()
      original.click()
    })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.inert).toBe(true)
    if (triggerState !== 'normal')
      await act(async () => root.render(<App triggerState={triggerState} />))
    const close = document.body.querySelector<HTMLButtonElement>('#close')!
    await act(async () => {
      close.focus()
      close.click()
      await new Promise((r) => setTimeout(r, 30))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(container.inert).toBe(false)
    if (triggerState === 'normal') expect(document.activeElement).toBe(original)
    else expect(document.activeElement).toBe(container.querySelector('#fallback'))
  }
)
it('IME composing Escape leaves preview open', async () => {
  await act(async () => root.render(<App />))
  await act(async () => container.querySelector<HTMLButtonElement>('#card')!.click())
  const field = document.body.querySelector('input')!
  await act(async () => {
    field.focus()
    field.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
        cancelable: true
      })
    )
  })
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.activeElement).toBe(field)
})
