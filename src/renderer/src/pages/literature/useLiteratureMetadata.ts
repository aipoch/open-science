import { useCallback, useRef, useState } from 'react'
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
    setCompletion(undefined)
    setCompletionError(undefined)
    setOverwriteFields((current) => (current.size === 0 ? current : new Set()))
    identifierRef.current = undefined
  }, [])

  const changeMode = useCallback(
    (next: DetailMode): void => {
      setError(undefined)
      if (next === 'complete' || next === 'view') resetCompletion()
      setMode(next)
    },
    [resetCompletion]
  )

  const save = async (item: LiteratureItemInput): Promise<void> => {
    const current = controller.getSnapshot().item
    if (!current || saving) return
    setSaving(true)
    setError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'update-item',
        itemId: current.id,
        expectedMetadataRevision: current.metadataRevision,
        item
      })
      const updated = await window.api.literature.get(current.id)
      if (!updated) throw new Error('Literature Item is unavailable after updating.')
      controller.replace(updated)
      onItemChange(updated)
      if (controller.getSnapshot().item?.id === current.id) setMode('view')
    } catch {
      if (controller.getSnapshot().item?.id === current.id) {
        setError(t('Literature could not be updated.'))
      }
    } finally {
      setSaving(false)
    }
  }

  const complete = async (
    operation: 'commit' | 'preview',
    nextIdentifier?: LiteratureMetadataIdentifier
  ): Promise<void> => {
    const current = controller.getSnapshot().item
    const identifier = nextIdentifier ?? identifierRef.current
    if (!current || !identifier?.value || completing) return
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
              identifier,
              overwriteFields: [...overwriteFields]
            }
      )
      if (controller.getSnapshot().item?.id === current.id) {
        setCompletion(result)
        if (result.mode === 'preview') setOverwriteFields(new Set())
      }
      if (result.mode === 'commit') {
        controller.replace(result.item)
        onItemChange(result.item)
      }
    } catch {
      setCompletionError({ itemId: current.id, message: t('Metadata could not be completed.') })
    } finally {
      setCompleting(false)
    }
  }

  return {
    mode,
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
