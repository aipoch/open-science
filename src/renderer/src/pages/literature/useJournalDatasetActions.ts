import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  journalDatasetLabel,
  type JournalDataset,
  type JournalResult
} from '../../../../shared/journal-attributes'
import { refreshJournalAttributes } from './journal-attribute-store'
import { exportJournalBundle } from './journal-bundle'
import { useJournalEditing } from './useJournalEditing'

/** Own revision-checked dataset removal and cancellable bundle export. */
export function useJournalDatasetActions({
  dataset,
  cancelled: cancelledRef,
  setBusy,
  setError,
  catalogGeneration: catalogGenerationRef,
  api,
  setDatasets,
  setSelected,
  setFieldDraft,
  setOffset,
  setQuery,
  setSortField,
  setMessage,
  fail,
  mounted,
  busy
}: {
  dataset: JournalDataset | undefined
  cancelled: React.RefObject<boolean>
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
  setError: React.Dispatch<React.SetStateAction<string>>
  catalogGeneration: React.RefObject<number>
  api: typeof window.api.literature.journals
  setDatasets: React.Dispatch<React.SetStateAction<JournalDataset[]>>
  setSelected: React.Dispatch<React.SetStateAction<string>>
  setFieldDraft: ReturnType<typeof useJournalEditing>['setFieldDraft']
  setOffset: React.Dispatch<React.SetStateAction<number>>
  setQuery: React.Dispatch<React.SetStateAction<string>>
  setSortField: React.Dispatch<React.SetStateAction<string | undefined>>
  setMessage: React.Dispatch<React.SetStateAction<string>>
  fail: (error: unknown) => void
  mounted: React.RefObject<boolean>
  busy: boolean
}): {
  confirmRemove: boolean
  setConfirmRemove: React.Dispatch<React.SetStateAction<boolean>>
  removal: JournalResult['removal']
  remove: () => Promise<void>
  reviewRemoval: () => Promise<void>
  exportBundle: () => Promise<void>
} {
  const { t } = useTranslation()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removal, setRemoval] = useState<JournalResult['removal']>()
  const remove = async (): Promise<void> => {
    if (!dataset || !removal) return
    cancelledRef.current = false
    setBusy(true)
    setError('')
    catalogGenerationRef.current++
    try {
      const result = await api({
        action: 'remove',
        expectedRemovalDigest: removal.digest,
        datasetId: dataset.id,
        expectedRevision: dataset.revision
      })
      setDatasets(result.datasets ?? [])
      setSelected(result.datasets?.[0]?.id ?? '')
      setFieldDraft(undefined)
      setOffset(0)
      setQuery('')
      setSortField(undefined)
      setMessage('')
      setConfirmRemove(false)
      refreshJournalAttributes()
    } catch (error) {
      setRemoval(undefined)
      setConfirmRemove(false)
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const reviewRemoval = async (): Promise<void> => {
    if (!dataset) return
    setBusy(true)
    setError('')
    setRemoval(undefined)
    try {
      const result = await api({
        action: 'remove-preview',
        datasetId: dataset.id,
        expectedRevision: dataset.revision
      })
      if (mounted.current) {
        setRemoval(result.removal)
        setConfirmRemove(true)
      }
    } catch (error) {
      fail(error)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const exportBundle = async (): Promise<void> => {
    if (!dataset || busy) return
    setBusy(true)
    setError('')
    cancelledRef.current = false
    try {
      const bytes = await exportJournalBundle(
        api,
        dataset,
        () => cancelledRef.current || !mounted.current
      )
      await window.api.saveBlobFile({
        suggestedName: `${journalDatasetLabel(dataset).replace(/[\\/:*?"<>|]/g, '-')}.journal.json`,
        mimeType: 'application/json',
        data: bytes.buffer
      })
    } catch {
      if (mounted.current && !cancelledRef.current)
        setError(t('Could not export this journal bundle. Reload the dataset and try again.'))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return { confirmRemove, setConfirmRemove, removal, remove, reviewRemoval, exportBundle }
}
