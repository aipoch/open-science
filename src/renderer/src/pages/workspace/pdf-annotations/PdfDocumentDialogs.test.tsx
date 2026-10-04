// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PdfAddToLiteratureDialog } from './PdfAddToLiteratureDialog'
import { PdfReconciliationDialog } from './PdfReconciliationDialog'
import type { PdfAnnotationSource } from '../../../../../shared/pdf-annotations'

const source: PdfAnnotationSource = {
  kind: 'upload-version',
  projectId: 'p',
  sessionId: 's',
  sourceFileId: 'file',
  versionId: 'v',
  checksum: 'a'.repeat(64),
  name: 'paper.pdf',
  path: 'upload-version:v'
}
let root: Root, container: HTMLDivElement
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((element) => element.textContent === label)!
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('opens without creating a reference and publishes one verified Add request on submit', async () => {
  const addPdf = vi.fn().mockResolvedValue({}),
    onClose = vi.fn()
  vi.stubGlobal('api', {
    literature: { search: vi.fn().mockResolvedValue({ entries: [] }), addPdf }
  })
  await act(async () => root.render(<PdfAddToLiteratureDialog source={source} onClose={onClose} />))
  expect(addPdf).not.toHaveBeenCalled()
  await act(async () => button('Add to Literature').click())
  expect(addPdf).toHaveBeenCalledExactlyOnceWith({
    source,
    operationId: expect.any(String),
    title: 'paper'
  })
  expect(onClose).toHaveBeenCalledOnce()
})

it('does not create a reference when dismissed', async () => {
  const addPdf = vi.fn(),
    onClose = vi.fn()
  vi.stubGlobal('api', {
    literature: { search: vi.fn().mockResolvedValue({ entries: [] }), addPdf }
  })
  await act(async () => root.render(<PdfAddToLiteratureDialog source={source} onClose={onClose} />))
  const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
  await act(async () => close.click())
  expect(onClose).toHaveBeenCalledOnce()
  expect(addPdf).not.toHaveBeenCalled()
})

it('selects a reference without publishing until the footer action is confirmed', async () => {
  vi.useFakeTimers()
  const addPdf = vi.fn().mockResolvedValue({}),
    onClose = vi.fn()
  vi.stubGlobal('api', {
    literature: {
      search: vi
        .fn()
        .mockResolvedValue({ entries: [{ id: 'reference', item: { title: 'Existing paper' } }] }),
      addPdf
    }
  })
  await act(async () => root.render(<PdfAddToLiteratureDialog source={source} onClose={onClose} />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  await act(async () => button('Existing paper').click())
  expect(addPdf).not.toHaveBeenCalled()
  await act(async () => button('Attach to reference').click())
  expect(addPdf).toHaveBeenCalledExactlyOnceWith({
    source,
    itemId: 'reference',
    operationId: expect.any(String)
  })
  expect(onClose).toHaveBeenCalledOnce()
})

it('cancels from the footer without publishing', async () => {
  const addPdf = vi.fn(),
    onClose = vi.fn()
  vi.stubGlobal('api', {
    literature: { search: vi.fn().mockResolvedValue({ entries: [] }), addPdf }
  })
  await act(async () => root.render(<PdfAddToLiteratureDialog source={source} onClose={onClose} />))
  await act(async () => button('Cancel').click())
  expect(onClose).toHaveBeenCalledOnce()
  expect(addPdf).not.toHaveBeenCalled()
})

it('requires a new preview after a stale historical reconciliation decision', async () => {
  const reconcile = vi
    .fn()
    .mockResolvedValueOnce({ token: 'stale', conflicts: [], shared: false })
    .mockRejectedValueOnce(new Error('stale'))
    .mockResolvedValueOnce(null)
  const onChanged = vi.fn()
  vi.stubGlobal('api', { pdfAnnotations: { reconcile } })
  await act(async () =>
    root.render(<PdfReconciliationDialog source={source} onChanged={onChanged} />)
  )
  await act(async () => button('Resolve historical note conflicts').click())
  await act(async () => button('Apply choices').click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Review the current notes'
  )
  await act(async () => button('Retry').click())
  expect(reconcile.mock.calls.map(([request]) => request.token)).toEqual([
    undefined,
    'stale',
    undefined
  ])
  expect(onChanged).toHaveBeenCalledOnce()
})
