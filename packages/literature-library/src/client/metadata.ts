import type {
  LiteratureMetadataCompletionRequest,
  LiteratureMetadataField
} from '@aipoch/literature-discovery/contracts'
import type {
  LiteratureCatalogCommand,
  LiteratureCatalogReceipt,
  LiteratureItemInput,
  LiteratureItemView,
  LiteratureMetadataCompletionResult
} from '../contracts.js'
import type { LiteratureDetailController } from './detail.js'
export type LiteratureMetadataIdentifier = { scheme: 'doi' | 'pmid'; value: string }
export type DetailMode =
  | 'view'
  | 'edit'
  | 'complete'
  | 'citation'
  | 'full-text'
  | 'supplements'
  | 'related'
  | 'publication-check'
export type MetadataSnapshot = {
  mode: DetailMode
  editBase?: LiteratureItemView
  awaitingReload: boolean
  saving: boolean
  error?: string
  completion?: LiteratureMetadataCompletionResult
  completing: boolean
  completionError?: { itemId: string; message: string }
  overwriteFields: ReadonlySet<LiteratureMetadataField>
}
export type LiteratureMetadata = {
  getSnapshot: () => MetadataSnapshot
  subscribe: (listener: () => void) => () => void
  start: () => () => void
  changeMode: (next: DetailMode) => void
  externallyUpdated: () => boolean
  reloadSaved: () => Promise<void>
  save: (item: LiteratureItemInput) => Promise<void>
  complete: (
    operation: 'commit' | 'preview',
    nextIdentifier?: LiteratureMetadataIdentifier
  ) => Promise<void>
  resetCompletion: () => void
  loadLatest: () => void
  toggleOverwrite: (field: LiteratureMetadataField) => void
}

export function createLiteratureMetadata(
  controller: LiteratureDetailController,
  options: {
    transact(command: LiteratureCatalogCommand): Promise<LiteratureCatalogReceipt>
    completeMetadata(
      request: LiteratureMetadataCompletionRequest
    ): Promise<LiteratureMetadataCompletionResult>
    onItemChange(item: LiteratureItemView): void
    messages(): { reload: string; update: string; complete: string }
  }
): LiteratureMetadata {
  let editBase: LiteratureItemView | undefined,
    awaitingReload = false,
    mode: DetailMode = 'view',
    saving = false,
    error: string | undefined,
    completion: LiteratureMetadataCompletionResult | undefined,
    completing = false,
    completionError: { itemId: string; message: string } | undefined,
    overwriteFields = new Set<LiteratureMetadataField>()
  const requestRef = { current: 0 },
    completionRequestRef = { current: 0 },
    identifierRef: { current: LiteratureMetadataIdentifier | undefined } = { current: undefined }
  const listeners = new Set<() => void>()
  const snapshot = (): MetadataSnapshot => ({
    mode,
    editBase,
    awaitingReload,
    saving,
    error,
    completion,
    completing,
    completionError,
    overwriteFields
  })
  let currentSnapshot = snapshot()
  const publish = (): void => {
    currentSnapshot = snapshot()
    for (const listener of listeners) listener()
  }
  const setEditBase = (value: LiteratureItemView | undefined): void => {
    editBase = value
    publish()
  }
  const setAwaitingReload = (value: boolean): void => {
    awaitingReload = value
    publish()
  }
  const setMode = (value: DetailMode): void => {
    mode = value
    publish()
  }
  const setSaving = (value: boolean): void => {
    saving = value
    publish()
  }
  const setError = (value: string | undefined): void => {
    error = value
    publish()
  }
  const setCompletion = (value: LiteratureMetadataCompletionResult | undefined): void => {
    completion = value
    publish()
  }
  const setCompleting = (value: boolean): void => {
    completing = value
    publish()
  }
  const setCompletionError = (value: { itemId: string; message: string } | undefined): void => {
    completionError = value
    publish()
  }
  const setOverwriteFields = (
    value:
      | Set<LiteratureMetadataField>
      | ((previous: Set<LiteratureMetadataField>) => Set<LiteratureMetadataField>)
  ): void => {
    overwriteFields = typeof value === 'function' ? value(overwriteFields) : value
    publish()
  }
  const resetCompletion = (): void => {
    completionRequestRef.current += 1
    setCompleting(false)
    setCompletion(undefined)
    setCompletionError(undefined)
    setOverwriteFields((current) => (current.size === 0 ? current : new Set()))
    identifierRef.current = undefined
  }

  const changeMode = (next: DetailMode): void => {
    requestRef.current += 1
    setSaving(false)
    setAwaitingReload(false)
    setEditBase(next === 'edit' ? controller.getSnapshot().item : undefined)
    setError(undefined)
    if (next === 'complete' || next === 'view') resetCompletion()
    setMode(next)
  }

  const start = (): (() => void) => {
    let previous = controller.getSnapshot()
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getSnapshot()
      const openingChanged = next.generation !== previous.generation
      const revisionChanged = next.item?.metadataRevision !== previous.item?.metadataRevision
      previous = next
      if (openingChanged) changeMode('view')
      else if (revisionChanged) resetCompletion()
    })
    return () => {
      unsubscribe()
      requestRef.current += 1
      completionRequestRef.current += 1
    }
  }

  const externallyUpdated = (): boolean =>
    Boolean(
      editBase &&
      (controller.getSnapshot().item?.metadataRevision ?? -1) > editBase.metadataRevision
    )

  const reloadSaved = async (): Promise<void> => {
    const current = controller.getSnapshot()
    if (!current.item || saving) return
    const request = ++requestRef.current
    const active = (): boolean =>
      controller.getSnapshot().generation === current.generation && requestRef.current === request
    setSaving(true)
    try {
      const updated = await controller.read(current.item.id)
      if (!updated) throw new Error('Literature Item is unavailable after updating.')
      options.onItemChange(updated)
      controller.replace(updated)
      if (active()) changeMode('view')
    } catch {
      if (active()) setError(options.messages().reload)
    } finally {
      if (active()) setSaving(false)
    }
  }

  const save = async (item: LiteratureItemInput): Promise<void> => {
    const current = editBase
    if (!current || saving || awaitingReload || externallyUpdated()) return
    const generation = controller.getSnapshot().generation
    const request = ++requestRef.current
    const active = (): boolean =>
      controller.getSnapshot().generation === generation &&
      controller.getSnapshot().item?.id === current.id &&
      requestRef.current === request
    setSaving(true)
    setError(undefined)
    let persisted = false
    try {
      await options.transact({
        kind: 'update-item',
        itemId: current.id,
        expectedMetadataRevision: current.metadataRevision,
        item
      })
      persisted = true
      const updated = await controller.read(current.id)
      if (!updated) throw new Error('Literature Item is unavailable after updating.')
      options.onItemChange(updated)
      controller.replace(updated)
      if (active()) changeMode('view')
    } catch {
      if (active()) {
        setAwaitingReload(persisted)
        setError(persisted ? options.messages().reload : options.messages().update)
      }
      if (!persisted) {
        // Read the conflicting version without rebasing the user's whole draft onto it.
        try {
          const latest = await controller.read(current.id)
          if (latest) {
            options.onItemChange(latest)
            controller.replace(latest)
          }
        } catch {
          /* Keep the draft and original error when the follow-up read also fails. */
        }
      }
    } finally {
      if (active()) setSaving(false)
    }
  }

  const complete = async (
    operation: 'commit' | 'preview',
    nextIdentifier?: LiteratureMetadataIdentifier
  ): Promise<void> => {
    const current = controller.getSnapshot().item
    const identifier = nextIdentifier ?? identifierRef.current
    if (!current || !identifier?.value || completing) return
    const generation = controller.getSnapshot().generation
    const request = ++completionRequestRef.current
    const active = (): boolean =>
      controller.getSnapshot().generation === generation &&
      controller.getSnapshot().item?.id === current.id &&
      controller.getSnapshot().item?.metadataRevision === current.metadataRevision &&
      completionRequestRef.current === request
    identifierRef.current = identifier
    setCompleting(true)
    setCompletionError(undefined)
    try {
      const result = await options.completeMetadata(
        operation === 'preview'
          ? { mode: operation, itemId: current.id, identifier }
          : {
              mode: operation,
              itemId: current.id,
              expectedMetadataRevision: current.metadataRevision,
              reviewToken: completion?.reviewToken,
              identifier,
              overwriteFields: [...overwriteFields]
            }
      )
      if (result.mode === 'commit') {
        const showResult = active()
        // Publishing the saved revision invalidates its preview; retain the successful receipt.
        controller.replace(result.item)
        options.onItemChange(result.item)
        const published = controller.getSnapshot()
        if (
          showResult &&
          published.generation === generation &&
          published.item?.id === current.id &&
          published.item.metadataRevision === result.item.metadataRevision
        )
          setCompletion(result)
      } else if (active()) {
        setCompletion(result)
        setOverwriteFields(new Set())
      }
    } catch {
      if (active()) setCompletionError({ itemId: current.id, message: options.messages().complete })
    } finally {
      if (active()) setCompleting(false)
    }
  }

  return {
    getSnapshot: () => currentSnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start,
    changeMode,
    externallyUpdated,
    reloadSaved,
    save,
    complete,
    resetCompletion,
    loadLatest: () => {
      setEditBase(controller.getSnapshot().item)
      setError(undefined)
    },
    toggleOverwrite: (field: LiteratureMetadataField) =>
      setOverwriteFields((current) => {
        const next = new Set(current)
        if (next.has(field)) next.delete(field)
        else next.add(field)
        return next
      })
  }
}
