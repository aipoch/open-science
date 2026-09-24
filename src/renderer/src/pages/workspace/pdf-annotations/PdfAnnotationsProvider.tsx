import { useTagStore } from '@/stores/tag-store'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { PDF_ANNOTATION_LIMITS } from '../../../../../shared/pdf-annotations'
import {
  indexPdfAnnotations,
  pdfAnnotationSourceKey as sourceKey,
  EMPTY_PDF_ANNOTATIONS
} from './pdf-annotation-index'
import type { PdfAnnotation, PdfAnnotationSource } from '../../../../../shared/pdf-annotations'
import {
  PdfAnnotationsContext,
  unavailableError,
  type PdfAnnotationPort
} from './pdf-annotations-context'

type Change = Readonly<{ before?: PdfAnnotation; after?: PdfAnnotation }>
type Runtime = {
  scopeKey: string
  active: boolean
  items: Map<string, PdfAnnotation>
  overlays: Map<string, PdfAnnotation | null>
  undo: Change[]
  redo: Change[]
  queue: Promise<unknown>
  pending: number
}
const HISTORY_LIMIT = 100
const changeSource = (change: Change): PdfAnnotationSource =>
  (change.after ?? change.before)!.target.source
const sortAnnotations = (annotations: readonly PdfAnnotation[]): PdfAnnotation[] =>
  [...annotations].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  )
const metadata = (
  annotation: PdfAnnotation
): { note: string; color: PdfAnnotation['color'] | null; tagIds: string[] } => ({
  note: annotation.note,
  color: annotation.color ?? null,
  tagIds: annotation.tagIds
})

type ScopeState = Readonly<{
  key: string
  annotations: readonly PdfAnnotation[]
  source?: PdfAnnotationSource
  loading: boolean
  loadError?: string
  pending: number
  undoSources: readonly string[]
  redoSources: readonly string[]
}>

const PdfAnnotationsStateProvider = ({
  projectId,
  sessionId,
  literatureVersionId,
  sourceFileId,
  versionId,
  loadAnnotations = true,
  writable = true,
  children
}: React.PropsWithChildren<{
  projectId?: string
  sessionId?: string
  literatureVersionId?: string
  sourceFileId?: string
  versionId?: string
  loadAnnotations?: boolean
  writable?: boolean
}>): React.JSX.Element => {
  const scopeKey = literatureVersionId
    ? `literature:${literatureVersionId}`
    : projectId
      ? `${projectId}\u0000${sessionId ?? ''}\u0000${sourceFileId ?? ''}\u0000${versionId ?? ''}`
      : ''
  const scope = useMemo(
    () => (literatureVersionId ? { literatureVersionId } : { projectId, sessionId }),
    [literatureVersionId, projectId, sessionId]
  )
  // Keep each scope's asynchronous work attached to its own runtime. A previous
  // request may settle after the scope changes, but must never mutate the new one.
  const runtime = useMemo<Runtime>(
    () => ({
      scopeKey,
      active: false,
      items: new Map(),
      overlays: new Map(),
      undo: [],
      redo: [],
      queue: Promise.resolve(),
      pending: 0
    }),
    [scopeKey]
  )
  const [state, setState] = useState<ScopeState>({
    key: scopeKey,
    annotations: [],
    loading: Boolean(scopeKey) && loadAnnotations,
    pending: 0,
    undoSources: [],
    redoSources: []
  })
  if (state.key !== scopeKey)
    setState({
      key: scopeKey,
      annotations: [],
      loading: Boolean(scopeKey) && loadAnnotations,
      pending: 0,
      undoSources: [],
      redoSources: []
    })
  const [loadAttempt, setLoadAttempt] = useState(0)
  useEffect(() => {
    const current = runtime
    // This per-scope runtime is an intentional mutable queue, not React state.
    // eslint-disable-next-line react-hooks/immutability
    current.active = true
    return () => {
      current.active = false
    }
  }, [runtime])

  const publish = useCallback(
    (annotationsChanged = false): void => {
      if (!runtime.active) return
      setState((current) =>
        current.key !== scopeKey
          ? current
          : {
              ...current,
              annotations: annotationsChanged
                ? sortAnnotations([...runtime.items.values()])
                : current.annotations,
              pending: runtime.pending,
              undoSources: runtime.undo.map((change) => sourceKey(changeSource(change))),
              redoSources: runtime.redo.map((change) => sourceKey(changeSource(change)))
            }
      )
    },
    [runtime, scopeKey]
  )

  useEffect(() => {
    let active = true
    // eslint-disable-next-line react-hooks/immutability
    runtime.overlays = new Map()
    if (!scopeKey || !loadAnnotations) return
    const load = async (): Promise<void> => {
      let cursor: { createdAt: string; id: string } | undefined
      const loaded = new Map<string, PdfAnnotation>()
      let source: PdfAnnotationSource | undefined
      do {
        const result = await window.api.pdfAnnotations.list({
          ...scope,
          sourceFileId,
          versionId,
          cursor,
          limit: PDF_ANNOTATION_LIMITS.pageSize
        })
        if (!active) return
        source ??=
          result.source ?? (sourceFileId && versionId ? result.items[0]?.target.source : undefined)
        for (const item of result.items) loaded.set(item.id, item)
        cursor = result.nextCursor
      } while (cursor)
      for (const [id, overlay] of runtime.overlays) {
        if (overlay) loaded.set(id, overlay)
        else loaded.delete(id)
      }
      // A refreshed external edit invalidates this document's local inverse commands.
      const changedSources = new Set<string>()
      let annotationsChanged = false
      for (const id of new Set([...runtime.items.keys(), ...loaded.keys()])) {
        const previous = runtime.items.get(id)
        const current = loaded.get(id)
        if (previous?.updatedAt !== current?.updatedAt)
          changedSources.add(sourceKey((current ?? previous)!.target.source))
        // Global tag deletion can change associations without changing the note's
        // update token; repaint it without discarding compatible undo history.
        if (
          previous?.updatedAt !== current?.updatedAt ||
          previous?.tagIds.join('\u0000') !== current?.tagIds.join('\u0000')
        )
          annotationsChanged = true
      }
      runtime.undo = runtime.undo.filter(
        (change) => !changedSources.has(sourceKey(changeSource(change)))
      )
      runtime.redo = runtime.redo.filter(
        (change) => !changedSources.has(sourceKey(changeSource(change)))
      )
      runtime.items = loaded
      setState((previous) =>
        previous.key !== scopeKey
          ? previous
          : {
              key: scopeKey,
              annotations: annotationsChanged
                ? sortAnnotations([...loaded.values()])
                : previous.annotations,
              source:
                source === undefined || JSON.stringify(source) === JSON.stringify(previous.source)
                  ? previous.source
                  : source,
              loading: false,
              pending: runtime.pending,
              undoSources: runtime.undo.map((change) => sourceKey(changeSource(change))),
              redoSources: runtime.redo.map((change) => sourceKey(changeSource(change)))
            }
      )
    }
    void load().catch((error: unknown) => {
      if (!active) return
      setState((current) =>
        current.key !== scopeKey
          ? current
          : {
              ...current,
              loading: false,
              loadError:
                error instanceof Error ? error.message : 'PDF annotations could not be loaded.'
            }
      )
    })
    return () => {
      active = false
    }
  }, [loadAttempt, scope, runtime, scopeKey, loadAnnotations, sourceFileId, versionId])

  const retryLoad = useCallback(() => {
    if (!runtime.active) return
    setState((current) =>
      current.key !== scopeKey
        ? current
        : {
            ...current,
            loading: Boolean(scopeKey) && loadAnnotations,
            loadError: undefined
          }
    )
    setLoadAttempt((attempt) => attempt + 1)
  }, [scopeKey, loadAnnotations, runtime])

  useEffect(() => {
    if (!loadAnnotations || !scopeKey) return
    if (useTagStore.getState().status === 'idle') void useTagStore.getState().load()
    let active = true
    let queued = false
    const refresh = (): void => {
      if (queued) return
      queued = true
      void runtime.queue.finally(() => {
        queued = false
        if (active) setLoadAttempt((attempt) => attempt + 1)
      })
    }
    // Assignment writes emit pdfAnnotations.onChanged with a CAS token. Only global Tag
    // deletion needs projection here; an older Tag snapshot must not overwrite a newer save.
    let knownTags = useTagStore.getState().tags
    const stopTagState = useTagStore.subscribe((next) => {
      if (next.status !== 'ready') return
      const ids = new Set(next.tags.map((tag) => tag.id))
      const removed = new Set(knownTags.filter((tag) => !ids.has(tag.id)).map((tag) => tag.id))
      knownTags = next.tags
      if (!removed.size) return
      void runtime.queue.then(() => {
        if (!active) return
        let changed = false
        for (const [id, annotation] of runtime.items) {
          const tagIds = annotation.tagIds.filter((tagId) => !removed.has(tagId))
          if (tagIds.length === annotation.tagIds.length) continue
          const updated = { ...annotation, tagIds }
          runtime.items.set(id, updated)
          runtime.overlays.set(id, updated)
          changed = true
        }
        if (changed) publish(true)
      })
    })
    const stopTags = window.api.tags?.onChanged?.(() => {
      void useTagStore.getState().load()
    })
    const stopAnnotations = window.api.pdfAnnotations?.onChanged?.((event) => {
      const other = event.scope
      if (
        other.literatureVersionId !== scope.literatureVersionId ||
        other.projectId !== scope.projectId
      )
        return
      const reconcile = async (): Promise<void> => {
        if (!active) return
        if (event.id && runtime.items.get(event.id)?.updatedAt === event.updatedAt) return
        if (!event.id) {
          refresh()
          return
        }
        const result = await window.api.pdfAnnotations.list({
          ...scope,
          sourceFileId,
          versionId,
          id: event.id,
          limit: 1
        })
        if (!active) return
        const previous = runtime.items.get(event.id)
        const next = result.items[0]
        if (!previous && !next) return
        if (
          previous?.updatedAt === next?.updatedAt &&
          previous?.tagIds.join('\u0000') === next?.tagIds.join('\u0000')
        )
          return
        if (previous?.updatedAt !== next?.updatedAt) {
          const key = sourceKey((next ?? previous)!.target.source)
          runtime.undo = runtime.undo.filter((change) => sourceKey(changeSource(change)) !== key)
          runtime.redo = runtime.redo.filter((change) => sourceKey(changeSource(change)) !== key)
        }
        if (next) runtime.items.set(event.id, next)
        else runtime.items.delete(event.id)
        runtime.overlays.set(event.id, next ?? null)
        publish(true)
      }
      // Remote reconciliation and local commands share the queue: a slow read cannot overwrite a later save.
      runtime.queue = runtime.queue.then(reconcile).catch(() => {
        if (active) refresh()
      })
    })
    const stopLiterature = literatureVersionId
      ? window.api.literature?.onChanged?.((event) => {
          if (!event || event.itemIds === undefined || event.itemIds.length > 0) refresh()
        })
      : undefined
    return () => {
      active = false
      stopTagState()
      stopTags?.()
      stopAnnotations?.()
      stopLiterature?.()
    }
  }, [
    scope,
    scopeKey,
    loadAnnotations,
    sourceFileId,
    versionId,
    literatureVersionId,
    publish,
    runtime
  ])

  // Serialize local writes, including history replay, so each command captures the committed prior value.
  const enqueue = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      if (!scopeKey || !writable || !runtime.active) return Promise.reject(unavailableError())
      // eslint-disable-next-line react-hooks/immutability
      runtime.pending += 1
      publish()
      const task = runtime.queue
        .then(async () => {
          if (!runtime.active) throw unavailableError()
          return operation()
        })
        .finally(() => {
          runtime.pending -= 1
          publish()
        })
      runtime.queue = task.catch(() => {})
      return task
    },
    [scopeKey, writable, runtime, publish]
  )

  const commit = useCallback(
    (id: string, annotation?: PdfAnnotation): void => {
      if (!runtime.active) return
      runtime.overlays.set(id, annotation ?? null)
      if (annotation) runtime.items.set(id, annotation)
      else runtime.items.delete(id)
      publish(true)
    },
    [runtime, publish]
  )

  const record = useCallback(
    (before?: PdfAnnotation, after?: PdfAnnotation): void => {
      if (!runtime.active || (!before && !after)) return
      if (before && after && JSON.stringify(metadata(before)) === JSON.stringify(metadata(after)))
        return
      const change = { before, after }
      // eslint-disable-next-line react-hooks/immutability
      runtime.undo = [...runtime.undo, change].slice(-HISTORY_LIMIT)
      runtime.redo = runtime.redo.filter(
        (entry) => sourceKey(changeSource(entry)) !== sourceKey(changeSource(change))
      )
    },
    [runtime]
  )

  const create = useCallback<PdfAnnotationPort['create']>(
    (id, target, kind, color, tagIds, note) =>
      enqueue(async () => {
        const before = runtime.items.get(id)
        const created = await window.api.pdfAnnotations.create({
          id,
          ...scope,
          target,
          kind,
          color,
          tagIds: [...tagIds],
          note
        })
        record(before, created)
        commit(id, created)
        return created
      }),
    [enqueue, runtime, scope, record, commit]
  )

  const update = useCallback<PdfAnnotationPort['update']>(
    (id, input) =>
      enqueue(async () => {
        const before = runtime.items.get(id)
        if (!before) throw new Error('PDF annotation not found. Reload annotations and try again.')
        const next = {
          note: input.note ?? before.note,
          color: input.color === undefined ? (before.color ?? null) : input.color,
          tagIds: input.tagIds ?? before.tagIds
        }
        if (JSON.stringify(metadata(before)) === JSON.stringify(next)) return before
        const updated = await window.api.pdfAnnotations.update({
          ...scope,
          id,
          ...input,
          tagIds: input.tagIds ? [...input.tagIds] : undefined,
          expectedUpdatedAt: before.updatedAt
        })
        record(before, updated)
        commit(id, updated)
        return updated
      }),
    [enqueue, runtime, scope, record, commit]
  )

  const remove = useCallback<PdfAnnotationPort['remove']>(
    (id) =>
      enqueue(async () => {
        const before = runtime.items.get(id)
        if (!before) throw new Error('PDF annotation not found. Reload annotations and try again.')
        const result = await window.api.pdfAnnotations.delete({
          ...scope,
          id,
          expectedUpdatedAt: before.updatedAt
        })
        if (result.deleted) {
          record(before)
          commit(id)
        }
        return result.deleted
      }),
    [enqueue, runtime, scope, record, commit]
  )

  const replay = useCallback(
    (source: PdfAnnotationSource, direction: 'undo' | 'redo'): Promise<void> =>
      enqueue(async () => {
        const stack = runtime[direction]
        const index = stack.findLastIndex(
          (change) => sourceKey(changeSource(change)) === sourceKey(source)
        )
        const change = stack[index]
        if (!change) return
        const from = direction === 'undo' ? change.after : change.before
        const to = direction === 'undo' ? change.before : change.after
        const id = (from ?? to)!.id
        const current = runtime.items.get(id)
        if (current?.updatedAt !== from?.updatedAt)
          throw new Error('PDF annotation changed. Reload annotations and try again.')
        // Global Tag deletion is authoritative, including when replaying older local history.
        const liveTags = to
          ? new Set((await window.api.tags.snapshot()).tags.map(({ id }) => id))
          : undefined
        const tagIds = to?.tagIds.filter((id) => liveTags!.has(id)) ?? []
        let result: PdfAnnotation | undefined
        if (!to) {
          await window.api.pdfAnnotations.delete({
            ...scope,
            id,
            expectedUpdatedAt: from!.updatedAt
          })
        } else if (!from) {
          result = await window.api.pdfAnnotations.create({
            id,
            ...scope,
            target: to.target,
            kind: to.kind,
            color: to.color,
            origin: to.origin,
            externalSubtype: to.externalSubtype,
            tagIds,
            note: to.note,
            createdAt: to.createdAt,
            createdInSessionId: to.sessionId ?? null
          })
        } else {
          result = await window.api.pdfAnnotations.update({
            ...scope,
            id,
            ...metadata(to),
            tagIds,
            expectedUpdatedAt: from.updatedAt
          })
        }
        if (!runtime.active) return
        runtime[direction] = runtime[direction].filter((entry) => entry !== change)
        const inverse = direction === 'undo' ? 'redo' : 'undo'
        runtime[inverse] = [
          ...runtime[inverse],
          direction === 'undo'
            ? { before: result, after: change.after }
            : { before: change.before, after: result }
        ].slice(-HISTORY_LIMIT)
        // Advance adjacent history entries to the restored record's fresh update token.
        for (const entry of runtime[direction]) {
          const adjacent = direction === 'undo' ? entry.after : entry.before
          if (
            adjacent?.id === id &&
            result &&
            JSON.stringify({
              ...metadata(adjacent),
              tagIds: adjacent.tagIds.filter((id) => liveTags!.has(id))
            }) === JSON.stringify(metadata(result))
          ) {
            const at = runtime[direction].indexOf(entry)
            runtime[direction][at] =
              direction === 'undo' ? { ...entry, after: result } : { ...entry, before: result }
          }
        }
        commit(id, result)
      }),
    [enqueue, runtime, scope, commit]
  )

  const index = useMemo(() => indexPdfAnnotations(state.annotations), [state.annotations])
  const value = useMemo<PdfAnnotationPort>(
    () => ({
      document:
        literatureVersionId || versionId
          ? { sourceFileId, versionId: (literatureVersionId ?? versionId)! }
          : undefined,
      scoped: Boolean(scopeKey),
      sessionId,
      source: state.key === scopeKey ? state.source : undefined,
      available: Boolean(scopeKey) && writable,
      annotations: state.key === scopeKey ? state.annotations : [],
      forSource: (source) =>
        source
          ? (index.get(sourceKey(source))?.annotations ?? EMPTY_PDF_ANNOTATIONS)
          : EMPTY_PDF_ANNOTATIONS,
      forPage: (source, page) =>
        source
          ? (index.get(sourceKey(source))?.pages.get(page) ?? EMPTY_PDF_ANNOTATIONS)
          : EMPTY_PDF_ANNOTATIONS,
      total: state.key === scopeKey ? state.annotations.length : 0,
      loading: state.key === scopeKey ? state.loading : Boolean(scopeKey) && loadAnnotations,
      loadError: state.key === scopeKey ? state.loadError : undefined,
      history: (source) => ({
        canUndo: state.undoSources.includes(sourceKey(source)),
        canRedo: state.redoSources.includes(sourceKey(source)),
        busy: state.pending > 0
      }),
      undo: (source) => replay(source, 'undo'),
      redo: (source) => replay(source, 'redo'),
      retryLoad,
      create,
      update,
      remove
    }),
    [
      scopeKey,
      sessionId,
      writable,
      state,
      index,
      replay,
      retryLoad,
      create,
      update,
      remove,
      sourceFileId,
      versionId,
      literatureVersionId,
      loadAnnotations
    ]
  )
  return <PdfAnnotationsContext.Provider value={value}>{children}</PdfAnnotationsContext.Provider>
}
const PdfAnnotationsProvider = ({
  projectId,
  sessionId,
  literatureVersionId,
  sourceFileId,
  versionId,
  ...props
}: React.ComponentProps<typeof PdfAnnotationsStateProvider>): React.JSX.Element => (
  <PdfAnnotationsStateProvider
    sourceFileId={sourceFileId}
    versionId={versionId}
    literatureVersionId={literatureVersionId}
    projectId={projectId}
    sessionId={sessionId}
    {...props}
  />
)
export { PdfAnnotationsProvider }
