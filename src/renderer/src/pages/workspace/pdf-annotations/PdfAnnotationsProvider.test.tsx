// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PdfAnnotationsProvider } from './PdfAnnotationsProvider'
import { usePdfAnnotations, type PdfAnnotationPort } from './pdf-annotations-context'
import type { PdfAnnotation, PdfAnnotationListResult } from '../../../../../shared/pdf-annotations'

const annotation: PdfAnnotation = {
  id: 'a1',
  projectId: 'p1',
  sessionId: 's1',
  version: 1,
  origin: 'user',
  kind: 'document-note',
  tagIds: [],
  note: 'Saved',
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
  target: {
    source: {
      kind: 'literature-attachment-version',
      projectId: 'p1',
      sourceFileId: 'f1',
      versionId: 'v1',
      checksum: 'a'.repeat(64),
      name: 'paper.pdf',
      path: 'literature-attachment-version:v1'
    },
    selector: { kind: 'document-note', coordinateVersion: 1 }
  }
}
let root: Root
let container: HTMLDivElement
let port: PdfAnnotationPort
const Probe = (): null => {
  const value = usePdfAnnotations()
  useEffect(() => {
    port = value
  }, [value])
  return null
}
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const mount = async (sessionId = 's1'): Promise<void> => {
  window.api.tags ??= {
    snapshot: vi.fn().mockResolvedValue({ revision: 1, tags: [], assignments: [] })
  } as unknown as Window['api']['tags']
  await act(async () =>
    root.render(
      <PdfAnnotationsProvider projectId="p1" sessionId={sessionId}>
        <Probe />
      </PdfAnnotationsProvider>
    )
  )
}
it('keeps writes committed during a stale paged load', async () => {
  const load = deferred<PdfAnnotationListResult>()
  window.api = {
    pdfAnnotations: {
      list: vi.fn(() => load.promise),
      create: vi.fn().mockResolvedValue(annotation),
      update: vi.fn(),
      delete: vi.fn(),
      importNative: vi.fn(),
      cancelImport: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
      onImportProgress: vi.fn(() => () => undefined)
    }
  } as unknown as Window['api']
  await mount()
  await act(async () => {
    await port.create('a1', annotation.target, 'document-note', undefined, [], 'Saved')
  })
  await act(async () => load.resolve({ items: [], total: 0 }))
  expect(port.annotations).toEqual([annotation])
  expect(port.total).toBe(1)
})
it('does not publish a pending write into a different Session', async () => {
  const save = deferred<PdfAnnotation>()
  window.api = {
    pdfAnnotations: {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      create: vi.fn(() => save.promise),
      update: vi.fn(),
      delete: vi.fn(),
      importNative: vi.fn(),
      cancelImport: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
      onImportProgress: vi.fn(() => () => undefined)
    }
  } as unknown as Window['api']
  await mount()
  let pending!: Promise<PdfAnnotation>
  await act(async () => {
    pending = port.create('a1', annotation.target, 'document-note', undefined, [], 'Saved')
  })
  await mount('s2')
  await act(async () => {
    save.resolve(annotation)
    await pending
  })
  expect(port.annotations).toEqual([])
  expect(port.total).toBe(0)
})
it('preserves list failures for retry instead of treating them as an empty notebook', async () => {
  const list = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ items: [annotation], total: 1 })
  window.api = {
    pdfAnnotations: {
      list,
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      importNative: vi.fn(),
      cancelImport: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
      onImportProgress: vi.fn(() => () => undefined)
    }
  } as unknown as Window['api']
  await mount()
  expect(port.loadError).toBe('offline')
  await act(async () => port.retryLoad())
  expect(port.loadError).toBeUndefined()
  expect(port.annotations).toEqual([annotation])
})

const installStore = (initial: PdfAnnotation[] = []): Map<string, PdfAnnotation> => {
  const items = new Map(initial.map((item) => [item.id, item]))
  let tick = 0
  const timestamp = (): string => new Date(Date.UTC(2026, 8, 20, 0, 0, ++tick)).toISOString()
  window.api = {
    pdfAnnotations: {
      list: vi.fn(async () => ({ items: [...items.values()], total: items.size })),
      create: vi.fn(async (request) => {
        const { createdAt, ...content } = request
        const stamp = timestamp()
        const item: PdfAnnotation = {
          ...content,
          origin: content.origin ?? 'user',
          version: 1,
          createdAt: createdAt ?? stamp,
          updatedAt: stamp
        }
        items.set(item.id, item)
        return item
      }),
      update: vi.fn(async ({ id, expectedUpdatedAt, color, note, tagIds }) => {
        const current = items.get(id)!
        if (!current || current.updatedAt !== expectedUpdatedAt) throw new Error('conflict')
        const item = {
          ...current,
          note: note ?? current.note,
          color: color === undefined ? current.color : (color ?? undefined),
          tagIds: tagIds ?? current.tagIds,
          updatedAt: timestamp()
        }
        items.set(id, item)
        return item
      }),
      delete: vi.fn(async ({ id, expectedUpdatedAt }) => {
        if (items.get(id)?.updatedAt !== expectedUpdatedAt) throw new Error('conflict')
        return { deleted: items.delete(id) }
      }),
      importNative: vi.fn(),
      cancelImport: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
      onImportProgress: vi.fn(() => () => undefined)
    }
  } as Pick<Window['api'], 'pdfAnnotations'> as Window['api']
  return items
}

it('ignores its own commit and other scopes, but reloads externally changed annotations', async () => {
  const items = installStore([annotation])
  await mount()
  const notify = vi.mocked(window.api.pdfAnnotations.onChanged).mock.calls[0][0]
  const list = vi.mocked(window.api.pdfAnnotations.list)
  expect(list).toHaveBeenCalledTimes(1)
  await act(async () => {
    await port.update('a1', { note: 'Local edit' })
    notify({
      scope: { projectId: 'p1', sessionId: 's1' },
      id: 'a1',
      updatedAt: items.get('a1')!.updatedAt
    })
    notify({ scope: { projectId: 'p1', sessionId: 'another-session' } })
  })
  expect(list).toHaveBeenCalledTimes(1)
  expect(port.history(annotation.target.source).canUndo).toBe(true)
  const remote = {
    ...items.get('a1')!,
    note: 'External edit',
    updatedAt: '2026-09-21T00:00:00.000Z'
  }
  items.set('a1', remote)
  await act(async () => {
    notify({ scope: { projectId: 'p1', sessionId: 's1' }, id: 'a1', updatedAt: remote.updatedAt })
  })
  expect(list).toHaveBeenCalledTimes(2)
  expect(port.annotations[0].note).toBe('External edit')
  expect(port.history(annotation.target.source).canUndo).toBe(false)
})

it('undoes and redoes create, edit and deletion without changing identity, anchors or creation time', async () => {
  installStore()
  await mount()
  const source = annotation.target.source
  let original!: PdfAnnotation
  await act(async () => {
    original = await port.create('a1', annotation.target, 'document-note', undefined, [], 'Saved')
  })
  await act(async () => {
    await port.update('a1', { note: 'Edited', color: 'pink', tagIds: ['review'] })
  })
  await act(async () => {
    await port.remove('a1')
  })
  expect(port.annotations).toEqual([])
  await act(async () => {
    await port.undo(source)
  })
  expect(port.annotations[0]).toMatchObject({
    id: 'a1',
    note: 'Edited',
    createdAt: original.createdAt,
    target: original.target
  })
  await act(async () => {
    await port.undo(source)
  })
  expect(port.annotations[0]).toMatchObject({ note: 'Saved', color: undefined, tagIds: [] })
  await act(async () => {
    await port.undo(source)
  })
  expect(port.annotations).toEqual([])
  expect(port.history(source).canUndo).toBe(false)
  for (let index = 0; index < 3; index++)
    await act(async () => {
      await port.redo(source)
    })
  expect(port.annotations).toEqual([])
  expect(port.history(source)).toMatchObject({ canUndo: true, canRedo: false, busy: false })
})

it('preserves native provenance when undoing deletion and replaying it again', async () => {
  const imported = { ...annotation, origin: 'imported' as const, externalSubtype: 'Text' }
  installStore([imported])
  await mount()
  await act(async () => {
    await port.remove(imported.id)
  })
  await act(async () => {
    await port.undo(imported.target.source)
  })
  expect(port.annotations[0]).toMatchObject({ origin: 'imported', externalSubtype: 'Text' })
  await act(async () => {
    await port.redo(imported.target.source)
  })
  await act(async () => {
    await port.undo(imported.target.source)
  })
  expect(port.annotations[0]).toMatchObject({ origin: 'imported', externalSubtype: 'Text' })
})

it('isolates document history and clears only that document redo after a new edit', async () => {
  installStore([annotation])
  await mount()
  const other = {
    ...annotation.target,
    source: { ...annotation.target.source, versionId: 'v2', checksum: 'b'.repeat(64) }
  }
  await act(async () => {
    await port.create('a2', other, 'document-note', undefined, [], 'Other')
  })
  await act(async () => {
    await port.update('a1', { note: 'Changed' })
  })
  await act(async () => {
    await port.undo(other.source)
  })
  expect(port.annotations).toHaveLength(1)
  expect(port.annotations[0].note).toBe('Changed')
  await act(async () => {
    await port.update('a1', { note: 'Changed again' })
  })
  expect(port.history(other.source).canRedo).toBe(true)
  await act(async () => {
    await port.create('a3', other, 'document-note', undefined, [], 'Replacement')
  })
  expect(port.history(other.source).canRedo).toBe(false)
  await mount('s2')
  expect(port.history(other.source)).toEqual({ canUndo: false, canRedo: false, busy: false })
})

it('retains failed history and prevents stale undo from overwriting a newer stored edit', async () => {
  const items = installStore([annotation])
  await mount()
  await act(async () => {
    await port.update('a1', { note: 'Changed' })
  })
  const latest = {
    ...items.get('a1')!,
    note: 'Another window',
    updatedAt: '2026-09-21T00:00:00.000Z'
  }
  items.set('a1', latest)
  await act(async () => {
    await expect(port.undo(annotation.target.source)).rejects.toThrow('conflict')
  })
  expect(items.get('a1')).toEqual(latest)
  expect(port.history(annotation.target.source)).toMatchObject({
    canUndo: true,
    canRedo: false,
    busy: false
  })
  await act(async () => {
    port.retryLoad()
  })
  expect(port.annotations[0]).toEqual(latest)
  expect(port.history(annotation.target.source).canUndo).toBe(false)
})

it('serializes rapid updates against the committed token and captures each prior value', async () => {
  installStore([annotation])
  await mount()
  await act(async () => {
    await Promise.all([port.update('a1', { note: 'First' }), port.update('a1', { note: 'Second' })])
  })
  expect(port.annotations[0].note).toBe('Second')
  await act(async () => {
    await port.undo(annotation.target.source)
  })
  expect(port.annotations[0].note).toBe('First')
  await act(async () => {
    await port.undo(annotation.target.source)
  })
  expect(port.annotations[0].note).toBe('Saved')
})

it('does not replay an undo twice when a refresh completes during the write', async () => {
  installStore([annotation])
  await mount()
  await act(async () => {
    await port.update('a1', { note: 'Changed' })
  })
  const gate = deferred<void>()
  const update = vi.mocked(window.api.pdfAnnotations.update)
  const apply = update.getMockImplementation()!
  update.mockImplementationOnce(async (request) => {
    await gate.promise
    return apply(request)
  })
  let pending!: Promise<void>
  await act(async () => {
    pending = port.undo(annotation.target.source)
  })
  await act(async () => {
    port.retryLoad()
  })
  await act(async () => {
    gate.resolve()
    await pending
  })
  expect(port.annotations[0].note).toBe('Saved')
  expect(port.history(annotation.target.source)).toEqual({
    canUndo: false,
    canRedo: true,
    busy: false
  })
})

it('preserves list and document snapshot identity while only busy state changes', async () => {
  installStore([annotation])
  await mount()
  expect(window.api.pdfAnnotations.list).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 100 })
  )
  const before = port.annotations
  const document = port.forSource(annotation.target.source)
  const save = deferred<PdfAnnotation>()
  vi.mocked(window.api.pdfAnnotations.update).mockImplementationOnce(() => save.promise)
  let pending!: Promise<PdfAnnotation>
  await act(async () => {
    pending = port.update('a1', { note: 'Changed' })
  })
  expect(port.history(annotation.target.source).busy).toBe(true)
  expect(port.annotations).toBe(before)
  expect(port.forSource(annotation.target.source)).toBe(document)
  await act(async () => {
    save.resolve({ ...annotation, note: 'Changed', updatedAt: '2026-09-20T00:00:00.000Z' })
    await pending
  })
  expect(port.annotations).not.toBe(before)
  expect(port.forSource(annotation.target.source)[0].note).toBe('Changed')
  expect(port.history(annotation.target.source).busy).toBe(false)
})

it('undoes through a globally deleted Tag without restoring that Tag or breaking adjacent history', async () => {
  installStore()
  await mount()
  const source = annotation.target.source
  await act(async () => {
    await port.create('a1', annotation.target, 'document-note', undefined, ['removed'], 'Keep note')
  })
  await act(async () => {
    await port.update('a1', { note: 'Changed' })
  })
  await act(async () => {
    await port.remove('a1')
  })
  await act(async () => {
    await port.undo(source)
  })
  expect(port.annotations[0]).toMatchObject({ note: 'Changed', tagIds: [] })
  await act(async () => {
    await port.undo(source)
  })
  expect(port.annotations[0]).toMatchObject({ note: 'Keep note', tagIds: [] })
  await act(async () => {
    await port.undo(source)
  })
  expect(port.annotations).toEqual([])
})

it('refreshes after its own change notification without discarding newly committed undo history', async () => {
  installStore()
  let notify: ((event: { revision: number }) => void) | undefined
  window.api.tags = {
    snapshot: vi.fn().mockResolvedValue({ revision: 1, tags: [], assignments: [] }),
    onChanged: (listener: (event: { revision: number }) => void) => {
      notify = listener
      return () => {
        notify = undefined
      }
    }
  } as unknown as Window['api']['tags']
  const create = vi.mocked(window.api.pdfAnnotations.create)
  const apply = create.getMockImplementation()!
  create.mockImplementation(async (request) => {
    const result = await apply(request)
    notify?.({ revision: 1 })
    return result
  })
  await mount()
  await act(async () => {
    await port.create('a1', annotation.target, 'document-note', undefined, [], 'Saved')
  })
  expect(port.history(annotation.target.source).canUndo).toBe(true)
  await act(async () => {
    await port.undo(annotation.target.source)
  })
  expect(port.annotations).toEqual([])
})

it('uses the shared Literature version scope for writes and history without a Session', async () => {
  const global = {
    ...annotation,
    projectId: undefined,
    sessionId: undefined,
    literatureVersionId: 'v1',
    target: { ...annotation.target, source: { ...annotation.target.source, projectId: undefined } }
  }
  window.api = {
    pdfAnnotations: {
      list: vi.fn().mockResolvedValue({ items: [], total: 0, source: global.target.source }),
      create: vi.fn().mockResolvedValue(global),
      delete: vi.fn().mockResolvedValue({ deleted: true })
    },
    tags: { snapshot: vi.fn().mockResolvedValue({ revision: 1, tags: [], assignments: [] }) }
  } as unknown as Window['api']
  await act(async () =>
    root.render(
      <PdfAnnotationsProvider literatureVersionId="v1">
        <Probe />
      </PdfAnnotationsProvider>
    )
  )
  expect(port.available).toBe(true)
  expect(port.source).toEqual(global.target.source)
  expect(window.api.pdfAnnotations.list).toHaveBeenCalledWith(
    expect.objectContaining({ literatureVersionId: 'v1' })
  )
  await act(async () => {
    await port.create('a1', global.target, 'document-note', undefined, [], 'Saved')
  })
  expect(window.api.pdfAnnotations.create).toHaveBeenCalledWith(
    expect.objectContaining({ literatureVersionId: 'v1' })
  )
  expect(vi.mocked(window.api.pdfAnnotations.create).mock.calls[0][0].projectId).toBeUndefined()
  await act(async () => {
    await port.undo(global.target.source)
  })
  expect(window.api.pdfAnnotations.delete).toHaveBeenCalledWith({
    literatureVersionId: 'v1',
    id: 'a1',
    expectedUpdatedAt: annotation.updatedAt
  })
})

it('reuses unchanged refresh snapshots but publishes globally removed tag associations', async () => {
  installStore([annotation])
  await mount()
  const before = port.annotations
  const document = port.forSource(annotation.target.source)
  vi.mocked(window.api.pdfAnnotations.list).mockResolvedValue({
    items: [{ ...annotation, tagIds: [...annotation.tagIds] }],
    total: 1
  })
  await act(async () => {
    port.retryLoad()
    await Promise.resolve()
  })
  expect(port.annotations).toBe(before)
  expect(port.forSource(annotation.target.source)).toBe(document)
  vi.mocked(window.api.pdfAnnotations.list).mockResolvedValue({
    items: [{ ...annotation, tagIds: ['new-tag'] }],
    total: 1
  })
  await act(async () => {
    port.retryLoad()
    await Promise.resolve()
  })
  expect(port.annotations).not.toBe(before)
  expect(port.annotations[0].tagIds).toEqual(['new-tag'])
})
