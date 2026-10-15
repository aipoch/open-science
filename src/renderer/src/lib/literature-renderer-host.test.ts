import { expect, it, vi } from 'vitest'
import { literatureRendererHost } from './literature-renderer-host'
import type { ManagedPreviewResource } from '../../../shared/preview-resources'

const loaders = vi.hoisted(() => ({ managed: vi.fn(), bytes: vi.fn() }))
vi.mock('@/pages/workspace/previews/managed-pdf-document', () => ({
  createManagedPdfLoadingTask: loaders.managed
}))
vi.mock('@/pages/workspace/previews/pdfjs', () => ({
  pdfjsLib: { getDocument: loaders.bytes }
}))

it('adapts managed capabilities without reading the PDF into renderer memory', async () => {
  const resource = { id: 'leased-pdf', size: 100 } as ManagedPreviewResource
  const task = { promise: Promise.resolve({ numPages: 2 }), destroy: vi.fn() }
  loaders.managed.mockReturnValueOnce(task)
  expect(await literatureRendererHost.loadPdf({ resource })).toBe(task)
  expect(loaders.managed).toHaveBeenCalledExactlyOnceWith(resource)
  expect(loaders.bytes).not.toHaveBeenCalled()
})

it('adapts local bytes to the host PDF loader without a managed resource', async () => {
  loaders.managed.mockClear()
  const data = new Uint8Array([1, 2, 3])
  const task = { promise: Promise.resolve({ numPages: 1 }), destroy: vi.fn() }
  loaders.bytes.mockReturnValueOnce(task)
  expect(await literatureRendererHost.loadPdf({ data })).toBe(task)
  expect(loaders.bytes).toHaveBeenCalledExactlyOnceWith({ data })
  expect(loaders.managed).not.toHaveBeenCalled()
})
