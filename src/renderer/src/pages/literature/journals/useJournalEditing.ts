import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type JournalDataset,
  type JournalField,
  type JournalResult
} from '../../../../../shared/journal-attributes'
import { refreshJournalAttributes } from './journal-attribute-store'

const JOURNAL_IDENTITY_COLUMNS_KEY = 'open-science:journal-identity-columns'
type IdentityColumns = { issn: boolean; externalIds: boolean }
const loadIdentityColumns = (): IdentityColumns => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(JOURNAL_IDENTITY_COLUMNS_KEY) ?? '{}')
    return { issn: stored?.issn !== false, externalIds: stored?.externalIds !== false }
  } catch {
    return { issn: true, externalIds: true }
  }
}

type EntryDraft = { id: string; values: Record<string, string> }

/** Own revision-bound row/column drafts, including cross-window display preferences. */
export function useJournalEditing({
  dataset,
  remoteDatasets,
  cancelled: cancelledRef,
  catalogGeneration: catalogGenerationRef,
  setBusy,
  setError,
  setMessage,
  setRemoteDatasets,
  setDatasets,
  setSortField,
  setOffset,
  fail
}: {
  dataset: JournalDataset | undefined
  remoteDatasets: JournalDataset[] | undefined
  cancelled: React.RefObject<boolean>
  catalogGeneration: React.RefObject<number>
  setBusy: (value: boolean) => void
  setError: (message: string) => void
  setMessage: (message: string) => void
  setRemoteDatasets: React.Dispatch<React.SetStateAction<JournalDataset[] | undefined>>
  setDatasets: React.Dispatch<React.SetStateAction<JournalDataset[]>>
  setSortField: React.Dispatch<React.SetStateAction<string | undefined>>
  setOffset: React.Dispatch<React.SetStateAction<number>>
  fail: (error: unknown) => void
}): {
  identityColumns: IdentityColumns
  identityDraft: IdentityColumns
  setIdentityDraft: React.Dispatch<React.SetStateAction<IdentityColumns>>
  fieldDraft: JournalField[] | undefined
  setFieldDraft: React.Dispatch<React.SetStateAction<JournalField[] | undefined>>
  entryDraft: EntryDraft | undefined
  setEntryDraft: React.Dispatch<React.SetStateAction<EntryDraft | undefined>>
  editing: boolean
  entryEditing: boolean
  choiceField: string
  setChoiceField: React.Dispatch<React.SetStateAction<string>>
  choiceQuery: string
  setChoiceQuery: React.Dispatch<React.SetStateAction<string>>
  choiceOffset: number
  setChoiceOffset: React.Dispatch<React.SetStateAction<number>>
  choiceResult: JournalResult | undefined
  setChoicePage: React.Dispatch<
    React.SetStateAction<{ key: string; result: JournalResult } | undefined>
  >
  persistFields: (fields: JournalField[]) => Promise<string | undefined>
  moveField: (id: string, targetId: string) => void
  saveFields: () => Promise<void>
  saveEntry: () => Promise<void>
} {
  const { t } = useTranslation()
  const api = window.api.literature.journals
  const [identityColumns, setIdentityColumns] = useState(loadIdentityColumns)
  const [identityDraft, setIdentityDraft] = useState(identityColumns)
  useEffect(() => {
    const sync = (event: StorageEvent): void => {
      if (event.key === null || event.key === JOURNAL_IDENTITY_COLUMNS_KEY)
        setIdentityColumns(loadIdentityColumns())
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const [fieldDraft, setFieldDraft] = useState<JournalField[]>()
  const [entryDraft, setEntryDraft] = useState<{
    id: string
    values: Record<string, string>
  }>()
  const editing = Boolean(fieldDraft)
  const entryEditing = Boolean(entryDraft)
  const [choiceField, setChoiceField] = useState('')
  const [choiceQuery, setChoiceQuery] = useState('')
  const [choiceOffset, setChoiceOffset] = useState(0)
  const [choicePage, setChoicePage] = useState<{ key: string; result: JournalResult }>()
  const choiceKey = JSON.stringify([
    dataset?.id,
    dataset?.revision,
    choiceField,
    choiceQuery,
    choiceOffset
  ])
  const choiceResult = choicePage?.key === choiceKey ? choicePage.result : undefined
  useEffect(() => {
    if (!editing || !choiceField || !dataset || remoteDatasets) return
    let active = true
    const timer = setTimeout(() => {
      void api({
        action: 'choices',
        datasetId: dataset.id,
        expectedRevision: dataset.revision,
        fieldId: choiceField,
        query: choiceQuery,
        offset: choiceOffset
      }).then(
        (result) => {
          if (active) setChoicePage({ key: choiceKey, result })
        },
        (error: unknown) => {
          if (active) fail(error)
        }
      )
    }, 150)
    return () => {
      active = false
      clearTimeout(timer)
    }
    // The result is tied to this dataset revision and query, never to the table page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, editing, choiceKey, remoteDatasets])

  const persistFields = useCallback(
    async (fields: JournalField[]): Promise<string | undefined> => {
      if (!dataset || remoteDatasets) return t('Journal data changed. Reload the dataset.')
      cancelledRef.current = false
      setBusy(true)
      setError('')
      catalogGenerationRef.current++
      try {
        const result = await api({
          action: 'fields',
          datasetId: dataset.id,
          expectedRevision: dataset.revision,
          fields
        })
        setRemoteDatasets(undefined)
        setDatasets(result.datasets ?? [])
        setFieldDraft(undefined)
        setSortField((current) =>
          fields.some((field) => field.id === current && field.visible) ? current : undefined
        )
        setOffset(0)
        refreshJournalAttributes()
        return undefined
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const message = reason.includes('selected type')
          ? t(
              'Some values do not match the selected type. Choose another type or update the values first.'
            )
          : /changed|expired/i.test(reason)
            ? t('Journal data changed. Reload the dataset.')
            : t('Could not save changes.')
        setError(message)
        return message
      } finally {
        setBusy(false)
      }
    },
    [
      api,
      dataset,
      remoteDatasets,
      t,
      cancelledRef,
      catalogGenerationRef,
      setBusy,
      setError,
      setRemoteDatasets,
      setDatasets,
      setSortField,
      setOffset
    ]
  )
  const moveField = (id: string, targetId: string): void => {
    setFieldDraft((fields) => {
      if (!fields) return fields
      const from = fields.findIndex((field) => field.id === id)
      const to = fields.findIndex((field) => field.id === targetId)
      if (from < 0 || to < 0 || from === to) return fields
      const reordered = [...fields]
      const [moved] = reordered.splice(from, 1)
      reordered.splice(to, 0, moved)
      return reordered
    })
  }
  const saveFields = async (): Promise<void> => {
    if (!fieldDraft || !dataset || remoteDatasets) return
    if (fieldDraft !== dataset.fields && (await persistFields(fieldDraft))) return
    setFieldDraft(undefined)
    setIdentityColumns(identityDraft)
    try {
      window.localStorage.setItem(JOURNAL_IDENTITY_COLUMNS_KEY, JSON.stringify(identityDraft))
    } catch {
      // Display preferences remain usable when local storage is unavailable.
    }
  }
  const saveEntry = useCallback(async (): Promise<void> => {
    if (!dataset || !entryDraft || remoteDatasets) return
    cancelledRef.current = false
    setBusy(true)
    setError('')
    catalogGenerationRef.current++
    try {
      const result = await api({
        action: 'entry',
        datasetId: dataset.id,
        expectedRevision: dataset.revision,
        journalId: entryDraft.id,
        values: entryDraft.values
      })
      setRemoteDatasets(undefined)
      setDatasets(result.datasets ?? [])
      setEntryDraft(undefined)
      setMessage(t('Journal row updated.'))
      refreshJournalAttributes()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [
    api,
    dataset,
    entryDraft,
    fail,
    remoteDatasets,
    t,
    cancelledRef,
    catalogGenerationRef,
    setBusy,
    setError,
    setRemoteDatasets,
    setDatasets,
    setMessage
  ])
  return {
    identityColumns,
    identityDraft,
    setIdentityDraft,
    fieldDraft,
    setFieldDraft,
    entryDraft,
    setEntryDraft,
    editing,
    entryEditing,
    choiceField,
    setChoiceField,
    choiceQuery,
    setChoiceQuery,
    choiceOffset,
    setChoiceOffset,
    choiceResult,
    setChoicePage,
    persistFields,
    moveField,
    saveFields,
    saveEntry
  }
}
