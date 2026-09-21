// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfAnnotationSource } from '../../../../../shared/pdf-annotations'
import { useNativePdfVisibility } from './use-native-pdf-visibility'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const receipt = { nativeRefs: [{ id: 'native-mark' }] }
const setup = (
  kind: 'upload-version' | 'artifact-version' = 'artifact-version'
): {
  source: PdfAnnotationSource
  list: ReturnType<typeof vi.fn>
  importNative: ReturnType<typeof vi.fn>
  document: PDFDocumentProxy
  setValue: ReturnType<typeof vi.fn>
} => {
  const source: PdfAnnotationSource = {
    kind,
    projectId: 'project',
    sessionId: 'creator',
    sourceFileId: 'file',
    versionId: 'version',
    name: 'paper.pdf',
    path: 'managed',
    checksum: 'a'.repeat(64)
  }
  const list = vi.fn().mockResolvedValue({ items: [], total: 0 })
  const importNative = vi.fn().mockImplementation(async () => {
    list.mockResolvedValue({ items: [], total: 0, nativeImport: receipt })
    return { cancelled: false }
  })
  vi.stubGlobal('api', { pdfAnnotations: { list, importNative } })
  const setValue = vi.fn()
  const document = { annotationStorage: { setValue } } as unknown as PDFDocumentProxy
  return { source, list, importNative, document, setValue }
}

it.each(['upload-version', 'artifact-version'] as const)(
  'imports an existing %s on first preview and hides only imported originals',
  async (kind) => {
    const { source, list, importNative, document, setValue } = setup(kind)
    const { result } = renderHook(() =>
      useNativePdfVisibility(document, source, 'viewer', undefined, true)
    )
    await waitFor(() => expect(result.current).toBe(1))
    expect(importNative).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        sessionId: 'viewer',
        sourceKind: kind,
        sourceFileId: 'file',
        versionId: 'version'
      })
    )
    expect(list).toHaveBeenCalledTimes(2)
    expect(setValue).toHaveBeenCalledWith('native-mark', { noView: true })
  }
)

it('uses creation context when opened directly without an active session', async () => {
  const { source, importNative, document } = setup()
  renderHook(() => useNativePdfVisibility(document, source, undefined, undefined, true))
  await waitFor(() =>
    expect(importNative).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'creator' }))
  )
})

it('does not reimport deleted marks when the document has a durable receipt', async () => {
  const { source, list, importNative, document, setValue } = setup()
  list.mockResolvedValue({ items: [], total: 0, nativeImport: receipt })
  renderHook(() => useNativePdfVisibility(document, source, 'viewer', undefined, true))
  await waitFor(() => expect(setValue).toHaveBeenCalledWith('native-mark', { noView: true }))
  expect(importNative).not.toHaveBeenCalled()
})

it('does not import from a read-only preview', async () => {
  const { source, list, importNative, document } = setup()
  renderHook(() => useNativePdfVisibility(document, source, 'viewer'))
  await waitFor(() => expect(list).toHaveBeenCalledOnce())
  expect(importNative).not.toHaveBeenCalled()
})

it('retains original rendering if import fails', async () => {
  const { source, importNative, document, setValue } = setup()
  importNative.mockRejectedValue(new Error('Source unavailable'))
  renderHook(() => useNativePdfVisibility(document, source, 'viewer', undefined, true))
  await waitFor(() => expect(importNative).toHaveBeenCalledOnce())
  expect(setValue).not.toHaveBeenCalled()
})
