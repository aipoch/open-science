// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
