// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PdfDocumentSource } from '../../../../../../shared/pdf-bookmarks'
import type { PdfTranslationCheckpoint } from '../../../../../../shared/pdf-translation'
import { usePdfTranslationCheckpoint } from './use-pdf-translation-checkpoint'

const source: PdfDocumentSource = {
  kind: 'upload-version',
  projectId: 'project-1',
  sourceFileId: 'file-1',
  versionId: 'version-1',
  sessionId: 'creator',
  checksum: 'a'.repeat(64),
  name: 'paper.pdf',
  path: 'upload-version:version-1'
}
const checkpoint = (documentSource: PdfDocumentSource): PdfTranslationCheckpoint => ({
  version: 1,
  key: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  documentSource,
  checksum: documentSource.checksum,
  fingerprint: 'fp',
  language: 'Chinese',
  glossary: [],
  targetKey: 'b'.repeat(64),
  model: { frameworkId: 'direct-api', mode: 'api' },
  sources: ['Original paragraph'],
  translatedSourceIndices: [0],
  translations: ['原始段落']
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const runtime = (readCheckpoint: ReturnType<typeof vi.fn>): void => {
  window.api = { pdfTranslation: { readCheckpoint } } as unknown as Window['api']
}

describe('PDF translation recovery source scope', () => {
  it.each(['upload-version', 'artifact-version'] as const)(
    'reads the exact %s source and reuses only its immutable scope',
    async (kind) => {
      const documentSource = { ...source, kind }
      const saved = checkpoint(documentSource)
      const readCheckpoint = vi.fn().mockResolvedValue(saved)
      runtime(readCheckpoint)
      const { result, rerender } = renderHook(
        ({ current }) => usePdfTranslationCheckpoint(current, true),
        { initialProps: { current: documentSource } }
      )
      expect(result.current.loading).toBe(true)
      await waitFor(() => expect(result.current.checkpoint).toEqual(saved))
      expect(readCheckpoint).toHaveBeenCalledWith(documentSource)
      rerender({ current: { ...documentSource, name: 'renamed.pdf', sessionId: 'another-reader' } })
      expect(result.current.loading).toBe(false)
      expect(readCheckpoint).toHaveBeenCalledOnce()
    }
  )

  it.each([
    { projectId: 'another-project' },
    { kind: 'artifact-version' as const },
    { sourceFileId: 'another-file' },
    { versionId: 'another-version' },
    { checksum: 'c'.repeat(64) }
  ])('rejects a checkpoint from another source: %j', async (difference) => {
    runtime(vi.fn().mockResolvedValue(checkpoint({ ...source, ...difference })))
    const { result } = renderHook(() => usePdfTranslationCheckpoint(source, true))
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.checkpoint).toBeUndefined()
    expect(result.current.loading).toBe(false)
  })

  it('retries a failed checkpoint read without reopening the PDF', async () => {
    const readCheckpoint = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary storage failure'))
      .mockResolvedValueOnce(null)
    runtime(readCheckpoint)
    const { result } = renderHook(() => usePdfTranslationCheckpoint(source, true))
    await waitFor(() => expect(result.current.error).toBe(true))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe(false)
    expect(result.current.checkpoint).toBeNull()
    expect(readCheckpoint).toHaveBeenCalledTimes(2)
  })

  it('clears recovery immediately on a source switch and ignores the late old read', async () => {
    const next = { ...source, versionId: 'version-2' }
    let resolveOld!: (value: PdfTranslationCheckpoint) => void
    let resolveNext!: (value: null) => void
    const readCheckpoint = vi
      .fn()
      .mockReturnValueOnce(new Promise((resolve) => (resolveOld = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveNext = resolve)))
    runtime(readCheckpoint)
    const { result, rerender } = renderHook(
      ({ current }) => usePdfTranslationCheckpoint(current, true),
      { initialProps: { current: source } }
    )
    rerender({ current: next })
    expect(result.current.checkpoint).toBeUndefined()
    expect(result.current.loading).toBe(true)
    await act(async () => resolveOld(checkpoint(source)))
    expect(result.current.checkpoint).toBeUndefined()
    await act(async () => resolveNext(null))
    expect(result.current.checkpoint).toBeNull()
    expect(result.current.error).toBe(false)
  })

  it('retains the legacy literature version request', async () => {
    const saved = checkpoint(source)
    delete saved.documentSource
    const readCheckpoint = vi.fn().mockResolvedValue({ ...saved, attachmentVersionId: 'v1' })
    runtime(readCheckpoint)
    const { result } = renderHook(() => usePdfTranslationCheckpoint('v1', true))
    await waitFor(() => expect(result.current.checkpoint?.attachmentVersionId).toBe('v1'))
    expect(readCheckpoint).toHaveBeenCalledWith('v1')
  })

  it('keeps independent reader scopes isolated even when their PDF bytes are identical', async () => {
    const another = { ...source, projectId: 'project-2', sourceFileId: 'file-2' }
    runtime(vi.fn(async (input: PdfDocumentSource) => checkpoint(input)))
    const first = renderHook(({ current }) => usePdfTranslationCheckpoint(current, true), {
      initialProps: { current: source }
    })
    const second = renderHook(() => usePdfTranslationCheckpoint(another, true))
    await waitFor(() => expect(first.result.current.checkpoint?.documentSource).toEqual(source))
    await waitFor(() => expect(second.result.current.checkpoint?.documentSource).toEqual(another))
    first.rerender({ current: another })
    expect(first.result.current.checkpoint).toBeUndefined()
    expect(second.result.current.checkpoint?.documentSource).toEqual(another)
    await waitFor(() => expect(first.result.current.checkpoint?.documentSource).toEqual(another))
  })

  it('does not read unmanaged PDFs or disabled recovery', () => {
    const readCheckpoint = vi.fn()
    runtime(readCheckpoint)
    const { result, rerender } = renderHook(
      ({ enabled }) => usePdfTranslationCheckpoint(undefined, enabled),
      { initialProps: { enabled: true } }
    )
    expect(result.current.loading).toBe(false)
    rerender({ enabled: false })
    expect(readCheckpoint).not.toHaveBeenCalled()
  })
})

describe('saved translation editions', () => {
  const first = {
    id: 'edition-1',
    key: '11111111-1111-4111-8111-111111111111',
    language: 'Chinese',
    glossary: [],
    concurrency: 1 as const,
    model: { frameworkId: 'direct-api', mode: 'api' as const },
    updatedAt: 1
  }
  const second = {
    ...first,
    id: 'edition-2',
    key: '22222222-2222-4222-8222-222222222222',
    language: 'Japanese'
  }
  it('lists multiple editions even without an implicit checkpoint and explicitly selects one', async () => {
    const selectEdition = vi
      .fn()
      .mockResolvedValue({ ...checkpoint(source), key: second.key, language: second.language })
    const listEditions = vi.fn().mockResolvedValue([first, second])
    window.api = {
      pdfTranslation: {
        readCheckpoint: vi.fn().mockResolvedValue(null),
        listEditions,
        selectEdition
      }
    } as never
    const { result } = renderHook(() => usePdfTranslationCheckpoint(source, true))
    await waitFor(() => expect(result.current.editions).toHaveLength(2))
    expect(result.current.checkpoint).toBeNull()
    await act(async () => {
      expect(await result.current.selectEdition(second.id)).toBe(true)
    })
    expect(selectEdition).toHaveBeenCalledWith({ source, translationId: second.id })
    expect(result.current.checkpoint?.key).toBe(second.key)
    act(() => result.current.refreshEditions())
    await waitFor(() => expect(listEditions).toHaveBeenCalledTimes(2))
    expect(result.current.checkpoint?.key).toBe(second.key)
  })

  it('retains the current edition after a selection failure and ignores superseded selections', async () => {
    let resolveOld!: (value: PdfTranslationCheckpoint) => void
    const selectEdition = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve
        })
      )
      .mockResolvedValueOnce({ ...checkpoint(source), key: second.key })
      .mockRejectedValueOnce(new Error('storage failure'))
    window.api = {
      pdfTranslation: {
        readCheckpoint: vi.fn().mockResolvedValue(checkpoint(source)),
        listEditions: vi.fn().mockResolvedValue([first, second]),
        selectEdition
      }
    } as never
    const { result } = renderHook(() => usePdfTranslationCheckpoint(source, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let pending!: Promise<boolean>
    act(() => {
      pending = result.current.selectEdition(first.id)
    })
    await act(async () => {
      await result.current.selectEdition(second.id)
    })
    await act(async () => {
      resolveOld(checkpoint(source))
      expect(await pending).toBe(false)
    })
    expect(result.current.checkpoint?.key).toBe(second.key)
    await act(async () => {
      expect(await result.current.selectEdition(first.id)).toBe(false)
    })
    expect(result.current.checkpoint?.key).toBe(second.key)
    expect(result.current.editionError).toBe(true)
    expect(result.current.selecting).toBe(false)
  })

  it('rejects a late selection after leaving and returning to the same source', async () => {
    let resolveSelection!: (value: PdfTranslationCheckpoint) => void
    window.api = {
      pdfTranslation: {
        readCheckpoint: vi.fn().mockResolvedValue(null),
        listEditions: vi.fn().mockResolvedValue([first]),
        selectEdition: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            resolveSelection = resolve
          })
        )
      }
    } as never
    const { result, rerender } = renderHook(
      ({ current }) => usePdfTranslationCheckpoint(current, true),
      { initialProps: { current: source } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    let pending!: Promise<boolean>
    act(() => {
      pending = result.current.selectEdition(first.id)
    })
    rerender({ current: { ...source, versionId: 'another-version' } })
    rerender({ current: source })
    await act(async () => {
      resolveSelection(checkpoint(source))
      expect(await pending).toBe(false)
    })
    expect(result.current.checkpoint).toBeNull()
    expect(result.current.selecting).toBe(false)
  })
})

it('keeps readable text on delete failure and clears only the deleted selected edition on success', async () => {
  const saved = checkpoint(source)
  const first = {
    id: 'first',
    key: saved.key,
    language: 'Chinese',
    glossary: [],
    concurrency: 1,
    model: saved.model,
    updatedAt: 1
  }
  const second = { ...first, id: 'second', key: 'another-key' }
  const listEditions = vi.fn().mockResolvedValue([first, second])
  const deleteEdition = vi
    .fn()
    .mockRejectedValueOnce(new Error('write failed'))
    .mockResolvedValue(undefined)
  window.api = {
    pdfTranslation: {
      readCheckpoint: vi.fn().mockResolvedValue(saved),
      listEditions,
      deleteEdition
    }
  } as unknown as Window['api']
  const { result } = renderHook(() => usePdfTranslationCheckpoint(source, true))
  await waitFor(() => expect(result.current.editions).toHaveLength(2))
  await act(async () => expect(await result.current.deleteEdition('first')).toBe(false))
  expect(result.current.checkpoint).toEqual(saved)
  listEditions.mockResolvedValue([first])
  await act(async () => expect(await result.current.deleteEdition('second')).toBe(true))
  expect(result.current.checkpoint).toEqual(saved)
  listEditions.mockResolvedValue([])
  vi.mocked(window.api.pdfTranslation!.readCheckpoint).mockResolvedValue(null)
  await act(async () => expect(await result.current.deleteEdition('first')).toBe(true))
  expect(result.current.checkpoint).toBeNull()
  expect(result.current.editions).toHaveLength(0)
  expect(deleteEdition).toHaveBeenLastCalledWith({ source, translationId: 'first' })
})

it('selects the latest remaining edition after deletion and exposes a retry if fallback loading fails', async () => {
  const saved = checkpoint(source)
  const fallback = { ...saved, key: '33333333-3333-4333-8333-333333333333' }
  const readCheckpoint = vi
    .fn()
    .mockResolvedValueOnce(saved)
    .mockResolvedValueOnce(fallback)
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue(null)
  const deleteEdition = vi.fn().mockResolvedValue(undefined)
  window.api = { pdfTranslation: { readCheckpoint, deleteEdition } } as unknown as Window['api']
  const { result } = renderHook(() => usePdfTranslationCheckpoint(source, true))
  await waitFor(() => expect(result.current.checkpoint).toEqual(saved))
  await act(async () => expect(await result.current.deleteEdition('newest')).toBe(true))
  expect(result.current.checkpoint).toEqual(fallback)
  await act(async () => expect(await result.current.deleteEdition('remaining')).toBe(true))
  expect(result.current.error).toBe(true)
  act(() => result.current.retry())
  await waitFor(() => expect(result.current.checkpoint).toBeNull())
})
