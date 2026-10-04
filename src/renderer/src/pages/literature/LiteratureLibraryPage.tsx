import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { LITERATURE_JOB_MAX_ITEMS } from '../../../../shared/literature-jobs'
import type { PdfAnnotation } from '../../../../shared/pdf-annotations'
import {
  createBookmarkPreviewItem,
  requestPdfAnnotationReveal
} from '../workspace/annotations/annotation-reveal'
import { LiteratureAttachmentOperations } from './workflows/LiteratureAttachmentOperations'
import { LiteratureCandidateDialog } from './list/LiteratureCandidateDialog'
import { LiteratureCollectionDeleteDialog } from './collections/LiteratureCollectionDeleteDialog'
import { LiteratureCreateItemDialog } from './imports/LiteratureCreateItemDialog'
import { LiteratureDeletionNotice } from './LiteratureDeletionNotice'
import { LiteratureDetailDialog } from './detail/LiteratureDetailDialog'
import { LiteratureDetailOverview } from './detail/LiteratureDetailOverview'
import { LiteratureInboxList } from './list/LiteratureInboxList'
import { LiteratureLibraryHeader } from './list/LiteratureLibraryHeader'
import { LiteratureLibrarySidebar, type LibrarySection } from './list/LiteratureLibrarySidebar'
import { LiteratureMergeDialog } from './duplicates/LiteratureMergeDialog'
import { LiteratureOversizedNotice } from './list/LiteratureOversizedNotice'
import { LiteraturePagination } from './list/LiteraturePagination'
import {
  LiteraturePdfBatchImportDialog,
  type PdfImportDestination
} from './imports/LiteraturePdfBatchImportDialog'
import { LiteratureReadingProjectDialog } from './workflows/LiteratureReadingProjectDialog'
import { LiteratureResultsTable } from './list/LiteratureResultsTable'
import { LiteratureSelectionToolbar } from './list/LiteratureSelectionToolbar'
import { LiteratureViewControls } from './list/LiteratureViewControls'
import { type SmartCollectionCellActions } from './collections/SmartCollectionDecision'
import { SmartCollectionPanel } from './collections/SmartCollectionPanel'
import { SmartCollectionProcess } from './collections/SmartCollectionProcess'
import {
  useDisplayedJournalDatasets,
  useJournalDatasets,
  useJournalSourceYears
} from './journals/journal-attribute-store'
import { useAttachmentOperations } from './workflows/literature-attachment-operations'
import { setSmartReevaluationConfirmation } from './collections/smart-collection-preferences'
import {
  createSmartCollectionState,
  SmartDecisionPendingContext
} from './collections/smart-collection-state'
import { useLiteratureAttachments } from './workflows/useLiteratureAttachments'
import { useLiteratureCandidates } from './list/useLiteratureCandidates'
import { isCollectionOnlyChange, useLiteratureChanges } from './useLiteratureChanges'
import { useLiteratureCollectionDeletion } from './collections/useLiteratureCollectionDeletion'
import { useLiteratureExport } from './workflows/useLiteratureExport'
import {
  emptyLiteratureItem,
  titleFromPdfFilename,
  useLiteratureImport
} from './imports/useLiteratureImport'
import { useLiteratureItemEdits } from './workflows/useLiteratureItemEdits'
import { useLiteratureLifecycle } from './list/useLiteratureLifecycle'
import { useLiteratureMembership } from './collections/useLiteratureMembership'
import { useLiteratureMerge } from './duplicates/useLiteratureMerge'
import { useLiteraturePdfStaging } from './imports/useLiteraturePdfStaging'
import type { LiteratureSort } from './list/useLiteratureQuery'
import { useLiteratureQuery } from './list/useLiteratureQuery'
import { useLiteratureReading } from './workflows/useLiteratureReading'
import { useLiteratureSmartDecisions } from './collections/useLiteratureSmartDecisions'
import { useLiteratureSmartReevaluation } from './collections/useLiteratureSmartReevaluation'
import { useLiteratureTable } from './list/useLiteratureTable'
import { useSmartDecisionBatch } from './collections/useSmartDecisionBatch'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import * as AlertDialog from '@/components/ui/alert-dialog'
import * as Dialog from '@/components/ui/dialog'
import { ArrowLeft, BookOpenText, Check, Inbox, LoaderCircle, Pencil, X } from 'lucide-react'
import { Checkbox, Tabs } from 'radix-ui'
import {
  lazy,
  memo,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useTranslation } from 'react-i18next'

import { ActionToast } from '@/components/ActionToast'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import type {
  LiteratureCitationStyle,
  LiteratureCitationStyleView,
  LiteratureCollectionView,
  LiteratureInboxCandidateView,
  LiteratureItemType,
  LiteratureItemView,
  LiteratureMetadataField
} from '../../../../shared/literature'
import { createLiteratureAttachmentVersionReference } from '../../../../shared/literature'
import { ProjectFormDialog } from '../home/ProjectFormDialog'
import { FilePreviewDialog } from '../workspace/FilePreviewDialog'
import { LITERATURE_PREVIEW_SESSION_ID } from '../workspace/preview-file-item'
import { CitationStylesView } from './CitationStylesView'
import {
  CollectionEditorDialog,
  type CollectionEditorDialogHandle
} from './collections/CollectionEditorDialog'
import { LiteratureBackgroundTasks } from './workflows/LiteratureBackgroundTasks'
import {
  LiteratureBatchLookupDialog,
  type BatchLookupMode
} from './workflows/LiteratureBatchLookupDialog'
import { createLiteratureDetailController } from './detail/LiteratureDetailController'
import {
  LiteratureDuplicatesView,
  type LiteratureDuplicateCountHandle
} from './duplicates/LiteratureDuplicatesView'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { LiteratureReadingDialog } from './workflows/LiteratureReadingDialog'
import { LiteratureRecordImportDialog } from './imports/LiteratureRecordImportDialog'
import { LiteratureSearchInput } from './list/LiteratureSearchInput'
import { LiteratureSelectionBoundary } from './list/LiteratureSelection'
import { mergeScalarFields } from './duplicates/literature-merge'
import {
  createLiteratureSelectionStore,
  isLiteratureItemSelected
} from './list/literature-selection'

import { useLiteratureMetadata } from './workflows/useLiteratureMetadata'
import { useLiteratureYearFilter } from './list/useLiteratureYearFilter'

import { LiteratureAddMenu } from './list/LiteratureLibraryMenus'

import { itemDescription } from './literature-item-display'

import { LiteratureRowActions } from './list/LiteratureItemRow'

const JournalManager = lazy(() =>
  import('./JournalManager').then((module) => ({ default: module.JournalManager }))
)

const CHILD_LAYER_DISMISS_GUARD_MS = 1_000

const literatureTabsListClassName = 'flex gap-3 overflow-x-auto border-b border-border'
const literatureTabClassName =
  'relative flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border-b-2 border-transparent px-1 py-3 text-xs font-medium text-muted-foreground data-[state=inactive]:hover:border-muted-foreground data-[state=inactive]:hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-primary transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'

const LITERATURE_PAGE_SIZES = [25, 50, 100] as const

type LiteraturePageSize = (typeof LITERATURE_PAGE_SIZES)[number]

const LITERATURE_REVIEW_CTA_ATTENTION_KEY = 'open-science:literature-review-cta-attention-seen'

// Keep unrelated library updates outside the preview subtree.
const LiteratureFilePreviewDialog = memo(FilePreviewDialog)

const LiteratureLibraryPage = (): React.JSX.Element => {
  const journalDatasets = useJournalDatasets()
  const displayedJournalDatasets = useDisplayedJournalDatasets()
  const journalSourceYears = useJournalSourceYears()
  const { i18n, t } = useTranslation()

  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const startLiteratureReviewConversation = useNavigationStore(
    (state) => state.startLiteratureReviewConversation
  )
  const pendingLiteratureItemId = useNavigationStore((state) => state.pendingLiteratureItemId)
  const pendingLiteratureAnnotation = useNavigationStore(
    (state) => state.pendingLiteratureAnnotation
  )
  const pendingLiteratureLibrarySection = useNavigationStore(
    (state) => state.pendingLiteratureLibrarySection
  )
  const consumeLiteratureLibrarySection = useNavigationStore(
    (state) => state.consumeLiteratureLibrarySection
  )
  const consumeLiteratureItem = useNavigationStore((state) => state.consumeLiteratureItem)
  const pendingLiteratureProjectId = useNavigationStore((state) => state.pendingLiteratureProjectId)
  const consumeLiteratureProject = useNavigationStore((state) => state.consumeLiteratureProject)
  const pendingLiteratureCollectionId = useNavigationStore(
    (state) => state.pendingLiteratureCollectionId
  )
  const consumeLiteratureCollection = useNavigationStore(
    (state) => state.consumeLiteratureCollection
  )
  const openProject = useNavigationStore((state) => state.openProject)
  const projects = useProjectStore((state) => state.projects)
  const projectsLoaded = useProjectStore((state) => state.isLoaded)
  const loadProjects = useProjectStore((state) => state.loadProjects)
  const loadTags = useTagStore((state) => state.load)
  const listenTags = useTagStore((state) => state.listen)
  const tagRevision = useTagStore((state) => state.revision)
  const [section, setSection] = useState<LibrarySection>('inbox')
  const [inboxState, setInboxState] = useState<'pending' | 'dismissed'>('pending')
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)
  const [shouldCueLiteratureReview, setShouldCueLiteratureReview] = useState(
    () => window.sessionStorage.getItem(LITERATURE_REVIEW_CTA_ATTENTION_KEY) !== 'true'
  )
  const [collectionId, setCollectionId] = useState<string>()
  const [screeningCollection, setScreeningCollection] = useState<string>()
  const [screeningStartingCollection, setScreeningStartingCollection] = useState<string>()
  const screeningOpen = Boolean(collectionId && screeningCollection === collectionId)
  const smartState = useMemo(() => createSmartCollectionState(collectionId), [collectionId])
  const smartView = useSyncExternalStore(smartState.subscribe, smartState.getSettledSnapshot)
  const screeningBackButton = useRef<HTMLButtonElement>(null)
  const screeningResults = useRef<HTMLDivElement>(null)
  const restoreScreeningFocus = useRef(false)
  useLayoutEffect(() => {
    if (screeningOpen) screeningBackButton.current?.focus()
    else if (restoreScreeningFocus.current) {
      restoreScreeningFocus.current = false
      screeningResults.current?.focus()
    }
  }, [screeningOpen])
  const pendingDecisionsRef = useRef(new Set<string>())
  const currentSmartState = useRef(smartState)
  useLayoutEffect(() => {
    if (currentSmartState.current !== smartState) {
      setScreeningCollection(undefined)
      setScreeningStartingCollection(undefined)
    }
    currentSmartState.current = smartState
  }, [smartState])
  const smartDecisionBatch = useSmartDecisionBatch()
  const [smartDecisionSource, setSmartDecisionSource] = useState<'all' | 'ai' | 'manual'>('all')
  const [smartFilter, setSmartFilter] = useState<'match' | 'review' | 'no-match' | 'pending'>(
    'match'
  )
  const [projectId, setProjectId] = useState<string>()
  const [query, setQuery] = useState('')
  const [searchResetRevision, setSearchResetRevision] = useState(0)
  const [tagId, setTagId] = useState('all')
  const [sortBy, setSortBy] = useState<LiteratureSort>('updated')
  const [filterItemType, setFilterItemType] = useState<LiteratureItemType | 'all'>('all')
  const [filterHasPdf, setFilterHasPdf] = useState<'all' | 'with' | 'without'>('all')
  const [selectionStore] = useState(createLiteratureSelectionStore)
  const clearSelection = useCallback((): void => selectionStore.clear(), [selectionStore])
  const {
    journalColumns,
    journalAttributeFilters,
    setJournalAttributeFilters,
    tableColumnOrder,
    visibleTableColumns,
    setVisibleTableColumns,
    tableMinWidth,
    tableColumnLabels,
    visibleOrderedTableColumns,
    moveTableColumn,
    moveTableColumnBy
  } = useLiteratureTable({
    datasets: displayedJournalDatasets,
    years: journalSourceYears,
    clearSelection
  })
  const yearFilter = useLiteratureYearFilter(clearSelection)
  const { from: filterYearFrom, to: filterYearTo } = yearFilter
  const [filtersOpen, setFiltersOpen] = useState(false)
  const journalFilterDatasets = displayedJournalDatasets
  const [isBatching, setIsBatching] = useState(false)
  const [batchLookup, setBatchLookup] = useState<{
    mode: BatchLookupMode
    itemIds: string[]
    jobId?: string
  }>()

  const duplicateCountRef = useRef<LiteratureDuplicateCountHandle>(null)
  const setDuplicateCount = useCallback((count: number | undefined) => {
    duplicateCountRef.current?.setCount(count)
  }, [])
  const [duplicatesRevision, setDuplicatesRevision] = useState(0)
  const [libraryCountRevision, setLibraryCountRevision] = useState(0)

  const [selectedCandidate, setSelectedCandidate] = useState<LiteratureInboxCandidateView>()
  const attachmentOperations = useAttachmentOperations((state) => state.operations)
  const [detailController] = useState(createLiteratureDetailController)
  const selectedItem = detailController.getSnapshot().item

  const [error, setError] = useState<string>()
  const [linkedItemError, setLinkedItemError] = useState<string>()

  const pdfStaging = useLiteraturePdfStaging()
  const [pdfBatch, setPdfBatch] = useState<{ files: File[]; destination: PdfImportDestination }>()

  const [projectLinkError, setProjectLinkError] = useState<string>()
  const [collectionLinkError, setCollectionLinkError] = useState<string>()
  const [previewItem, setPreviewItem] = useState<PreviewFileItem>()
  const [annotationToReveal, setAnnotationToReveal] = useState<PdfAnnotation>()

  const [citationStyles, setCitationStyles] = useState<LiteratureCitationStyleView[]>()
  const [citationStylesOpen, setCitationStylesOpen] = useState(false)
  const [journalsOpen, setJournalsOpen] = useState(false)
  const [journalsVisited, setJournalsVisited] = useState(false)
  const closeJournals = useCallback(() => setJournalsOpen(false), [])
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const importPdfInputRef = useRef<HTMLInputElement>(null)
  const importRecordsInputRef = useRef<HTMLInputElement>(null)
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const citationStyleRef = useRef<LiteratureCitationStyle>('apa')
  const detailTagMenuOpenRef = useRef(false)
  const detailSelectOpenRef = useRef(false)
  const childLayerDismissGuardUntilRef = useRef(0)
  const detailInitiatorRef = useRef<HTMLElement | null>(null)
  const libraryEntryRef = useRef<HTMLButtonElement>(null)
  const accessibilityId = useId()
  const selectedItemDialogRef = useRef<HTMLDivElement>(null)
  const collectionEditorRef = useRef<CollectionEditorDialogHandle>(null)

  const updateCitationStyles = useCallback((next: LiteratureCitationStyleView[]): void => {
    setCitationStyles(next)
    if (!next.some(({ id }) => id === citationStyleRef.current)) citationStyleRef.current = 'apa'
  }, [])

  const [removedDetailItemId, setRemovedDetailItemId] = useState<string>()
  const detailInteractionRef = useRef(0)
  const openSelectedItemDetail = useCallback(
    (item: LiteratureItemView, initiator?: HTMLElement): void => {
      if (item.deletedAt !== undefined) return
      if (!detailController.getSnapshot().open) {
        detailInitiatorRef.current =
          initiator ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      }
      detailInteractionRef.current += 1
      setRemovedDetailItemId(undefined)
      setError(undefined)
      detailController.open(item)
    },
    [detailController]
  )

  const handleDetailTagMenuOpenChange = useCallback((open: boolean): void => {
    detailTagMenuOpenRef.current = open
    if (!open) {
      childLayerDismissGuardUntilRef.current = Date.now() + CHILD_LAYER_DISMISS_GUARD_MS
    }
  }, [])

  const openJournalReference = useCallback(
    async (id: string, initiator?: HTMLElement): Promise<void> => {
      const interaction = ++detailInteractionRef.current
      const item = await detailController.read(id)
      if (detailInteractionRef.current !== interaction || !initiator?.isConnected) return
      if (!item || item.deletedAt !== undefined) throw new Error('Reference unavailable')
      openSelectedItemDetail(item, initiator)
    },
    [detailController, openSelectedItemDetail]
  )

  const handleDetailSelectOpenChange = useCallback((open: boolean): void => {
    detailSelectOpenRef.current = open
    if (!open) {
      childLayerDismissGuardUntilRef.current = Date.now() + CHILD_LAYER_DISMISS_GUARD_MS
    }
  }, [])

  useEffect(() => {
    if (!projectsLoaded) void loadProjects()
  }, [loadProjects, projectsLoaded])

  useEffect(() => {
    void loadTags()
    return listenTags()
  }, [listenTags, loadTags])

  useEffect(() => {
    if (!pendingLiteratureItemId) return
    const itemId = pendingLiteratureItemId
    const interaction = ++detailInteractionRef.current
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setDuplicatesOpen(false)
      setSection('library')
      setCollectionId(undefined)
      setProjectId(undefined)
      clearSelection()
      setError(undefined)
      setLinkedItemError(undefined)
      void detailController.read(itemId).then(
        (item) => {
          if (!active) return
          if (detailInteractionRef.current !== interaction) {
            consumeLiteratureItem(itemId)
            return
          }
          if (item) {
            if (pendingLiteratureAnnotation) {
              const preview = createBookmarkPreviewItem({
                id: pendingLiteratureAnnotation.id,
                kind: 'pdf',
                ...pendingLiteratureAnnotation.target
              })
              if (preview) {
                detailController.close()
                setPreviewItem(preview)
                setAnnotationToReveal(pendingLiteratureAnnotation)
              } else setError(t('PDF annotations are unavailable for this source.'))
            } else openSelectedItemDetail(item)
          } else setLinkedItemError(t('This reference is no longer in your Library.'))
          consumeLiteratureItem(itemId)
        },
        () => {
          if (!active) return
          if (detailInteractionRef.current !== interaction) {
            consumeLiteratureItem(itemId)
            return
          }
          setLinkedItemError(undefined)
          setError(t('Literature could not be loaded.'))
          consumeLiteratureItem(itemId)
        }
      )
    })
    return () => {
      active = false
    }
  }, [
    clearSelection,
    consumeLiteratureItem,
    detailController,
    openSelectedItemDetail,
    pendingLiteratureItemId,
    pendingLiteratureAnnotation,
    t
  ])

  useEffect(() => {
    if (!annotationToReveal || !previewItem) return
    let active = true
    void requestPdfAnnotationReveal(annotationToReveal)
      .then((outcome) => {
        if (!active) return
        if (outcome !== 'revealed') setError(t('The exact annotation location could not be found.'))
        setAnnotationToReveal(undefined)
      })
      .catch(() => {
        if (!active) return
        setError(t('The exact annotation location could not be found.'))
        setAnnotationToReveal(undefined)
      })
    return () => {
      active = false
    }
  }, [annotationToReveal, previewItem, t])

  useEffect(() => {
    if (pendingLiteratureLibrarySection !== 'library') return
    queueMicrotask(() => {
      setDuplicatesOpen(false)
      setSection('library')
      setCollectionId(undefined)
      setProjectId(undefined)
      clearSelection()
      consumeLiteratureLibrarySection()
    })
  }, [clearSelection, consumeLiteratureLibrarySection, pendingLiteratureLibrarySection])

  useEffect(() => {
    if (!pendingLiteratureProjectId) return
    const nextProjectId = pendingLiteratureProjectId
    queueMicrotask(() => {
      setDuplicatesOpen(false)
      setSection('library')
      setCollectionId(undefined)
      setProjectId(nextProjectId)
      clearSelection()
      consumeLiteratureProject(nextProjectId)
    })
  }, [clearSelection, consumeLiteratureProject, pendingLiteratureProjectId])

  useEffect(() => {
    if (!pendingLiteratureCollectionId) return
    const nextCollectionId = pendingLiteratureCollectionId
    queueMicrotask(() => {
      setDuplicatesOpen(false)
      setSection('library')
      setSmartFilter('match')
      setSmartDecisionSource('all')

      setCollectionId(nextCollectionId)
      setProjectId(undefined)
      clearSelection()
      consumeLiteratureCollection(nextCollectionId)
    })
  }, [clearSelection, consumeLiteratureCollection, pendingLiteratureCollectionId])

  const {
    items,
    setItems,
    candidates,
    setCandidates,
    inboxPendingCount,
    setInboxPendingCount,
    inboxDismissedCount,
    setInboxDismissedCount,
    collections,
    setCollections,
    projectItemCounts,
    setProjectItemCounts,
    entriesPageSize,
    setEntriesPageSize,
    entriesOffset,
    setEntriesOffset,
    rowNumbers,
    entriesTotalCount,
    setEntriesTotalCount,
    nextEntriesOffset,
    collectionsGenerationRef,
    loadCollections,
    loadInboxCounts,
    loadProjectCounts,
    selectedCollection,
    smartSetup,
    entriesKey,
    linkScopeRef,
    buildEntriesRequest,
    oversizedItemId,
    entriesLoading,
    entriesFailed,
    entriesPageTransitionLoading,
    reloadEntries,
    refreshItems
  } = useLiteratureQuery({
    pendingDecisionsRef,
    collectionId,
    smartView,
    section,
    inboxState,
    smartFilter,
    smartDecisionSource,
    projectId,
    query,
    tagId,
    sortBy,
    filterItemType,
    filterYearFrom,
    filterYearTo,
    filterHasPdf,
    journalAttributeFilters,
    tableScrollRef,
    setError,
    detailController,
    duplicatesOpen
  })

  const updateMetadataItem = useCallback(
    (updated: LiteratureItemView): void => {
      const current = detailController.getSnapshot().item
      const latest =
        current?.id === updated.id && current.metadataRevision > updated.metadataRevision
          ? current
          : updated
      void refreshItems([updated.id], [latest])
      setDuplicatesRevision((value) => value + 1)
    },
    [detailController, refreshItems]
  )

  const focusPreviewFallback = useCallback(() => libraryEntryRef.current?.focus(), [])
  const closeFilePreview = useCallback((): void => {
    setPreviewItem(undefined)
    setAnnotationToReveal(undefined)
    const current = detailController.getSnapshot().item
    if (current)
      void window.api.literature
        .get(current.id)
        .then((updated) => {
          if (!updated) return
          if (detailController.getSnapshot().item?.id === updated.id)
            detailController.replace(updated)
          updateMetadataItem(updated)
        })
        .catch(() => undefined)
  }, [detailController, updateMetadataItem])
  const metadata = useLiteratureMetadata(detailController, updateMetadataItem)
  const { changeMode: changeDetailMode } = metadata
  const detailModeRef = useRef(metadata.mode)
  useLayoutEffect(() => {
    detailModeRef.current = metadata.mode
  }, [metadata.mode])

  const metadataExitFocusRef = useRef<HTMLElement | null>(null)
  const metadataDirtyRef = useRef(false)
  const [discardMetadata, setDiscardMetadata] = useState<() => void>()
  const trackMetadataDirty = useCallback((dirty: boolean) => {
    metadataDirtyRef.current = dirty
  }, [])
  const requestMetadataExit = useCallback((dirty: boolean, action: () => void): void => {
    if (dirty) {
      metadataExitFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDiscardMetadata(() => action)
    } else action()
  }, [])
  const leaveMetadataEditor = (): void => {
    if (metadata.saving) return
    requestMetadataExit(metadataDirtyRef.current, () => changeDetailMode('view'))
  }

  const appliedTagRevision = useRef(tagRevision)
  useEffect(() => {
    if (appliedTagRevision.current === tagRevision) return
    appliedTagRevision.current = tagRevision
    if (tagId !== 'all') {
      clearSelection()
      // Keep surviving keyed editors mounted during an authoritative background refresh.
      void reloadEntries(true, true)
    } else {
      // Previously visited filtered scopes must not resurrect old assignment membership.
      void refreshItems([])
    }
  }, [clearSelection, refreshItems, reloadEntries, tagId, tagRevision])

  const loadEntries = useCallback(
    (force = false, preservePage = false): Promise<boolean | undefined> => {
      if (force) {
        detailController.invalidate()
        setDuplicatesRevision((value) => value + 1)
        setLibraryCountRevision((value) => value + 1)
      }
      return reloadEntries(force, preservePage)
    },
    [detailController, reloadEntries]
  )
  const {
    isAddingPdf,
    addingPdfRef,
    pdfError,
    setPdfError,
    addPdf,
    isDraggingPdf,
    pdfDropZoneProps
  } = useLiteratureAttachments({ detailController, pdfStaging, loadEntries })
  const resolveSelectedItemIds = async (): Promise<string[]> => {
    const { allMatchingSelected, excludedMatchingIds, selectedIds } = selectionStore.getSnapshot()
    if (!allMatchingSelected) return [...selectedIds]
    const page = await window.api.literature.search({ ...buildEntriesRequest(0), allItemIds: true })
    if (!page.itemIds) throw new Error('Literature membership is unavailable.')
    return page.itemIds.filter((id) => !excludedMatchingIds.has(id))
  }

  const {
    restorePreview,
    setRestorePreview,
    dialogRestorePreview,
    permanentDeleteIds,
    setPermanentDeleteIds,
    permanentDeleteFailed,
    permanentDeletionDiagnostic,
    permanentDeleteResult,
    lifecycleFailure,
    setLifecycleFailure,
    previewRestoreSelection,
    setItemsLifecycle,
    runLifecycleAction,
    requestPermanentDeletion,
    refreshAfterPermanentDeletion,
    deleteItemsPermanently
  } = useLiteratureLifecycle({
    scope: JSON.stringify([section, projectId, collectionId]),
    selection: selectionStore,
    batch: { busy: isBatching, setBusy: setIsBatching },
    query: {
      key: entriesKey,
      currentKey: linkScopeRef,
      build: buildEntriesRequest,
      resolveSelectedItemIds
    },
    refresh: {
      entries: loadEntries,
      collections: loadCollections,
      projects: loadProjectCounts,
      tags: loadTags
    },
    onError: setError
  })

  const {
    linkFailure,
    setLinkFailure,
    runLinkBatch,
    moveSelectedItems,
    createCollectionForSelection,
    addSelectedItemsToProject
  } = useLiteratureMembership({
    collectionId,
    selectionStore,
    detailController,
    entriesKey,
    linkScopeRef,
    isBatching,
    setIsBatching,
    setError,
    resolveSelectedItemIds,
    loadEntries,
    loadCollections,
    loadProjectCounts
  })

  const currentEntriesReload = useRef(loadEntries)
  useLayoutEffect(() => {
    currentEntriesReload.current = loadEntries
  }, [loadEntries])
  const receiveBackgroundItems = useCallback(
    (itemIds: string[]): void => {
      setDuplicatesRevision((value) => value + 1)
      void refreshItems(itemIds, undefined, true)
    },
    [refreshItems]
  )

  const currentCollectionId = useRef(collectionId)
  useLayoutEffect(() => {
    currentCollectionId.current = collectionId
    return () => {
      currentCollectionId.current = undefined
    }
  }, [collectionId])

  const {
    smartResultSnapshot,
    smartRunningCollection,
    singleReevaluation,
    completedReevaluation,
    smartReevaluation,
    setSmartReevaluation,
    smartReevaluationRemember,
    setSmartReevaluationRemember,
    refreshSmartSummary,
    receiveSmartView,
    updateSmartEvidence,
    prepareSmartReevaluation,
    runSmartReevaluation
  } = useLiteratureSmartReevaluation({
    collectionId,
    selectedCollection,
    smartState,
    smartView,
    currentCollectionId,
    collectionsGenerationRef,
    setCollections,
    detailController,
    pendingDecisionsRef,
    isBatching,
    setIsBatching,
    setError,
    resolveSelectedItemIds,
    loadEntries,
    loadCollections,
    clearSelection,
    setSmartBatchResult: () => setSmartBatchResult(undefined)
  })
  const closeSelectedItemDetail = useCallback((): void => {
    if (metadata.saving || addingPdfRef.current) return
    requestMetadataExit(metadataDirtyRef.current, () => {
      setSmartReevaluation((current) => (current?.detailItemId ? undefined : current))
      if (addingPdfRef.current) return
      detailInteractionRef.current += 1
      detailTagMenuOpenRef.current = false
      detailSelectOpenRef.current = false
      childLayerDismissGuardUntilRef.current = 0
      detailController.close()
      setRemovedDetailItemId(undefined)
      startTransition(() => {
        setPdfError(undefined)
        changeDetailMode('view')
        setProjectLinkError(undefined)
        setCollectionLinkError(undefined)
      })
    })
  }, [
    changeDetailMode,
    detailController,
    metadata.saving,
    requestMetadataExit,
    setSmartReevaluation,
    addingPdfRef,
    setPdfError
  ])

  const smartTableBlocked =
    smartRunningCollection === collectionId &&
    !!collectionId &&
    singleReevaluation?.collectionId !== collectionId &&
    !smartDecisionBatch.progress

  const selectLibrary = (nextCollectionId?: string): void => {
    setCitationStylesOpen(false)
    setJournalsOpen(false)
    setDuplicatesOpen(false)
    setSection('library')
    setSmartFilter('match')
    setSmartDecisionSource('all')

    setCollectionId(nextCollectionId)
    setProjectId(undefined)
    clearSelection()
  }

  const consumePendingCollectionChange = useLiteratureChanges((event) => {
    const collectionOnly = isCollectionOnlyChange(event)
    if (
      collectionOnly &&
      pendingDecisionsRef.current.size &&
      event?.collectionIds?.every((id) => id === currentCollectionId.current)
    )
      return
    if (
      collectionOnly &&
      smartDecisionBatch.active.current &&
      event?.collectionIds?.every((id) => id === smartDecisionBatch.active.current)
    )
      return
    // The panel owns live progress. Keep saved rows and sidebar counts stable until the run ends.
    if (
      collectionOnly &&
      smartResultSnapshot.current &&
      smartResultSnapshot.current === currentCollectionId.current &&
      event?.collectionIds?.every((id) => id === smartResultSnapshot.current)
    )
      return
    if (collectionOnly) detailController.invalidate()
    // Starting the new reads invalidates outstanding list/navigation requests immediately.
    void Promise.all([
      collectionOnly ? reloadEntries(true, true) : loadEntries(true, true),
      loadCollections().then((collections) => {
        const selectedId = currentCollectionId.current
        if (
          collections &&
          selectedId &&
          !collections.some((collection) => collection.id === selectedId)
        ) {
          selectLibrary()
        }
      }),
      ...(!collectionOnly ? [loadInboxCounts(), loadProjectCounts()] : []),
      (async () => {
        const snapshot = detailController.getSnapshot()
        if (!snapshot.open || !snapshot.item) return
        const latest = await detailController.read(snapshot.item.id)
        if (latest && selectedCollection?.smart) {
          const receipt = await window.api.literature.transact({
            kind: 'read-smart-decisions',
            collectionId: selectedCollection.id,
            itemIds: [latest.id]
          })
          latest.smartDecision = receipt.smartDecisions?.[0]
        }
        if (detailController.getSnapshot().generation !== snapshot.generation) return
        if (!latest || latest.id !== snapshot.item.id || latest.deletedAt !== undefined) {
          // Read the current mode after awaiting: an edit may have started during the refresh.
          if (detailModeRef.current === 'view') {
            setPreviewItem(undefined)
            closeSelectedItemDetail()
          } else setRemovedDetailItemId(snapshot.item.id)
          setError(t('This reference is no longer in your Library.'))
        } else {
          setRemovedDetailItemId((id) => (id === latest.id ? undefined : id))
          detailController.replace(latest)
        }
      })()
    ]).catch(() => setError(t('Literature could not be loaded.')))
  })

  useEffect(() => {
    const loadNavigation = async (): Promise<void> => {
      try {
        await Promise.all([loadCollections(), loadInboxCounts(), loadProjectCounts()])
      } catch {
        setError(t('Literature could not be loaded.'))
      }
    }
    void loadNavigation()
  }, [loadCollections, loadInboxCounts, loadProjectCounts, t])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setEntriesOffset(0)
      clearSelection()
      setLifecycleFailure(undefined)
      setRestorePreview(undefined)
      setLinkFailure(undefined)
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [
    clearSelection,
    entriesKey,
    setLifecycleFailure,
    setRestorePreview,
    setLinkFailure,
    setEntriesOffset
  ])

  const citationLocale = i18n.resolvedLanguage === 'zh-Hans' ? 'zh-CN' : 'en-US'

  useEffect(() => {
    if (metadata.mode !== 'citation' || citationStyles !== undefined) return
    let active = true
    void window.api.literature.citationStyles({ kind: 'list' }).then(
      ({ styles }) => {
        if (active) updateCitationStyles(styles)
      },
      () => undefined
    )
    return () => {
      active = false
    }
  }, [citationStyles, metadata.mode, updateCitationStyles])

  const formattedMatchingCount = useMemo(
    () => new Intl.NumberFormat(i18n.language).format(entriesTotalCount),
    [entriesTotalCount, i18n.language]
  )
  const activeProjects = useMemo(
    () => projects.filter((project) => project.archivedAt === undefined),
    [projects]
  )
  const smartScopeCanOpen = (() => {
    const scope = smartView?.scope
    if (!scope) return false
    if (scope.kind !== 'project') return true
    return activeProjects.some((project) => project.id === scope.id)
  })()
  const returnLabel = activeProjects.some((project) => project.id === activeProjectId)
    ? t('Back to Project')
    : t('Back to Home')
  const selectedProject = useMemo(
    () => activeProjects.find((project) => project.id === projectId),
    [activeProjects, projectId]
  )
  const reviewProjectId =
    selectedProject?.id ??
    (selectedCollection && activeProjects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : undefined)
  const showLiteratureReviewAction =
    section === 'library' &&
    Boolean(reviewProjectId && (selectedProject || selectedCollection)) &&
    (selectedCollection
      ? selectedCollection.itemCount > 0
      : (projectItemCounts[projectId ?? ''] ?? 0) > 0)

  useEffect(() => {
    if (!showLiteratureReviewAction || !shouldCueLiteratureReview) return
    window.sessionStorage.setItem(LITERATURE_REVIEW_CTA_ATTENTION_KEY, 'true')
  }, [shouldCueLiteratureReview, showLiteratureReviewAction])

  const displayCollections = useMemo(() => {
    const byId = new Map(collections.map((collection) => [collection.id, collection]))
    return collections.map((collection) => {
      const names = [collection.name]
      const seen = new Set([collection.id])
      let parentId = collection.parentId
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = byId.get(parentId)
        if (!parent) break
        names.unshift(parent.name)
        parentId = parent.parentId
      }
      return { ...collection, name: names.join(' / ') }
    })
  }, [collections])
  const batchCollections = useMemo(
    () =>
      displayCollections.filter(
        (collection) => !collection.smart && collection.id !== collectionId
      ),
    [collectionId, displayCollections]
  )
  const itemTypeLabels = useMemo<Record<LiteratureItemType, string>>(
    () => ({
      journalArticle: t('Journal article'),
      review: t('Review'),
      preprint: t('Preprint'),
      conferencePaper: t('Conference paper'),
      book: t('Book'),
      bookSection: t('Book section'),
      thesis: t('Thesis'),
      report: t('Report'),
      dataset: t('Dataset'),
      standard: t('Standard'),
      patent: t('Patent'),
      webpage: t('Web page'),
      document: t('Document')
    }),
    [t]
  )
  const activeFilterCount =
    (tagId !== 'all' ? 1 : 0) +
    (filterItemType !== 'all' ? 1 : 0) +
    (yearFilter.from ? 1 : 0) +
    (yearFilter.to ? 1 : 0) +
    (filterHasPdf !== 'all' ? 1 : 0) +
    journalAttributeFilters.length

  const clearFilters = (): void => {
    setTagId('all')
    setFilterItemType('all')
    yearFilter.clear()
    setFilterHasPdf('all')
    setJournalAttributeFilters([])
    clearSelection()
  }

  const {
    pendingCandidateId,
    dismissedCandidateUndo,
    candidateUpdateUncertain,
    candidateCountsFailed,
    undoNotice,
    retryCandidateReads,
    changeCandidateState,
    settleSelectedCandidates,
    restoreDismissedCandidates,
    dismissUndo
  } = useLiteratureCandidates({
    selection: selectionStore,
    batch: { busy: isBatching, setBusy: setIsBatching },
    entries: { candidates, update: setCandidates, reload: loadEntries, failed: entriesFailed },
    counts: {
      reloadProjects: loadProjectCounts,
      reloadInbox: loadInboxCounts,
      updatePending: setInboxPendingCount,
      updateDismissed: setInboxDismissedCount
    },
    onError: setError
  })

  const candidateProjectNames = (entry: LiteratureInboxCandidateView): string[] => {
    const ids = new Set(
      (entry.discoveries?.map(({ origin }) => origin) ?? [entry.candidate.origin])
        .map(({ projectId }) => projectId)
        .filter(Boolean)
    )
    return projects.filter(({ id }) => ids.has(id)).map(({ name }) => name)
  }

  const openCreateCollection = (): void => {
    collectionEditorRef.current?.openCreate()
  }

  const openEditCollection = (collection: LiteratureCollectionView): void => {
    collectionEditorRef.current?.openEdit(collection)
  }

  const {
    collectionPendingDelete,
    setCollectionPendingDelete,
    isDeletingCollection,
    collectionDeleteError,
    setCollectionDeleteError,
    dialogCollectionDeletion,
    promotedCollections,
    conflictingCollections,
    deleteCollection
  } = useLiteratureCollectionDeletion({
    collections,
    setCollections,
    collectionId,
    selectLibrary,
    loadCollections
  })

  const selectProject = (nextProjectId: string): void => {
    setCitationStylesOpen(false)
    setJournalsOpen(false)
    setDuplicatesOpen(false)
    setSection('library')
    setCollectionId(undefined)
    setProjectId(nextProjectId)
    clearSelection()
  }

  const selectSection = (nextSection: Exclude<LibrarySection, 'library'>): void => {
    setCitationStylesOpen(false)
    setJournalsOpen(false)
    setDuplicatesOpen(false)
    setSection(nextSection)
    setCollectionId(undefined)
    setProjectId(undefined)
    clearSelection()
  }

  const { setProjectLink, setCollectionLink, persistInlineItem } = useLiteratureItemEdits({
    detailController,
    setItems,
    setProjectLinkError,
    setProjectItemCounts,
    projectId,
    closeSelectedItemDetail,
    loadEntries,
    setCollections,
    setCollectionLinkError,
    collectionId,
    selectionStore,
    setEntriesTotalCount,
    refreshItems,
    setError
  })

  const metadataFieldLabel = (field: LiteratureMetadataField): string => {
    switch (field) {
      case 'title':
        return t('Title')
      case 'abstract':
        return t('Abstract')
      case 'authors':
        return t('Authors')
      case 'identifiers':
        return t('Identifiers (★ primary)')
      case 'publicationDate':
        return t('Publication date')
      case 'year':
        return t('Year')
      case 'journal':
        return t('Journal')
      case 'shortTitle':
        return t('Short title')
      case 'volume':
        return t('Volume')
      case 'issue':
        return t('Issue')
      case 'pages':
        return t('Pages')
      case 'publisher':
        return t('Publisher')
      case 'issn':
        return t('ISSN')
      case 'language':
        return t('Language')
      case 'url':
        return t('URL')
    }
  }

  const mergeFieldLabel = (field: (typeof mergeScalarFields)[number]): string => {
    switch (field) {
      case 'title':
        return t('Title')
      case 'abstract':
        return t('Abstract')
      case 'issuedText':
        return t('Publication date')
      case 'issuedYear':
        return t('Year')
      case 'containerTitle':
        return t('Journal')
      case 'shortTitle':
        return t('Short title')
      case 'language':
        return t('Language')
      case 'rights':
        return t('Rights')
      case 'url':
        return t('URL')
      case 'citationKey':
        return t('Citation key')
      case 'extra':
        return t('Extra')
      case 'personalNote':
        return t('Notes')
      case 'accessedAt':
        return t('Date accessed')
      case 'rating':
        return t('Rating')
    }
  }

  const {
    isCreatingItem,
    isSavingNewItem,
    createdItemId,
    dialogItemEditor,
    recordImport,
    duplicatePolicy,
    setDuplicatePolicy,
    isImportingRecords,
    createManualItem,
    beginPdfImport,
    closeItemEditor,
    previewRecordImport,
    commitRecordImport,
    trackNewMetadataDirty,
    beginManualImport,
    closeRecordImport
  } = useLiteratureImport({
    projectId,
    collectionId,
    selectedProject,
    selectedCollection,
    detailController,
    pdfStaging,
    setItems,
    loadEntries,
    loadCollections,
    loadProjectCounts,
    openSelectedItemDetail,
    setPdfError,
    requestMetadataExit
  })

  const pendingPdfImport = useNavigationStore((state) => state.pendingLiteraturePdfImport)
  useEffect(() => {
    if (!pendingPdfImport || projectId !== pendingPdfImport.projectId) return
    queueMicrotask(() => {
      const source = useNavigationStore.getState().consumeLiteraturePdfImport(pendingPdfImport)
      if (source) beginPdfImport(source)
    })
  }, [beginPdfImport, pendingPdfImport, projectId])

  const {
    pendingDecisions,
    decisionFailures,
    setDecisionFailures,
    smartRefreshFailure,
    setSmartRefreshFailure,
    smartBatchResult,
    setSmartBatchResult,
    confirmSmartDecision
  } = useLiteratureSmartDecisions({
    selectedCollection,
    smartState,
    currentSmartState,
    currentCollectionId,
    collectionsGenerationRef,
    setCollections,
    detailController,
    pendingDecisionsRef,
    isBatching,
    setIsBatching,
    setError,
    resolveSelectedItemIds,
    loadEntries,
    loadCollections,
    smartRunningCollection,
    consumePendingCollectionChange,
    currentEntriesReload,
    smartDecisionBatch,
    selectionStore,
    refreshSmartSummary
  })

  const smartCellActions = useRef<SmartCollectionCellActions>({
    update: () => {},
    reevaluate: () => {},
    decide: () => {}
  })
  useLayoutEffect(() => {
    smartCellActions.current = {
      update: () => void updateSmartEvidence(),
      reevaluate: (id) => void prepareSmartReevaluation([id]),
      decide: (id, decision) => void confirmSmartDecision(decision, [id], true)
    }
  })

  const requestBatchLookup = async (mode: BatchLookupMode): Promise<void> => {
    if (isBatching) return
    setIsBatching(true)
    setError(undefined)
    try {
      const itemIds = await resolveSelectedItemIds()
      if (itemIds.length > LITERATURE_JOB_MAX_ITEMS) {
        setError(
          t('Select no more than {{limit}} references for this task.', {
            limit: LITERATURE_JOB_MAX_ITEMS
          })
        )
        return
      }
      if (itemIds.length) setBatchLookup({ mode, itemIds })
    } catch {
      setError(t('Selected references could not be loaded.'))
    } finally {
      setIsBatching(false)
    }
  }

  const previewFirstAttachment = (entry: LiteratureItemView): void => {
    const attachment = entry.attachments.find((candidate) => candidate.versions[0])
    const version = attachment?.versions[0]
    if (
      section === 'trash' ||
      entry.deletedAt !== undefined ||
      !attachment ||
      !version ||
      version.availability === 'unavailable' ||
      useAttachmentOperations
        .getState()
        .operations.some((operation) => operation.itemId === entry.id && operation.pending)
    )
      return
    setPreviewItem({
      id: `literature:${version.id}`,
      sessionId: LITERATURE_PREVIEW_SESSION_ID,
      title: version.filename,
      type: 'file',
      source: 'literature',
      managedFileId: attachment.id,
      path: createLiteratureAttachmentVersionReference(version.id),
      format: 'pdf',
      name: version.filename,
      mimeType: version.contentType,
      size: version.sizeBytes,
      versionNumber: version.versionNumber
    })
  }

  const {
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
  } = useLiteratureReading({
    selectedProject,
    setPreviewItem,
    isBatching,
    selectionStore,
    items,
    detailController,
    buildEntriesRequest
  })

  const batchProjectFormDialog = useProjectFormDialog({
    onCreated: (project) => void addSelectedItemsToProject(project.id)
  })

  const { exportSelectedItems, exportCurrentScope } = useLiteratureExport({
    citationStyle: citationStyleRef,
    locale: citationLocale,
    selectedProject,
    selectedCollection,
    resolveSelectedItemIds,
    onError: setError
  })

  const {
    mergeOpen,
    setMergeOpen,
    mergeError,
    setMergeError,
    setDuplicateMergeItems,
    mergeSurvivorId,
    setMergeSurvivorId,
    mergeFieldSources,
    setMergeFieldSources,
    selectedItems,
    mergeSelectedItems
  } = useLiteratureMerge({
    selectionStore,
    items,
    isBatching,
    setIsBatching,
    setError,
    setDuplicatesRevision,
    clearSelection,
    loadEntries,
    loadCollections,
    loadProjectCounts
  })

  const entriesPagination =
    entriesTotalCount > 0 ? (
      <LiteraturePagination
        total={entriesTotalCount}
        offset={entriesOffset}
        pageSize={entriesPageSize}
        displayedCount={section === 'inbox' ? candidates.length : items.length}
        countLabel={t('{{count}} references', {
          count: entriesTotalCount,
          defaultValue_one: '{{count}} reference'
        })}
        pageSizeLabel={t('References per page')}
        disabled={smartTableBlocked}
        loading={entriesLoading}
        onOffsetChange={(offset) => {
          clearSelection()
          setEntriesOffset(offset)
        }}
        onPageSizeChange={(size) => {
          if (!LITERATURE_PAGE_SIZES.includes(size as LiteraturePageSize)) return
          clearSelection()
          setEntriesOffset(0)
          setEntriesPageSize(size as LiteraturePageSize)
        }}
      />
    ) : null

  const smartReevaluationNotice = smartReevaluation &&
    smartReevaluation.collectionId === collectionId && (
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open) setSmartReevaluation(undefined)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            data-slot="smart-reevaluation-dialog"
            className={dialogPanelClassName('w-[min(480px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div>
                <Dialog.Title className={dialogTitleClassName}>
                  {smartReevaluation.detailItemId ? t('Re-evaluate') : t('Re-evaluate selected')}
                </Dialog.Title>
                <Dialog.Description className={dialogDescriptionClassName}>
                  {t(
                    'Re-evaluate selected references ({{total}})? This may incur costs. Manual decisions are retained.',
                    { total: smartReevaluation.ids.length }
                  )}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Close')}>
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>
            <div className={dialogBodyClassName}>
              {smartReevaluation.detailItemId && selectedItem ? (
                <p className="mb-3 line-clamp-2 text-sm font-medium leading-5">
                  {selectedItem.item.title}
                </p>
              ) : null}
              <label className="flex items-start gap-2 text-sm text-muted-foreground">
                <Checkbox.Root
                  checked={smartReevaluationRemember}
                  onCheckedChange={(checked) => setSmartReevaluationRemember(checked === true)}
                  className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border-300 bg-bg-000 data-[state=checked]:border-primary data-[state=checked]:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Checkbox.Indicator>
                    <Check className="size-3 text-white" aria-hidden="true" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                {t("Don't ask again")}
              </label>
            </div>
            <div className={dialogFooterClassName}>
              <Dialog.Close asChild>
                <Button variant="outline">{t('Cancel')}</Button>
              </Dialog.Close>
              <Button
                disabled={
                  isBatching ||
                  !smartView?.configured ||
                  smartView?.run?.state === 'running' ||
                  smartView?.run?.state === 'queued'
                }
                onClick={() => {
                  if (smartReevaluationRemember && !setSmartReevaluationConfirmation(false))
                    setError(t('Settings could not be saved'))
                  void runSmartReevaluation()
                }}
              >
                {smartReevaluation.detailItemId ? t('Re-evaluate') : t('Re-evaluate selected')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )

  const rowActions = useRef<LiteratureRowActions>({
    openSelectedItemDetail,
    persistInlineItem,
    previewFirstAttachment,
    setItemsLifecycle,
    requestPermanentDeletion
  })
  useLayoutEffect(() => {
    rowActions.current = {
      openSelectedItemDetail,
      persistInlineItem,
      previewFirstAttachment,
      setItemsLifecycle,
      requestPermanentDeletion
    }
  })

  const discardMetadataDialog = (
    <ConfirmActionDialog
      open={Boolean(discardMetadata)}
      title={t('Discard unsaved changes?')}
      description={t('Your reference edits have not been saved.')}
      cancelLabel={t('Keep editing')}
      confirmLabel={t('Discard changes')}
      destructive
      onCloseAutoFocus={(event) => {
        const target = metadataExitFocusRef.current
        metadataExitFocusRef.current = null
        if (target?.isConnected && !target.closest('[inert], [aria-hidden="true"]')) {
          event.preventDefault()
          target.focus()
        }
      }}
      onCancel={() => setDiscardMetadata(undefined)}
      onConfirm={() => {
        setDiscardMetadata(undefined)
        discardMetadata?.()
      }}
    />
  )

  return (
    <SmartDecisionPendingContext.Provider value={pendingDecisions.size > 0}>
      <main className="flex h-svh min-h-0 overflow-hidden bg-bg-10 text-text-000">
        <LiteratureLibrarySidebar
          navigation={{
            section,
            collectionId,
            projectId,
            citationStylesOpen,
            journalsOpen,
            duplicatesOpen,
            selectSection,
            selectLibrary,
            selectProject,
            openDuplicates: () => {
              setCitationStylesOpen(false)
              setJournalsOpen(false)
              setDuplicatesOpen(true)
              clearSelection()
            },
            openJournals: () => {
              setCitationStylesOpen(false)
              setJournalsVisited(true)
              setJournalsOpen(true)
              setDuplicatesOpen(false)
              clearSelection()
            },
            openCitationStyles: () => {
              setJournalsOpen(false)
              setCitationStylesOpen(true)
              setDuplicatesOpen(false)
            }
          }}
          counts={{ inboxPendingCount, libraryCountRevision, projectItemCounts, duplicateCountRef }}
          activeProjects={activeProjects}
          displayCollections={displayCollections}
          libraryEntryRef={libraryEntryRef}
          returnLabel={returnLabel}
          openCreateCollection={openCreateCollection}
        />

        <section className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <LiteratureDuplicatesView
            active={duplicatesOpen && !citationStylesOpen && !journalsOpen}
            revision={duplicatesRevision}
            onCount={setDuplicateCount}
            onMerged={() => {
              void loadEntries(true)
              void loadCollections()
              void loadProjectCounts()
              setDuplicatesRevision((value) => value + 1)
            }}
            onReview={(entries) => {
              setMergeError(undefined)
              setDuplicateMergeItems(entries)
              setMergeSurvivorId(entries[0]?.id ?? '')
              setMergeFieldSources({})
              setMergeOpen(true)
            }}
          />
          {journalsVisited ? (
            <div className={journalsOpen ? 'contents' : 'hidden'}>
              <Suspense
                fallback={
                  <div role="status" className="p-6 text-sm text-muted-foreground">
                    {t('Loading')}
                  </div>
                }
              >
                <JournalManager
                  embedded
                  active={journalsOpen}
                  onClose={closeJournals}
                  onOpenItem={openJournalReference}
                />
              </Suspense>
            </div>
          ) : null}
          {citationStylesOpen ? (
            <CitationStylesView
              embedded
              styles={citationStyles}
              onBack={() => setCitationStylesOpen(false)}
              onStylesChange={updateCitationStyles}
            />
          ) : null}
          <div
            className={cn(
              'flex h-full min-h-0 w-full max-w-none flex-col px-4 py-6 lg:px-6 lg:py-8',
              (citationStylesOpen || journalsOpen || duplicatesOpen) && 'hidden'
            )}
          >
            <LiteratureLibraryHeader
              selectedCollection={selectedCollection}
              selectedProject={selectedProject}
              section={section}
              openProject={openProject}
              smartSetup={smartSetup}
              showLiteratureReviewAction={showLiteratureReviewAction}
              reviewProjectId={reviewProjectId}
              shouldCueLiteratureReview={shouldCueLiteratureReview}
              startLiteratureReviewConversation={startLiteratureReviewConversation}
              setShouldCueLiteratureReview={setShouldCueLiteratureReview}
              importPdfInputRef={importPdfInputRef}
              setPdfBatch={setPdfBatch}
              projectId={projectId}
              collectionId={collectionId}
              beginPdfImport={beginPdfImport}
              importRecordsInputRef={importRecordsInputRef}
              previewRecordImport={previewRecordImport}
              beginManualImport={beginManualImport}
              query={query}
              searchResetRevision={searchResetRevision}
              setQuery={setQuery}
              clearSelection={clearSelection}
              openEditCollection={openEditCollection}
              setCollectionDeleteError={setCollectionDeleteError}
              setCollectionPendingDelete={setCollectionPendingDelete}
              loadCollections={loadCollections}
              entriesLoading={entriesLoading}
              projectItemCounts={projectItemCounts}
              exportCurrentScope={exportCurrentScope}
            />

            {selectedCollection?.smart && (
              <SmartCollectionPanel
                key={selectedCollection.id}
                collectionId={selectedCollection.id}
                state={smartState}
                name={selectedCollection.name}
                description={selectedCollection.description}
                onReview={
                  showLiteratureReviewAction && reviewProjectId
                    ? () =>
                        startLiteratureReviewConversation(
                          reviewProjectId,
                          {
                            type: 'literature-scope',
                            scope: 'collection',
                            collectionId: selectedCollection.id,
                            name: selectedCollection.name
                          },
                          t('Synthesize this literature into a concise review.')
                        )
                    : undefined
                }

                onRunPendingChange={(pending) => {
                  if (currentSmartState.current !== smartState) return
                  if (pending) {
                    setScreeningStartingCollection(selectedCollection.id)
                    setScreeningCollection(selectedCollection.id)
                  } else {
                    setScreeningStartingCollection((current) =>
                      current === selectedCollection.id ? undefined : current
                    )
                  }
                }}
                onOpenProcess={() => setScreeningCollection(selectedCollection.id)}
                processOpen={screeningOpen}
                onExport={exportCurrentScope}
                exportDisabled={entriesLoading || selectedCollection.itemCount === 0}
                searchActions={
                  <div className={screeningOpen ? 'hidden' : 'contents'}>
                    <LiteratureSearchInput
                      initialValue={query}
                      resetRevision={searchResetRevision}
                      onCommit={setQuery}
                      onDraftChange={clearSelection}
                    />
                  </div>
                }
                decisionPending={pendingDecisions.size > 0}
                singleReevaluation={singleReevaluation?.collectionId === selectedCollection.id}
                onViewChange={receiveSmartView}
                onEdit={() => openEditCollection(selectedCollection)}
                onOpenScope={
                  smartScopeCanOpen
                    ? (scope) => {
                        if (scope.kind === 'library') selectLibrary()
                        else if (scope.kind === 'project') selectProject(scope.id)
                        else selectLibrary(scope.id)
                      }
                    : undefined
                }
                onDelete={() => {
                  setCollectionDeleteError(undefined)
                  setCollectionPendingDelete(selectedCollection)
                  void loadCollections().catch(() =>
                    setCollectionDeleteError(t('Literature could not be loaded.'))
                  )
                }}
              />
            )}

            {selectedCollection?.smart && screeningOpen && (
              <div data-slot="smart-screening-view" className="flex min-h-0 flex-1 flex-col">
                <div className="mt-4 border-b border-border pb-2">
                  <Button
                    ref={screeningBackButton}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      restoreScreeningFocus.current = true
                      setScreeningCollection(undefined)
                    }}
                  >
                    <ArrowLeft className="size-4" aria-hidden="true" />
                    {t('Back to results')}
                  </Button>
                </div>
                <SmartCollectionProcess
                  key={selectedCollection.id}
                  collectionId={selectedCollection.id}
                  starting={screeningStartingCollection === selectedCollection.id}
                  state={smartState}
                />
              </div>
            )}
            <div
              ref={screeningResults}
              role={selectedCollection?.smart ? 'region' : undefined}
              aria-label={selectedCollection?.smart ? t('Results') : undefined}
              tabIndex={-1}
              className={
                selectedCollection?.smart && screeningOpen
                  ? 'hidden'
                  : 'flex min-h-0 flex-1 flex-col'
              }
            >
              <div className="flex min-h-0 flex-1 flex-col">
                {decisionFailures.map((failure) => (
                  <LiteratureErrorNotice
                    key={failure.key}
                    className="mt-3 w-full"
                    description={t('The decision could not be saved in {{collection}}.', {
                      collection: failure.collection
                    })}
                    primaryButton={{
                      label: t('Retry'),
                      onClick: failure.retry,
                      disabled: pendingDecisions.has(failure.key)
                    }}
                    secondaryButton={{
                      label: t('Dismiss'),
                      onClick: () =>
                        setDecisionFailures((current) =>
                          current.filter((entry) => entry.key !== failure.key)
                        )
                    }}
                  />
                ))}
                {smartRefreshFailure && smartRefreshFailure === collectionId && (
                  <LiteratureErrorNotice
                    className="mt-3 w-full"
                    description={t(
                      'Decision saved, but results could not be refreshed. Reload the collection to see the latest results.'
                    )}
                    primaryButton={{
                      label: t('Retry'),
                      disabled: entriesLoading || isBatching || pendingDecisions.size > 0,
                      onClick: () => {
                        void Promise.all([loadEntries(true, true), refreshSmartSummary()])
                          .then(([refreshed, summary]) => {
                            if (
                              refreshed === true &&
                              summary &&
                              currentCollectionId.current === collectionId
                            ) {
                              setSmartRefreshFailure(undefined)
                              setError(undefined)
                            }
                          })
                          .catch(() => {
                            /* Keep the saved-state warning and its read-only retry. */
                          })
                      }
                    }}
                  />
                )}
                {smartBatchResult && smartBatchResult.collectionId === collectionId && (
                  <div
                    role="status"
                    className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <span>
                      {t('Decisions saved: {{done}}. Failed: {{failed}}.', {
                        done: smartBatchResult.done,
                        failed: smartBatchResult.failed.length
                      })}
                    </span>
                    {smartBatchResult.remaining.length > 0 && (
                      <span>
                        {t('Not processed: {{remaining}}', {
                          remaining: smartBatchResult.remaining.length
                        })}
                      </span>
                    )}
                    {(smartBatchResult.failed.length > 0 ||
                      smartBatchResult.remaining.length > 0) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isBatching}
                        onClick={() =>
                          void confirmSmartDecision(smartBatchResult.decision, [
                            ...smartBatchResult.failed,
                            ...smartBatchResult.remaining
                          ])
                        }
                      >
                        {t('Retry')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSmartBatchResult(undefined)}
                    >
                      {t('Dismiss')}
                    </Button>
                  </div>
                )}
                <div
                  data-slot="literature-action-rail"
                  className={
                    section === 'inbox' || smartSetup ? 'hidden' : 'mt-4 min-h-12 shrink-0'
                  }
                >
                  <fieldset
                    disabled={smartTableBlocked}
                    className="contents"
                    data-slot="smart-table-controls"
                  >
                    <LiteratureSelectionBoundary store={selectionStore}>
                      {(selection) => {
                        const hasSelection =
                          selection.allMatchingSelected || selection.selectedIds.size > 0
                        const selectedItemCount = selection.allMatchingSelected
                          ? Math.max(0, entriesTotalCount - selection.excludedMatchingIds.size)
                          : selection.selectedIds.size
                        const allLoadedItemsSelected =
                          items.length > 0 &&
                          items.every((item) => isLiteratureItemSelected(selection, item.id))
                        return (
                          <div className={cn('flex h-12 min-w-0 items-center justify-end gap-2')}>
                            {selectedCollection?.smart && !hasSelection && (
                              <>
                                <Tabs.Root
                                  value={smartFilter}
                                  onValueChange={(value) =>
                                    setSmartFilter(value as typeof smartFilter)
                                  }
                                  className="mr-auto min-w-0 max-w-full"
                                >
                                  <Tabs.List
                                    aria-label={t('Filter decisions')}
                                    className={literatureTabsListClassName}
                                  >
                                    {(
                                      [
                                        [
                                          'match',
                                          t('Included'),
                                          t('Papers included by the rule or your manual decision.')
                                        ],
                                        [
                                          'review',
                                          t('Needs review'),
                                          t('Uncertain or outdated results that need review.')
                                        ],
                                        [
                                          'no-match',
                                          t('Excluded'),
                                          t('Papers excluded by the rule or your manual decision.')
                                        ],
                                        [
                                          'pending',
                                          t('Not evaluated'),
                                          t(
                                            'Papers not evaluated by a model: not started, failed, or insufficient evidence.'
                                          )
                                        ]
                                      ] as const
                                    ).map(([value, label, hint]) => (
                                      <Tabs.Trigger
                                        key={value}
                                        value={value}
                                        id={`smart-decision-${value}`}
                                        aria-controls="smart-collection-results"
                                        title={hint}
                                        className={literatureTabClassName}
                                      >
                                        {label}
                                        <span className="rounded-sm bg-muted px-1.5 text-xs tabular-nums">
                                          {(smartDecisionSource === 'all'
                                            ? smartView?.counts
                                            : smartView?.countsBySource?.[smartDecisionSource])?.[
                                            value
                                          ] ?? '—'}
                                        </span>
                                      </Tabs.Trigger>
                                    ))}
                                  </Tabs.List>
                                </Tabs.Root>
                              </>
                            )}
                            <LiteratureBackgroundTasks
                              hidden={hasSelection || section === 'inbox'}
                              onOpen={(job) =>
                                setBatchLookup({ mode: job.mode, jobId: job.id, itemIds: [] })
                              }
                              onChanged={receiveBackgroundItems}
                            />
                            {section !== 'inbox' && (
                              <>
                                {!hasSelection && (
                                  <LiteratureViewControls
                                    selectedCollection={selectedCollection}
                                    smartDecisionSource={smartDecisionSource}
                                    smartView={smartView}
                                    setSmartDecisionSource={setSmartDecisionSource}
                                    clearSelection={clearSelection}
                                    sortBy={sortBy}
                                    setSortBy={setSortBy}
                                    filtersOpen={filtersOpen}
                                    setFiltersOpen={setFiltersOpen}
                                    yearFilter={yearFilter}
                                    activeFilterCount={activeFilterCount}
                                    accessibilityId={accessibilityId}
                                    tagId={tagId}
                                    setTagId={setTagId}
                                    filterItemType={filterItemType}
                                    setFilterItemType={setFilterItemType}
                                    itemTypeLabels={itemTypeLabels}
                                    filterHasPdf={filterHasPdf}
                                    setFilterHasPdf={setFilterHasPdf}
                                    journalFilterDatasets={journalFilterDatasets}
                                    journalAttributeFilters={journalAttributeFilters}
                                    setJournalAttributeFilters={setJournalAttributeFilters}
                                    clearFilters={clearFilters}
                                    journalDatasets={journalDatasets}
                                    journalSourceYears={journalSourceYears}
                                    tableColumnOrder={tableColumnOrder}
                                    journalColumns={journalColumns}
                                    tableColumnLabels={tableColumnLabels}
                                    visibleTableColumns={visibleTableColumns}
                                    moveTableColumn={moveTableColumn}
                                    moveTableColumnBy={moveTableColumnBy}
                                    setVisibleTableColumns={setVisibleTableColumns}
                                  />
                                )}
                                {hasSelection && (
                                  <LiteratureSelectionToolbar
                                    selectedItemCount={selectedItemCount}
                                    selection={selection}
                                    allLoadedItemsSelected={allLoadedItemsSelected}
                                    entriesOffset={entriesOffset}
                                    nextEntriesOffset={nextEntriesOffset}
                                    formattedMatchingCount={formattedMatchingCount}
                                    isBatching={isBatching}
                                    selectionStore={selectionStore}
                                    clearSelection={clearSelection}
                                    smartDecisionBatch={smartDecisionBatch}
                                    collectionId={collectionId}
                                    selectedCollection={selectedCollection}
                                    pendingDecisions={pendingDecisions}
                                    confirmSmartDecision={confirmSmartDecision}
                                    smartView={smartView}
                                    prepareSmartReevaluation={prepareSmartReevaluation}
                                    section={section}
                                    startingReadingProjectId={startingReadingProjectId}
                                    requestReadSelection={requestReadSelection}
                                    batchCollections={batchCollections}
                                    activeProjects={activeProjects}
                                    projectsLoaded={projectsLoaded}
                                    createCollectionForSelection={createCollectionForSelection}
                                    batchProjectFormDialog={batchProjectFormDialog}
                                    moveSelectedItems={moveSelectedItems}
                                    addSelectedItemsToProject={addSelectedItemsToProject}
                                    items={items}
                                    previewRestoreSelection={previewRestoreSelection}
                                    exportSelectedItems={exportSelectedItems}
                                    requestBatchLookup={requestBatchLookup}
                                    setMergeSurvivorId={setMergeSurvivorId}
                                    setMergeFieldSources={setMergeFieldSources}
                                    setMergeError={setMergeError}
                                    setMergeOpen={setMergeOpen}
                                    runLifecycleAction={runLifecycleAction}
                                    requestPermanentDeletion={requestPermanentDeletion}
                                  />
                                )}
                              </>
                            )}
                          </div>
                        )
                      }}
                    </LiteratureSelectionBoundary>
                  </fieldset>
                </div>
                <LiteratureAttachmentOperations
                  detailController={detailController}
                  onChanged={(operation) => {
                    if (!operation.item) return
                    const current = detailController.getSnapshot().item
                    const updated =
                      current?.id === operation.itemId
                        ? { ...current, attachments: operation.item.attachments }
                        : operation.item
                    detailController.replace(updated)
                    updateMetadataItem(updated)
                    void loadEntries(true)
                  }}
                />
                {batchLookup ? (
                  <LiteratureBatchLookupDialog
                    key={
                      batchLookup.jobId ?? `${batchLookup.mode}:${batchLookup.itemIds.join(',')}`
                    }
                    {...batchLookup}
                    initialItems={items}
                    fieldLabel={metadataFieldLabel}
                    onClose={() => setBatchLookup(undefined)}
                    onChanged={receiveBackgroundItems}
                  />
                ) : null}
                {dismissedCandidateUndo ? (
                  <fieldset
                    className="contents"
                    disabled={isBatching || Boolean(pendingCandidateId)}
                    aria-busy={isBatching || Boolean(pendingCandidateId)}
                  >
                    <ActionToast
                      title={t('Dismissed from Inbox')}
                      detail={dismissedCandidateUndo.detail}
                      actionLabel={dismissedCandidateUndo.needsRecheck ? t('Recheck') : t('Undo')}
                      dismissLabel={t('Close')}
                      onAction={() => void restoreDismissedCandidates()}
                      onDismiss={() => {
                        dismissUndo()
                      }}
                      testId="literature-dismiss-undo"
                      className="static w-full max-w-none shadow-none"
                    />
                  </fieldset>
                ) : null}
                {linkFailure && linkFailure.scopeKey === entriesKey ? (
                  <div className="mt-2">
                    <LiteratureErrorNotice
                      className="w-full min-w-0 rounded-md px-3 py-1.5"
                      description={
                        linkFailure.skipped
                          ? t(
                              'Updated: {{completed}}. Not updated: {{remaining}}. Unavailable: {{skipped}}.',
                              {
                                completed: linkFailure.completed,
                                remaining: linkFailure.itemIds.length,
                                skipped: linkFailure.skipped
                              }
                            )
                          : t('Updated: {{completed}}. Not updated: {{remaining}}.', {
                              completed: linkFailure.completed,
                              remaining: linkFailure.itemIds.length
                            })
                      }
                      primaryButton={
                        linkFailure.itemIds.length
                          ? {
                              label: t('Retry'),
                              disabled: isBatching,
                              onClick: () =>
                                void runLinkBatch(
                                  linkFailure.command,
                                  linkFailure.itemIds,
                                  linkFailure.completed,
                                  linkFailure.skipped,
                                  true
                                )
                            }
                          : undefined
                      }
                    />
                  </div>
                ) : null}
                {lifecycleFailure ? (
                  <div className="mt-5">
                    <LiteratureErrorNotice
                      title={t('Literature could not be updated.')}
                      description={t('Updated: {{completed}}. Not updated: {{remaining}}.', {
                        completed: lifecycleFailure.completed,
                        remaining: lifecycleFailure.itemIds.length
                      })}
                      secondaryButton={{
                        label: t('Retry'),
                        disabled: isBatching,
                        onClick: () =>
                          void setItemsLifecycle(lifecycleFailure.itemIds, lifecycleFailure.state)
                      }}
                    />
                  </div>
                ) : null}
                {candidateUpdateUncertain || candidateCountsFailed ? (
                  <div className="mt-2">
                    <LiteratureErrorNotice
                      className="w-fit max-w-full rounded-md px-3 py-1.5 [&>div]:items-center"
                      description={
                        candidateUpdateUncertain
                          ? t(
                              'The update could not be confirmed. Check the Inbox before trying again.'
                            )
                          : [
                              t('Project counts could not be refreshed.'),
                              error === t('Literature could not be loaded.') ? error : undefined
                            ]
                              .filter(Boolean)
                              .join(' ')
                      }
                      primaryButton={{
                        label: t('Retry'),
                        disabled: isBatching || Boolean(pendingCandidateId),
                        onClick: () => void retryCandidateReads()
                      }}
                    />
                  </div>
                ) : null}
                {undoNotice ? (
                  <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">
                    {undoNotice}
                  </p>
                ) : null}
                {permanentDeleteResult?.cleanupPending ? (
                  <div className="mt-2">
                    <LiteratureErrorNotice
                      title={t(
                        'References were permanently deleted. Some files are awaiting cleanup.'
                      )}
                      description={t(
                        'Startup cleanup can retry unreferenced files. Completion depends on file access and is not guaranteed on the next start.'
                      )}
                    />
                  </div>
                ) : null}
                {permanentDeleteResult && (permanentDeleteResult.refreshFailed || entriesFailed) ? (
                  <div className="mt-2">
                    <LiteratureErrorNotice
                      description={t(
                        'References were permanently deleted, but the view could not be refreshed.'
                      )}
                      primaryButton={{
                        label: t('Retry'),
                        loading: isBatching,
                        onClick: () => void refreshAfterPermanentDeletion()
                      }}
                    />
                  </div>
                ) : null}
                {oversizedItemId ? <LiteratureOversizedNotice itemId={oversizedItemId} /> : null}
                {!oversizedItemId &&
                (linkedItemError || error) &&
                !(
                  permanentDeleteResult &&
                  !linkedItemError &&
                  error === t('Literature could not be loaded.')
                ) &&
                !entriesLoading &&
                // A failed Inbox read is already covered by the recovery notice and its Retry.
                !(
                  !linkedItemError &&
                  (candidateUpdateUncertain || candidateCountsFailed) &&
                  error === t('Literature could not be loaded.')
                ) ? (
                  <div className="mt-2">
                    <LiteratureErrorNotice
                      className="w-fit max-w-full rounded-md px-3 py-1.5 [&>div]:items-center"
                      description={linkedItemError || error || undefined}
                      primaryButton={
                        !linkedItemError && error === t('Literature could not be loaded.')
                          ? {
                              label: t('Retry'),
                              disabled: isBatching,
                              onClick: () => {
                                void Promise.all([
                                  loadEntries(true, true),
                                  loadCollections(),
                                  loadInboxCounts(),
                                  loadProjectCounts()
                                ]).catch(() => setError(t('Literature could not be loaded.')))
                              }
                            }
                          : undefined
                      }
                    />
                  </div>
                ) : null}

                {section === 'inbox' ? (
                  <Tabs.Root
                    value={inboxState}
                    onValueChange={(value) => {
                      setInboxState(value as typeof inboxState)
                      clearSelection()
                      setEntriesOffset(0)
                    }}
                    className="mt-5 min-w-0 max-w-full self-start"
                  >
                    <Tabs.List aria-label={t('Inbox')} className={literatureTabsListClassName}>
                      {(['pending', 'dismissed'] as const).map((state) => (
                        <Tabs.Trigger
                          key={state}
                          value={state}
                          id={`inbox-state-${state}`}
                          aria-controls="inbox-results"
                          className={literatureTabClassName}
                          disabled={isBatching || pendingCandidateId !== undefined}
                        >
                          {state === 'pending' ? t('Pending') : t('Dismissed')}
                          <span className="rounded-sm bg-muted px-1.5 text-xs tabular-nums">
                            {(state === 'pending' ? inboxPendingCount : inboxDismissedCount) ?? '—'}
                          </span>
                        </Tabs.Trigger>
                      ))}
                    </Tabs.List>
                  </Tabs.Root>
                ) : null}
                <div
                  id={
                    section === 'inbox'
                      ? 'inbox-results'
                      : selectedCollection?.smart
                        ? 'smart-collection-results'
                        : undefined
                  }
                  role={section === 'inbox' || selectedCollection?.smart ? 'tabpanel' : undefined}
                  aria-labelledby={
                    section === 'inbox'
                      ? `inbox-state-${inboxState}`
                      : selectedCollection?.smart
                        ? `smart-decision-${smartFilter}`
                        : undefined
                  }
                  className={
                    smartSetup ? 'hidden' : cn('flex min-h-0 flex-1 flex-col gap-2', 'mt-6')
                  }
                >
                  {entriesFailed ? null : entriesLoading && !entriesPageTransitionLoading ? (
                    <div
                      role="status"
                      className="flex min-h-0 flex-1 justify-center py-20 text-muted-foreground"
                    >
                      <LoaderCircle
                        className="size-5 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                      <span className="sr-only">{t('Loading…')}</span>
                    </div>
                  ) : section === 'inbox' ? (
                    candidates.length > 0 ? (
                      <LiteratureInboxList
                        selectionStore={selectionStore}
                        candidates={candidates}
                        isBatching={isBatching}
                        pendingCandidateId={pendingCandidateId}
                        clearSelection={clearSelection}
                        inboxState={inboxState}
                        restoreDismissedCandidates={restoreDismissedCandidates}
                        settleSelectedCandidates={settleSelectedCandidates}
                        setSelectedCandidate={setSelectedCandidate}
                        itemTypeLabels={itemTypeLabels}
                        candidateProjectNames={candidateProjectNames}
                        changeCandidateState={changeCandidateState}
                        entriesPagination={entriesPagination}
                      />
                    ) : (
                      <div className="rounded-2xl border border-dashed border-border py-20 text-center">
                        <Inbox
                          className="mx-auto size-7 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <h3 className="mt-3 font-medium">
                          {inboxState === 'dismissed'
                            ? t('No dismissed references')
                            : t('Inbox is clear')}
                        </h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {inboxState === 'dismissed'
                            ? t('Dismissed references can be restored here.')
                            : t('New Agent discoveries will appear here for review.')}
                        </p>
                      </div>
                    )
                  ) : items.length > 0 || entriesPageTransitionLoading ? (
                    <LiteratureResultsTable
                      tableScrollRef={tableScrollRef}
                      tableMinWidth={tableMinWidth}
                      selectedCollection={selectedCollection}
                      smartTableBlocked={smartTableBlocked}
                      items={items}
                      selectionStore={selectionStore}
                      visibleOrderedTableColumns={visibleOrderedTableColumns}
                      tableColumnLabels={tableColumnLabels}
                      rowNumbers={rowNumbers}
                      section={section}
                      isBatching={isBatching}
                      pendingDecisions={pendingDecisions}
                      collectionId={collectionId}
                      smartRunningCollection={smartRunningCollection}
                      smartView={smartView}
                      completedReevaluation={completedReevaluation}
                      singleReevaluation={singleReevaluation}
                      attachmentOperations={attachmentOperations}
                      smartCellActions={smartCellActions}
                      itemTypeLabels={itemTypeLabels}
                      rowActions={rowActions}
                      entriesPageTransitionLoading={entriesPageTransitionLoading}
                      entriesPagination={entriesPagination}
                    />
                  ) : selectedCollection?.smart && !query ? (
                    smartView?.sourceAvailable ? (
                      <div className="rounded-2xl border border-dashed border-border py-20 text-center">
                        <BookOpenText
                          className="mx-auto size-7 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <h3 className="mt-3 font-medium">
                          {smartView.run ? t('No papers in this view.') : t('Ready to organize')}
                        </h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {smartView.run
                            ? t('Try another decision view or adjust the collection rule.')
                            : t(
                                'Evaluate references against your collection rules using the evidence selected for each collection.'
                              )}
                        </p>
                        <Button
                          className="mt-3"
                          variant="outline"
                          disabled={smartTableBlocked}
                          onClick={() => openEditCollection(selectedCollection)}
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                          {t('Edit rule')}
                        </Button>
                      </div>
                    ) : null
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border py-20 text-center">
                      <BookOpenText
                        className="mx-auto size-7 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <h3 className="mt-3 font-medium">
                        {query || activeFilterCount
                          ? t('No references found')
                          : t('No references yet')}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {query || activeFilterCount
                          ? t('Try a different search or clear the filters.')
                          : t(
                              'Add a reference, import a PDF, or import a bibliography to get started.'
                            )}
                      </p>
                      <div className="mt-4 flex justify-center">
                        {query || activeFilterCount ? (
                          <Button
                            variant="outline"
                            onClick={() => {
                              setQuery('')
                              setSearchResetRevision((revision) => revision + 1)
                              clearFilters()
                            }}
                          >
                            {t('Clear filters')}
                          </Button>
                        ) : (
                          <LiteratureAddMenu
                            label={t('Add reference')}
                            onAddReference={() => {
                              beginManualImport()
                            }}
                            onImportPdf={() => importPdfInputRef.current?.click()}
                            onImportReferences={() => importRecordsInputRef.current?.click()}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <LiteratureMergeDialog
          mergeOpen={mergeOpen}
          isBatching={isBatching}
          setMergeOpen={setMergeOpen}
          setDuplicateMergeItems={setDuplicateMergeItems}
          mergeError={mergeError}
          selectedItems={selectedItems}
          mergeSurvivorId={mergeSurvivorId}
          setMergeSurvivorId={setMergeSurvivorId}
          mergeFieldSources={mergeFieldSources}
          setMergeFieldSources={setMergeFieldSources}
          mergeFieldLabel={mergeFieldLabel}
          itemTypeLabels={itemTypeLabels}
          mergeSelectedItems={mergeSelectedItems}
        />

        {pdfBatch ? (
          <LiteraturePdfBatchImportDialog
            {...pdfBatch}
            createDraft={(file) => ({
              ...emptyLiteratureItem(),
              title: titleFromPdfFilename(file.name)
            })}
            onClose={() => {
              setPdfBatch(undefined)
              void loadEntries(true)
              void loadCollections()
              void loadProjectCounts()
            }}
          />
        ) : null}
        {recordImport ? (
          <LiteratureRecordImportDialog
            recordImport={recordImport}
            duplicatePolicy={duplicatePolicy}
            onDuplicatePolicyChange={setDuplicatePolicy}
            isImportingRecords={isImportingRecords}
            destination={recordImport.destination.name}
            itemDescription={itemDescription}
            itemTypeLabels={itemTypeLabels}
            onClose={() => {
              closeRecordImport()
            }}
            onImport={() => void commitRecordImport()}
          />
        ) : null}

        <LiteratureCreateItemDialog
          isCreatingItem={isCreatingItem}
          isSavingNewItem={isSavingNewItem}
          closeItemEditor={closeItemEditor}
          discardMetadataDialog={discardMetadataDialog}
          dialogItemEditor={dialogItemEditor}
          pdfStaging={pdfStaging}
          trackNewMetadataDirty={trackNewMetadataDirty}
          duplicatePolicy={duplicatePolicy}
          setDuplicatePolicy={setDuplicatePolicy}
          createdItemId={createdItemId}
          createManualItem={createManualItem}
        />

        <LiteratureCandidateDialog
          selectedCandidate={selectedCandidate}
          onClose={() => setSelectedCandidate(undefined)}
          itemTypeLabels={itemTypeLabels}
          projectNames={selectedCandidate ? candidateProjectNames(selectedCandidate) : []}
          busy={isBatching || Boolean(pendingCandidateId)}
          entriesFailed={entriesFailed}
          changeCandidateState={changeCandidateState}
          restoreDismissedCandidates={restoreDismissedCandidates}
        />

        <LiteratureDetailDialog
          detailController={detailController}
          previewItem={previewItem}
          selectedItemDialogRef={selectedItemDialogRef}
          detailTagMenuOpenRef={detailTagMenuOpenRef}
          detailSelectOpenRef={detailSelectOpenRef}
          childLayerDismissGuardUntilRef={childLayerDismissGuardUntilRef}
          closeSelectedItemDetail={closeSelectedItemDetail}
          detailInitiatorRef={detailInitiatorRef}
          libraryEntryRef={libraryEntryRef}
          metadata={metadata}
          discardMetadataDialog={discardMetadataDialog}
          leaveMetadataEditor={leaveMetadataEditor}
          itemTypeLabels={itemTypeLabels}
          changeDetailMode={changeDetailMode}
          isAddingPdf={isAddingPdf}
          pdfStaging={pdfStaging}
          pdfInputRef={pdfInputRef}
          updateMetadataItem={updateMetadataItem}
          loadEntries={loadEntries}
          trackMetadataDirty={trackMetadataDirty}
          removedDetailItemId={removedDetailItemId}
          metadataFieldLabel={metadataFieldLabel}
          handleDetailSelectOpenChange={handleDetailSelectOpenChange}
          citationStyleRef={citationStyleRef}
          citationLocale={citationLocale}
          citationStyles={citationStyles}
          setJournalsOpen={setJournalsOpen}
          setCitationStylesOpen={setCitationStylesOpen}
          renderOverview={(selectedItem) => (
            <LiteratureDetailOverview
              selectedCollection={selectedCollection}
              updateSmartEvidence={updateSmartEvidence}
              isBatching={isBatching}
              smartTableBlocked={smartTableBlocked}
              smartView={smartView}
              items={items}
              selectedItem={selectedItem}
              completedReevaluation={completedReevaluation}
              collectionId={collectionId}
              singleReevaluation={singleReevaluation}
              prepareSmartReevaluation={prepareSmartReevaluation}
              pendingDecisions={pendingDecisions}
              smartRunningCollection={smartRunningCollection}
              confirmSmartDecision={confirmSmartDecision}
              itemTypeLabels={itemTypeLabels}
              handleDetailTagMenuOpenChange={handleDetailTagMenuOpenChange}
              activeProjects={activeProjects}
              projectLinkError={projectLinkError}
              projectsLoaded={projectsLoaded}
              setProjectLink={setProjectLink}
              displayCollections={displayCollections}
              collectionLinkError={collectionLinkError}
              setCollectionLink={setCollectionLink}
              changeDetailMode={changeDetailMode}
              isAddingPdf={isAddingPdf}
              pdfInputRef={pdfInputRef}
              addPdf={addPdf}
              pdfError={pdfError}
              detailController={detailController}
              setPreviewItem={setPreviewItem}
              pdfDropZoneProps={pdfDropZoneProps}
              isDraggingPdf={isDraggingPdf}
            />
          )}
        />
        <CollectionEditorDialog
          ref={collectionEditorRef}
          scopes={[
            ...activeProjects.map(({ id, name }) => ({ id, name, kind: 'project' as const })),
            ...collections
              .filter((entry) => !entry.smart)
              .map(({ id, name }) => ({ id, name, kind: 'collection' as const }))
          ]}
          onSaved={({ id, revision, name, description }) => {
            if (id && revision !== undefined) {
              setCollections((current) =>
                current.map((collection) =>
                  collection.id === id && collection.revision <= revision
                    ? { ...collection, revision, name, description, updatedAt: Date.now() }
                    : collection
                )
              )
            }
            if (id && revision === undefined) selectLibrary(id)
            void loadCollections().catch(() => setError(t('Literature could not be loaded.')))
          }}
        />
        <LiteratureCollectionDeleteDialog
          collectionPendingDelete={collectionPendingDelete}
          isDeletingCollection={isDeletingCollection}
          setCollectionPendingDelete={setCollectionPendingDelete}
          dialogCollectionDeletion={dialogCollectionDeletion}
          promotedCollections={promotedCollections}
          conflictingCollections={conflictingCollections}
          openEditCollection={openEditCollection}
          collectionDeleteError={collectionDeleteError}
          deleteCollection={deleteCollection}
        />
        <AlertDialog.Root
          open={Boolean(restorePreview)}
          onOpenChange={(open) => {
            if (!open && !isBatching) setRestorePreview(undefined)
          }}
        >
          <AlertDialog.Portal>
            <AlertDialog.Overlay className={dialogOverlayClassName} />
            <AlertDialog.Content
              className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
            >
              <div className={dialogHeaderClassName}>
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Restore')}
                </AlertDialog.Title>
              </div>
              <div className={dialogBodyClassName}>
                <AlertDialog.Description className={dialogDescriptionClassName}>
                  {t('Can restore: {{recoverable}}. Merged duplicates skipped: {{skipped}}.', {
                    recoverable: dialogRestorePreview?.itemIds.length ?? 0,
                    skipped: dialogRestorePreview?.skipped ?? 0
                  })}
                </AlertDialog.Description>
              </div>
              <div className={dialogFooterClassName}>
                <AlertDialog.Cancel asChild>
                  <Button type="button" variant="ghost" disabled={isBatching}>
                    {t('Cancel')}
                  </Button>
                </AlertDialog.Cancel>
                <Button
                  type="button"
                  disabled={isBatching || !restorePreview?.itemIds.length}
                  onClick={() => {
                    const ids = restorePreview?.itemIds
                    setRestorePreview(undefined)
                    if (ids?.length) void setItemsLifecycle(ids, 'active')
                  }}
                >
                  {t('Restore')}
                </Button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
        <AlertDialog.Root
          open={permanentDeleteIds.length > 0}
          onOpenChange={(open) => {
            if (!open && !isBatching) setPermanentDeleteIds([])
          }}
        >
          <AlertDialog.Portal>
            <AlertDialog.Overlay className={dialogOverlayClassName} />
            <AlertDialog.Content
              className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
            >
              <div className={dialogHeaderClassName}>
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Delete permanently?')}
                </AlertDialog.Title>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={dialogCloseButtonClassName}
                  aria-label={t('Close')}
                  disabled={isBatching}
                  onClick={() => setPermanentDeleteIds([])}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <div className={dialogBodyClassName}>
                <AlertDialog.Description className={dialogDescriptionClassName}>
                  {t(
                    'This permanently deletes the selected references and their metadata. Unshared attached files are cleaned up afterward. This action cannot be undone.'
                  )}{' '}
                  {t(
                    'PDF annotations, notes, and their tag assignments will also be deleted. Global Tags are kept.'
                  )}
                </AlertDialog.Description>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {t(
                    'Search indexes expire separately after inactivity. Historical outputs are kept. This is not secure erasure.'
                  )}
                </p>
                {permanentDeletionDiagnostic ? (
                  <div className="mt-3">
                    <LiteratureDeletionNotice
                      diagnostic={permanentDeletionDiagnostic}
                      onNavigate={() => setPermanentDeleteIds([])}
                    />
                  </div>
                ) : permanentDeleteFailed ? (
                  <div className="mt-3">
                    <LiteratureErrorNotice
                      title={t('Literature could not be deleted permanently.')}
                      description={t(
                        'Refresh references to check their current state before trying again.'
                      )}
                      primaryButton={{
                        label: t('Refresh'),
                        onClick: () => {
                          setPermanentDeleteIds([])
                          clearSelection()
                          void loadEntries(true)
                        }
                      }}
                    />
                  </div>
                ) : null}
              </div>
              <div
                className={`${dialogFooterClassName} flex-wrap items-center [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:h-auto [&_button]:min-h-8 [&_button]:py-1`}
              >
                <AlertDialog.Cancel asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className={dialogCancelButtonClassName}
                    disabled={isBatching}
                  >
                    {t('Cancel')}
                  </Button>
                </AlertDialog.Cancel>
                <Button
                  type="button"
                  className="border-transparent bg-danger-000 text-white hover:bg-danger-000/90 hover:text-white"
                  disabled={isBatching || permanentDeleteFailed}
                  onClick={() => void deleteItemsPermanently()}
                >
                  {isBatching ? t('Deleting…') : t('Delete permanently')}
                </Button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
        {smartReevaluationNotice}
        <LiteratureReadingProjectDialog
          pendingLiteratureReading={pendingLiteratureReading}
          readingProjectFormDialog={readingProjectFormDialog}
          startingReadingProjectId={startingReadingProjectId}
          setReadingProjectQuery={setReadingProjectQuery}
          setPendingLiteratureReading={setPendingLiteratureReading}
          setReadingProjectError={setReadingProjectError}
          readingProjectError={readingProjectError}
          readingSelectionEntries={readingSelectionEntries}
          setBatchReading={setBatchReading}
          projectsLoaded={projectsLoaded}
          activeProjects={activeProjects}
          readingProjectQuery={readingProjectQuery}
          startReadingInProject={startReadingInProject}
        />
        <ProjectFormDialog {...readingProjectFormDialog.dialogProps} />
        {batchReading ? (
          <LiteratureReadingDialog
            {...batchReading}
            onClose={() => {
              batchReadingRequestRef.current += 1
              setBatchReading(undefined)
            }}
            onContinue={(documents) => {
              setBatchReading(undefined)
              setReadingProjectQuery('')
              setReadingProjectError(undefined)
              if (selectedProject) void startReadingInProject(selectedProject.id, documents)
              else setPendingLiteratureReading(documents)
            }}
          />
        ) : null}
        <ProjectFormDialog {...batchProjectFormDialog.dialogProps} />
        <LiteratureFilePreviewDialog
          onFocusFallback={focusPreviewFallback}
          item={previewItem}
          allowReadingContext={false}
          onReadWithAgent={requestReadWithAgent}
          onClose={closeFilePreview}
        />
      </main>
    </SmartDecisionPendingContext.Provider>
  )
}

export { LiteratureLibraryPage }
