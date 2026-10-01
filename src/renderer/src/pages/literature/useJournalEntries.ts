import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseApplicationCommandError } from '../../../../shared/application-command-contract'
import { type JournalDataset, type JournalResult } from '../../../../shared/journal-attributes'
import { type JournalSheet } from './journal-import-file'

/** Keep each loaded page tied to its dataset and query; preserve unchanged snapshot identity. */
export function useJournalEntries({
  dataset,
  sheet,
  entryEditing,
  query,
  offset,
  pageSize,
  sortField,
  descending,
  entriesTick,
  setOffset,
  setError
}: {
  dataset: JournalDataset | undefined
  sheet: JournalSheet | undefined
  entryEditing: boolean
  query: string
  offset: number
  pageSize: 25 | 50 | 100
  sortField: string | undefined
  descending: boolean
  entriesTick: number
  setOffset: React.Dispatch<React.SetStateAction<number>>
  setError: (message: string) => void
}): {
  entries: JournalResult
  entriesOffset: number
  entriesLoading: boolean
  entriesFailed: boolean
} {
  const { t } = useTranslation()
  const api = window.api.literature.journals
  const [loadedEntries, setEntries] = useState<{
    datasetId: string
    offset: number
    result: JournalResult
  }>()
  const entries: JournalResult =
    loadedEntries?.datasetId === dataset?.id ? (loadedEntries?.result ?? {}) : {}
  const entriesOffset = loadedEntries?.offset ?? 0
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [entriesFailed, setEntriesFailed] = useState(false)
  const previousQuery = useRef(query)
  useEffect(() => {
    if (!dataset || sheet || entryEditing) return
    const queryChanged = previousQuery.current !== query
    previousQuery.current = query
    let active = true
    const load = (retried = false): void => {
      setEntriesLoading(true)
      void api({
        action: 'entries',
        datasetId: dataset.id,
        query,
        offset,
        ...(pageSize === 50 ? {} : { limit: pageSize }),
        sortField,
        descending
      }).then(
        (result) => {
          if (active) {
            setEntriesLoading(false)
            setEntriesFailed(false)
            if (offset > 0 && offset >= (result.total ?? 0)) {
              setOffset(Math.max(0, Math.ceil((result.total ?? 0) / pageSize) - 1) * pageSize)
            }
            setEntries((previous) =>
              previous?.datasetId === dataset.id &&
              previous.offset === offset &&
              JSON.stringify(previous.result) === JSON.stringify(result)
                ? previous
                : { datasetId: dataset.id, offset, result }
            )
          }
        },
        (error) => {
          if (active) {
            const reason =
              parseApplicationCommandError(error)?.message ??
              (error instanceof Error ? error.message : '')
            // A concurrent write invalidates the main-process read. Retry once while
            // this query is still current; persistent conflicts remain visible errors.
            if (!retried && reason === 'Journal data changed. Reload the dataset.') {
              load(true)
              return
            }
            setEntriesLoading(false)
            setEntriesFailed(true)
            console.error('Could not load journal entries', error)
            setError(t('Could not load journals. Reload to try again.'))
          }
        }
      )
    }
    // Typing is debounced; pagination, sorting and dataset switching start immediately.
    const timer = queryChanged ? setTimeout(load, 150) : undefined
    if (!queryChanged) load()
    return () => {
      active = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, sheet, entryEditing, query, offset, pageSize, sortField, descending, entriesTick])

  return { entries, entriesOffset, entriesLoading, entriesFailed }
}
