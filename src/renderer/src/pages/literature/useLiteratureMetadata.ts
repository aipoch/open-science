import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  LiteratureItemInput,
  LiteratureItemView,
  LiteratureMetadataCompletionResult,
  LiteratureMetadataField
} from '../../../../shared/literature'
import type { LiteratureDetailController } from './LiteratureDetailController'
import type { LiteratureMetadataIdentifier } from './LiteratureMetadataLookup'

type DetailMode = 'view' | 'edit' | 'complete' | 'citation' | 'full-text'

const useLiteratureMetadata = (
  controller: LiteratureDetailController,
  onItemChange: (item: LiteratureItemView) => void
): {
  mode: DetailMode
  changeMode: (mode: DetailMode) => void
  saving: boolean
  editBase?: LiteratureItemView
  awaitingReload: boolean
  externallyUpdated: () => boolean
  reloadSaved: () => Promise<void>
  loadLatest: () => void
  error?: string
  completion?: LiteratureMetadataCompletionResult
  completing: boolean
  completionError?: { itemId: string; message: string }
  overwriteFields: ReadonlySet<LiteratureMetadataField>
  resetCompletion: () => void
  toggleOverwrite: (field: LiteratureMetadataField) => void
  save: (item: LiteratureItemInput) => Promise<void>
  complete: (mode: 'commit' | 'preview', identifier?: LiteratureMetadataIdentifier) => Promise<void>
} => {
  const { t } = useTranslation()
  const [editBase, setEditBase] = useState<LiteratureItemView>()
  const [awaitingReload, setAwaitingReload] = useState(false)
  const requestRef = useRef(0)
  const completionRequestRef = useRef(0)
  const [mode, setMode] = useState<DetailMode>('view')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [completion, setCompletion] = useState<LiteratureMetadataCompletionResult>()
  const [completing, setCompleting] = useState(false)
  const [completionError, setCompletionError] = useState<{ itemId: string; message: string }>()
  const [overwriteFields, setOverwriteFields] = useState<Set<LiteratureMetadataField>>(
    () => new Set()
  )
  const identifierRef = useRef<LiteratureMetadataIdentifier>(undefined)

  const resetCompletion = useCallback((): void => {
    completionRequestRef.current += 1
    setCompleting(false)
    setCompletion(undefined)
    setCompletionError(undefined)
    setOverwriteFields((current) => (current.size === 0 ? current : new Set()))
    identifierRef.current = undefined
  }, [])

  const changeMode = useCallback(
    (next: DetailMode): void => {
      requestRef.current += 1
      setSaving(false)
      setAwaitingReload(false)
      setEditBase(next === 'edit' ? controller.getSnapshot().item : undefined)
      setError(undefined)
      if (next === 'complete' || next === 'view') resetCompletion()
      setMode(next)
    },
    [controller, resetCompletion]
  )

  useLayoutEffect(() => {
    let generation = controller.getSnapshot().generation
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getSnapshot().generation
      if (next === generation) return
      generation = next
      changeMode('view')
    })
    return () => {
      unsubscribe()
      requestRef.current += 1
      completionRequestRef.current += 1
    }
  }, [controller, changeMode])

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
      const updated = await window.api.literature.get(current.item.id)
      if (!updated) throw new Error('Literature Item is unavailable after updating.')
      onItemChange(updated)
      if (active()) {
        controller.replace(updated)
        changeMode('view')
      }
    } catch {
      if (active()) setError(t('The reference was saved, but could not be reloaded.'))
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
      await window.api.literature.transact({
        kind: 'update-item',
        itemId: current.id,
        expectedMetadataRevision: current.metadataRevision,
        item
      })
      persisted = true
      const updated = await window.api.literature.get(current.id)
      if (!updated) throw new Error('Literature Item is unavailable after updating.')
      onItemChange(updated)
      if (active()) {
        controller.replace(updated)
        changeMode('view')
      }
    } catch {
      if (active()) {
        setAwaitingReload(persisted)
        setError(
          persisted
            ? t('The reference was saved, but could not be reloaded.')
            : t('Literature could not be updated.')
        )
      }
      if (!persisted) {
        // Read the conflicting version without rebasing the user's whole draft onto it.
        try {
          const latest = await window.api.literature.get(current.id)
          if (latest) {
            onItemChange(latest)
            if (active()) controller.replace(latest)
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
      completionRequestRef.current === request
    identifierRef.current = identifier
    setCompleting(true)
    setCompletionError(undefined)
    try {
      const result = await window.api.literature.completeMetadata(
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
      if (active()) {
        setCompletion(result)
        if (result.mode === 'preview') setOverwriteFields(new Set())
      }
      if (result.mode === 'commit') {
        if (active()) controller.replace(result.item)
        onItemChange(result.item)
      }
    } catch {
      if (active())
        setCompletionError({ itemId: current.id, message: t('Metadata could not be completed.') })
    } finally {
      if (active()) setCompleting(false)
    }
  }

  return {
    mode,
    editBase,
    awaitingReload,
    externallyUpdated,
    reloadSaved,
    loadLatest: () => {
      setEditBase(controller.getSnapshot().item)
      setError(undefined)
    },
    changeMode,
    saving,
    error,
    completion,
    completing,
    completionError,
    overwriteFields,
    resetCompletion,
    toggleOverwrite: (field) =>
      setOverwriteFields((current) => {
        const next = new Set(current)
        if (next.has(field)) next.delete(field)
        else next.add(field)
        return next
      }),
    save,
    complete
  }
}

export { useLiteratureMetadata }
