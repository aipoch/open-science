import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { useNavigationStore, type PdfReadingDocument } from '@/stores/navigation-store'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LiteratureCatalogSearchRequest,
  LiteratureItemView
} from '../../../../shared/literature'
import { resolvePdfContextTarget } from '../workspace/use-pdf-context-action'
import { readLiteratureSelectionPage } from './literature-read-pages'
type PendingLiteratureReading = readonly PdfReadingDocument[]
const isItem = (entry: unknown): entry is LiteratureItemView =>
  typeof entry === 'object' && entry !== null && 'item' in entry && 'metadataRevision' in entry

import type { LiteratureDetailController } from './LiteratureDetailController'
import type { LiteratureSelectionStore } from './literature-selection'

/** Own reading selection, project admission and cancellation of stale selection reads. */
export function useLiteratureReading({
  selectedProject,
  setPreviewItem,
  isBatching,
  selectionStore,
  items,
  detailController,
  buildEntriesRequest
}: {
  selectedProject: ReturnType<typeof useProjectStore.getState>['projects'][number] | undefined
  setPreviewItem: React.Dispatch<React.SetStateAction<PreviewFileItem | undefined>>
  isBatching: boolean
  selectionStore: LiteratureSelectionStore
  items: LiteratureItemView[]
  detailController: LiteratureDetailController
  buildEntriesRequest: (offset?: number) => LiteratureCatalogSearchRequest
}): {
  pendingLiteratureReading: PendingLiteratureReading | undefined
  setPendingLiteratureReading: React.Dispatch<
    React.SetStateAction<PendingLiteratureReading | undefined>
  >
  batchReading: { entries?: LiteratureItemView[]; error?: string } | undefined
  setBatchReading: React.Dispatch<
    React.SetStateAction<{ entries?: LiteratureItemView[]; error?: string } | undefined>
  >
  readingSelectionEntries: LiteratureItemView[] | undefined
  batchReadingRequestRef: React.RefObject<number>
  startingReadingProjectId: string | undefined
  readingProjectQuery: string
  setReadingProjectQuery: React.Dispatch<React.SetStateAction<string>>
  readingProjectError: string | undefined
  setReadingProjectError: React.Dispatch<React.SetStateAction<string | undefined>>
  startReadingInProject: (
    targetProjectId: string,
    reading?: PendingLiteratureReading | undefined
  ) => Promise<void>
  requestReadWithAgent: (item: PreviewFileItem) => void
  readingProjectFormDialog: ReturnType<typeof useProjectFormDialog>
  requestReadSelection: () => Promise<void>
} {
  const { t } = useTranslation()
  const startPdfReadingConversation = useNavigationStore(
    (state) => state.startPdfReadingConversation
  )
  const startPdfReadingConversations = useNavigationStore(
    (state) => state.startPdfReadingConversations
  )
  const [pendingLiteratureReading, setPendingLiteratureReading] =
    useState<PendingLiteratureReading>()
  const [batchReading, setBatchReading] = useState<{
    entries?: LiteratureItemView[]
    error?: string
  }>()
  const [readingSelectionEntries, setReadingSelectionEntries] = useState<LiteratureItemView[]>()
  const batchReadingRequestRef = useRef(0)
  useEffect(
    () => () => {
      batchReadingRequestRef.current += 1
    },
    []
  )
  const [startingReadingProjectId, setStartingReadingProjectId] = useState<string>()
  const [readingProjectQuery, setReadingProjectQuery] = useState('')
  const [readingProjectError, setReadingProjectError] = useState<string>()
  const startReadingInProject = useCallback(
    async (targetProjectId: string, reading = pendingLiteratureReading): Promise<void> => {
      if (!reading || startingReadingProjectId) return
      setStartingReadingProjectId(targetProjectId)
      setReadingProjectError(undefined)
      try {
        const result = await window.api.sessions.filterPdfContextCandidates({
          projectId: targetProjectId,
          sources: reading.map(({ source }) => source)
        })
        const eligible = reading.every(({ source: requested }) =>
          result.sources.some(
            (source) =>
              source.sourceKind === requested.sourceKind &&
              source.sourceVersionId === requested.sourceVersionId
          )
        )
        if (!eligible) {
          setPendingLiteratureReading(reading)
          setReadingProjectError(
            reading.length > 1
              ? t('Some selected PDFs cannot be read. Review your selection.')
              : t('No multi-page PDFs available')
          )
          return
        }
        const opened =
          reading.length === 1
            ? startPdfReadingConversation(targetProjectId, reading[0].item, reading[0].source)
            : startPdfReadingConversations(targetProjectId, reading)
        if (opened) {
          setPendingLiteratureReading(undefined)
          setReadingSelectionEntries(undefined)
        }
      } catch {
        setPendingLiteratureReading(reading)
        setReadingProjectError(t('No multi-page PDFs available'))
      } finally {
        setStartingReadingProjectId(undefined)
      }
    },
    [
      pendingLiteratureReading,
      startingReadingProjectId,
      startPdfReadingConversation,
      startPdfReadingConversations,
      t
    ]
  )
  const selectedReadingProjectId = selectedProject?.id
  const requestReadWithAgent = useCallback(
    (item: PreviewFileItem): void => {
      setReadingSelectionEntries(undefined)
      const source = resolvePdfContextTarget(item)
      if (!source) return
      setPreviewItem(undefined)
      setReadingProjectError(undefined)
      const reading = [{ item, source }]
      if (selectedReadingProjectId) {
        void startReadingInProject(selectedReadingProjectId, reading)
        return
      }
      setReadingProjectQuery('')
      setPendingLiteratureReading(reading)
    },
    [selectedReadingProjectId, startReadingInProject, setPreviewItem]
  )
  const readingProjectFormDialog = useProjectFormDialog({
    onCreated: (project) => void startReadingInProject(project.id)
  })
  const requestReadSelection = async (): Promise<void> => {
    if (batchReading || isBatching) return
    const request = ++batchReadingRequestRef.current
    setReadingSelectionEntries(undefined)
    const selection = selectionStore.getSnapshot()
    setBatchReading({})
    try {
      let entries: LiteratureItemView[]
      if (!selection.allMatchingSelected) {
        entries = await Promise.all(
          [...selection.selectedIds].map(async (id) => {
            const entry = items.find((item) => item.id === id) ?? (await detailController.read(id))
            if (!entry || !isItem(entry)) throw new Error('Selected reference unavailable')
            return entry
          })
        )
      } else {
        entries = []
        const seen = new Set<number>()
        let offset = 0
        while (!seen.has(offset)) {
          seen.add(offset)
          const page = await readLiteratureSelectionPage(buildEntriesRequest(offset))
          if (request !== batchReadingRequestRef.current) return
          entries.push(
            ...page.entries
              .filter(isItem)
              .filter(({ id }) => !selection.excludedMatchingIds.has(id))
          )
          if (page.nextOffset === undefined) break
          offset = page.nextOffset
        }
      }
      if (request === batchReadingRequestRef.current) {
        setBatchReading({ entries })
        setReadingSelectionEntries(entries)
      }
    } catch {
      if (request === batchReadingRequestRef.current)
        setBatchReading({ error: t('Selected references could not be loaded.') })
    }
  }
  return {
    pendingLiteratureReading,
    setPendingLiteratureReading,
    batchReading,
    setBatchReading,
    readingSelectionEntries,
    batchReadingRequestRef,
    startingReadingProjectId,
    readingProjectQuery,
    setReadingProjectQuery,
    readingProjectError,
    setReadingProjectError,
    startReadingInProject,
    requestReadWithAgent,
    readingProjectFormDialog,
    requestReadSelection
  }
}
