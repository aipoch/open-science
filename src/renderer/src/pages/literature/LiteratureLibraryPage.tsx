import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { literatureMetadataProviderLabel } from '../../../../shared/literature'
import { SmartDecisionPendingContext, createSmartCollectionState } from './smart-collection-state'
import { SmartCollectionIcon } from '@/components/app-icons/custom-glyphs'
import { SmartRuleSummary } from './SmartRuleSummary'
import {
  shouldConfirmSmartReevaluation,
  setSmartReevaluationConfirmation
} from './smart-collection-preferences'
import { LiteratureHoverDropdown, LiteratureHoverMenuGroup } from './LiteratureHoverMenus'
import { useSmartDecisionBatch } from './useSmartDecisionBatch'
import {
  SmartCollectionCells,
  type SmartCollectionCellActions,
  SmartCollectionAssessment,
  SmartCollectionDecisionActions
} from './SmartCollectionDecision'
import { ActionMenuProvider, ActionMenuTarget, useActionMenu } from '@/components/action-menu'
import type { SmartCollectionView } from '../../../../shared/literature-smart-collections'
import { SmartCollectionPanel } from './SmartCollectionPanel'
import { SmartCollectionProcess } from './SmartCollectionProcess'
import type { PdfAnnotation } from '../../../../shared/pdf-annotations'
import {
  createBookmarkPreviewItem,
  requestPdfAnnotationReveal
} from '../workspace/annotations/annotation-reveal'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import {
  LiteraturePdfBatchImportDialog,
  type PdfImportDestination
} from './LiteraturePdfBatchImportDialog'
import {
  parseLiteratureDeletionError,
  type LiteratureDeletionDiagnostic
} from '../../../../shared/literature-deletion'
import { LiteratureDeletionNotice } from './LiteratureDeletionNotice'
import { readLiteratureSelectionPage } from './literature-read-pages'
import { LiteratureOversizedNotice } from './LiteratureOversizedNotice'
import { isCollectionOnlyChange, useLiteratureChanges } from './useLiteratureChanges'
import type { TFunction } from 'i18next'
import { LiteratureSources } from './LiteratureSources'
import { LiteratureAttachments } from './LiteratureAttachments'
import { LiteratureAttachmentOperations } from './LiteratureAttachmentOperations'
import { useAttachmentOperations } from './literature-attachment-operations'
import { LITERATURE_JOB_MAX_ITEMS } from '../../../../shared/literature-jobs'
import {
  LITERATURE_COLLECTION_NAME_CONFLICT,
  LITERATURE_IMPORT_IDENTITY_CONFLICT
} from '../../../../shared/literature'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { AlertDialog, Tabs } from 'radix-ui'
import * as Dialog from '@/components/ui/dialog'
import * as Checkbox from '@radix-ui/react-checkbox'
import {
  ArrowLeft,
  BookOpenText,
  Check,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  GalleryVerticalEnd,
  Inbox,
  LoaderCircle,
  Merge,
  MoreHorizontal,
  Paperclip,
  PanelLeft,
  Pencil,
  Plus,
  Quote,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Upload,
  RotateCcw,
  Settings,
  X
} from 'lucide-react'
import {
  memo,
  createContext,
  useContext,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { FileDropOverlay } from '@/components/FileDropOverlay'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { ActionToast } from '@/components/ActionToast'
import { ErrorNotice } from '@/components/error-notice'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { ProjectPicker } from '@/components/ProjectPicker'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { cn } from '@/lib/utils'
import { useNavigationStore, type PdfReadingDocument } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import { LiteratureMergeReview } from './LiteratureMergeReview'
import { LiteratureBatchLookupDialog, type BatchLookupMode } from './LiteratureBatchLookupDialog'
import { LiteratureBackgroundTasks } from './LiteratureBackgroundTasks'
import { LiteratureTable, LiteratureTextTooltip } from './LiteratureTable'
import { buildLiteratureMergeItem, mergeScalarFields } from './literature-merge'
import type {
  LiteratureCatalogCommand,
  LiteratureCatalogReceipt,
  LiteratureCatalogSearchRequest,
  LiteratureCatalogSearchPage,
  LiteratureCollectionView,
  LiteratureCitationStyle,
  LiteratureCitationStyleView,
  LiteratureInboxCandidateView,
  LiteratureItemInput,
  LiteratureDuplicatePolicy,
  LiteratureItemView,
  LiteratureMetadataField,
  LiteratureItemType,
  LiteratureProjectCountView
} from '../../../../shared/literature'
import {
  createLiteratureIdentifierUrl,
  createLiteratureAttachmentVersionReference,
  LITERATURE_RECORD_IMPORT_MAX_BYTES,
  normalizeLiteratureIdentifierValue
} from '../../../../shared/literature'
import { formatUploadSizeLimit, type UploadTransferProgress } from '../../../../shared/uploads'
import { stageComposerFile } from '../workspace/composer-upload-transfer'
import { FilePreviewDialog } from '../workspace/FilePreviewDialog'
import { LITERATURE_PREVIEW_SESSION_ID } from '../workspace/preview-file-item'
import { resolvePdfContextTarget } from '../workspace/use-pdf-context-action'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { ProjectFormDialog } from '../home/ProjectFormDialog'
import { CollectionEditorDialog, type CollectionEditorDialogHandle } from './CollectionEditorDialog'
import { LiteratureCitationPanel } from './LiteratureCitationPanel'
import { CitationStylesView } from './CitationStylesView'
import {
  LiteratureDuplicatesView,
  LiteratureDuplicateCount,
  type LiteratureDuplicateCountHandle
} from './LiteratureDuplicatesView'
import {
  LiteratureRecordImportDialog,
  type RecordImportDraft
} from './LiteratureRecordImportDialog'
import { LiteratureBatchDestinationMenus } from './LiteratureBatchDestinationMenus'
import { LiteratureColumnCustomizer } from './LiteratureColumnCustomizer'
import {
  createLiteratureDetailController,
  type LiteratureDetailController,
  type LiteratureDetailSnapshot
} from './LiteratureDetailController'
import { LiteratureDetailLinkList } from './LiteratureDetailLinkList'
import { LiteratureMetadataLookup } from './LiteratureMetadataLookup'
import { useLiteratureEntries } from './useLiteratureEntries'
import { useLiteratureMetadata } from './useLiteratureMetadata'
import { LiteratureLibraryCount } from './LiteratureLibraryCount'
import { LiteratureMetadataEditor } from './LiteratureMetadataEditor'
import { LiteratureDuplicatePolicyField } from './LiteratureDuplicatePolicyField'
import { LiteratureSearchInput } from './LiteratureSearchInput'
import { LiteratureYearFilter } from './LiteratureYearFilter'
import { LiteratureReadingDialog } from './LiteratureReadingDialog'
import { LiteratureFullTextLookup } from './LiteratureFullTextLookup'
import { useLiteratureYearFilter } from './useLiteratureYearFilter'
import {
  ResourceTagBadges,
  ResourceTagMenu,
  ResourceTagSummary,
  TagFilter
} from '../settings/ResourceTagControls'

type LibrarySection = 'inbox' | 'library' | 'trash'

const literatureSorts = {
  updated: { sortBy: 'updated', sortDirection: 'desc' },
  created: { sortBy: 'created', sortDirection: 'desc' },
  'created-asc': { sortBy: 'created', sortDirection: 'asc' },
  title: { sortBy: 'title', sortDirection: 'asc' },
  'title-desc': { sortBy: 'title', sortDirection: 'desc' },
  year: { sortBy: 'year', sortDirection: 'desc' },
  'year-asc': { sortBy: 'year', sortDirection: 'asc' },
  rating: { sortBy: 'rating', sortDirection: 'desc' }
} as const satisfies Record<
  string,
  Pick<LiteratureCatalogSearchRequest, 'sortBy' | 'sortDirection'>
>

type PendingLiteratureReading = readonly PdfReadingDocument[]

type DismissedCandidateUndo = Readonly<{
  candidateIds: readonly string[]
  detail: string
  needsRecheck?: boolean
}>

const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'
const CHILD_LAYER_DISMISS_GUARD_MS = 1_000

const pdfImportErrorMessage = (error: unknown, t: TFunction): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('[pdf-password]'))
    return t('This PDF requires a password. Add an unlocked copy.')
  if (message.includes('[pdf-invalid]'))
    return t('This PDF is damaged or invalid. Select another file.')
  if (message.includes('[pdf-unreadable]'))
    return t(
      'This PDF could not be parsed. It may use unsupported features. Select another file or try again.'
    )
  return t('PDF could not be added.')
}

const hasLiteratureDetailChildLayer = (): boolean =>
  Boolean(
    document.querySelector(
      '[data-slot="dropdown-menu-content"], [data-slot="select-content"], [data-radix-popper-content-wrapper]'
    )
  )

type LiteratureTableColumn =
  'abstract' | 'authors' | 'notes' | 'publication' | 'rating' | 'tags' | 'type' | 'url' | 'year'

const literatureTableColumns = [
  'abstract',
  'year',
  'publication',
  'authors',
  'type',
  'tags',
  'rating',
  'notes',
  'url'
] as const satisfies readonly LiteratureTableColumn[]

const defaultLiteratureTableColumns = literatureTableColumns.filter(
  (column) => column !== 'abstract' && column !== 'notes' && column !== 'url'
)

const literatureTableColumnWidths: Record<LiteratureTableColumn, number> = {
  type: 160,
  authors: 224,
  year: 80,
  publication: 224,
  tags: 208,
  abstract: 320,
  rating: 152,
  notes: 280,
  url: 80
}

const LITERATURE_TABLE_PREFERENCES_KEY = 'open-science:literature-table-preferences'
const literatureTabsListClassName = 'flex gap-3 overflow-x-auto border-b border-border'
const literatureTabClassName =
  'relative flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border-b-2 border-transparent px-1 py-3 text-xs font-medium text-muted-foreground data-[state=inactive]:hover:border-muted-foreground data-[state=inactive]:hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-primary transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'

const LITERATURE_DEFAULT_PAGE_SIZE = 25
const LITERATURE_PAGE_SIZES = [25, 50, 100] as const
const LITERATURE_SIDEBAR_GROUP_LIMIT = 5
const LITERATURE_BATCH_COMMAND_SIZE = 200
const LITERATURE_INBOX_COMMAND_SIZE = 100

type LiteratureSelectionSnapshot = Readonly<{
  selectedIds: ReadonlySet<string>
  allMatchingSelected: boolean
  excludedMatchingIds: ReadonlySet<string>
}>

type LiteratureSelectionStore = Readonly<{
  getSnapshot: () => LiteratureSelectionSnapshot
  subscribe: (listener: () => void) => () => void
  clear: () => void
  remove: (itemId: string) => void
  replace: (itemIds: Iterable<string>) => void
  selectAllMatching: () => void
  toggle: (itemId: string) => void
}>

const createLiteratureSelectionStore = (): LiteratureSelectionStore => {
  let snapshot: LiteratureSelectionSnapshot = {
    selectedIds: new Set(),
    allMatchingSelected: false,
    excludedMatchingIds: new Set()
  }
  const listeners = new Set<() => void>()
  const publish = (next: LiteratureSelectionSnapshot): void => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    clear: () => {
      if (
        snapshot.selectedIds.size === 0 &&
        !snapshot.allMatchingSelected &&
        snapshot.excludedMatchingIds.size === 0
      ) {
        return
      }
      publish({
        selectedIds: new Set(),
        allMatchingSelected: false,
        excludedMatchingIds: new Set()
      })
    },
    remove: (itemId) => {
      if (!snapshot.selectedIds.has(itemId)) return
      const selectedIds = new Set(snapshot.selectedIds)
      selectedIds.delete(itemId)
      publish({ ...snapshot, selectedIds })
    },
    replace: (itemIds) =>
      publish({
        selectedIds: new Set(itemIds),
        allMatchingSelected: false,
        excludedMatchingIds: new Set()
      }),
    selectAllMatching: () =>
      publish({
        selectedIds: new Set(),
        allMatchingSelected: true,
        excludedMatchingIds: new Set()
      }),
    toggle: (itemId) => {
      if (snapshot.allMatchingSelected) {
        const excludedMatchingIds = new Set(snapshot.excludedMatchingIds)
        if (excludedMatchingIds.has(itemId)) excludedMatchingIds.delete(itemId)
        else excludedMatchingIds.add(itemId)
        publish({ ...snapshot, excludedMatchingIds })
        return
      }
      const selectedIds = new Set(snapshot.selectedIds)
      if (selectedIds.has(itemId)) selectedIds.delete(itemId)
      else selectedIds.add(itemId)
      publish({ ...snapshot, selectedIds })
    }
  }
}

const isLiteratureItemSelected = (
  snapshot: LiteratureSelectionSnapshot,
  itemId: string
): boolean =>
  snapshot.allMatchingSelected
    ? !snapshot.excludedMatchingIds.has(itemId)
    : snapshot.selectedIds.has(itemId)

const LiteratureSelectionBoundary = ({
  children,
  store
}: Readonly<{
  children: (snapshot: LiteratureSelectionSnapshot) => ReactNode
  store: LiteratureSelectionStore
}>): React.JSX.Element => {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return <>{children(snapshot)}</>
}

const LiteratureDetailBoundary = ({
  children,
  controller
}: Readonly<{
  children: (snapshot: LiteratureDetailSnapshot) => ReactNode
  controller: LiteratureDetailController
}>): React.JSX.Element => {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  )
  return <>{children(snapshot)}</>
}

const LiteratureSelectionCheckbox = ({
  className,
  disabled,
  itemId,
  label,
  store
}: Readonly<{
  className?: string
  disabled?: boolean
  itemId: string
  label: string
  store: LiteratureSelectionStore
}>): React.JSX.Element => {
  const selected = useSyncExternalStore(
    store.subscribe,
    () => isLiteratureItemSelected(store.getSnapshot(), itemId),
    () => isLiteratureItemSelected(store.getSnapshot(), itemId)
  )
  return (
    <input
      type="checkbox"
      checked={selected}
      disabled={disabled}
      onChange={() => store.toggle(itemId)}
      aria-label={label}
      className={className}
    />
  )
}

const LiteratureSelectPageCheckbox = ({
  className,
  disabled,
  itemIds,
  label,
  store
}: Readonly<{
  className?: string
  disabled?: boolean
  itemIds: readonly string[]
  label: string
  store: LiteratureSelectionStore
}>): React.JSX.Element => {
  const selectedCount = useSyncExternalStore(
    store.subscribe,
    () => {
      const snapshot = store.getSnapshot()
      return itemIds.filter((itemId) => isLiteratureItemSelected(snapshot, itemId)).length
    },
    () => 0
  )
  const allSelected = itemIds.length > 0 && selectedCount === itemIds.length
  const mixed = selectedCount > 0 && !allSelected
  return (
    <input
      ref={(input) => {
        if (input) input.indeterminate = mixed
      }}
      type="checkbox"
      checked={allSelected}
      disabled={disabled}
      onChange={() => {
        if (store.getSnapshot().allMatchingSelected || allSelected) store.clear()
        else store.replace(itemIds)
      }}
      aria-label={label}
      className={className}
    />
  )
}

type LiteratureTablePreferences = Readonly<{
  order: LiteratureTableColumn[]
  visible: LiteratureTableColumn[]
}>

type LiteraturePageSize = (typeof LITERATURE_PAGE_SIZES)[number]

const isLiteratureTableColumn = (value: unknown): value is LiteratureTableColumn =>
  typeof value === 'string' && literatureTableColumns.includes(value as LiteratureTableColumn)

const loadLiteratureTablePreferences = (): LiteratureTablePreferences => {
  const fallback = {
    order: [...literatureTableColumns],
    visible: [...defaultLiteratureTableColumns]
  }
  try {
    const stored = window.localStorage.getItem(LITERATURE_TABLE_PREFERENCES_KEY)
    if (!stored) return fallback
    const parsed = JSON.parse(stored) as { order?: unknown; visible?: unknown }
    const storedOrder = Array.isArray(parsed.order)
      ? parsed.order.filter(isLiteratureTableColumn)
      : []
    const order = [
      ...new Set<LiteratureTableColumn>([
        ...storedOrder,
        ...literatureTableColumns.filter((column) => !storedOrder.includes(column))
      ])
    ]
    const visible = Array.isArray(parsed.visible)
      ? parsed.visible.filter(isLiteratureTableColumn)
      : fallback.visible
    return { order, visible }
  } catch {
    return fallback
  }
}

const isItem = (entry: unknown): entry is LiteratureItemView =>
  typeof entry === 'object' && entry !== null && 'item' in entry && 'metadataRevision' in entry

const isCandidate = (entry: unknown): entry is LiteratureInboxCandidateView =>
  typeof entry === 'object' && entry !== null && 'candidate' in entry && 'state' in entry

const isCollection = (entry: unknown): entry is LiteratureCollectionView =>
  typeof entry === 'object' && entry !== null && 'itemCount' in entry && 'name' in entry

const isProjectCount = (entry: unknown): entry is LiteratureProjectCountView =>
  typeof entry === 'object' && entry !== null && 'projectId' in entry && 'itemCount' in entry

function limitSidebarEntries<T extends { id: string }>(
  entries: readonly T[],
  selectedId: string | undefined
): T[] {
  const limited = entries.slice(0, LITERATURE_SIDEBAR_GROUP_LIMIT)
  if (!selectedId || limited.some((entry) => entry.id === selectedId)) return limited
  const selected = entries.find((entry) => entry.id === selectedId)
  return selected ? [...limited.slice(0, -1), selected] : limited
}

type LiteratureSidebarGroupProps<T extends { id: string }> = Readonly<{
  collapsed: boolean
  entries: readonly T[]
  groupId: string
  label: string
  action?: ReactNode
  navButtonClassName: string
  selectedId?: string
  showAllLabel: string
  showAllText: string
  showFewerLabel: string
  showLessText: string
  renderEntry: (entry: T) => React.JSX.Element
}>

function LiteratureSidebarHint({
  label,
  collapsed,
  children
}: Readonly<{ label: string; collapsed: boolean; children: ReactElement }>): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
        }}
      >
        {children}
      </TooltipTrigger>
      {collapsed ? <TooltipContent side="right">{label}</TooltipContent> : null}
    </Tooltip>
  )
}

function LiteratureSidebarGroup<T extends { id: string }>({
  collapsed,
  entries,
  groupId,
  label,
  action,
  navButtonClassName,
  selectedId,
  showAllLabel,
  showAllText,
  showFewerLabel,
  showLessText,
  renderEntry
}: LiteratureSidebarGroupProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const visibleEntries = expanded ? entries : limitSidebarEntries(entries, selectedId)

  return (
    <>
      {!collapsed || action ? (
        <div className={cn('flex items-center gap-1', collapsed && 'justify-center')}>
          {!collapsed ? (
            <button
              type="button"
              className={cn(
                navButtonClassName,
                'min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground'
              )}
              aria-expanded={open}
              aria-controls={groupId}
              aria-label={label}
              onClick={() => setOpen((current) => !current)}
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{label}</span>
              <span className="ml-auto shrink-0 tabular-nums" aria-hidden="true">
                {entries.length}
              </span>
            </button>
          ) : null}
          {action}
        </div>
      ) : null}
      <div id={groupId} className="mt-2 space-y-1" hidden={!collapsed && !open}>
        {visibleEntries.map(renderEntry)}
        {!collapsed && entries.length > LITERATURE_SIDEBAR_GROUP_LIMIT ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mt-1 w-full justify-between px-3 text-xs text-muted-foreground transition-none"
            aria-expanded={expanded}
            aria-label={expanded ? showFewerLabel : showAllLabel}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? showLessText : showAllText}
            {expanded ? (
              <ChevronUp className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        ) : null}
      </div>
    </>
  )
}

function LiteratureSidebarState({
  children
}: Readonly<{
  children: (collapsed: boolean, toggle: () => void) => React.JSX.Element
}>): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const toggleFromShortcut = (event: KeyboardEvent): void => {
      const isMac = window.api?.platform === 'darwin'
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.key.toLowerCase() !== 'b' ||
        !(isMac ? event.metaKey : event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        document.querySelector(OPEN_DIALOG_SELECTOR) !== null
      ) {
        return
      }

      event.preventDefault()
      setCollapsed((current) => !current)
    }

    window.addEventListener('keydown', toggleFromShortcut)
    return () => window.removeEventListener('keydown', toggleFromShortcut)
  }, [])

  return (
    <TooltipProvider>
      {children(collapsed, () => setCollapsed((current) => !current))}
    </TooltipProvider>
  )
}

function LiteratureAddMenu({
  label,
  onAddReference,
  onImportPdf,
  onImportReferences
}: Readonly<{
  label?: string
  onAddReference: () => void
  onImportPdf: () => void
  onImportReferences: () => void
}>): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" className="shrink-0 transition-none">
          <Plus data-icon="inline-start" aria-hidden="true" />
          {label ?? t('Add')}
          <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem
          className="gap-2.5"
          aria-label={t('Add reference')}
          onSelect={onAddReference}
        >
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex flex-col">
            <span>{t('Add reference')}</span>
            <span className="text-xs text-muted-foreground">{t('Create metadata manually')}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" aria-label={t('Import PDFs')} onSelect={onImportPdf}>
          <FilePlus2 className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex flex-col">
            <span>{t('Import PDFs')}</span>
            <span className="text-xs text-muted-foreground">
              {t('Create references from PDF files')}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2.5"
          aria-label={t('Import references')}
          onSelect={onImportReferences}
        >
          <Upload className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex flex-col">
            <span>{t('Import references')}</span>
            <span className="text-xs text-muted-foreground">
              {t('BibTeX, RIS, or PubMed NBIB')}
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LiteratureExportMenu({
  disabled,
  onExport
}: Readonly<{
  disabled?: boolean
  onExport: (format: 'bibtex' | 'ris') => Promise<boolean>
}>): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'error' | 'idle' | 'loading' | 'success'>('idle')
  const resetTimeoutRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (resetTimeoutRef.current !== undefined) window.clearTimeout(resetTimeoutRef.current)
    },
    []
  )

  const runExport = async (format: 'bibtex' | 'ris'): Promise<void> => {
    if (status === 'loading') return
    if (resetTimeoutRef.current !== undefined) window.clearTimeout(resetTimeoutRef.current)
    setStatus('loading')
    try {
      const saved = await onExport(format)
      setStatus(saved ? 'success' : 'idle')
      if (saved) {
        resetTimeoutRef.current = window.setTimeout(() => setStatus('idle'), 1_500)
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <LiteratureHoverDropdown
      disabled={disabled || status === 'loading'}
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || status === 'loading'}
          aria-invalid={status === 'error' || undefined}
          aria-busy={status === 'loading'}
          data-state={status}
        >
          {status === 'loading' ? (
            <LoaderCircle
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : status === 'success' ? (
            <Check className="size-3.5 text-primary" aria-hidden="true" />
          ) : (
            <Download className="size-3.5" aria-hidden="true" />
          )}
          {status === 'loading' ? t('Exporting…') : status === 'success' ? t('Saved') : t('Export')}
          <ChevronRight className="ml-auto size-3.5 opacity-60" aria-hidden="true" />
        </Button>
      }
    >
      <DropdownMenuItem onSelect={() => void runExport('bibtex')}>
        <FileText className="mr-2 size-4" aria-hidden="true" />
        {t('BibTeX')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void runExport('ris')}>
        <FileText className="mr-2 size-4" aria-hidden="true" />
        {t('RIS')}
      </DropdownMenuItem>
    </LiteratureHoverDropdown>
  )
}

function LibraryMenuTrigger({ status }: { status: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { openMenu } = useActionMenu()
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={t('More actions')}
      disabled={status === 'loading'}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        openMenu({
          targetId: 'library-actions',
          pointer: { x: bounds.right, y: bounds.bottom },
          align: 'end',
          focusTarget: event.currentTarget
        })
      }}
    >
      {status === 'loading' ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      ) : status === 'success' ? (
        <Check className="size-4" aria-hidden="true" />
      ) : (
        <MoreHorizontal className="size-4" aria-hidden="true" />
      )}
    </Button>
  )
}
function LiteratureLibraryActionsMenu({
  exportDisabled,
  onEdit,
  onDelete,
  identityKey,
  onExport
}: Readonly<{
  onEdit?: () => void
  onDelete?: () => void
  identityKey: string
  exportDisabled?: boolean
  onExport: (format: 'bibtex' | 'ris') => Promise<boolean>
}>): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'error' | 'idle' | 'loading' | 'success'>('idle')
  const resetTimeoutRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (resetTimeoutRef.current !== undefined) window.clearTimeout(resetTimeoutRef.current)
    },
    []
  )

  const runExport = async (format: 'bibtex' | 'ris'): Promise<void> => {
    if (status === 'loading') return
    if (resetTimeoutRef.current !== undefined) window.clearTimeout(resetTimeoutRef.current)
    setStatus('loading')
    try {
      const saved = await onExport(format)
      setStatus(saved ? 'success' : 'idle')
      if (saved) {
        resetTimeoutRef.current = window.setTimeout(() => setStatus('idle'), 1_500)
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <ActionMenuProvider onActionError={() => setStatus('error')}>
      <ActionMenuTarget
        asChild
        targetId="library-actions"
        identityKey={identityKey}
        invocation={identityKey}
        catalog={{
          edit: { labelKey: 'Edit collection', icon: Pencil },
          remove: { labelKey: 'Delete collection', icon: Trash2, danger: true },
          bibtex: { labelKey: 'BibTeX', icon: FileText },
          ris: { labelKey: 'RIS', icon: FileText }
        }}
        recipe={[
          { kind: 'action', action: 'edit' },
          { kind: 'submenu', labelKey: 'Export', icon: Download, actions: ['bibtex', 'ris'] },
          { kind: 'separator' },
          { kind: 'action', action: 'remove' }
        ]}
        bindings={{
          edit: { execute: () => onEdit?.(), hidden: !onEdit },
          remove: { execute: () => onDelete?.(), hidden: !onDelete },
          bibtex: { execute: () => runExport('bibtex'), disabled: exportDisabled },
          ris: { execute: () => runExport('ris'), disabled: exportDisabled }
        }}
      >
        <div>
          <LibraryMenuTrigger status={status} />
        </div>
      </ActionMenuTarget>
      {status === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {t('References could not be exported.')}
        </p>
      )}
    </ActionMenuProvider>
  )
}

function LiteratureRatingControl({
  value,
  disabled = false,
  onCommit
}: Readonly<{
  disabled?: boolean
  value: number
  onCommit: (rating: number) => Promise<void>
}>): React.JSX.Element {
  const { t } = useTranslation()
  const [rating, setRating] = useState(value)
  const [isSaving, setIsSaving] = useState(false)

  const commitRating = async (nextRating: number): Promise<void> => {
    if (isSaving) return
    const previousRating = rating
    setRating(nextRating)
    setIsSaving(true)
    try {
      await onCommit(nextRating)
    } catch {
      setRating(previousRating)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-0.5" aria-busy={isSaving}>
      {[1, 2, 3, 4, 5].map((option) => {
        const active = option <= rating
        return (
          <button
            key={option}
            type="button"
            disabled={isSaving || disabled}
            aria-label={t('Set rating to {{rating}}', { rating: option })}
            aria-pressed={active}
            className="rounded-sm p-0.5 text-muted-foreground outline-none transition-colors hover:text-amber-500 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
            onClick={() => void commitRating(rating === option ? 0 : option)}
          >
            <Star
              className={cn(
                'size-3.5',
                active && 'fill-amber-400 text-amber-500 dark:fill-amber-400 dark:text-amber-400'
              )}
              aria-hidden="true"
            />
          </button>
        )
      })}
    </div>
  )
}

function LiteratureTypeControl({
  value,
  title,
  labels,
  disabled = false,
  onCommit
}: Readonly<{
  disabled?: boolean
  value: LiteratureItemType
  title: string
  labels: Record<LiteratureItemType, string>
  onCommit: (itemType: LiteratureItemType) => Promise<void>
}>): React.JSX.Element {
  const { t } = useTranslation()
  const [itemType, setItemType] = useState(value)
  const [isSaving, setIsSaving] = useState(false)

  const commitItemType = async (nextItemType: LiteratureItemType): Promise<void> => {
    if (isSaving || nextItemType === itemType) return
    const previousItemType = itemType
    setItemType(nextItemType)
    setIsSaving(true)
    try {
      await onCommit(nextItemType)
    } catch {
      setItemType(previousItemType)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Select
      value={itemType}
      disabled={isSaving || disabled}
      onValueChange={(nextValue) => void commitItemType(nextValue as LiteratureItemType)}
    >
      <SelectTrigger
        aria-label={`${t('Reference type')}: ${title}`}
        aria-busy={isSaving}
        className="h-7 w-full border-transparent bg-transparent px-1.5 text-xs hover:border-border hover:bg-muted"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(labels).map(([option, label]) => (
          <SelectItem key={option} value={option}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function LiteratureNoteControl({
  entry,
  disabled = false,
  onCommit
}: Readonly<{
  disabled?: boolean
  entry: LiteratureItemView
  onCommit: (
    base: LiteratureItemView,
    note: string,
    onPersisted: (reload: () => Promise<LiteratureItemView>) => void
  ) => Promise<void>
}>): React.JSX.Element {
  const { t } = useTranslation()
  const [edit, setEdit] = useState<{ base: LiteratureItemView; draft: string }>()
  const [isSaving, setIsSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const savingRef = useRef(false)
  const recoveryRef = useRef<
    { note: string; reload: () => Promise<LiteratureItemView> } | undefined
  >(undefined)
  const cancelNextBlurRef = useRef(false)
  const dirty = edit !== undefined && edit.draft !== (edit.base.item.personalNote ?? '')
  // A dirty draft keeps its original full item and revision, including across rating refreshes.
  const base = dirty ? edit.base : entry
  const draft = dirty ? edit.draft : (entry.item.personalNote ?? '')

  const commitNote = async (): Promise<void> => {
    if (cancelNextBlurRef.current) {
      cancelNextBlurRef.current = false
      return
    }
    if (disabled || savingRef.current) return
    const note = draft.trim()
    if (!recoveryRef.current && note === (base.item.personalNote ?? '')) {
      setEdit(undefined)
      setFailed(false)
      return
    }
    savingRef.current = true
    setIsSaving(true)
    try {
      const recovery = recoveryRef.current
      if (recovery) {
        const updated = await recovery.reload()
        // New typing during recovery remains a draft. Only rebase it when the saved note
        // still matches our acknowledged write; otherwise retain conflict protection.
        setEdit(
          note === recovery.note
            ? undefined
            : {
                base: (updated.item.personalNote ?? '') === recovery.note ? updated : base,
                draft
              }
        )
      } else {
        await onCommit(base, note, (reload) => {
          recoveryRef.current = { note, reload }
        })
        setEdit(undefined)
      }
      recoveryRef.current = undefined
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      savingRef.current = false
      setIsSaving(false)
    }
  }

  return (
    <div>
      <Input
        value={draft}
        readOnly={isSaving || disabled}
        aria-label={t('Note for {{title}}', { title: entry.item.title })}
        aria-busy={isSaving}
        aria-invalid={failed || undefined}
        placeholder={t('Add a note…')}
        className="h-8 border-transparent bg-transparent px-2 text-xs placeholder:text-muted-foreground/70 hover:border-border hover:bg-bg-100 focus-visible:border-border focus-visible:bg-bg-000"
        onFocus={() => {
          if (disabled) return
          if (!dirty) setEdit({ base: entry, draft: entry.item.personalNote ?? '' })
        }}
        onChange={(event) => setEdit({ base, draft: event.currentTarget.value })}
        onKeyDown={(event) => {
          if (isSaving || event.nativeEvent.isComposing) return
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            cancelNextBlurRef.current = true
            setEdit(undefined)
            setFailed(false)
            event.currentTarget.blur()
          }
        }}
        onBlur={() => {
          if (!disabled) void commitNote()
        }}
      />
      {failed ? (
        <div className="flex items-center gap-2 px-2 text-xs text-status-warning-foreground">
          <p
            role="alert"
            className="whitespace-normal [overflow-wrap:anywhere]"
            title={t('Draft preserved. Escape to discard.')}
          >
            {t('Draft preserved. Escape to discard.')}
          </p>
          <button
            type="button"
            className="shrink-0 underline"
            disabled={isSaving || disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void commitNote()}
          >
            {t('Retry')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

const creatorNames = (item: LiteratureItemInput): string[] =>
  item.creators.map((creator) =>
    creator.nameMode === 'organization'
      ? creator.literalName
      : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
  )

const creatorLabel = (item: LiteratureItemInput): string =>
  creatorNames(item).slice(0, 3).join(', ')

const fullCreatorLabel = (item: LiteratureItemInput): string => creatorNames(item).join(', ')

const typeFieldText = (item: LiteratureItemInput, field: string): string => {
  const value = item.typeFields[field]
  return typeof value === 'string' ? value.trim() : ''
}

const publicationSummary = (item: LiteratureItemInput): string => {
  const publication = typeFieldText(item, 'journalAbbreviation') || item.containerTitle
  const date = item.issuedText || item.issuedYear?.toString() || ''
  const volume = typeFieldText(item, 'volume')
  const issue = typeFieldText(item, 'issue')
  const pages = typeFieldText(item, 'pages')
  const doiIdentifier = item.identifiers.find((identifier) => identifier.scheme === 'doi')
  const doi = doiIdentifier
    ? normalizeLiteratureIdentifierValue(doiIdentifier.scheme, doiIdentifier.value)
    : undefined
  const volumeIssue = `${volume}${issue ? `(${issue})` : ''}`
  const volumeIssuePages = volumeIssue && pages ? `${volumeIssue}:${pages}` : volumeIssue || pages
  const citation = `${[publication, date].filter(Boolean).join('. ')}${
    volumeIssuePages ? `${publication || date ? ';' : ''}${volumeIssuePages}` : ''
  }`
  return [citation, doi ? `doi: ${doi}` : ''].filter(Boolean).join('. ')
}

const getExternalLiteratureUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

const ABSTRACT_PREVIEW_LINE_COUNT = 8
const AUTHOR_PREVIEW_LINE_COUNT = 5

const CollapsibleDetailText = ({
  collapsedClassName,
  previewLineCount,
  text
}: {
  collapsedClassName: string
  previewLineCount: number
  text: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const textId = useId()
  const textRef = useRef<HTMLParagraphElement>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)

  useLayoutEffect(() => {
    const content = textRef.current
    if (!content) return

    setIsExpanded(false)
    const measureOverflow = (): void => {
      const style = window.getComputedStyle(content)
      const parsedLineHeight = Number.parseFloat(style.lineHeight)
      const parsedFontSize = Number.parseFloat(style.fontSize)
      const lineHeight =
        Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
          ? parsedLineHeight < 4 && Number.isFinite(parsedFontSize)
            ? parsedLineHeight * parsedFontSize
            : parsedLineHeight
          : undefined
      const previewHeight = lineHeight ? lineHeight * previewLineCount : content.clientHeight
      setCanExpand(content.scrollHeight > previewHeight + 1)
    }

    measureOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(content)
    return () => observer.disconnect()
  }, [previewLineCount, text])

  return (
    <>
      <p
        ref={textRef}
        id={textId}
        className={cn(
          'mt-2 whitespace-pre-wrap break-words leading-6 text-muted-foreground',
          !isExpanded && collapsedClassName
        )}
      >
        {text}
      </p>
      {canExpand ? (
        <button
          type="button"
          className="-ml-2 mt-1 inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-primary outline-none transition-colors hover:bg-primary/10 hover:text-primary focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={isExpanded}
          aria-controls={textId}
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          {isExpanded ? t('Show less') : t('Show more')}
          {isExpanded ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </>
  )
}

const CollapsibleAbstract = ({ text }: { text: string }): React.JSX.Element => (
  <CollapsibleDetailText
    text={text}
    previewLineCount={ABSTRACT_PREVIEW_LINE_COUNT}
    collapsedClassName="line-clamp-8"
  />
)

const CollapsibleAuthors = ({ text }: { text: string }): React.JSX.Element => (
  <CollapsibleDetailText
    text={text}
    previewLineCount={AUTHOR_PREVIEW_LINE_COUNT}
    collapsedClassName="line-clamp-5"
  />
)

const normalizedMetadataValue = (value: string): string =>
  value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.\s]+$/gu, '')
    .toLocaleLowerCase()

const metadataValuesMatch = (currentValue: string, candidateValue: string): boolean =>
  normalizedMetadataValue(currentValue) === normalizedMetadataValue(candidateValue)

const itemDescription = (item: LiteratureItemInput): string =>
  [creatorLabel(item), item.issuedYear, item.containerTitle].filter(Boolean).join(' · ')

const inboxProviderLabel = (provider: string): string => {
  const trimmedProvider = provider.trim()
  return trimmedProvider.toLocaleLowerCase() === 'pubmed' ? 'PubMed' : trimmedProvider
}

const emptyLiteratureItem = (): LiteratureItemInput => ({
  itemType: 'journalArticle',
  title: '',
  abstract: '',
  issuedText: '',
  containerTitle: '',
  shortTitle: '',
  language: '',
  rights: '',
  url: '',
  extra: '',
  typeFields: {},
  creators: [],
  identifiers: []
})

const titleFromPdfFilename = (filename: string): string =>
  filename
    .replace(/\.pdf$/iu, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || filename

const LITERATURE_REVIEW_CTA_ATTENTION_KEY = 'open-science:literature-review-cta-attention-seen'

type LiteratureRowActions = {
  openSelectedItemDetail: (entry: LiteratureItemView, initiator?: HTMLElement) => void
  persistInlineItem: (
    entry: LiteratureItemView,
    patch: Partial<Pick<LiteratureItemInput, 'itemType' | 'personalNote' | 'rating'>>,
    onPersisted?: (reload: () => Promise<LiteratureItemView>) => void
  ) => Promise<void>
  previewFirstAttachment: (entry: LiteratureItemView) => void
  setItemsLifecycle: (
    ids: readonly string[] | undefined,
    state: 'active' | 'deleted'
  ) => Promise<void>
  requestPermanentDeletion: (ids: string[]) => void
}

// Position changes affect only the number cells, not each reference's entire row.
const LiteratureRowNumbers = createContext<ReadonlyMap<string, number>>(new Map())
function LiteratureRowNumber({ itemId }: { itemId: string }): React.JSX.Element {
  const number = useContext(LiteratureRowNumbers).get(itemId)
  return (
    <td
      data-row-number={number}
      className="px-2 py-2 text-center align-middle text-xs tabular-nums text-muted-foreground"
    >
      {number}
    </td>
  )
}

// Render inputs are explicit; event handlers read the latest owner guards at interaction time.
const LiteratureItemRow = memo(function LiteratureItemRow({
  entry,
  trash,
  smart,
  smartTableBlocked,
  isBatching,
  decisionDisabled,
  updateDisabled,
  completed,
  evaluating,
  attachmentPending,
  selectionStore,
  smartCellActions,
  visibleOrderedTableColumns,
  itemTypeLabels,
  actions
}: {
  entry: LiteratureItemView
  trash: boolean
  smart: boolean
  smartTableBlocked: boolean
  isBatching: boolean
  decisionDisabled: boolean
  updateDisabled: boolean
  completed: boolean
  evaluating: boolean
  attachmentPending: boolean
  selectionStore: LiteratureSelectionStore
  smartCellActions: React.RefObject<SmartCollectionCellActions>
  visibleOrderedTableColumns: LiteratureTableColumn[]
  itemTypeLabels: Record<LiteratureItemType, string>
  actions: React.RefObject<LiteratureRowActions>
}): React.JSX.Element {
  const { t } = useTranslation()
  const attachmentVersion = entry.attachments.find((attachment) => attachment.versions[0])
    ?.versions[0]
  const hasUnavailableAttachment = entry.attachments.some((attachment) =>
    attachment.versions.some((version) => version.availability === 'unavailable')
  )
  return (
    <tr className="group h-16 bg-bg-000 hover:bg-bg-200 focus-within:bg-bg-200">
      <td className="px-3 py-2 align-middle">
        <LiteratureSelectionCheckbox
          disabled={smartTableBlocked}
          itemId={entry.id}
          label={t('Select {{title}}', { title: entry.item.title })}
          store={selectionStore}
          className="size-4"
        />
      </td>
      <LiteratureRowNumber itemId={entry.id} />
      <td className="p-0 align-middle">
        <LiteratureTextTooltip text={entry.item.title}>
          <button
            type="button"
            className="flex h-full min-h-16 w-full min-w-0 items-center gap-2 px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            disabled={trash}
            onClick={(event) => actions.current.openSelectedItemDetail(entry, event.currentTarget)}
          >
            <span className="min-w-0 line-clamp-2 break-words font-medium text-foreground">
              {entry.item.title}
            </span>
            {entry.mergedIntoItemId ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('Merged duplicate')}
              </span>
            ) : null}
          </button>
        </LiteratureTextTooltip>
      </td>
      {smart && (
        <SmartCollectionCells
          itemId={entry.id}
          row={entry.smartDecision}
          actions={smartCellActions}
          completed={completed}
          evaluating={evaluating}
          disabled={decisionDisabled}
          updateDisabled={updateDisabled}
        />
      )}
      {visibleOrderedTableColumns.map((column) => {
        switch (column) {
          case 'abstract':
            return (
              <LiteratureTextTooltip key={column} text={entry.item.abstract}>
                <td
                  tabIndex={entry.item.abstract ? 0 : undefined}
                  className="px-3 py-2 align-middle text-muted-foreground"
                >
                  <span className="line-clamp-2 leading-5">{entry.item.abstract || '—'}</span>
                </td>
              </LiteratureTextTooltip>
            )
          case 'year':
            return (
              <td
                key={column}
                className="px-3 py-2 align-middle text-muted-foreground tabular-nums"
              >
                {entry.item.issuedYear ?? '—'}
              </td>
            )
          case 'publication':
            return (
              <LiteratureTextTooltip key={column} text={entry.item.containerTitle}>
                <td
                  tabIndex={entry.item.containerTitle ? 0 : undefined}
                  className="truncate px-3 py-2 align-middle text-muted-foreground"
                >
                  {entry.item.containerTitle || '—'}
                </td>
              </LiteratureTextTooltip>
            )
          case 'authors':
            return (
              <LiteratureTextTooltip key={column} text={fullCreatorLabel(entry.item)}>
                <td
                  tabIndex={entry.item.creators.length ? 0 : undefined}
                  className="truncate px-3 py-2 align-middle text-muted-foreground"
                >
                  {creatorLabel(entry.item) || t('Unknown')}
                </td>
              </LiteratureTextTooltip>
            )
          case 'type':
            return (
              <td key={column} className="px-2 py-2 align-middle">
                <LiteratureTypeControl
                  disabled={trash || smartTableBlocked}
                  key={`${entry.id}:${entry.metadataRevision}:type`}
                  value={entry.item.itemType}
                  title={entry.item.title}
                  labels={itemTypeLabels}
                  onCommit={(itemType) => actions.current.persistInlineItem(entry, { itemType })}
                />
              </td>
            )
          case 'tags':
            return (
              <td key={column} className="px-2 py-2 align-middle">
                <ResourceTagMenu
                  reference={{
                    resourceType: 'literature.item',
                    resourceId: entry.id
                  }}
                  trigger={
                    <button
                      type="button"
                      aria-label={t('Manage Tags')}
                      disabled={trash || smartTableBlocked}
                      className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 flex-1">
                        <ResourceTagBadges
                          reference={{
                            resourceType: 'literature.item',
                            resourceId: entry.id
                          }}
                          removable={false}
                          className="min-w-0 justify-start"
                        />
                      </span>
                      <ChevronDown
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  }
                />
              </td>
            )
          case 'rating':
            return (
              <td key={column} className="px-2 py-2 align-middle">
                <LiteratureRatingControl
                  disabled={trash || smartTableBlocked}
                  key={`${entry.id}:${entry.metadataRevision}:rating`}
                  value={entry.item.rating ?? 0}
                  onCommit={(rating) => actions.current.persistInlineItem(entry, { rating })}
                />
              </td>
            )
          case 'notes':
            return (
              <td key={column} className="px-2 py-2 align-middle">
                <LiteratureNoteControl
                  disabled={trash || smartTableBlocked}
                  key={entry.id}
                  entry={entry}
                  onCommit={(base, personalNote, onPersisted) =>
                    actions.current.persistInlineItem(base, { personalNote }, onPersisted)
                  }
                />
              </td>
            )
          case 'url': {
            const externalUrl = getExternalLiteratureUrl(entry.item.url)
            return (
              <td key={column} className="px-2 py-2 text-center align-middle text-muted-foreground">
                {externalUrl ? (
                  <ExternalTextLink
                    href={externalUrl.href}
                    aria-label={`${t('URL')}: ${externalUrl.href}`}
                    className="size-8 justify-center rounded-md no-underline hover:bg-muted"
                  >
                    <span className="sr-only">{externalUrl.href}</span>
                  </ExternalTextLink>
                ) : (
                  '—'
                )}
              </td>
            )
          }
        }
      })}
      <td className="sticky right-12 z-20 w-28 min-w-28 max-w-28 border-l border-border-300/80 bg-inherit px-3 py-2 text-center align-middle shadow-card-opaque">
        {attachmentVersion ? (
          <LiteratureTextTooltip text={attachmentVersion.filename}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Preview {{title}}', {
                title: attachmentVersion.filename
              })}
              disabled={
                trash || attachmentVersion.availability === 'unavailable' || attachmentPending
              }
              onClick={() => actions.current.previewFirstAttachment(entry)}
            >
              <Paperclip className="size-4 text-primary" aria-hidden="true" />
            </Button>
          </LiteratureTextTooltip>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {hasUnavailableAttachment ? (
          <button
            type="button"
            className="block w-full text-xs text-danger-000"
            disabled={trash}
            onClick={(event) => actions.current.openSelectedItemDetail(entry, event.currentTarget)}
          >
            {t('Attachment unavailable')}
          </button>
        ) : null}
      </td>
      <td className="sticky right-0 z-20 w-12 min-w-12 max-w-12 bg-inherit px-2 py-2 align-middle">
        <div className="flex items-center justify-end">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('More actions')}
                disabled={smartTableBlocked}
                className="transition-none"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={trash}
                onSelect={() => actions.current.openSelectedItemDetail(entry)}
              >
                <Pencil className="mr-2 size-4" aria-hidden="true" />
                {t('Edit')}
              </DropdownMenuItem>
              {trash ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={isBatching || Boolean(entry.mergedIntoItemId)}
                    onSelect={() => void actions.current.setItemsLifecycle([entry.id], 'active')}
                  >
                    <RotateCcw className="mr-2 size-4" aria-hidden="true" />
                    {t('Restore')}
                  </DropdownMenuItem>
                  {entry.mergedIntoItemId ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        useNavigationStore
                          .getState()
                          .openLiteratureItem(entry.mergedIntoItemId!, 'user')
                      }
                    >
                      <BookOpenText className="mr-2 size-4" aria-hidden="true" />
                      {t('Open retained reference')}
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
              {!trash ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={isBatching}
                    onSelect={() => void actions.current.setItemsLifecycle([entry.id], 'deleted')}
                  >
                    <Trash2 className="mr-2 size-4" aria-hidden="true" />
                    {t('Move to Trash')}
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-danger-000 focus:text-danger-000"
                    disabled={isBatching}
                    onSelect={() => actions.current.requestPermanentDeletion([entry.id])}
                  >
                    <Trash2 className="mr-2 size-4" aria-hidden="true" />
                    {t('Delete permanently')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  )
})

// Keep unrelated library updates outside the preview subtree.
const LiteratureFilePreviewDialog = memo(FilePreviewDialog)

const LiteratureLibraryPage = (): React.JSX.Element => {
  const { i18n, t } = useTranslation()
  const returnFromLibrary = useNavigationStore((state) => state.returnFromLibrary)
  const startPdfReadingConversation = useNavigationStore(
    (state) => state.startPdfReadingConversation
  )
  const startPdfReadingConversations = useNavigationStore(
    (state) => state.startPdfReadingConversations
  )
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const startLiteratureReviewConversation = useNavigationStore(
    (state) => state.startLiteratureReviewConversation
  )
  const pendingLiteratureItemId = useNavigationStore((state) => state.pendingLiteratureItemId)
  const pendingLiteratureAnnotation = useNavigationStore(
    (state) => state.pendingLiteratureAnnotation
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
  const [pendingDecisions, setPendingDecisions] = useState<Set<string>>(new Set())
  const decisionQueue = useRef(Promise.resolve())
  const currentSmartState = useRef(smartState)
  useLayoutEffect(() => {
    if (currentSmartState.current !== smartState) {
      setScreeningCollection(undefined)
      setScreeningStartingCollection(undefined)
    }
    currentSmartState.current = smartState
  }, [smartState])
  const [decisionFailures, setDecisionFailures] = useState<
    Array<{ key: string; collection: string; retry: () => void }>
  >([])
  const [smartRefreshFailure, setSmartRefreshFailure] = useState<string>()
  const smartResultSnapshot = useRef<string | undefined>(undefined)
  const [smartRunningCollection, setSmartRunningCollection] = useState<string>()
  const [singleReevaluation, setSingleReevaluation] = useState<{
    collectionId: string
    itemId: string
    previousRunId?: string
  }>()
  const [completedReevaluation, setCompletedReevaluation] = useState<typeof singleReevaluation>()
  useEffect(() => {
    if (!completedReevaluation) return
    const timer = setTimeout(() => setCompletedReevaluation(undefined), 1600)
    return () => clearTimeout(timer)
  }, [completedReevaluation])
  const singleReevaluationRef = useRef<typeof singleReevaluation>(undefined)
  const smartDecisionBatch = useSmartDecisionBatch()
  const smartTableBlocked =
    smartRunningCollection === collectionId &&
    !!collectionId &&
    singleReevaluation?.collectionId !== collectionId &&
    !smartDecisionBatch.progress
  const [smartBatchResult, setSmartBatchResult] = useState<{
    collectionId: string
    done: number
    failed: string[]
    remaining: string[]
    decision: 'include' | 'exclude' | 'automatic'
  }>()
  const [smartReevaluation, setSmartReevaluation] = useState<{
    collectionId: string
    ids: string[]
    detailItemId?: string
  }>()
  const [smartReevaluationRemember, setSmartReevaluationRemember] = useState(false)

  const [smartDecisionSource, setSmartDecisionSource] = useState<'all' | 'ai' | 'manual'>('all')
  const [smartFilter, setSmartFilter] = useState<'match' | 'review' | 'no-match' | 'pending'>(
    'match'
  )
  const [projectId, setProjectId] = useState<string>()
  const [query, setQuery] = useState('')
  const [tagId, setTagId] = useState('all')
  const [sortBy, setSortBy] = useState<keyof typeof literatureSorts>('updated')
  const [initialTablePreferences] = useState(loadLiteratureTablePreferences)
  const [tableColumnOrder, setTableColumnOrder] = useState<LiteratureTableColumn[]>(
    initialTablePreferences.order
  )
  const [visibleTableColumns, setVisibleTableColumns] = useState<Set<LiteratureTableColumn>>(
    () => new Set(initialTablePreferences.visible)
  )
  const [filterItemType, setFilterItemType] = useState<LiteratureItemType | 'all'>('all')
  const [filterHasPdf, setFilterHasPdf] = useState<'all' | 'with' | 'without'>('all')
  const [selectionStore] = useState(createLiteratureSelectionStore)
  const clearSelection = useCallback((): void => selectionStore.clear(), [selectionStore])
  const yearFilter = useLiteratureYearFilter(clearSelection)
  const { from: filterYearFrom, to: filterYearTo } = yearFilter
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [restorePreview, setRestorePreview] = useState<{ itemIds: string[]; skipped: number }>()
  const dialogRestorePreview = useRetainedDialogValue(restorePreview)
  const [isBatching, setIsBatching] = useState(false)
  const [batchLookup, setBatchLookup] = useState<{
    mode: BatchLookupMode
    itemIds: string[]
    jobId?: string
  }>()
  const [permanentDeleteIds, setPermanentDeleteIds] = useState<string[]>([])
  const [permanentDeleteFailed, setPermanentDeleteFailed] = useState(false)
  const [permanentDeletionDiagnostic, setPermanentDeletionDiagnostic] =
    useState<LiteratureDeletionDiagnostic>()
  const [permanentDeleteResult, setPermanentDeleteResult] = useState<{
    scope: string
    cleanupPending: boolean
    refreshFailed: boolean
  }>()
  const permanentDeleteScope = JSON.stringify([section, projectId, collectionId])
  if (permanentDeleteResult && permanentDeleteResult.scope !== permanentDeleteScope) {
    setPermanentDeleteResult(undefined)
  }
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeError, setMergeError] = useState<string>()
  const [duplicateMergeItems, setDuplicateMergeItems] = useState<LiteratureItemView[]>()
  const duplicateCountRef = useRef<LiteratureDuplicateCountHandle>(null)
  const setDuplicateCount = useCallback((count: number | undefined) => {
    duplicateCountRef.current?.setCount(count)
  }, [])
  const [duplicatesRevision, setDuplicatesRevision] = useState(0)
  const [libraryCountRevision, setLibraryCountRevision] = useState(0)
  const [mergeSurvivorId, setMergeSurvivorId] = useState('')
  const [mergeFieldSources, setMergeFieldSources] = useState<Record<string, string>>({})
  const [items, setItems] = useState<LiteratureItemView[]>([])
  const [candidates, setCandidates] = useState<LiteratureInboxCandidateView[]>([])
  const [inboxPendingCount, setInboxPendingCount] = useState<number>()
  const [inboxDismissedCount, setInboxDismissedCount] = useState<number>()
  const [collections, setCollections] = useState<LiteratureCollectionView[]>([])
  const [projectItemCounts, setProjectItemCounts] = useState<Record<string, number>>({})
  const [selectedCandidate, setSelectedCandidate] = useState<LiteratureInboxCandidateView>()
  const attachmentOperations = useAttachmentOperations((state) => state.operations)
  const [detailController] = useState(createLiteratureDetailController)
  const selectedItem = detailController.getSnapshot().item
  const selectedItemId = selectedItem?.id
  const [isCreatingItem, setIsCreatingItem] = useState(false)
  const [isSavingNewItem, setIsSavingNewItem] = useState(false)
  const [createItemError, setCreateItemError] = useState<string>()
  const [createdItemId, setCreatedItemId] = useState<string>()
  const creatingItemRef = useRef(false)
  const pendingCreationRef = useRef<{
    id: string
    destination?: Extract<
      LiteratureCatalogCommand,
      { kind: 'set-project-item' | 'set-collection-item' }
    >
    projectId?: string
    collectionId?: string
    file?: File
    pdfItem?: LiteratureItemView
  }>(undefined)
  const [pdfBatch, setPdfBatch] = useState<{ files: File[]; destination: PdfImportDestination }>()
  const [pendingImportPdf, setPendingImportPdf] = useState<File>()
  const [pendingImportMetadataNotice, setPendingImportMetadataNotice] = useState<string>()
  const [pendingImportDraft, setPendingImportDraft] = useState<LiteratureItemInput>()
  const [isReadingImportMetadata, setIsReadingImportMetadata] = useState(false)
  const [recordImport, setRecordImport] = useState<
    RecordImportDraft & { destination: { name: string; projectId?: string; collectionId?: string } }
  >()
  const [duplicatePolicy, setDuplicatePolicy] = useState<LiteratureDuplicatePolicy>('reuse')
  const dialogItemEditor = useRetainedDialogValue(
    useMemo(
      () =>
        isCreatingItem
          ? {
              file: pendingImportPdf,
              draft: pendingImportDraft,
              metadataNotice: pendingImportMetadataNotice,
              reading: isReadingImportMetadata,
              error: createItemError,
              duplicatePolicy,
              createdItemId
            }
          : undefined,
      [
        isCreatingItem,
        pendingImportPdf,
        pendingImportDraft,
        pendingImportMetadataNotice,
        isReadingImportMetadata,
        createItemError,
        duplicatePolicy,
        createdItemId
      ]
    )
  )
  const recordImportRequest = useRef(0)

  const [isImportingRecords, setIsImportingRecords] = useState(false)
  const [entriesPageSize, setEntriesPageSize] = useState<LiteraturePageSize>(
    LITERATURE_DEFAULT_PAGE_SIZE
  )
  const [entriesOffset, setEntriesOffset] = useState(0)
  const rowNumbers = useMemo(
    () => new Map(items.map((item, index) => [item.id, entriesOffset + index + 1])),
    [items, entriesOffset]
  )
  const [entriesTotalCount, setEntriesTotalCount] = useState(0)
  const [nextEntriesOffset, setNextEntriesOffset] = useState<number>()
  const [error, setError] = useState<string>()
  const [lifecycleFailure, setLifecycleFailure] = useState<{
    itemIds: string[]
    state: 'active' | 'deleted'
    completed: number
  }>()
  const [linkFailure, setLinkFailure] = useState<{
    command:
      | Omit<Extract<LiteratureCatalogCommand, { kind: 'move-collection-items' }>, 'itemIds'>
      | Omit<Extract<LiteratureCatalogCommand, { kind: 'set-project-items' }>, 'itemIds'>
    itemIds: readonly string[]
    completed: number
    scopeKey: string
    skipped: number
  }>()
  const [linkedItemError, setLinkedItemError] = useState<string>()
  const [pendingCandidateId, setPendingCandidateId] = useState<string>()
  const [dismissedCandidateUndo, setDismissedCandidateUndo] = useState<DismissedCandidateUndo>()
  const [candidateUpdateUncertain, setCandidateUpdateUncertain] = useState(false)
  const [candidateCountsFailed, setCandidateCountsFailed] = useState(false)
  const [undoNotice, setUndoNotice] = useState<string>()
  const [collectionPendingDelete, setCollectionPendingDelete] = useState<LiteratureCollectionView>()
  const [isDeletingCollection, setIsDeletingCollection] = useState(false)
  const [collectionDeleteError, setCollectionDeleteError] = useState<string>()
  const [isAddingPdf, setIsAddingPdf] = useState(false)
  const addingPdfRef = useRef(false)
  const [pdfUpload, setPdfUpload] = useState<{
    progress: UploadTransferProgress
    phase: 'uploading' | 'cancelling' | 'saving'
  }>()
  const [pdfNativeProgress, setPdfNativeProgress] =
    useState<import('../../../../shared/pdf-annotations').PdfNativeAnnotationImportProgress>()
  const pdfUploadRef = useRef<{ controller: AbortController; transferId: string } | undefined>(
    undefined
  )
  const pdfNativeImportRef = useRef<string | undefined>(undefined)
  const uploadPageMountedRef = useRef(true)
  const stagePdf = async (
    file: File,
    transferId: string
  ): Promise<Awaited<ReturnType<typeof stageComposerFile>>> => {
    const controller = new AbortController()
    pdfUploadRef.current = { controller, transferId }
    if (!uploadPageMountedRef.current) controller.abort()
    return stageComposerFile(file, window.api.uploads, {
      transferId,
      name: file.name,
      signal: controller.signal,
      onProgress: (progress) =>
        setPdfUpload({
          progress,
          phase: controller.signal.aborted ? 'cancelling' : 'uploading'
        })
    })
  }
  const finishPdfStaging = (): void => {
    if (pdfUploadRef.current?.controller.signal.aborted)
      throw new DOMException('Upload cancelled.', 'AbortError')
    pdfUploadRef.current = undefined
    setPdfUpload((current) => (current ? { ...current, phase: 'saving' } : current))
  }
  const cancelPdfUpload = (): void => {
    const operationId = pdfNativeImportRef.current
    if (operationId) {
      void window.api.literature.cancelPdfImport({ operationId }).catch(() => undefined)
      setPdfUpload((current) => (current ? { ...current, phase: 'cancelling' } : current))
    }
    const controller = pdfUploadRef.current?.controller
    if (!controller || controller.signal.aborted || !pdfUpload || pdfUpload.phase !== 'uploading')
      return
    controller.abort()
    setPdfUpload({ ...pdfUpload, phase: 'cancelling' })
    void window.api.uploads
      .abortTransfer({ transferId: pdfUpload.progress.transferId })
      .catch(() => undefined)
  }
  useEffect(() => {
    const subscribe = window.api.pdfAnnotations?.onImportProgress
    if (!subscribe) return
    return subscribe((progress) => {
      if (progress.operationId === pdfNativeImportRef.current) setPdfNativeProgress(progress)
    })
  }, [])
  useEffect(() => {
    uploadPageMountedRef.current = true
    return () => {
      uploadPageMountedRef.current = false
      const operationId = pdfNativeImportRef.current
      if (operationId)
        void window.api.literature.cancelPdfImport({ operationId }).catch(() => undefined)
      const upload = pdfUploadRef.current
      if (!upload) return
      upload.controller.abort()
      void window.api.uploads
        .abortTransfer({ transferId: upload.transferId })
        .catch(() => undefined)
    }
  }, [])
  const pdfUploadNotice =
    pdfUpload || pdfNativeProgress ? (
      <div className="shrink-0 space-y-2 border-b border-border px-5 py-3">
        {pdfUpload ? (
          <>
            <p className="truncate text-sm font-medium">{pdfUpload.progress.name}</p>
            <progress
              className="h-2 w-full accent-primary"
              aria-label={t('Upload progress')}
              max={Math.max(1, pdfUpload.progress.totalBytes)}
              value={pdfUpload.progress.receivedBytes}
            />
            <div className="flex items-center justify-between gap-3">
              <p role="status" className="text-xs text-muted-foreground">
                {pdfUpload.phase === 'cancelling'
                  ? t('Cancelling…')
                  : pdfUpload.phase === 'saving'
                    ? t('Saving…')
                    : t('{{received}} / {{total}} bytes uploaded', {
                        received: pdfUpload.progress.receivedBytes.toLocaleString(),
                        total: pdfUpload.progress.totalBytes.toLocaleString()
                      })}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pdfUpload.phase !== 'uploading' && pdfNativeProgress?.phase !== 'parsing'}
                onClick={cancelPdfUpload}
              >
                {t('Cancel upload')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('Keep this window open until the upload finishes or is cancelled.')}
            </p>
          </>
        ) : null}
        {pdfNativeProgress ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {pdfNativeProgress.phase === 'parsing' || pdfNativeProgress.phase === 'saving' ? (
              <LoaderCircle
                className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {pdfNativeProgress.phase === 'completed'
              ? t('Imported {{count}} native annotations.', {
                  count: pdfNativeProgress.importedCount
                })
              : pdfNativeProgress.phase === 'cancelled'
                ? t('Native annotation import cancelled.')
                : pdfNativeProgress.phase === 'failed'
                  ? t('Native annotation import failed.')
                  : t('Importing native annotations…')}{' '}
            {pdfNativeProgress.pageCount > 0
              ? t('{{processed}} / {{total}} pages', {
                  processed: pdfNativeProgress.pagesProcessed,
                  total: pdfNativeProgress.pageCount
                })
              : null}
            {pdfNativeProgress.truncated
              ? ` · ${t('Native annotation import limit reached. Some annotations were not imported.')}`
              : null}
            {pdfNativeProgress.unsupportedCount > 0
              ? ` · ${t('Unsupported native annotations: {{count}}', {
                  count: pdfNativeProgress.unsupportedCount
                })}`
              : null}
          </p>
        ) : null}
      </div>
    ) : null
  const [pdfError, setPdfError] = useState<string>()
  const [projectLinkError, setProjectLinkError] = useState<string>()
  const [collectionLinkError, setCollectionLinkError] = useState<string>()
  const [previewItem, setPreviewItem] = useState<PreviewFileItem>()
  const [annotationToReveal, setAnnotationToReveal] = useState<PdfAnnotation>()
  const [pendingLiteratureReading, setPendingLiteratureReading] =
    useState<PendingLiteratureReading>()
  const [batchReading, setBatchReading] = useState<{
    entries?: LiteratureItemView[]
    error?: string
  }>()
  const [readingSelectionEntries, setReadingSelectionEntries] = useState<LiteratureItemView[]>()
  const batchReadingRequest = useRef(0)
  useEffect(
    () => () => {
      batchReadingRequest.current += 1
    },
    []
  )
  const [startingReadingProjectId, setStartingReadingProjectId] = useState<string>()
  const [readingProjectQuery, setReadingProjectQuery] = useState('')
  const [readingProjectError, setReadingProjectError] = useState<string>()
  const [citationStyles, setCitationStyles] = useState<LiteratureCitationStyleView[]>()
  const [citationStylesOpen, setCitationStylesOpen] = useState(false)
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
  const importMetadataGenerationRef = useRef(0)

  const updateCitationStyles = useCallback((next: LiteratureCitationStyleView[]): void => {
    setCitationStyles(next)
    if (!next.some(({ id }) => id === citationStyleRef.current)) citationStyleRef.current = 'apa'
  }, [])

  const tableMinWidth =
    540 +
    literatureTableColumns.reduce(
      (width, column) =>
        width + (visibleTableColumns.has(column) ? literatureTableColumnWidths[column] : 0),
      0
    )

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

  const handleDetailSelectOpenChange = useCallback((open: boolean): void => {
    detailSelectOpenRef.current = open
    if (!open) {
      childLayerDismissGuardUntilRef.current = Date.now() + CHILD_LAYER_DISMISS_GUARD_MS
    }
  }, [])

  const previousTablePreferences = useRef(initialTablePreferences)
  useEffect(() => {
    const previous = previousTablePreferences.current
    const local = { order: tableColumnOrder, visible: [...visibleTableColumns] }
    // External updates have already been adopted; do not echo them to other windows.
    if (
      local.order === previous.order &&
      local.visible.length === previous.visible.length &&
      local.visible.every((column) => previous.visible.includes(column))
    )
      return
    const latest = loadLiteratureTablePreferences()
    const visible = new Set(latest.visible)
    for (const column of literatureTableColumns) {
      if (visibleTableColumns.has(column) !== previous.visible.includes(column)) {
        if (visibleTableColumns.has(column)) visible.add(column)
        else visible.delete(column)
      }
    }
    const merged = {
      order: tableColumnOrder === previous.order ? latest.order : tableColumnOrder,
      visible: [...visible]
    }
    try {
      window.localStorage.setItem(LITERATURE_TABLE_PREFERENCES_KEY, JSON.stringify(merged))
    } catch {
      // Non-critical preferences remain usable in memory; retry only on another edit.
      return
    }
    previousTablePreferences.current = merged
    if (merged.order !== tableColumnOrder) setTableColumnOrder(merged.order)
    if (
      merged.visible.length !== local.visible.length ||
      merged.visible.some((column) => !visibleTableColumns.has(column))
    )
      setVisibleTableColumns(visible)
  }, [tableColumnOrder, visibleTableColumns])

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (
        event.storageArea !== window.localStorage ||
        (event.key !== null && event.key !== LITERATURE_TABLE_PREFERENCES_KEY)
      )
        return
      const preferences = loadLiteratureTablePreferences()
      previousTablePreferences.current = preferences
      setTableColumnOrder(preferences.order)
      setVisibleTableColumns(new Set(preferences.visible))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
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

  const collectionsGenerationRef = useRef(0)
  const loadCollections = useCallback(async (): Promise<LiteratureCollectionView[] | undefined> => {
    if (pendingDecisionsRef.current.size) return
    const generation = ++collectionsGenerationRef.current
    const collections: LiteratureCollectionView[] = []
    let offset: number | undefined = 0
    do {
      const page = await window.api.literature.search({ scope: 'collections', limit: 100, offset })
      if (generation !== collectionsGenerationRef.current) return
      collections.push(...page.entries.filter(isCollection))
      offset = page.nextOffset
    } while (offset !== undefined)
    setCollections(collections)
    return collections
  }, [])

  const inboxCountGeneration = useRef(0)
  const loadInboxCounts = useCallback(async (): Promise<void> => {
    const generation = ++inboxCountGeneration.current
    await Promise.all(
      (['pending', 'dismissed'] as const).map(async (state) => {
        const page = await window.api.literature.search({
          scope: 'inbox',
          inboxState: state,
          limit: 1
        })
        if (generation !== inboxCountGeneration.current) return
        const count = page.totalCount ?? page.entries.length
        if (state === 'pending') setInboxPendingCount(count)
        else setInboxDismissedCount(count)
      })
    )
  }, [])

  const projectCountsGenerationRef = useRef(0)
  const loadProjectCounts = useCallback(async (): Promise<void> => {
    const generation = ++projectCountsGenerationRef.current
    const page = await window.api.literature.search({ scope: 'project-counts' })
    if (generation !== projectCountsGenerationRef.current) return
    setProjectItemCounts(
      Object.fromEntries(
        page.entries
          .filter(isProjectCount)
          .map(({ projectId, itemCount }) => [projectId, itemCount])
      )
    )
  }, [])

  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === collectionId),
    [collectionId, collections]
  )
  const smartSetup = Boolean(
    selectedCollection?.smart && !smartView?.configured && !smartView?.run && !smartView?.matches
  )
  const entriesKey = useMemo(
    () =>
      JSON.stringify({
        section,
        inboxState,
        collectionId,
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
        entriesPageSize
      }),
    [
      collectionId,
      smartFilter,
      smartDecisionSource,
      filterHasPdf,
      entriesPageSize,
      filterItemType,
      filterYearFrom,
      filterYearTo,
      inboxState,
      query,
      projectId,
      section,
      sortBy,
      tagId
    ]
  )
  const linkScopeRef = useRef(entriesKey)
  useLayoutEffect(() => {
    linkScopeRef.current = entriesKey
    return () => {
      linkScopeRef.current = ''
    }
  }, [entriesKey])
  const entriesPage = Math.floor(entriesOffset / entriesPageSize) + 1
  const entriesPageCount = Math.max(1, Math.ceil(entriesTotalCount / entriesPageSize))
  const displayedEntryCount = section === 'inbox' ? candidates.length : items.length
  const entriesRangeStart = entriesTotalCount > 0 ? entriesOffset + 1 : 0
  const entriesRangeEnd = Math.min(entriesOffset + displayedEntryCount, entriesTotalCount)
  const entriesPaginationItems = useMemo<Array<number | 'ellipsis'>>(() => {
    if (entriesPageCount <= 7) {
      return Array.from({ length: entriesPageCount }, (_, index) => index + 1)
    }

    const visiblePages = new Set([
      1,
      entriesPageCount,
      entriesPage - 1,
      entriesPage,
      entriesPage + 1
    ])
    if (entriesPage <= 4) {
      for (let page = 2; page <= 5; page += 1) visiblePages.add(page)
    }
    if (entriesPage >= entriesPageCount - 3) {
      for (let page = entriesPageCount - 4; page < entriesPageCount; page += 1) {
        visiblePages.add(page)
      }
    }

    const pages = [...visiblePages]
      .filter((page) => page >= 1 && page <= entriesPageCount)
      .sort((left, right) => left - right)
    return pages.flatMap((page, index) => {
      const previousPage = pages[index - 1]
      return previousPage !== undefined && page - previousPage > 1 ? ['ellipsis', page] : [page]
    })
  }, [entriesPage, entriesPageCount])

  const buildEntriesRequest = useCallback(
    (offset = entriesOffset): LiteratureCatalogSearchRequest =>
      section === 'inbox'
        ? {
            scope: 'inbox',
            inboxState,
            query,
            offset,
            limit: entriesPageSize
          }
        : {
            scope: 'library',
            collectionId: section === 'library' ? collectionId : undefined,
            smartFilter: selectedCollection?.smart ? smartFilter : undefined,
            ...(selectedCollection?.smart && smartDecisionSource !== 'all'
              ? { smartDecisionSource }
              : {}),
            projectId: section === 'library' ? projectId : undefined,
            query,
            lifecycle: section === 'trash' ? 'deleted' : 'active',
            ...literatureSorts[sortBy],
            tagId: tagId === 'all' ? undefined : tagId,
            filter: {
              ...(filterItemType !== 'all' ? { itemTypes: [filterItemType] } : {}),
              ...(filterYearFrom ? { yearFrom: Number(filterYearFrom) } : {}),
              ...(filterYearTo ? { yearTo: Number(filterYearTo) } : {}),
              ...(filterHasPdf !== 'all' ? { hasFullText: filterHasPdf === 'with' } : {})
            },
            offset,
            limit: entriesPageSize
          },
    [
      collectionId,
      selectedCollection?.smart,
      smartFilter,
      smartDecisionSource,
      entriesOffset,
      entriesPageSize,
      filterHasPdf,
      filterItemType,
      filterYearFrom,
      filterYearTo,
      inboxState,
      query,
      projectId,
      section,
      sortBy,
      tagId
    ]
  )

  const receiveEntries = useCallback(
    (
      page: LiteratureCatalogSearchPage,
      request: LiteratureCatalogSearchRequest,
      _fromCache: boolean,
      preservePosition = false
    ): void => {
      if (request.scope === 'inbox') setCandidates(page.entries.filter(isCandidate))
      else setItems(page.entries.filter(isItem))
      setNextEntriesOffset(page.nextOffset)
      const totalCount =
        page.totalCount ??
        (request.offset ?? 0) + page.entries.length + (page.nextOffset === undefined ? 0 : 1)
      setEntriesTotalCount(totalCount)
      if (request.scope === 'inbox' && !request.query) {
        if (request.inboxState === 'pending') setInboxPendingCount(totalCount)
        else if (request.inboxState === 'dismissed') setInboxDismissedCount(totalCount)
      }
      if (
        request.scope === 'library' &&
        request.projectId &&
        !request.collectionId &&
        !request.query &&
        request.lifecycle === 'active' &&
        !request.tagId &&
        (!request.filter || Object.keys(request.filter).length === 0)
      ) {
        setProjectItemCounts((current) => ({ ...current, [request.projectId!]: totalCount }))
      }
      if (!preservePosition && tableScrollRef.current) tableScrollRef.current.scrollTop = 0
    },
    []
  )
  const receiveEntriesError = useCallback(
    (failed: boolean): void => setError(failed ? t('Literature could not be loaded.') : undefined),
    [t]
  )
  const receiveItems = useCallback(
    (updated: LiteratureItemView[]): void => {
      updated.forEach((item) => detailController.replace(item))
    },
    [detailController]
  )
  const entriesRequest = useMemo(() => buildEntriesRequest(), [buildEntriesRequest])
  const {
    oversizedItemId,
    loading: entriesLoading,
    failed: entriesFailed,
    pageTransitionLoading: entriesPageTransitionLoading,
    reload: reloadEntries,
    refreshItems
  } = useLiteratureEntries({
    enabled: !duplicatesOpen,
    request: entriesRequest,
    scopeKey: entriesKey,
    onPage: receiveEntries,
    onItems: receiveItems,
    onEmptyPage: setEntriesOffset,
    onError: receiveEntriesError
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
  const newMetadataDirtyRef = useRef(false)
  const [discardMetadata, setDiscardMetadata] = useState<() => void>()
  const trackMetadataDirty = useCallback((dirty: boolean) => {
    metadataDirtyRef.current = dirty
  }, [])
  const trackNewMetadataDirty = useCallback((dirty: boolean) => {
    newMetadataDirtyRef.current = dirty
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
  }, [changeDetailMode, detailController, metadata.saving, requestMetadataExit])

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
  const currentEntriesReload = useRef(loadEntries)
  useLayoutEffect(() => {
    currentEntriesReload.current = loadEntries
  }, [loadEntries])
  const refreshSmartSummary = useCallback(async () => {
    if (!collectionId) return false
    const token = smartState.beginRead()
    const receipt = await window.api.literature.transact({
      kind: 'smart-collection',
      collectionId,
      action: 'read',
      summaryOnly: true,
      offset: 0
    })
    return Boolean(receipt.smart) && smartState.acceptRead(token, receipt.smart)
  }, [collectionId, smartState])
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

  const receiveSmartView = useCallback(
    (view: SmartCollectionView | undefined, updating: boolean): void => {
      if (!collectionId || currentCollectionId.current !== collectionId) return
      setSmartRunningCollection(updating ? collectionId : undefined)
      if (!updating && singleReevaluationRef.current?.collectionId === collectionId) {
        if (
          view?.run?.state === 'completed' &&
          !view.run.failure &&
          view.run.id !== singleReevaluationRef.current.previousRunId
        )
          setCompletedReevaluation(singleReevaluationRef.current)
        singleReevaluationRef.current = undefined
        setSingleReevaluation(undefined)
      }
      if (updating) {
        smartResultSnapshot.current = collectionId
        return
      }

      if (view) {
        collectionsGenerationRef.current++
        setCollections((current) => {
          const index = current.findIndex((collection) => collection.id === collectionId)
          if (index < 0 || current[index].itemCount === view.counts.match) return current
          const next = [...current]
          next[index] = { ...current[index], itemCount: view.counts.match }
          return next
        })
      }
      if (smartResultSnapshot.current === collectionId) {
        smartResultSnapshot.current = undefined
        void Promise.all([loadEntries(true, true), loadCollections()]).catch(() =>
          setError(t('Literature could not be loaded.'))
        )
      }
    },
    [collectionId, loadEntries, loadCollections, t]
  )

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
  }, [clearSelection, entriesKey])

  const citationLocale = i18n.resolvedLanguage === 'zh-Hans' ? 'zh-CN' : 'en-US'
  const activeMetadataCompletion =
    metadata.completion?.item.id === selectedItemId ? metadata.completion : undefined

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

  const renderedSelection = selectionStore.getSnapshot()
  const selectedItems =
    duplicateMergeItems ??
    items.filter((item) => isLiteratureItemSelected(renderedSelection, item.id))
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
  const tableColumnLabels = useMemo<Record<LiteratureTableColumn, string>>(
    () => ({
      abstract: t('Abstract'),
      year: t('Year'),
      publication: t('Publication'),
      authors: t('Authors'),
      type: t('Type'),
      tags: t('Tags'),
      rating: t('Rating'),
      notes: t('Notes'),
      url: t('URL')
    }),
    [t]
  )
  const visibleOrderedTableColumns = useMemo(
    () => tableColumnOrder.filter((column) => visibleTableColumns.has(column)),
    [tableColumnOrder, visibleTableColumns]
  )
  const activeFilterCount =
    (tagId !== 'all' ? 1 : 0) +
    (filterItemType !== 'all' ? 1 : 0) +
    (yearFilter.from ? 1 : 0) +
    (yearFilter.to ? 1 : 0) +
    (filterHasPdf !== 'all' ? 1 : 0)

  const clearFilters = (): void => {
    setTagId('all')
    setFilterItemType('all')
    yearFilter.clear()
    setFilterHasPdf('all')
    clearSelection()
  }

  const moveTableColumn = (
    source: LiteratureTableColumn,
    target: LiteratureTableColumn,
    edge: 'before' | 'after'
  ): void => {
    if (source === target) return
    setTableColumnOrder((current) => {
      const next = current.filter((column) => column !== source)
      const targetIndex = next.indexOf(target)
      const insertionIndex =
        targetIndex < 0 ? next.length : targetIndex + (edge === 'after' ? 1 : 0)
      next.splice(insertionIndex, 0, source)
      return next
    })
  }

  const moveTableColumnBy = (column: LiteratureTableColumn, delta: -1 | 1): void => {
    setTableColumnOrder((current) => {
      const sourceIndex = current.indexOf(column)
      const targetIndex = sourceIndex + delta
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= current.length) return current
      const next = [...current]
      ;[next[sourceIndex], next[targetIndex]] = [next[targetIndex]!, next[sourceIndex]!]
      return next
    })
  }

  const dismissedUndo = (candidateIds: readonly string[]): DismissedCandidateUndo | undefined =>
    candidateIds.length
      ? {
          candidateIds,
          detail: t('{{count}} references', {
            count: candidateIds.length,
            defaultValue_one: '{{count}} reference'
          })
        }
      : undefined

  const refreshCandidateProjectCounts = async (): Promise<void> => {
    try {
      await loadProjectCounts()
      setCandidateCountsFailed(false)
    } catch {
      setCandidateCountsFailed(true)
    }
  }

  const refreshCandidateInboxCount = async (): Promise<void> => {
    try {
      await loadInboxCounts()
    } catch {
      setInboxPendingCount(undefined)
      setError(t('Literature could not be loaded.'))
    }
  }

  const retryCandidateReads = async (): Promise<void> => {
    if (isBatching || pendingCandidateId) return
    setIsBatching(true)
    setCandidateUpdateUncertain(false)
    try {
      await Promise.all([loadEntries(true), refreshCandidateProjectCounts()])
      await refreshCandidateInboxCount()
    } finally {
      setIsBatching(false)
    }
  }

  const submitCandidateChange = async (
    candidateIds: string[],
    state: 'accepted' | 'dismissed',
    command: Extract<
      LiteratureCatalogCommand,
      { kind: 'accept-candidate' | 'dismiss-candidate' | 'settle-candidates' }
    >
  ): Promise<boolean> => {
    setError(undefined)
    setCandidateUpdateUncertain(false)
    setUndoNotice(undefined)
    try {
      await window.api.literature.transact(command)
    } catch {
      // A rejected transport response does not prove that the transaction rolled back.
      // Reload handles its own read errors; never put a saved candidate snapshot back here.
      if (state === 'dismissed') {
        const undoIds = [
          ...new Set([...(dismissedCandidateUndo?.candidateIds ?? []), ...candidateIds])
        ]
        // Keep recovery reachable even if the following reads are also unavailable.
        setDismissedCandidateUndo({ ...dismissedUndo(undoIds)!, needsRecheck: true })
        await Promise.all([recheckDismissedCandidates(undoIds), refreshCandidateProjectCounts()])
      } else {
        await Promise.all([loadEntries(true), refreshCandidateProjectCounts()])
        await refreshCandidateInboxCount()
      }
      setCandidateUpdateUncertain(true)
      return false
    }
    if (state === 'dismissed') {
      setDismissedCandidateUndo((current) => {
        const candidateIdsToUndo = [...new Set([...(current?.candidateIds ?? []), ...candidateIds])]
        const undo = dismissedUndo(candidateIdsToUndo)!
        return {
          ...undo,
          needsRecheck: current?.needsRecheck,
          detail:
            candidateIdsToUndo.length === 1
              ? (candidates.find(({ id }) => id === candidateIdsToUndo[0])?.candidate.item.title ??
                undo.detail)
              : undo.detail
        }
      })
    }
    if (state === 'dismissed')
      setInboxDismissedCount((current) =>
        current === undefined ? current : current + candidateIds.length
      )
    const settledIds = new Set(candidateIds)
    setCandidates((current) => current.filter(({ id }) => !settledIds.has(id)))
    candidateIds.forEach((id) => selectionStore.remove(id))
    setInboxPendingCount((current) =>
      current === undefined ? current : Math.max(0, current - candidateIds.length)
    )
    // Committed writes stay committed even when an independent refresh fails.
    await Promise.all([
      loadEntries(true),
      ...(state === 'accepted' ? [refreshCandidateProjectCounts()] : [])
    ])
    return true
  }

  const changeCandidateState = async (
    candidateId: string,
    kind: 'accept-candidate' | 'dismiss-candidate'
  ): Promise<boolean> => {
    if (isBatching || pendingCandidateId || entriesFailed) return false
    setPendingCandidateId(candidateId)
    try {
      return await submitCandidateChange(
        [candidateId],
        kind === 'accept-candidate' ? 'accepted' : 'dismissed',
        { kind, candidateId }
      )
    } finally {
      setPendingCandidateId(undefined)
    }
  }

  const settleSelectedCandidates = async (state: 'accepted' | 'dismissed'): Promise<void> => {
    const { selectedIds } = selectionStore.getSnapshot()
    const candidateIds = candidates.map(({ id }) => id).filter((id) => selectedIds.has(id))
    if (!candidateIds.length || isBatching || pendingCandidateId || entriesFailed) return
    setIsBatching(true)
    clearSelection()
    try {
      await submitCandidateChange(candidateIds, state, {
        kind: 'settle-candidates',
        candidateIds,
        state
      })
    } finally {
      setIsBatching(false)
    }
  }

  const recheckDismissedCandidates = async (candidateIds: readonly string[]): Promise<void> => {
    setDismissedCandidateUndo({ ...dismissedUndo(candidateIds)!, needsRecheck: true })
    try {
      const wanted = new Set(candidateIds)
      const readMatchingIds = async (inboxState: 'pending' | 'dismissed'): Promise<Set<string>> => {
        const matching = new Set<string>()
        let offset: number | undefined = 0
        do {
          const page = await window.api.literature.search({
            scope: 'inbox',
            inboxState,
            limit: 100,
            offset
          })
          for (const entry of page.entries) {
            if (isCandidate(entry) && wanted.has(entry.id)) matching.add(entry.id)
          }
          offset = page.nextOffset
        } while (offset !== undefined && matching.size < wanted.size)
        return matching
      }
      const dismissed = await readMatchingIds('dismissed')
      const pending =
        dismissed.size === wanted.size ? new Set<string>() : await readMatchingIds('pending')
      const remaining = candidateIds.filter((id) => dismissed.has(id))
      const alreadyRestored = candidateIds.filter(
        (id) => !dismissed.has(id) && pending.has(id)
      ).length
      setDismissedCandidateUndo(dismissedUndo(remaining))
      setUndoNotice(
        t(
          'Already restored: {{restored}}. Accepted or unavailable, skipped: {{skipped}}. Still dismissed: {{remaining}}.',
          {
            restored: alreadyRestored,
            skipped: candidateIds.length - remaining.length - alreadyRestored,
            remaining: remaining.length
          }
        )
      )
    } catch {
      setUndoNotice(t('The remaining references could not be checked. Recheck before undoing.'))
    }
    await loadEntries(true)
    await refreshCandidateInboxCount()
  }

  const restoreDismissedCandidates = async (
    candidateIds: readonly string[] = dismissedCandidateUndo?.candidateIds ?? []
  ): Promise<boolean> => {
    if (candidateIds.length === 0 || isBatching || pendingCandidateId) return false
    setIsBatching(true)
    setError(undefined)
    setUndoNotice(undefined)
    let remaining = [...candidateIds]
    let undoRemaining = [...(dismissedCandidateUndo?.candidateIds ?? [])]
    try {
      if (dismissedCandidateUndo?.needsRecheck) {
        await recheckDismissedCandidates([...new Set([...undoRemaining, ...remaining])])
        return false
      }
      while (remaining.length) {
        const batch = remaining.slice(0, LITERATURE_INBOX_COMMAND_SIZE)
        try {
          await window.api.literature.transact({ kind: 'restore-candidates', candidateIds: batch })
        } catch {
          await recheckDismissedCandidates([...new Set([...undoRemaining, ...remaining])])
          return false
        }
        remaining = remaining.slice(batch.length)
        undoRemaining = undoRemaining.filter((id) => !batch.includes(id))
        setInboxDismissedCount((current) =>
          current === undefined ? current : Math.max(0, current - batch.length)
        )
        setDismissedCandidateUndo(dismissedUndo(undoRemaining))
        for (const id of batch) selectionStore.remove(id)
        setCandidates((current) => current.filter(({ id }) => !batch.includes(id)))
        setInboxPendingCount((current) =>
          current === undefined ? current : current + batch.length
        )
      }
      await loadEntries(true)
      await refreshCandidateInboxCount()
      return true
    } finally {
      setIsBatching(false)
    }
  }

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

  const collectionDeletion = useMemo(() => {
    if (!collectionPendingDelete) return undefined
    const promoted = collections.filter(({ parentId }) => parentId === collectionPendingDelete.id)
    const rootNames = new Set(
      collections.filter(({ parentId }) => !parentId).map(({ name }) => name.toLowerCase())
    )
    return {
      collection: collectionPendingDelete,
      promoted,
      conflicting: promoted.filter(({ name }) => rootNames.has(name.toLowerCase()))
    }
  }, [collectionPendingDelete, collections])
  const dialogCollectionDeletion = useRetainedDialogValue(collectionDeletion)
  const promotedCollections = dialogCollectionDeletion?.promoted ?? []
  const conflictingCollections = dialogCollectionDeletion?.conflicting ?? []

  const deleteCollection = async (): Promise<void> => {
    if (!collectionPendingDelete || isDeletingCollection || collectionDeletion?.conflicting.length)
      return
    const deletingCollection = collectionPendingDelete
    setIsDeletingCollection(true)
    setCollectionDeleteError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'delete-collection',
        collectionId: deletingCollection.id
      })
      setCollections((current) =>
        current.filter((collection) => collection.id !== deletingCollection.id)
      )
      if (collectionId === deletingCollection.id) selectLibrary()
      setCollectionPendingDelete(undefined)
    } catch (error) {
      setCollectionDeleteError(
        error instanceof Error && error.message.includes(LITERATURE_COLLECTION_NAME_CONFLICT)
          ? t(
              'A child collection would duplicate a top-level name. Rename it before deleting this collection.'
            )
          : t('Collection could not be deleted.')
      )
      await loadCollections().catch(() => undefined)
    } finally {
      setIsDeletingCollection(false)
    }
  }

  const selectLibrary = (nextCollectionId?: string): void => {
    setCitationStylesOpen(false)
    setDuplicatesOpen(false)
    setSection('library')
    setSmartFilter('match')
    setSmartDecisionSource('all')

    setCollectionId(nextCollectionId)
    setProjectId(undefined)
    clearSelection()
  }

  const selectProject = (nextProjectId: string): void => {
    setCitationStylesOpen(false)
    setDuplicatesOpen(false)
    setSection('library')
    setCollectionId(undefined)
    setProjectId(nextProjectId)
    clearSelection()
  }

  const selectSection = (nextSection: Exclude<LibrarySection, 'library'>): void => {
    setCitationStylesOpen(false)
    setDuplicatesOpen(false)
    setSection(nextSection)
    setCollectionId(undefined)
    setProjectId(undefined)
    clearSelection()
  }

  const addPdf = async (file: File): Promise<void> => {
    const { item: current, generation } = detailController.getSnapshot()
    if (!current || addingPdfRef.current) return
    addingPdfRef.current = true
    setIsAddingPdf(true)
    setPdfError(undefined)
    const transferId = crypto.randomUUID()
    let staged: Awaited<ReturnType<typeof stageComposerFile>> | undefined
    try {
      staged = await stagePdf(file, transferId)
      await window.api.uploads.claimLocalFile?.({ transferId })
      finishPdfStaging()
      const operationId = crypto.randomUUID()
      pdfNativeImportRef.current = operationId
      const receipt = await window.api.literature.importPdf({
        itemId: current.id,
        attachment: staged,
        operationId
      })
      pdfNativeImportRef.current = undefined
      // An attachment receipt may predate metadata edits in a reopened detail. Re-read rather
      // than using metadataRevision as an attachment version or rolling metadata backwards.
      const updated = await detailController.read(current.id).catch(() => undefined)
      detailController.replace(updated ?? receipt.item)
      await loadEntries(true)
    } catch (error) {
      if (detailController.getSnapshot().generation === generation)
        setPdfError(
          pdfUploadRef.current?.controller.signal.aborted
            ? t('PDF upload cancelled. The reference was kept.')
            : pdfImportErrorMessage(error, t)
        )
    } finally {
      if (staged)
        await window.api.uploads.deleteUpload({ path: staged.path }).catch(() => undefined)
      pdfUploadRef.current = undefined
      pdfNativeImportRef.current = undefined
      setPdfNativeProgress(undefined)
      setPdfUpload(undefined)
      addingPdfRef.current = false
      setIsAddingPdf(false)
    }
  }

  const { isDragging: isDraggingPdf, dropZoneProps: pdfDropZoneProps } = useFileDropZone({
    enabled: !isAddingPdf,
    onFiles: (files) => {
      const unsupported = files.filter(
        (file) => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')
      )
      if (files.length !== 1 || unsupported.length) {
        setPdfError(
          [
            t('Choose one PDF at a time. No files were added.'),
            ...(unsupported.length
              ? [
                  t('Unsupported files: {{names}}', {
                    names: unsupported.map((file) => file.name).join(', ')
                  })
                ]
              : [])
          ].join(' ')
        )
        return
      }
      void addPdf(files[0])
    }
  })

  const setProjectLink = async (targetProjectId: string, included: boolean): Promise<boolean> => {
    const itemId = detailController.getSnapshot().item?.id
    if (!itemId) return false
    const updateProjectLinkState = (nextIncluded: boolean): void => {
      const updateProjects = (item: LiteratureItemView): LiteratureItemView => ({
        ...item,
        projectIds: nextIncluded
          ? [...new Set([...item.projectIds, targetProjectId])]
          : item.projectIds.filter((id) => id !== targetProjectId)
      })
      const detailItem = detailController.getSnapshot().item
      if (detailItem?.id === itemId) detailController.replace(updateProjects(detailItem))
      setItems((current) =>
        current.map((item) => (item.id === itemId ? updateProjects(item) : item))
      )
    }
    setProjectLinkError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'set-project-item',
        projectId: targetProjectId,
        itemId,
        included,
        source: 'library'
      })
      setProjectItemCounts((current) => ({
        ...current,
        [targetProjectId]: Math.max(0, (current[targetProjectId] ?? 0) + (included ? 1 : -1))
      }))
      if (!included && targetProjectId === projectId) {
        closeSelectedItemDetail()
        await loadEntries(true)
      } else {
        updateProjectLinkState(included)
      }
      return true
    } catch {
      setProjectLinkError(t('Project link could not be updated.'))
      return false
    }
  }

  const setCollectionLink = async (
    targetCollectionId: string,
    included: boolean
  ): Promise<boolean> => {
    const itemId = detailController.getSnapshot().item?.id
    if (!itemId) return false
    const updateCollectionLinkState = (nextIncluded: boolean): void => {
      const updateCollections = (item: LiteratureItemView): LiteratureItemView => ({
        ...item,
        collectionIds: nextIncluded
          ? [...new Set([...item.collectionIds, targetCollectionId])]
          : item.collectionIds.filter((id) => id !== targetCollectionId)
      })
      const detailItem = detailController.getSnapshot().item
      if (detailItem?.id === itemId) detailController.replace(updateCollections(detailItem))
      setItems((current) =>
        current.map((item) => (item.id === itemId ? updateCollections(item) : item))
      )
      setCollections((current) =>
        current.map((collection) =>
          collection.id === targetCollectionId
            ? {
                ...collection,
                itemCount: Math.max(0, collection.itemCount + (nextIncluded ? 1 : -1))
              }
            : collection
        )
      )
    }
    setCollectionLinkError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'set-collection-item',
        collectionId: targetCollectionId,
        itemId,
        included
      })
      updateCollectionLinkState(included)
      if (!included && targetCollectionId === collectionId) {
        selectionStore.remove(itemId)
        setItems((current) => current.filter((item) => item.id !== itemId))
        setEntriesTotalCount((current) => Math.max(0, current - 1))
        await loadEntries(true)
      }
      return true
    } catch {
      setCollectionLinkError(t('Collection link could not be updated.'))
      return false
    }
  }

  const persistInlineItem = async (
    entry: LiteratureItemView,
    patch: Partial<Pick<LiteratureItemInput, 'itemType' | 'personalNote' | 'rating'>>,
    onPersisted?: (reload: () => Promise<LiteratureItemView>) => void
  ): Promise<void> => {
    const item = { ...entry.item, ...patch }
    if (
      item.itemType === entry.item.itemType &&
      (item.personalNote ?? '') === (entry.item.personalNote ?? '') &&
      (item.rating ?? 0) === (entry.item.rating ?? 0)
    )
      return
    let persisted = false
    try {
      await window.api.literature.transact({
        kind: 'update-item',
        itemId: entry.id,
        expectedMetadataRevision: entry.metadataRevision,
        item
      })
      persisted = true
      const reload = async (): Promise<LiteratureItemView> => {
        try {
          const updated = await detailController.read(entry.id)
          if (!updated) throw new Error('Literature Item is unavailable after updating.')
          await refreshItems([updated.id], [updated])
          detailController.replace(updated)
          setError(undefined)
          return updated
        } catch (error) {
          setError(t('The reference was saved, but could not be reloaded.'))
          throw error
        }
      }
      onPersisted?.(reload)
      await reload()
    } catch (error) {
      setError(
        persisted
          ? t('The reference was saved, but could not be reloaded.')
          : t('Literature could not be updated.')
      )
      throw error
    }
  }

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

  const createManualItem = async (item?: LiteratureItemInput): Promise<void> => {
    if (creatingItemRef.current || (!pendingCreationRef.current && !item)) return
    creatingItemRef.current = true
    setIsSavingNewItem(true)
    setCreateItemError(undefined)
    const transferId = crypto.randomUUID()
    let staged: Awaited<ReturnType<typeof stageComposerFile>> | undefined
    try {
      if (!pendingCreationRef.current) {
        const receipt = await window.api.literature.transact({
          kind: 'create-item',
          item: item!,
          ...(duplicatePolicy === 'reuse' ? {} : { duplicatePolicy })
        })
        // This receipt belongs to this dialog's creation intent, including its original destination.
        pendingCreationRef.current = {
          id: receipt.id,
          projectId,
          collectionId,
          file: pendingImportPdf,
          destination: projectId
            ? {
                kind: 'set-project-item',
                projectId,
                itemId: receipt.id,
                included: true,
                source: 'library'
              }
            : collectionId && !selectedCollection?.smart
              ? { kind: 'set-collection-item', collectionId, itemId: receipt.id, included: true }
              : undefined
        }
        setCreatedItemId(receipt.id)
      }
      const pending = pendingCreationRef.current
      if (pending.destination) {
        await window.api.literature.transact(pending.destination)
        pending.destination = undefined
      }
      if (pending.file && !pending.pdfItem) {
        staged = await stagePdf(pending.file, transferId)
        await window.api.uploads.claimLocalFile?.({ transferId })
        finishPdfStaging()
        const operationId = crypto.randomUUID()
        pdfNativeImportRef.current = operationId
        pending.pdfItem = (
          await window.api.literature.importPdf({
            itemId: pending.id,
            attachment: staged,
            operationId
          })
        ).item
        pdfNativeImportRef.current = undefined
      }
      const created = pending.pdfItem ?? (await detailController.read(pending.id))
      if (!created) throw new Error('Literature Item is unavailable after creating.')
      setItems((entries) =>
        entries.some((entry) => entry.id === created.id)
          ? entries.map((entry) => (entry.id === created.id ? created : entry))
          : [created, ...entries]
      )
      if (pending.collectionId) await loadCollections()
      if (pending.projectId) await loadProjectCounts()
      resetItemEditor()
      openSelectedItemDetail(created)
    } catch (error) {
      const pending = pendingCreationRef.current
      // Retain the existing PDF-error detail recovery only once destination linking has completed.
      const created =
        pending?.file && !pending.destination && !pending.pdfItem
          ? await detailController.read(pending.id).catch(() => undefined)
          : undefined
      if (created) {
        resetItemEditor()
        openSelectedItemDetail(created)
        setPdfError(
          pdfUploadRef.current?.controller.signal.aborted
            ? t('PDF upload cancelled. The reference was kept.')
            : pdfImportErrorMessage(error, t)
        )
      } else {
        setCreateItemError(
          pending
            ? pending.destination
              ? t(
                  'The reference was created, but linking it to the destination failed. Retry to finish linking. Closing leaves it in your library without that link.'
                )
              : t(
                  'The reference was created, but the remaining steps failed. Retry to finish. If you close, the reference remains in your library.'
                )
            : t('Literature could not be created.')
        )
      }
    } finally {
      if (staged)
        await window.api.uploads.deleteUpload({ path: staged.path }).catch(() => undefined)
      void loadEntries(true)
      pdfUploadRef.current = undefined
      pdfNativeImportRef.current = undefined
      setPdfNativeProgress(undefined)
      setPdfUpload(undefined)
      creatingItemRef.current = false
      setIsSavingNewItem(false)
    }
  }

  const beginPdfImport = (file: File): void => {
    setDuplicatePolicy('reuse')
    const fallback = { ...emptyLiteratureItem(), title: titleFromPdfFilename(file.name) }
    const generation = ++importMetadataGenerationRef.current
    setPendingImportPdf(file)
    setPendingImportDraft(fallback)
    setPendingImportMetadataNotice(undefined)
    setCreateItemError(undefined)
    setIsReadingImportMetadata(true)
    setIsCreatingItem(true)
    void import('./literature-pdf-metadata')
      .then(
        async ({
          extractLiteraturePdfDraft,
          completeLiteraturePdfDraft,
          pdfMetadataNoticeLabel
        }) => {
          const notice = (value: Parameters<typeof pdfMetadataNoticeLabel>[0]): void => {
            if (importMetadataGenerationRef.current === generation)
              setPendingImportMetadataNotice(pdfMetadataNoticeLabel(value, t))
          }
          const local = await extractLiteraturePdfDraft(file, fallback, notice)
          if (importMetadataGenerationRef.current !== generation) return local
          return completeLiteraturePdfDraft(local, notice)
        }
      )
      .then((draft) => {
        if (importMetadataGenerationRef.current === generation) setPendingImportDraft(draft)
      })
      .catch(() => {
        if (importMetadataGenerationRef.current === generation)
          setPendingImportMetadataNotice(
            t(
              'PDF text could not be read. For scanned pages, use a searchable PDF. Review the metadata before importing.'
            )
          )
      })
      .finally(() => {
        if (importMetadataGenerationRef.current === generation) setIsReadingImportMetadata(false)
      })
  }

  const resetItemEditor = (): void => {
    pendingCreationRef.current = undefined
    setCreatedItemId(undefined)
    setDuplicatePolicy('reuse')
    importMetadataGenerationRef.current += 1
    setIsCreatingItem(false)
    setPendingImportPdf(undefined)
    setPendingImportDraft(undefined)
    setIsReadingImportMetadata(false)
    setCreateItemError(undefined)
  }

  const closeItemEditor = (): void => {
    if (creatingItemRef.current) return
    requestMetadataExit(newMetadataDirtyRef.current && !createdItemId, resetItemEditor)
  }

  const previewRecordImport = async (file: File): Promise<void> => {
    setDuplicatePolicy('reuse')
    const request = ++recordImportRequest.current
    const destination = {
      name: selectedProject?.name ?? selectedCollection?.name ?? t('All references'),
      projectId,
      collectionId
    }
    setRecordImport({ fileName: file.name, content: '', reading: true, destination })
    if (file.size > LITERATURE_RECORD_IMPORT_MAX_BYTES) {
      setRecordImport({
        destination,
        fileName: file.name,
        content: '',
        error: t('{{fileName}}: file is too large (limit {{limit}}).', {
          fileName: file.name,
          limit: formatUploadSizeLimit(LITERATURE_RECORD_IMPORT_MAX_BYTES)
        })
      })
      return
    }
    try {
      const content = await file.text()
      if (request !== recordImportRequest.current) return
      setRecordImport({ fileName: file.name, content, destination })
      const preview = await window.api.literature.importRecords({ mode: 'preview', content })
      if (request !== recordImportRequest.current) return
      setRecordImport({ fileName: file.name, content, preview, destination })
    } catch {
      if (request !== recordImportRequest.current) return
      setRecordImport({
        destination,
        fileName: file.name,
        content: '',
        error: t('Reference file could not be read.')
      })
    }
  }

  const commitRecordImport = async (): Promise<void> => {
    if (!recordImport?.preview || recordImport.preview.items.length === 0) return
    const { projectId, collectionId } = recordImport.destination
    setIsImportingRecords(true)
    setRecordImport((current) =>
      current ? { ...current, error: undefined, failedCount: undefined } : current
    )
    try {
      const imported = await window.api.literature.importRecords({
        mode: 'commit',
        content: recordImport.content,
        ...(duplicatePolicy === 'reuse' ? {} : { duplicatePolicy }),
        ...(collectionId ? { collectionId } : {})
      })
      setRecordImport((current) => (current ? { ...current, preview: imported } : current))
      if (projectId && imported.imported?.itemIds.length) {
        for (
          let offset = 0;
          offset < imported.imported.itemIds.length;
          offset += LITERATURE_BATCH_COMMAND_SIZE
        ) {
          await window.api.literature.transact({
            kind: 'set-project-items',
            projectId,
            itemIds: imported.imported.itemIds.slice(
              offset,
              offset + LITERATURE_BATCH_COMMAND_SIZE
            ),
            included: true,
            source: 'library'
          })
        }
      }
      await Promise.all([
        loadEntries(true),
        loadCollections(),
        ...(projectId ? [loadProjectCounts()] : [])
      ])
    } catch (error) {
      if (error instanceof Error && error.message.includes(LITERATURE_IMPORT_IDENTITY_CONFLICT)) {
        const preview = await window.api.literature
          .importRecords({ mode: 'preview', content: recordImport.content })
          .catch(() => undefined)
        setRecordImport((current) =>
          current
            ? {
                ...current,
                ...(preview ? { preview } : {}),
                error: t(
                  'Some identifiers disagree or match different references. Correct the source file or keep separate copies of every reference in this import.'
                )
              }
            : current
        )
        return
      }
      setRecordImport((current) =>
        current
          ? {
              ...current,
              error: current.preview?.imported
                ? t(
                    'References were saved, but the destination could not be updated. You can find them in All references.'
                  )
                : t('Reference import failed. Please try again.'),
              failedCount: current.preview?.imported ? 0 : (current.preview?.items.length ?? 0)
            }
          : current
      )
    } finally {
      setIsImportingRecords(false)
    }
  }

  const resolveSelectedItemIds = async (): Promise<string[]> => {
    const { allMatchingSelected, excludedMatchingIds, selectedIds } = selectionStore.getSnapshot()
    if (!allMatchingSelected) return [...selectedIds]
    const page = await window.api.literature.search({ ...buildEntriesRequest(0), allItemIds: true })
    if (!page.itemIds) throw new Error('Literature membership is unavailable.')
    return page.itemIds.filter((id) => !excludedMatchingIds.has(id))
  }

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

  const updateSmartEvidence = async (): Promise<void> => {
    if (
      !selectedCollection?.smart ||
      isBatching ||
      pendingDecisionsRef.current.size > 0 ||
      smartRunningCollection === selectedCollection.id
    )
      return
    setIsBatching(true)
    smartState.beginWrite()
    try {
      const receipt = await window.api.literature.transact({
        kind: 'smart-collection',
        collectionId: selectedCollection.id,
        action: 'refresh',
        offset: 0
      })
      smartState.finishWrite(receipt.smart)
    } catch {
      setError(t('Collection could not be updated.'))
    } finally {
      smartState.finishWrite()
      setIsBatching(false)
    }
  }

  const confirmSmartDecision = async (
    decision: 'include' | 'exclude' | 'automatic',
    itemIds?: string[],
    singleRecord = false
  ): Promise<void> => {
    if (
      !selectedCollection?.smart ||
      isBatching ||
      smartRunningCollection === selectedCollection.id
    )
      return
    const targetCollectionId = selectedCollection.id
    if (singleRecord && itemIds?.length === 1) {
      const itemId = itemIds[0]
      const operationKey = `${targetCollectionId}:${itemId}`
      if (pendingDecisionsRef.current.has(operationKey)) return
      pendingDecisionsRef.current.add(operationKey)
      setPendingDecisions(new Set(pendingDecisionsRef.current))
      const submit = async (): Promise<void> => {
        let saved = false
        const owner =
          currentSmartState.current.collectionId === targetCollectionId
            ? currentSmartState.current
            : smartState
        owner.beginWrite()
        collectionsGenerationRef.current++
        if (currentCollectionId.current === targetCollectionId) setError(undefined)
        setDecisionFailures((current) => current.filter((failure) => failure.key !== operationKey))
        try {
          const receipt = await window.api.literature.transact({
            kind: 'smart-collection',
            collectionId: targetCollectionId,
            action: 'override',
            itemId,
            decision,
            offset: 0
          })
          saved = true
          collectionsGenerationRef.current++
          consumePendingCollectionChange(targetCollectionId)
          owner.finishWrite(receipt.smart)
          if (
            currentSmartState.current.collectionId === targetCollectionId &&
            currentSmartState.current !== owner
          )
            currentSmartState.current.finishWrite(receipt.smart)
          if (receipt.smart) {
            const view = receipt.smart
            setCollections((current) =>
              current.map((collection) =>
                collection.id === targetCollectionId
                  ? { ...collection, itemCount: view.counts.match }
                  : collection
              )
            )
            if (currentCollectionId.current === targetCollectionId) {
              const detail = detailController.getSnapshot().item
              const row = view.rows.find((row) => row.id === itemId)
              if (detail?.id === itemId && row)
                detailController.replace({ ...detail, smartDecision: row })
            }
          }
          if (receipt.smartRefreshFailed) setSmartRefreshFailure(targetCollectionId)
          if (currentCollectionId.current !== targetCollectionId) return
          const refreshed = await currentEntriesReload.current(true, true)
          setSmartRefreshFailure(
            receipt.smartRefreshFailed || refreshed === false ? targetCollectionId : undefined
          )
        } catch {
          if (saved) setSmartRefreshFailure(targetCollectionId)
          else
            setDecisionFailures((current) => [
              ...current.filter((failure) => failure.key !== operationKey),
              {
                key: operationKey,
                collection: selectedCollection.name,
                retry: () => {
                  void confirmSmartDecision(decision, [itemId], true)
                }
              }
            ])
        } finally {
          owner.finishWrite()
          collectionsGenerationRef.current++
        }
      }
      const queued = decisionQueue.current.then(submit)
      decisionQueue.current = queued.catch(() => undefined)
      try {
        await queued
      } finally {
        pendingDecisionsRef.current.delete(operationKey)
        setPendingDecisions(new Set(pendingDecisionsRef.current))
      }
      return
    }
    if (pendingDecisionsRef.current.size) return
    setIsBatching(true)
    setError(undefined)
    try {
      const ids = itemIds ?? (await resolveSelectedItemIds())
      if (currentCollectionId.current !== targetCollectionId) return
      smartState.beginWrite()
      const { done, failed, remaining } = await smartDecisionBatch.run(
        targetCollectionId,
        ids,
        decision
      )
      setSmartBatchResult(
        failed.length > 0 || remaining.length > 0
          ? {
              collectionId: targetCollectionId,
              done,
              failed,
              remaining,
              decision
            }
          : undefined
      )
      if (currentCollectionId.current === targetCollectionId) {
        selectionStore.replace([...failed, ...remaining])
        consumePendingCollectionChange(targetCollectionId)
        smartState.finishWrite()
        await Promise.all([loadEntries(true, true), loadCollections(), refreshSmartSummary()])
      }
    } catch {
      setError(t('Collection could not be updated.'))
    } finally {
      smartState.finishWrite()
      setIsBatching(false)
    }
  }

  const prepareSmartReevaluation = async (ids?: string[], detailItemId?: string): Promise<void> => {
    if (
      !selectedCollection?.smart ||
      isBatching ||
      pendingDecisionsRef.current.size > 0 ||
      smartRunningCollection === selectedCollection.id
    )
      return
    setIsBatching(true)
    let request: typeof smartReevaluation
    try {
      setSmartBatchResult(undefined)
      const detail = detailController.getSnapshot()
      request = {
        collectionId: selectedCollection.id,
        ids: ids ?? (await resolveSelectedItemIds()),
        detailItemId:
          detailItemId ??
          (detail.open && ids?.length === 1 && ids[0] === detail.item?.id
            ? detail.item.id
            : undefined)
      }
    } catch {
      setError(t('Literature could not be loaded.'))
    } finally {
      setIsBatching(false)
    }
    if (!request || currentCollectionId.current !== request.collectionId) return
    if (request.ids.length === 1 || !shouldConfirmSmartReevaluation()) {
      void runSmartReevaluation(request)
    } else {
      setSmartReevaluationRemember(false)
      setSmartReevaluation(request)
    }
  }
  const runSmartReevaluation = async (request = smartReevaluation): Promise<void> => {
    if (
      !request ||
      currentCollectionId.current !== request.collectionId ||
      (isBatching && request === smartReevaluation)
    )
      return
    setIsBatching(true)
    smartState.beginWrite()
    const single =
      request.ids.length === 1
        ? {
            collectionId: request.collectionId,
            itemId: request.ids[0],
            previousRunId: smartView?.run?.id
          }
        : undefined
    setCompletedReevaluation(undefined)
    singleReevaluationRef.current = single
    setSingleReevaluation(single)
    receiveSmartView(smartView, true)
    try {
      const receipt = await window.api.literature.transact({
        kind: 'smart-collection',
        collectionId: request.collectionId,
        action: 'recompute',
        itemIds: request.ids,
        offset: 0
      })
      smartState.finishWrite(receipt.smart)
      if (receipt.smart?.run?.state !== 'running' && receipt.smart?.run?.state !== 'queued')
        receiveSmartView(receipt.smart, false)
      setSmartReevaluation(undefined)
      if (
        currentCollectionId.current === request.collectionId &&
        !request.detailItemId &&
        request.ids.length > 1
      )
        clearSelection()
    } catch {
      receiveSmartView(smartView, false)
      setError(t('Collection could not be updated.'))
    } finally {
      smartState.finishWrite()
      setIsBatching(false)
    }
  }

  const previewRestoreSelection = async (): Promise<void> => {
    if (isBatching) return
    const scopeKey = entriesKey
    setIsBatching(true)
    setError(undefined)
    try {
      const selectedIds = new Set(await resolveSelectedItemIds())
      const restorable = new Set<string>()
      const skipped = new Set<string>()
      const seenOffsets = new Set<number>()
      let offset = 0
      for (;;) {
        if (seenOffsets.has(offset)) throw new Error('Repeated Literature page.')
        seenOffsets.add(offset)
        const page = await readLiteratureSelectionPage({
          ...buildEntriesRequest(offset),
          limit: 100
        })
        if (linkScopeRef.current !== scopeKey) return
        for (const entry of page.entries.filter(isItem)) {
          if (!selectedIds.has(entry.id)) continue
          if (entry.mergedIntoItemId) skipped.add(entry.id)
          else restorable.add(entry.id)
        }
        if (page.nextOffset === undefined) break
        offset = page.nextOffset
      }
      if (restorable.size + skipped.size !== selectedIds.size)
        throw new Error('Selected Literature membership changed.')
      setRestorePreview({ itemIds: [...restorable], skipped: skipped.size })
    } catch {
      if (linkScopeRef.current === scopeKey) setError(t('Selected references could not be loaded.'))
    } finally {
      setIsBatching(false)
    }
  }

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

  const setItemsLifecycle = async (
    itemIds: readonly string[] | undefined,
    state: 'active' | 'deleted'
  ): Promise<void> => {
    const { allMatchingSelected } = selectionStore.getSnapshot()
    if ((!allMatchingSelected && (itemIds?.length ?? 0) === 0) || isBatching) return
    setIsBatching(true)
    setError(undefined)
    setLifecycleFailure(undefined)
    let resolvedIds: readonly string[] = []
    let completed = 0
    try {
      resolvedIds = itemIds ?? (await resolveSelectedItemIds())
      for (let offset = 0; offset < resolvedIds.length; offset += LITERATURE_BATCH_COMMAND_SIZE) {
        const batch = resolvedIds.slice(offset, offset + LITERATURE_BATCH_COMMAND_SIZE)
        await window.api.literature.transact({ kind: 'set-item-lifecycle', itemIds: batch, state })
        completed += batch.length
      }
      clearSelection()
    } catch {
      if (resolvedIds.length) {
        const remaining = resolvedIds.slice(completed)
        selectionStore.replace(remaining)
        setLifecycleFailure({ itemIds: remaining, state, completed })
      } else {
        setError(t('Literature could not be updated.'))
      }
    } finally {
      if (resolvedIds.length) {
        // Refresh even after a failed command: earlier batches may already be committed.
        const refreshed = await Promise.allSettled([
          loadEntries(true),
          loadCollections(),
          loadProjectCounts()
        ])
        if (refreshed.some((result) => result.status === 'rejected')) {
          setError(t('Literature could not be loaded.'))
        }
      }
      setIsBatching(false)
    }
  }

  const runLifecycleAction = async (state: 'active' | 'deleted'): Promise<void> => {
    const { allMatchingSelected, selectedIds } = selectionStore.getSnapshot()
    return setItemsLifecycle(allMatchingSelected ? undefined : [...selectedIds], state)
  }

  const requestPermanentDeletion = (itemIds: string[]): void => {
    setPermanentDeleteFailed(false)
    setPermanentDeletionDiagnostic(undefined)
    setPermanentDeleteIds(itemIds)
  }

  const refreshAfterPermanentDeletion = async (): Promise<void> => {
    setIsBatching(true)
    try {
      const refreshed = await Promise.allSettled([
        loadEntries(true),
        loadCollections(),
        loadProjectCounts(),
        loadTags()
      ])
      setPermanentDeleteResult(
        (current) =>
          current && {
            ...current,
            refreshFailed:
              refreshed.some((result) => result.status === 'rejected') ||
              useTagStore.getState().status === 'error'
          }
      )
    } finally {
      setIsBatching(false)
    }
  }

  const deleteItemsPermanently = async (): Promise<void> => {
    if (permanentDeleteIds.length === 0 || isBatching || permanentDeleteFailed) return
    setIsBatching(true)
    setError(undefined)
    setPermanentDeleteResult(undefined)
    let receipt: LiteratureCatalogReceipt
    try {
      receipt = await window.api.literature.transact({
        kind: 'delete-items-permanently',
        itemIds: permanentDeleteIds
      })
    } catch (error) {
      setPermanentDeletionDiagnostic(parseLiteratureDeletionError(error))
      setPermanentDeleteFailed(true)
      setIsBatching(false)
      return
    }
    clearSelection()
    setPermanentDeleteIds([])
    setPermanentDeleteResult({
      scope: permanentDeleteScope,
      cleanupPending: receipt.cleanupPending === true,
      refreshFailed: false
    })
    await refreshAfterPermanentDeletion()
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

  const requestReadWithAgent = useCallback(
    (item: PreviewFileItem): void => {
      setReadingSelectionEntries(undefined)
      const source = resolvePdfContextTarget(item)
      if (!source) return
      setPreviewItem(undefined)
      setReadingProjectError(undefined)
      const reading = [{ item, source }]
      if (selectedProject?.id) {
        void startReadingInProject(selectedProject.id, reading)
        return
      }
      setReadingProjectQuery('')
      setPendingLiteratureReading(reading)
    },
    [selectedProject?.id, startReadingInProject]
  )

  const readingProjectFormDialog = useProjectFormDialog({
    onCreated: (project) => void startReadingInProject(project.id)
  })

  const requestReadSelection = async (): Promise<void> => {
    if (batchReading || isBatching) return
    const request = ++batchReadingRequest.current
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
          if (request !== batchReadingRequest.current) return
          entries.push(
            ...page.entries
              .filter(isItem)
              .filter(({ id }) => !selection.excludedMatchingIds.has(id))
          )
          if (page.nextOffset === undefined) break
          offset = page.nextOffset
        }
      }
      if (request === batchReadingRequest.current) {
        setBatchReading({ entries })
        setReadingSelectionEntries(entries)
      }
    } catch {
      if (request === batchReadingRequest.current)
        setBatchReading({ error: t('Selected references could not be loaded.') })
    }
  }

  const runLinkBatch = async (
    command: NonNullable<typeof linkFailure>['command'],
    itemIds?: readonly string[],
    previousCompleted = 0,
    previousSkipped = 0,
    reconcile = false
  ): Promise<void> => {
    const scopeKey = entriesKey
    setIsBatching(true)
    setError(undefined)
    setLinkFailure(undefined)
    let resolvedIds: readonly string[] = itemIds ?? []
    let completed = 0
    let skipped = previousSkipped
    try {
      resolvedIds = itemIds ?? (await resolveSelectedItemIds())
      if (reconcile) {
        const activeIds: string[] = []
        for (let offset = 0; offset < resolvedIds.length; offset += LITERATURE_BATCH_COMMAND_SIZE) {
          const batch = resolvedIds.slice(offset, offset + LITERATURE_BATCH_COMMAND_SIZE)
          const entries = await Promise.all(batch.map((id) => detailController.read(id)))
          entries.forEach((entry, index) => {
            // get resolves merged aliases; never redirect the original association intent.
            if (
              entry?.id === batch[index] &&
              entry.deletedAt === undefined &&
              entry.mergedIntoItemId === undefined
            )
              activeIds.push(batch[index])
          })
        }
        skipped += resolvedIds.length - activeIds.length
        resolvedIds = activeIds
      }
      for (let offset = 0; offset < resolvedIds.length; offset += LITERATURE_BATCH_COMMAND_SIZE) {
        const batch = resolvedIds.slice(offset, offset + LITERATURE_BATCH_COMMAND_SIZE)
        await window.api.literature.transact({ ...command, itemIds: [...batch] })
        completed += batch.length
      }
      if (linkScopeRef.current === scopeKey) {
        clearSelection()
        if (skipped)
          setLinkFailure({
            command,
            itemIds: [],
            completed: previousCompleted + completed,
            scopeKey,
            skipped
          })
      }
    } catch {
      if (linkScopeRef.current === scopeKey) {
        if (resolvedIds.length) {
          const remaining = resolvedIds.slice(completed)
          selectionStore.replace(remaining)
          setLinkFailure({
            command,
            itemIds: remaining,
            completed: previousCompleted + completed,
            skipped,
            scopeKey
          })
        } else {
          setError(t('Selected references could not be loaded.'))
        }
      }
    } finally {
      const refreshed = await Promise.allSettled([
        ...(linkScopeRef.current === scopeKey ? [loadEntries(true)] : []),
        loadCollections(),
        loadProjectCounts()
      ])
      if (
        linkScopeRef.current === scopeKey &&
        refreshed.some((result) => result.status === 'rejected')
      ) {
        setError(t('Literature could not be loaded.'))
      }
      setIsBatching(false)
    }
  }

  const moveSelectedItems = async (targetCollectionId: string): Promise<void> => {
    if (!targetCollectionId || isBatching) return
    await runLinkBatch({
      kind: 'move-collection-items',
      targetCollectionId,
      ...(collectionId ? { sourceCollectionId: collectionId } : {})
    })
  }

  const createCollectionForSelection = async (name: string): Promise<boolean> => {
    const selection = selectionStore.getSnapshot()
    if (!name || (!selection.allMatchingSelected && selection.selectedIds.size === 0) || isBatching)
      return false
    setIsBatching(true)
    setError(undefined)
    const scopeKey = entriesKey
    try {
      // Resolve before creating so every continuation has a fixed reference set.
      const itemIds = await resolveSelectedItemIds()
      if (linkScopeRef.current !== scopeKey) return false
      const receipt = await window.api.literature.transact({ kind: 'create-collection', name })
      void loadCollections().catch(() => undefined)
      await runLinkBatch(
        {
          kind: 'move-collection-items',
          targetCollectionId: receipt.id,
          ...(collectionId ? { sourceCollectionId: collectionId } : {})
        },
        itemIds
      )
      // Creation succeeded even if association needs Retry; retire the creation form.
      return true
    } catch (error) {
      if (linkScopeRef.current === scopeKey)
        setError(
          error instanceof Error && error.message.includes(LITERATURE_COLLECTION_NAME_CONFLICT)
            ? t('A collection with this name already exists at this level. Choose another name.')
            : t('Collection could not be created.')
        )
      return false
    } finally {
      setIsBatching(false)
    }
  }

  const addSelectedItemsToProject = async (projectId: string): Promise<void> => {
    if (!projectId || isBatching) return
    await runLinkBatch({ kind: 'set-project-items', projectId, included: true, source: 'library' })
  }

  const batchProjectFormDialog = useProjectFormDialog({
    onCreated: (project) => void addSelectedItemsToProject(project.id)
  })

  const exportInFlightRef = useRef(false)

  const exportReferenceIds = async (
    itemIds: readonly string[],
    format: 'bibtex' | 'ris',
    filenameStem: string
  ): Promise<boolean> => {
    if (itemIds.length === 0 || exportInFlightRef.current) return false
    exportInFlightRef.current = true
    setError(undefined)
    try {
      const chunks: string[] = []
      const citationKeys = new Set<string>()
      for (let offset = 0; offset < itemIds.length; offset += LITERATURE_BATCH_COMMAND_SIZE) {
        const result = await window.api.literature.formatReferences({
          itemIds: itemIds.slice(offset, offset + LITERATURE_BATCH_COMMAND_SIZE),
          styleId: citationStyleRef.current,
          locale: citationLocale
        })
        if (format === 'bibtex') {
          // These headers come from our BibTeX exporter, whose keys are validated before emission.
          for (const match of result.exports.bibtex.matchAll(/^@[a-z]+\{([^,\r\n]+),/gimu)) {
            const key = match[1]!
            if (citationKeys.has(key))
              throw new Error('Selected Literature Items have duplicate citation keys.')
            citationKeys.add(key)
          }
        }
        chunks.push(result.exports[format].trim())
      }
      const content = `${chunks.filter(Boolean).join('\n\n')}\n`
      const encoded = new TextEncoder().encode(content)
      const safeStem =
        filenameStem
          .normalize('NFKC')
          .trim()
          .replace(/[/:*?"<>|\\]/gu, '-')
          .replace(/\s+/gu, ' ')
          .slice(0, 80) || 'references'
      const result = await window.api.saveBlobFile({
        suggestedName: `${safeStem}.${format === 'bibtex' ? 'bib' : 'ris'}`,
        mimeType:
          format === 'bibtex'
            ? 'application/x-bibtex;charset=utf-8'
            : 'application/x-research-info-systems;charset=utf-8',
        data: encoded.buffer
      })
      return result.saved
    } catch (exportError) {
      setError(t('References could not be exported.'))
      throw exportError
    } finally {
      exportInFlightRef.current = false
    }
  }

  const exportSelectedItems = async (format: 'bibtex' | 'ris'): Promise<boolean> =>
    exportReferenceIds(await resolveSelectedItemIds(), format, 'selected-references')

  const exportCurrentScope = async (format: 'bibtex' | 'ris'): Promise<boolean> => {
    if (!selectedProject && !selectedCollection) return false
    try {
      const page = await window.api.literature.search({
        scope: 'library',
        ...(selectedProject ? { projectId: selectedProject.id } : {}),
        ...(selectedCollection ? { collectionId: selectedCollection.id } : {}),
        lifecycle: 'active',
        sortBy: 'title',
        sortDirection: 'asc',
        allItemIds: true
      })
      if (!page.itemIds) throw new Error('Literature membership is unavailable.')
      return await exportReferenceIds(
        page.itemIds,
        format,
        `${selectedProject?.name ?? selectedCollection?.name ?? 'references'}-references`
      )
    } catch (error) {
      setError(t('References could not be exported.'))
      throw error
    }
  }

  const mergeSelectedItems = async (): Promise<void> => {
    const survivor = selectedItems.find((item) => item.id === mergeSurvivorId)
    if (!survivor || selectedItems.length < 2 || isBatching) return
    const duplicates = selectedItems.filter((item) => item.id !== survivor.id)
    const merged = buildLiteratureMergeItem(selectedItems, survivor.id, mergeFieldSources)
    setIsBatching(true)
    setMergeError(undefined)
    setError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'merge-items',
        survivorId: survivor.id,
        duplicateIds: duplicates.map((item) => item.id),
        expectedItems: selectedItems.map(({ id, metadataRevision, updatedAt }) => ({
          id,
          metadataRevision,
          updatedAt
        })),
        expectedMetadataRevision: survivor.metadataRevision,
        item: merged
      })
      setMergeOpen(false)
      setDuplicateMergeItems(undefined)
      setDuplicatesRevision((value) => value + 1)
      clearSelection()
      await Promise.all([loadEntries(true), loadCollections(), loadProjectCounts()])
    } catch (error) {
      setMergeError(
        error instanceof Error && error.message.includes('changed after review')
          ? t(
              'References changed after review. Reopen the merge dialog to compare the latest metadata.'
            )
          : t('Literature could not be merged.')
      )
    } finally {
      setIsBatching(false)
    }
  }

  const entriesPagination =
    entriesTotalCount > 0 ? (
      <fieldset
        disabled={smartTableBlocked}
        className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border-300/80 bg-bg-000 px-3 py-2"
      >
        <p className="text-xs text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">
            {entriesRangeStart}–{entriesRangeEnd}
          </span>{' '}
          ·{' '}
          {t('{{count}} references', {
            count: entriesTotalCount,
            defaultValue_one: '{{count}} reference'
          })}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="whitespace-nowrap">{t('References per page')}</span>
            <Select
              value={String(entriesPageSize)}
              onValueChange={(value) => {
                const pageSize = Number(value) as LiteraturePageSize
                if (!LITERATURE_PAGE_SIZES.includes(pageSize)) return
                clearSelection()
                setEntriesOffset(0)
                setEntriesPageSize(pageSize)
              }}
            >
              <SelectTrigger
                aria-label={t('References per page')}
                className="h-7 w-16 bg-bg-000 text-xs tabular-nums"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {LITERATURE_PAGE_SIZES.map((pageSize) => (
                  <SelectItem key={pageSize} value={String(pageSize)}>
                    {pageSize}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {entriesPageCount > 1 ? (
            <nav
              aria-label={t('Page {{page}}', { page: entriesPage })}
              className="flex items-center gap-1"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Previous page')}
                disabled={entriesPage <= 1 || entriesLoading}
                onClick={() => {
                  clearSelection()
                  setEntriesOffset((entriesPage - 2) * entriesPageSize)
                }}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              {entriesPaginationItems.map((item, index) =>
                item === 'ellipsis' ? (
                  <span
                    key={`ellipsis-${index}`}
                    aria-hidden="true"
                    className="grid size-7 place-items-center text-xs text-muted-foreground"
                  >
                    …
                  </span>
                ) : (
                  <Button
                    key={item}
                    type="button"
                    variant={item === entriesPage ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    aria-label={t('Page {{page}}', { page: item })}
                    aria-current={item === entriesPage ? 'page' : undefined}
                    disabled={entriesLoading}
                    className="tabular-nums"
                    onClick={() => {
                      clearSelection()
                      setEntriesOffset((item - 1) * entriesPageSize)
                    }}
                  >
                    {item}
                  </Button>
                )
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Next page')}
                disabled={entriesPage >= entriesPageCount || entriesLoading}
                onClick={() => {
                  clearSelection()
                  setEntriesOffset(entriesPage * entriesPageSize)
                }}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </nav>
          ) : null}
        </div>
      </fieldset>
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
        <LiteratureSidebarState>
          {(sidebarCollapsed, toggleSidebar) => {
            const navButtonClassName = cn(
              'relative flex h-9 w-full items-center rounded-lg text-sm hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
              sidebarCollapsed ? 'justify-center px-0' : 'gap-2 px-3'
            )
            return (
              <aside
                className={cn(
                  'flex shrink-0 flex-col border-r border-border-300/80 bg-bg-000 py-3',
                  sidebarCollapsed ? 'w-14 px-2' : 'w-60 px-3'
                )}
              >
                <div
                  className={cn(
                    'mb-3 flex min-h-10 items-center',
                    sidebarCollapsed ? 'justify-center' : 'gap-2 px-1'
                  )}
                >
                  {!sidebarCollapsed ? (
                    <>
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-bg-200 text-primary">
                        <BookOpenText className="size-4" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h1 className="truncate text-sm font-semibold">
                          {t('Literature library')}
                        </h1>
                        <p className="truncate text-xs text-muted-foreground">
                          {t('Your research references')}
                        </p>
                      </div>
                    </>
                  ) : null}
                  <LiteratureSidebarHint
                    label={
                      sidebarCollapsed ? t('Expand sidebar panel') : t('Collapse sidebar panel')
                    }
                    collapsed
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className={cn('shrink-0', !sidebarCollapsed && 'ml-auto')}
                      aria-label={
                        sidebarCollapsed ? t('Expand sidebar panel') : t('Collapse sidebar panel')
                      }
                      aria-expanded={!sidebarCollapsed}
                      aria-controls="literature-sidebar-navigation"
                      aria-keyshortcuts={window.api?.platform === 'darwin' ? 'Meta+B' : 'Control+B'}
                      onClick={toggleSidebar}
                    >
                      <PanelLeft className="size-4" aria-hidden="true" />
                    </Button>
                  </LiteratureSidebarHint>
                </div>
                <div className="mb-3 border-b border-border-300/80 pb-3">
                  <LiteratureSidebarHint label={returnLabel} collapsed={sidebarCollapsed}>
                    <button
                      type="button"
                      className={navButtonClassName}
                      aria-label={returnLabel}
                      onClick={() => returnFromLibrary('user')}
                    >
                      <ArrowLeft className="size-4" aria-hidden="true" />
                      {!sidebarCollapsed ? <span>{returnLabel}</span> : null}
                    </button>
                  </LiteratureSidebarHint>
                </div>
                <nav
                  id="literature-sidebar-navigation"
                  className="space-y-1"
                  aria-label={t('Literature library')}
                >
                  <LiteratureSidebarHint label={t('Inbox')} collapsed={sidebarCollapsed}>
                    <button
                      type="button"
                      className={cn(
                        navButtonClassName,
                        !duplicatesOpen && section === 'inbox' && 'bg-bg-300 font-medium'
                      )}
                      aria-current={
                        !citationStylesOpen && !duplicatesOpen && section === 'inbox'
                          ? 'page'
                          : undefined
                      }
                      aria-label={t('Inbox')}
                      onClick={() => selectSection('inbox')}
                    >
                      <Inbox className="size-4" aria-hidden="true" />
                      {!sidebarCollapsed ? <span>{t('Inbox')}</span> : null}
                      {!sidebarCollapsed &&
                      inboxPendingCount !== undefined &&
                      inboxPendingCount > 0 ? (
                        <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          {inboxPendingCount}
                        </span>
                      ) : null}
                      {sidebarCollapsed &&
                      inboxPendingCount !== undefined &&
                      inboxPendingCount > 0 ? (
                        <span
                          className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary"
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  </LiteratureSidebarHint>
                  <LiteratureSidebarHint label={t('All references')} collapsed={sidebarCollapsed}>
                    <button
                      type="button"
                      className={cn(
                        navButtonClassName,
                        !duplicatesOpen &&
                          section === 'library' &&
                          !collectionId &&
                          !projectId &&
                          'bg-bg-300 font-medium'
                      )}
                      ref={libraryEntryRef}
                      aria-current={
                        !citationStylesOpen &&
                        !duplicatesOpen &&
                        section === 'library' &&
                        !collectionId &&
                        !projectId
                          ? 'page'
                          : undefined
                      }
                      aria-label={t('All references')}
                      onClick={() => selectLibrary()}
                    >
                      <BookOpenText className="size-4" aria-hidden="true" />
                      {!sidebarCollapsed ? <span>{t('All references')}</span> : null}
                      <LiteratureLibraryCount
                        revision={libraryCountRevision}
                        hidden={sidebarCollapsed}
                      />
                    </button>
                  </LiteratureSidebarHint>
                  <LiteratureSidebarHint label={t('Duplicates')} collapsed={sidebarCollapsed}>
                    <button
                      type="button"
                      className={cn(navButtonClassName, duplicatesOpen && 'bg-bg-300 font-medium')}
                      aria-current={!citationStylesOpen && duplicatesOpen ? 'page' : undefined}
                      aria-label={t('Duplicates')}
                      onClick={() => {
                        setCitationStylesOpen(false)
                        setDuplicatesOpen(true)
                        clearSelection()
                      }}
                    >
                      <Copy className="size-4" aria-hidden="true" />
                      {!sidebarCollapsed ? <span>{t('Duplicates')}</span> : null}
                      <LiteratureDuplicateCount ref={duplicateCountRef} hidden={sidebarCollapsed} />
                    </button>
                  </LiteratureSidebarHint>
                  <LiteratureSidebarHint label={t('Trash')} collapsed={sidebarCollapsed}>
                    <button
                      type="button"
                      className={cn(
                        navButtonClassName,
                        !duplicatesOpen && section === 'trash' && 'bg-bg-300 font-medium'
                      )}
                      aria-current={
                        !citationStylesOpen && !duplicatesOpen && section === 'trash'
                          ? 'page'
                          : undefined
                      }
                      aria-label={t('Trash')}
                      onClick={() => selectSection('trash')}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      {!sidebarCollapsed ? <span>{t('Trash')}</span> : null}
                    </button>
                  </LiteratureSidebarHint>
                </nav>
                <div
                  className={cn(
                    'min-h-0 flex-1 overflow-y-auto',
                    sidebarCollapsed ? 'mt-3 border-t border-border-300/80 pt-3' : 'mt-2'
                  )}
                >
                  {!sidebarCollapsed ? (
                    <div
                      role="separator"
                      aria-orientation="horizontal"
                      className="mx-2 mb-2 mt-2 h-px bg-border-300/80"
                    />
                  ) : null}
                  <LiteratureSidebarGroup
                    collapsed={sidebarCollapsed}
                    entries={activeProjects}
                    groupId="literature-sidebar-projects"
                    label={t('Projects')}
                    navButtonClassName={navButtonClassName}
                    selectedId={duplicatesOpen ? undefined : projectId}
                    showAllLabel={t('Show all projects')}
                    showAllText={t('Show all')}
                    showFewerLabel={t('Show fewer projects')}
                    showLessText={t('Show less')}
                    renderEntry={(project) => (
                      <LiteratureSidebarHint
                        key={project.id}
                        label={project.name}
                        collapsed={sidebarCollapsed}
                      >
                        <button
                          type="button"
                          className={cn(
                            navButtonClassName,
                            !duplicatesOpen && projectId === project.id && 'bg-bg-300 font-medium'
                          )}
                          aria-current={
                            !citationStylesOpen &&
                            !duplicatesOpen &&
                            section === 'library' &&
                            projectId === project.id
                              ? 'page'
                              : undefined
                          }
                          aria-label={project.name}
                          onClick={() => selectProject(project.id)}
                        >
                          <GalleryVerticalEnd className="size-4" aria-hidden="true" />
                          {!sidebarCollapsed ? (
                            <span className="min-w-0 flex-1 truncate text-left">
                              {project.name}
                            </span>
                          ) : null}
                          {!sidebarCollapsed ? (
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {projectItemCounts[project.id] ?? 0}
                            </span>
                          ) : null}
                        </button>
                      </LiteratureSidebarHint>
                    )}
                  />
                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    className={cn(
                      'mx-2 h-px bg-border-300/80',
                      sidebarCollapsed ? 'my-3' : 'mb-2 mt-4'
                    )}
                  />
                  <LiteratureSidebarGroup
                    collapsed={sidebarCollapsed}
                    entries={displayCollections}
                    groupId="literature-sidebar-collections"
                    label={t('Collections')}
                    action={
                      <LiteratureSidebarHint label={t('New collection')} collapsed>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-lg"
                          className="text-muted-foreground hover:bg-bg-300 hover:text-foreground active:bg-bg-300 transition-none"
                          aria-label={t('New collection')}
                          aria-haspopup="dialog"
                          onClick={openCreateCollection}
                        >
                          {sidebarCollapsed ? (
                            <FolderPlus className="size-4" aria-hidden="true" />
                          ) : (
                            <Plus className="size-4" aria-hidden="true" />
                          )}
                        </Button>
                      </LiteratureSidebarHint>
                    }
                    navButtonClassName={navButtonClassName}
                    selectedId={duplicatesOpen ? undefined : collectionId}
                    showAllLabel={t('Show all collections')}
                    showAllText={t('Show all')}
                    showFewerLabel={t('Show fewer collections')}
                    showLessText={t('Show less')}
                    renderEntry={(collection) => (
                      <LiteratureSidebarHint
                        key={collection.id}
                        label={collection.name}
                        collapsed={sidebarCollapsed}
                      >
                        <button
                          type="button"
                          className={cn(
                            navButtonClassName,
                            !duplicatesOpen &&
                              collectionId === collection.id &&
                              'bg-bg-300 font-medium'
                          )}
                          aria-current={
                            !citationStylesOpen &&
                            !duplicatesOpen &&
                            section === 'library' &&
                            collectionId === collection.id
                              ? 'page'
                              : undefined
                          }
                          aria-label={collection.name}
                          onClick={() => selectLibrary(collection.id)}
                        >
                          <span aria-hidden="true">
                            {collection.smart ? (
                              <SmartCollectionIcon
                                className="size-4 text-primary"
                                aria-hidden="true"
                              />
                            ) : (
                              <FolderOpen className="size-4" />
                            )}
                          </span>
                          {!sidebarCollapsed ? (
                            <span className="min-w-0 flex-1 truncate text-left">
                              {collection.name}
                            </span>
                          ) : null}
                          {!sidebarCollapsed ? (
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {collection.itemCount}
                            </span>
                          ) : null}
                        </button>
                      </LiteratureSidebarHint>
                    )}
                  />
                </div>
                <div
                  className={cn(
                    'mt-auto space-y-1 border-t border-border-300/80 pt-2',
                    sidebarCollapsed && 'flex flex-col items-center'
                  )}
                >
                  <LiteratureSidebarHint label={t('Settings')} collapsed={sidebarCollapsed}>
                    <button
                      type="button"
                      className={cn(
                        navButtonClassName,
                        citationStylesOpen && 'bg-bg-300 font-medium'
                      )}
                      aria-current={citationStylesOpen ? 'page' : undefined}
                      aria-label={t('Settings')}
                      onClick={() => setCitationStylesOpen(true)}
                    >
                      <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
                      {!sidebarCollapsed ? <span>{t('Settings')}</span> : null}
                    </button>
                  </LiteratureSidebarHint>
                </div>
              </aside>
            )
          }}
        </LiteratureSidebarState>

        <section className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <LiteratureDuplicatesView
            active={duplicatesOpen && !citationStylesOpen}
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
          {citationStylesOpen ? (
            <CitationStylesView
              styles={citationStyles}
              onBack={() => setCitationStylesOpen(false)}
              onStylesChange={updateCitationStyles}
            />
          ) : null}
          <div
            className={cn(
              'flex h-full min-h-0 w-full max-w-none flex-col px-4 py-6 lg:px-6 lg:py-8',
              (citationStylesOpen || duplicatesOpen) && 'hidden'
            )}
          >
            <div
              className={
                selectedCollection?.smart
                  ? 'hidden'
                  : 'flex flex-wrap items-end justify-between gap-4'
              }
            >
              <div className="min-w-0 flex-1">
                <div className="flex w-fit max-w-full min-w-0 items-center gap-1.5">
                  <h2
                    className="min-w-0 truncate text-2xl font-semibold tracking-tight"
                    title={selectedProject?.name ?? selectedCollection?.name}
                  >
                    {section === 'inbox'
                      ? t('Inbox')
                      : section === 'trash'
                        ? t('Trash')
                        : (selectedProject?.name ??
                          selectedCollection?.name ??
                          t('All references'))}
                  </h2>
                  {section === 'library' && selectedProject ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label={t('Open project')}
                      title={t('Open project')}
                      onClick={() => openProject(selectedProject.id, 'user')}
                    >
                      <ExternalLink className="size-4" aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {section === 'inbox'
                    ? t('Review references found by Agents before they enter your library.')
                    : section === 'trash'
                      ? t(
                          'Restore references to edit, preview, or export them, or delete them permanently.'
                        )
                      : selectedProject
                        ? t('References linked to this project.')
                        : selectedCollection
                          ? (selectedCollection.smart
                              ? t('Smart collection')
                              : selectedCollection.description) ||
                            t('References saved in this collection.')
                          : t('Search and organize the references you use across projects.')}
                </p>
              </div>
              <div
                className={
                  smartSetup
                    ? 'hidden'
                    : 'flex w-full min-w-0 shrink-0 flex-wrap items-center gap-2 sm:w-auto'
                }
              >
                {showLiteratureReviewAction && reviewProjectId ? (
                  <Button
                    type="button"
                    className="literature-review-cta h-8 shrink-0 px-1.5 pr-3 shadow-card hover:bg-primary/90 active:translate-y-px active:shadow-none dark:shadow-none [@media(pointer:coarse)]:h-11"
                    data-attention={shouldCueLiteratureReview ? 'true' : undefined}
                    onClick={() =>
                      startLiteratureReviewConversation(
                        reviewProjectId,
                        selectedCollection
                          ? {
                              type: 'literature-scope',
                              scope: 'collection',
                              collectionId: selectedCollection.id,
                              name: selectedCollection.name
                            }
                          : { type: 'literature-scope', scope: 'project' },
                        t('Synthesize this literature into a concise review.')
                      )
                    }
                  >
                    <span className="literature-review-cta__content inline-flex items-center gap-2">
                      <span
                        className="literature-review-cta__mark inline-grid size-6 place-items-center rounded-md bg-primary-foreground/15 ring-1 ring-primary-foreground/20 ring-inset"
                        onAnimationEnd={() => setShouldCueLiteratureReview(false)}
                      >
                        <Sparkles className="size-3.5" aria-hidden="true" />
                      </span>
                      <span>{t('Review with agent')}</span>
                    </span>
                  </Button>
                ) : null}
                {section === 'library' && !selectedCollection?.smart ? (
                  <div>
                    <input
                      ref={importPdfInputRef}
                      multiple
                      type="file"
                      accept="application/pdf,.pdf"
                      className="sr-only"
                      aria-label={t('Import PDFs')}
                      onChange={(event) => {
                        const files = Array.from(event.currentTarget.files ?? [])
                        event.currentTarget.value = ''
                        if (files.length > 1)
                          setPdfBatch({
                            files,
                            destination: {
                              name:
                                selectedProject?.name ??
                                selectedCollection?.name ??
                                t('All references'),
                              projectId,
                              collectionId
                            }
                          })
                        else if (files[0]) beginPdfImport(files[0])
                      }}
                    />
                    <input
                      ref={importRecordsInputRef}
                      type="file"
                      accept=".bib,.bibtex,.ris,.nbib,.txt,application/x-bibtex,application/x-research-info-systems,text/plain"
                      className="sr-only"
                      aria-label={t('Import references')}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0]
                        event.currentTarget.value = ''
                        if (file) void previewRecordImport(file)
                      }}
                    />
                    <LiteratureAddMenu
                      onAddReference={() => {
                        setPendingImportPdf(undefined)
                        setPendingImportDraft(undefined)
                        setIsReadingImportMetadata(false)
                        setCreateItemError(undefined)
                        setDuplicatePolicy('reuse')
                        setIsCreatingItem(true)
                      }}
                      onImportPdf={() => importPdfInputRef.current?.click()}
                      onImportReferences={() => importRecordsInputRef.current?.click()}
                    />
                  </div>
                ) : null}
                <LiteratureSearchInput
                  initialValue={query}
                  onCommit={setQuery}
                  onDraftChange={clearSelection}
                />
                {section === 'library' && (selectedProject || selectedCollection) ? (
                  <LiteratureLibraryActionsMenu
                    identityKey={selectedCollection?.id ?? selectedProject?.id ?? 'library'}
                    onEdit={
                      selectedCollection ? () => openEditCollection(selectedCollection) : undefined
                    }
                    onDelete={
                      selectedCollection
                        ? () => {
                            setCollectionDeleteError(undefined)
                            setCollectionPendingDelete(selectedCollection)
                            void loadCollections().catch(() =>
                              setCollectionDeleteError(t('Literature could not be loaded.'))
                            )
                          }
                        : undefined
                    }
                    exportDisabled={
                      entriesLoading ||
                      (selectedProject
                        ? projectItemCounts[selectedProject.id] === 0
                        : selectedCollection?.itemCount === 0)
                    }
                    onExport={exportCurrentScope}
                  />
                ) : null}
              </div>
            </div>

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
                                  <div className="flex shrink-0 items-center justify-end gap-2">
                                    {selectedCollection?.smart && (
                                      <Select
                                        value={smartDecisionSource}
                                        disabled={!smartView?.countsBySource}
                                        onValueChange={(value) => {
                                          setSmartDecisionSource(
                                            value as typeof smartDecisionSource
                                          )
                                          clearSelection()
                                        }}
                                      >
                                        <SelectTrigger
                                          aria-label={t('Decision source')}
                                          className="w-40"
                                        >
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="all">
                                            {t('All decision sources')}
                                          </SelectItem>
                                          <SelectItem value="ai">{t('AI decisions')}</SelectItem>
                                          <SelectItem value="manual">
                                            {t('Manual decisions')}
                                          </SelectItem>
                                        </SelectContent>
                                      </Select>
                                    )}

                                    <Select
                                      value={sortBy}
                                      onValueChange={(value) => {
                                        setSortBy(value as typeof sortBy)
                                        clearSelection()
                                      }}
                                    >
                                      <SelectTrigger
                                        aria-label={t('Sort references')}
                                        className="w-52"
                                      >
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="updated">
                                          {t('Recently updated')}
                                        </SelectItem>
                                        <SelectItem value="created">
                                          {t('Recently added')}
                                        </SelectItem>
                                        <SelectItem value="created-asc">
                                          {t('First added')}
                                        </SelectItem>
                                        <SelectItem value="title">{t('Title: A–Z')}</SelectItem>
                                        <SelectItem value="title-desc">
                                          {t('Title: Z–A')}
                                        </SelectItem>
                                        <SelectItem value="year">
                                          {t('Year: newest first')}
                                        </SelectItem>
                                        <SelectItem value="year-asc">
                                          {t('Year: oldest first')}
                                        </SelectItem>
                                        <SelectItem value="rating">{t('Highest rated')}</SelectItem>
                                      </SelectContent>
                                    </Select>
                                    <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
                                      <PopoverTrigger asChild>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          className="relative"
                                          aria-describedby={
                                            yearFilter.invalid && !filtersOpen
                                              ? 'literature-year-filter-error'
                                              : undefined
                                          }
                                        >
                                          <SlidersHorizontal
                                            className="size-4"
                                            aria-hidden="true"
                                          />
                                          {t('Filters')}
                                          {activeFilterCount > 0 ? (
                                            <span className="rounded-full bg-primary/10 px-1.5 text-[11px] font-medium tabular-nums text-primary">
                                              {activeFilterCount}
                                            </span>
                                          ) : null}
                                        </Button>
                                      </PopoverTrigger>
                                      <PopoverContent
                                        align="end"
                                        aria-labelledby={`${accessibilityId}-filters`}
                                        className="w-72 space-y-4 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-menu"
                                      >
                                        <p
                                          id={`${accessibilityId}-filters`}
                                          className="text-sm font-medium"
                                        >
                                          {t('Filters')}
                                        </p>
                                        <div className="space-y-1.5">
                                          <span className="text-xs font-medium text-muted-foreground">
                                            {t('Tags')}
                                          </span>
                                          <TagFilter
                                            resourceType="literature.item"
                                            value={tagId}
                                            onChange={(value) => {
                                              setTagId(value)
                                              clearSelection()
                                            }}
                                            className="w-full"
                                          />
                                        </div>
                                        <>
                                          <div className="space-y-1.5">
                                            <span className="text-xs font-medium text-muted-foreground">
                                              {t('Reference type')}
                                            </span>
                                            <Select
                                              value={filterItemType}
                                              onValueChange={(value) => {
                                                setFilterItemType(
                                                  value as LiteratureItemType | 'all'
                                                )
                                                clearSelection()
                                              }}
                                            >
                                              <SelectTrigger aria-label={t('Reference type')}>
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                <SelectItem value="all">{t('All')}</SelectItem>
                                                {Object.entries(itemTypeLabels).map(
                                                  ([value, label]) => (
                                                    <SelectItem key={value} value={value}>
                                                      {label}
                                                    </SelectItem>
                                                  )
                                                )}
                                              </SelectContent>
                                            </Select>
                                          </div>
                                          <LiteratureYearFilter {...yearFilter} />
                                          <div className="space-y-1.5">
                                            <span className="text-xs font-medium text-muted-foreground">
                                              {t('PDF')}
                                            </span>
                                            <Select
                                              value={filterHasPdf}
                                              onValueChange={(value) => {
                                                setFilterHasPdf(value as typeof filterHasPdf)
                                                clearSelection()
                                              }}
                                            >
                                              <SelectTrigger aria-label={t('PDF')}>
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                <SelectItem value="all">{t('All')}</SelectItem>
                                                <SelectItem value="with">
                                                  {t('With PDF')}
                                                </SelectItem>
                                                <SelectItem value="without">
                                                  {t('Without PDF')}
                                                </SelectItem>
                                              </SelectContent>
                                            </Select>
                                          </div>
                                        </>
                                        <div className="border-t border-border pt-3">
                                          <Button
                                            type="button"
                                            variant="outline"
                                            className="w-full"
                                            disabled={
                                              activeFilterCount === 0 &&
                                              !yearFilter.draftFrom &&
                                              !yearFilter.draftTo
                                            }
                                            onClick={clearFilters}
                                          >
                                            {t('Clear filters')}
                                          </Button>
                                        </div>
                                      </PopoverContent>
                                    </Popover>
                                    {yearFilter.invalid && !filtersOpen ? (
                                      <p
                                        id="literature-year-filter-error"
                                        role="status"
                                        className="text-xs text-destructive"
                                      >
                                        {t('Enter a valid year range (0–9999).')}
                                      </p>
                                    ) : null}
                                    <LiteratureColumnCustomizer
                                      columns={tableColumnOrder}
                                      labels={tableColumnLabels}
                                      visible={visibleTableColumns}
                                      onMove={moveTableColumn}
                                      onMoveBy={moveTableColumnBy}
                                      onVisibilityChange={(column, nextVisible) =>
                                        setVisibleTableColumns((current) => {
                                          const next = new Set(current)
                                          if (nextVisible) next.add(column)
                                          else next.delete(column)
                                          return next
                                        })
                                      }
                                    />
                                  </div>
                                )}
                                {hasSelection && (
                                  <div
                                    data-slot="literature-selection-toolbar"
                                    className="w-full min-w-0 rounded-lg border border-primary/20 bg-primary/5 px-2 py-1"
                                  >
                                    <div
                                      data-slot="literature-selection-common-actions"
                                      className="flex min-h-9 min-w-0 items-center gap-2 overflow-x-auto [&>button]:shrink-0"
                                    >
                                      <span className="shrink-0 whitespace-nowrap px-1 text-sm font-medium tabular-nums">
                                        {t('{{count}} selected', { count: selectedItemCount })}
                                      </span>
                                      {!selection.allMatchingSelected &&
                                      allLoadedItemsSelected &&
                                      (entriesOffset > 0 || nextEntriesOffset !== undefined) ? (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          aria-label={`${t('Select all matching references')} ${formattedMatchingCount}`}
                                          disabled={isBatching}
                                          onClick={selectionStore.selectAllMatching}
                                          className="shrink-0 whitespace-nowrap"
                                        >
                                          <span>{t('Select all')}</span>
                                          <span className="text-muted-foreground tabular-nums">
                                            {formattedMatchingCount}
                                          </span>
                                        </Button>
                                      ) : null}
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={t('Clear selection')}
                                        title={t('Clear selection')}
                                        disabled={isBatching}
                                        onClick={clearSelection}
                                      >
                                        <X className="size-3.5" aria-hidden="true" />
                                      </Button>
                                      {smartDecisionBatch.progress &&
                                      smartDecisionBatch.progress.collectionId === collectionId ? (
                                        <>
                                          <span role="status" className="text-sm tabular-nums">
                                            {t(
                                              'Saving decisions: {{done}}/{{total}}',
                                              smartDecisionBatch.progress
                                            )}
                                          </span>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={smartDecisionBatch.stop}
                                            disabled={smartDecisionBatch.progress.stopping}
                                          >
                                            {t('Stop')}
                                          </Button>
                                        </>
                                      ) : (
                                        selectedCollection?.smart && (
                                          <>
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              disabled={isBatching || pendingDecisions.size > 0}
                                              onClick={() => void confirmSmartDecision('include')}
                                            >
                                              {t('Include')}
                                            </Button>
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              disabled={isBatching || pendingDecisions.size > 0}
                                              onClick={() => void confirmSmartDecision('exclude')}
                                            >
                                              {t('Exclude')}
                                            </Button>
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              disabled={
                                                isBatching ||
                                                pendingDecisions.size > 0 ||
                                                !smartView?.configured ||
                                                !smartView?.sourceAvailable ||
                                                smartView?.run?.state === 'running' ||
                                                smartView?.run?.state === 'queued'
                                              }
                                              onClick={() => void prepareSmartReevaluation()}
                                            >
                                              <RotateCcw className="size-3.5" aria-hidden="true" />
                                              {t('Re-evaluate selected')}
                                            </Button>
                                          </>
                                        )
                                      )}
                                      <Popover>
                                        <PopoverTrigger asChild>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="ml-auto shrink-0"
                                            disabled={isBatching}
                                          >
                                            {t('More actions')}
                                            <ChevronDown className="size-3.5" aria-hidden="true" />
                                          </Button>
                                        </PopoverTrigger>
                                        <PopoverContent
                                          align="end"
                                          className="w-64 max-w-[calc(100vw-2rem)] space-y-1 rounded-xl border border-border bg-bg-000 p-1.5 text-foreground [&_button]:h-8 [&_button]:w-full [&_button]:justify-start [&_button]:border-transparent [&_button]:bg-transparent [&_button]:shadow-none [&_button:hover]:bg-bg-200"
                                        >
                                          <LiteratureHoverMenuGroup>
                                            <div className="flex flex-col gap-0.5">
                                              {section === 'library' ? (
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="sm"
                                                  className="shrink-0 whitespace-nowrap"
                                                  disabled={
                                                    isBatching || Boolean(startingReadingProjectId)
                                                  }
                                                  onClick={() => void requestReadSelection()}
                                                >
                                                  <BookOpenText
                                                    className="size-3.5"
                                                    aria-hidden="true"
                                                  />
                                                  {t('Read with agent')}
                                                </Button>
                                              ) : null}
                                              {section === 'library' ? (
                                                <LiteratureBatchDestinationMenus
                                                  collections={batchCollections}
                                                  disabled={isBatching}
                                                  moveBetweenCollections={Boolean(collectionId)}
                                                  projects={activeProjects}
                                                  projectsLoaded={projectsLoaded}
                                                  onCreateCollection={createCollectionForSelection}
                                                  onCreateProject={
                                                    batchProjectFormDialog.openCreateDialog
                                                  }
                                                  onSelectCollection={(id) =>
                                                    void moveSelectedItems(id)
                                                  }
                                                  onSelectProject={(id) =>
                                                    void addSelectedItemsToProject(id)
                                                  }
                                                />
                                              ) : (
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="sm"
                                                  disabled={
                                                    isBatching ||
                                                    (!selection.allMatchingSelected &&
                                                      [...selection.selectedIds].every((id) =>
                                                        items.some(
                                                          (item) =>
                                                            item.id === id &&
                                                            Boolean(item.mergedIntoItemId)
                                                        )
                                                      ))
                                                  }
                                                  onClick={() => void previewRestoreSelection()}
                                                >
                                                  <RotateCcw
                                                    className="size-3.5"
                                                    aria-hidden="true"
                                                  />
                                                  {t('Restore')}
                                                </Button>
                                              )}
                                              <LiteratureExportMenu
                                                disabled={isBatching || section === 'trash'}
                                                onExport={exportSelectedItems}
                                              />
                                              {section === 'library' ||
                                              (section === 'trash' &&
                                                !selection.allMatchingSelected &&
                                                selection.selectedIds.size <=
                                                  LITERATURE_BATCH_COMMAND_SIZE) ? (
                                                <LiteratureHoverDropdown
                                                  disabled={isBatching}
                                                  trigger={
                                                    <Button
                                                      type="button"
                                                      variant="ghost"
                                                      size="sm"
                                                      className="shrink-0"
                                                      aria-label={t('Actions')}
                                                      disabled={isBatching}
                                                    >
                                                      <MoreHorizontal
                                                        className="size-3.5"
                                                        aria-hidden="true"
                                                      />
                                                      {t('Actions')}
                                                      <ChevronRight
                                                        className="ml-auto size-3.5 opacity-60"
                                                        aria-hidden="true"
                                                      />
                                                    </Button>
                                                  }
                                                >
                                                  {section === 'library' ? (
                                                    <>
                                                      <PopoverClose asChild>
                                                        <DropdownMenuItem
                                                          onSelect={() =>
                                                            void requestBatchLookup('metadata')
                                                          }
                                                        >
                                                          <Search
                                                            className="mr-2 size-4"
                                                            aria-hidden="true"
                                                          />
                                                          {t('Complete metadata')}
                                                        </DropdownMenuItem>
                                                      </PopoverClose>
                                                      <PopoverClose asChild>
                                                        <DropdownMenuItem
                                                          onSelect={() =>
                                                            void requestBatchLookup('full-text')
                                                          }
                                                        >
                                                          <Download
                                                            className="mr-2 size-4"
                                                            aria-hidden="true"
                                                          />
                                                          {t('Find full-text PDF')}
                                                        </DropdownMenuItem>
                                                      </PopoverClose>
                                                      <DropdownMenuSeparator />
                                                      {!selection.allMatchingSelected &&
                                                      selection.selectedIds.size > 1 &&
                                                      selection.selectedIds.size <= 20 ? (
                                                        <>
                                                          <PopoverClose asChild>
                                                            <DropdownMenuItem
                                                              onSelect={() => {
                                                                const firstSelected = items.find(
                                                                  (item) =>
                                                                    selection.selectedIds.has(
                                                                      item.id
                                                                    )
                                                                )
                                                                setMergeSurvivorId(
                                                                  firstSelected?.id ?? ''
                                                                )
                                                                setMergeFieldSources({})
                                                                setMergeError(undefined)
                                                                setMergeOpen(true)
                                                              }}
                                                            >
                                                              <Merge
                                                                className="mr-2 size-4"
                                                                aria-hidden="true"
                                                              />
                                                              {t('Merge')}
                                                            </DropdownMenuItem>
                                                          </PopoverClose>
                                                          <DropdownMenuSeparator />
                                                        </>
                                                      ) : null}
                                                      <PopoverClose asChild>
                                                        <DropdownMenuItem
                                                          onSelect={() =>
                                                            void runLifecycleAction('deleted')
                                                          }
                                                        >
                                                          <Trash2
                                                            className="mr-2 size-4"
                                                            aria-hidden="true"
                                                          />
                                                          {t('Move to Trash')}
                                                        </DropdownMenuItem>
                                                      </PopoverClose>
                                                    </>
                                                  ) : (
                                                    <>
                                                      <PopoverClose asChild>
                                                        <DropdownMenuItem
                                                          className="text-danger-000 focus:text-danger-000"
                                                          onSelect={() =>
                                                            requestPermanentDeletion([
                                                              ...selection.selectedIds
                                                            ])
                                                          }
                                                        >
                                                          <Trash2
                                                            className="mr-2 size-4"
                                                            aria-hidden="true"
                                                          />
                                                          {t('Delete permanently')}
                                                        </DropdownMenuItem>
                                                      </PopoverClose>
                                                    </>
                                                  )}
                                                </LiteratureHoverDropdown>
                                              ) : null}
                                            </div>
                                            {selectedCollection?.smart && (
                                              <div
                                                data-slot="smart-selection-actions"
                                                className="flex flex-col gap-0.5 border-t border-border pt-1"
                                              >
                                                <Button
                                                  variant="ghost"
                                                  size="sm"
                                                  disabled={isBatching}
                                                  onClick={() =>
                                                    void confirmSmartDecision('automatic')
                                                  }
                                                >
                                                  {t('Use model decision')}
                                                </Button>
                                              </div>
                                            )}
                                          </LiteratureHoverMenuGroup>
                                        </PopoverContent>
                                      </Popover>
                                    </div>
                                  </div>
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
                        setDismissedCandidateUndo(undefined)
                        setUndoNotice(undefined)
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
                      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <LiteratureSelectionBoundary store={selectionStore}>
                          {(selection) => {
                            const selectedCount = selection.selectedIds.size
                            return (
                              <div className="mb-2 flex min-h-10 shrink-0 items-center gap-2 px-2">
                                <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                                  <LiteratureSelectPageCheckbox
                                    itemIds={candidates.map(({ id }) => id)}
                                    label={t('Select all references')}
                                    store={selectionStore}
                                    disabled={isBatching || Boolean(pendingCandidateId)}
                                    className="size-4"
                                  />
                                  {t('Select all')}
                                </label>
                                {selectedCount > 0 ? (
                                  <>
                                    <span className="ml-2 text-sm font-medium tabular-nums">
                                      {t('{{count}} selected', { count: selectedCount })}
                                    </span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={isBatching || Boolean(pendingCandidateId)}
                                      onClick={clearSelection}
                                    >
                                      {t('Clear selection')}
                                    </Button>
                                    <div className="ml-auto flex items-center gap-2">
                                      {inboxState === 'dismissed' ? (
                                        <Button
                                          type="button"
                                          size="sm"
                                          disabled={isBatching || Boolean(pendingCandidateId)}
                                          onClick={() =>
                                            void restoreDismissedCandidates([
                                              ...selection.selectedIds
                                            ])
                                          }
                                        >
                                          <RotateCcw className="size-3.5" aria-hidden="true" />
                                          {t('Restore')}
                                        </Button>
                                      ) : (
                                        <>
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            disabled={isBatching || Boolean(pendingCandidateId)}
                                            onClick={() =>
                                              void settleSelectedCandidates('dismissed')
                                            }
                                          >
                                            <X className="size-3.5" aria-hidden="true" />
                                            {t('Dismiss')}
                                          </Button>
                                          <Button
                                            type="button"
                                            size="sm"
                                            disabled={isBatching || Boolean(pendingCandidateId)}
                                            onClick={() =>
                                              void settleSelectedCandidates('accepted')
                                            }
                                          >
                                            <Check className="size-3.5" aria-hidden="true" />
                                            {t('Accept')}
                                          </Button>
                                        </>
                                      )}
                                    </div>
                                  </>
                                ) : null}
                              </div>
                            )
                          }}
                        </LiteratureSelectionBoundary>
                        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-1 pb-3">
                          {candidates.map((candidate) => {
                            const item = candidate.candidate.item
                            const pending = pendingCandidateId === candidate.id
                            const authors = creatorLabel(item)
                            const publication = [item.issuedYear, item.containerTitle]
                              .filter(Boolean)
                              .join(' · ')
                            return (
                              <article
                                key={candidate.id}
                                aria-busy={pending}
                                className={cn(
                                  'group relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-4 rounded-xl border border-border-300/80 bg-bg-000 px-5 py-4 transition-[box-shadow,opacity] duration-150 ease-out has-[input:checked]:border-primary/30 has-[input:checked]:bg-primary/5 hover:z-10 hover:shadow-lg motion-reduce:transition-none sm:grid-cols-[1.25rem_minmax(0,1fr)_8rem]',
                                  pending && 'opacity-60'
                                )}
                              >
                                <button
                                  type="button"
                                  className="absolute inset-0 cursor-pointer rounded-xl outline-none active:bg-muted/10 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed"
                                  aria-label={`${t('View details')}: ${item.title}`}
                                  disabled={isBatching || Boolean(pendingCandidateId)}
                                  onClick={() => setSelectedCandidate(candidate)}
                                />
                                <LiteratureSelectionCheckbox
                                  itemId={candidate.id}
                                  label={t('Select {{title}}', { title: item.title })}
                                  store={selectionStore}
                                  disabled={isBatching || Boolean(pendingCandidateId)}
                                  className="relative z-10 mt-1 size-4"
                                />
                                <div className="pointer-events-none relative min-w-0">
                                  <h3 className="line-clamp-2 text-base font-semibold leading-6 text-foreground">
                                    {item.title}
                                  </h3>
                                  <p className="mt-1 text-sm leading-5 text-foreground/70">
                                    {authors || itemTypeLabels[item.itemType]}
                                  </p>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs leading-5 text-muted-foreground">
                                    {candidate.pdfs?.length ? (
                                      <span>
                                        {t('PDF')} · {candidate.pdfs.length}
                                      </span>
                                    ) : null}
                                    {publication ? <span>{publication}</span> : null}
                                    <span className="whitespace-nowrap">
                                      {t('Found via {{provider}}', {
                                        provider: inboxProviderLabel(
                                          candidate.candidate.source.provider
                                        )
                                      })}
                                    </span>
                                  </div>
                                  {candidateProjectNames(candidate).length > 0 ? (
                                    <p className="mt-2 text-xs text-muted-foreground">
                                      {t('Accepting will link to: {{projects}}', {
                                        projects: candidateProjectNames(candidate).join(', ')
                                      })}
                                    </p>
                                  ) : null}
                                  {item.abstract ? (
                                    <p className="mt-3 line-clamp-2 text-[0.8125rem] leading-5 text-muted-foreground">
                                      {item.abstract}
                                    </p>
                                  ) : null}
                                </div>
                                <div className="relative z-10 col-start-2 grid grid-cols-2 gap-2 self-center sm:col-start-auto sm:grid-cols-1">
                                  {candidate.state === 'dismissed' ? (
                                    <Button
                                      type="button"
                                      className="w-full"
                                      disabled={isBatching || Boolean(pendingCandidateId)}
                                      onClick={() =>
                                        void restoreDismissedCandidates([candidate.id])
                                      }
                                    >
                                      <RotateCcw className="size-3.5" aria-hidden="true" />
                                      {t('Restore')}
                                    </Button>
                                  ) : (
                                    <>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        className="w-full"
                                        disabled={isBatching || Boolean(pendingCandidateId)}
                                        onClick={() =>
                                          void changeCandidateState(
                                            candidate.id,
                                            'dismiss-candidate'
                                          )
                                        }
                                      >
                                        <X className="size-3.5" aria-hidden="true" />
                                        {t('Dismiss')}
                                      </Button>
                                      <Button
                                        type="button"
                                        className="w-full"
                                        disabled={isBatching || Boolean(pendingCandidateId)}
                                        onClick={() =>
                                          void changeCandidateState(
                                            candidate.id,
                                            'accept-candidate'
                                          )
                                        }
                                      >
                                        <Check className="size-3.5" aria-hidden="true" />
                                        {t('Accept')}
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </article>
                            )
                          })}
                        </div>
                        {entriesPagination}
                      </div>
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
                    <div className="isolate flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-300/80 bg-bg-000">
                      <div className="relative min-h-0 flex-1 overflow-hidden">
                        <div
                          ref={tableScrollRef}
                          data-slot="literature-table-scroll"
                          className="h-full overflow-auto pb-3 [scrollbar-gutter:stable]"
                        >
                          <LiteratureTable
                            className="w-full table-fixed text-left text-sm"
                            style={{
                              minWidth: tableMinWidth + (selectedCollection?.smart ? 272 : 0)
                            }}
                          >
                            <thead className="sticky top-0 z-40 border-b border-border-300/80 bg-bg-200 text-xs font-medium text-muted-foreground">
                              <tr>
                                <th className="w-11 px-3 py-2.5">
                                  <LiteratureSelectPageCheckbox
                                    disabled={smartTableBlocked}
                                    itemIds={items.map((item) => item.id)}
                                    label={t('Select all references')}
                                    store={selectionStore}
                                    className="size-4"
                                  />
                                </th>
                                <th
                                  scope="col"
                                  className="w-12 min-w-12 max-w-12 px-2 py-2.5 text-center tabular-nums"
                                >
                                  #
                                </th>
                                <th scope="col" className="w-72 px-2 py-2.5">
                                  {t('Title')}
                                </th>
                                {selectedCollection?.smart && (
                                  <>
                                    <th scope="col" className="w-40 px-2 py-2.5">
                                      {t('Evaluation')}
                                    </th>
                                    <th scope="col" className="w-28 px-2 py-2.5">
                                      {t('Actions')}
                                    </th>
                                  </>
                                )}
                                {visibleOrderedTableColumns.map((column) => (
                                  <th
                                    key={column}
                                    scope="col"
                                    className={cn(
                                      'px-3 py-2.5',
                                      column === 'type' && 'w-40',
                                      column === 'authors' && 'w-56',
                                      column === 'year' && 'w-20 tabular-nums',
                                      column === 'publication' && 'w-56',
                                      column === 'tags' && 'w-52 px-2',
                                      column === 'abstract' && 'w-80',
                                      column === 'rating' && 'w-[152px]',
                                      column === 'notes' && 'w-[280px]',
                                      column === 'url' && 'w-20 text-center'
                                    )}
                                  >
                                    {tableColumnLabels[column]}
                                  </th>
                                ))}
                                <th
                                  scope="col"
                                  className="sticky right-12 z-30 w-28 min-w-28 max-w-28 overflow-hidden border-l border-border-300/80 bg-bg-200 px-2 py-2.5 text-center text-[11px] whitespace-nowrap shadow-card-opaque"
                                >
                                  {t('Attachment')}
                                </th>
                                <th
                                  scope="col"
                                  className="sticky right-0 z-30 w-12 min-w-12 max-w-12 bg-bg-200 px-2 py-2.5 text-right"
                                >
                                  <span className="sr-only">{t('Actions')}</span>
                                </th>
                              </tr>
                            </thead>
                            <TooltipProvider
                              disableHoverableContent
                              delayDuration={150}
                              skipDelayDuration={300}
                            >
                              <LiteratureRowNumbers.Provider value={rowNumbers}>
                                <tbody className="divide-y divide-border-300/70">
                                  {items.map((entry) => (
                                    <LiteratureItemRow
                                      key={entry.id}
                                      entry={entry}
                                      trash={section === 'trash'}
                                      smart={Boolean(selectedCollection?.smart)}
                                      smartTableBlocked={smartTableBlocked}
                                      isBatching={isBatching}
                                      decisionDisabled={
                                        isBatching ||
                                        pendingDecisions.has(`${collectionId}:${entry.id}`) ||
                                        smartRunningCollection === collectionId
                                      }
                                      updateDisabled={
                                        pendingDecisions.has(`${collectionId}:${entry.id}`) ||
                                        isBatching ||
                                        smartTableBlocked ||
                                        !smartView?.configured ||
                                        !smartView?.sourceAvailable
                                      }
                                      completed={
                                        completedReevaluation?.collectionId === collectionId &&
                                        completedReevaluation?.itemId === entry.id
                                      }
                                      evaluating={
                                        singleReevaluation?.collectionId === collectionId &&
                                        singleReevaluation?.itemId === entry.id
                                      }
                                      attachmentPending={attachmentOperations.some(
                                        (operation) =>
                                          operation.itemId === entry.id && operation.pending
                                      )}
                                      selectionStore={selectionStore}
                                      smartCellActions={smartCellActions}
                                      visibleOrderedTableColumns={visibleOrderedTableColumns}
                                      itemTypeLabels={itemTypeLabels}
                                      actions={rowActions}
                                    />
                                  ))}
                                </tbody>
                              </LiteratureRowNumbers.Provider>
                            </TooltipProvider>
                          </LiteratureTable>
                        </div>
                        {entriesPageTransitionLoading ? (
                          <div
                            role="status"
                            className="pointer-events-none absolute inset-x-0 top-10 bottom-0 z-30 flex items-center justify-center bg-bg-000/80 text-muted-foreground backdrop-blur-[1px]"
                          >
                            <LoaderCircle
                              className="size-5 animate-spin motion-reduce:animate-none"
                              aria-hidden="true"
                            />
                            <span className="sr-only">{t('Loading…')}</span>
                          </div>
                        ) : null}
                      </div>
                      {entriesPagination}
                    </div>
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
                              clearFilters()
                            }}
                          >
                            {t('Clear filters')}
                          </Button>
                        ) : (
                          <LiteratureAddMenu
                            label={t('Add reference')}
                            onAddReference={() => {
                              setDuplicatePolicy('reuse')
                              setIsCreatingItem(true)
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

        <Dialog.Root
          open={mergeOpen}
          onOpenChange={(open) => {
            if (isBatching) return
            setMergeOpen(open)
            if (!open) setDuplicateMergeItems(undefined)
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content
              className={dialogPanelClassName('flex w-[min(960px,calc(100vw-2rem))] flex-col p-0')}
            >
              <div className={dialogHeaderClassName}>
                <div>
                  <Dialog.Title className={dialogTitleClassName}>
                    {t('Merge references')}
                  </Dialog.Title>
                  <Dialog.Description className={dialogDescriptionClassName}>
                    {t('Choose the reference to keep and resolve conflicting fields.')}
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Close')}>
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </Dialog.Close>
              </div>
              <div className="relative min-h-0 max-h-[60vh] space-y-5 overflow-y-auto p-5">
                {mergeError ? <LiteratureErrorNotice tone="amber" title={mergeError} /> : null}
                <LiteratureMergeReview
                  entries={selectedItems}
                  survivorId={mergeSurvivorId}
                  onSurvivorChange={setMergeSurvivorId}
                  sources={mergeFieldSources}
                  onSourceChange={(field, id) =>
                    setMergeFieldSources((current) => ({ ...current, [field]: id }))
                  }
                  fieldLabel={mergeFieldLabel}
                  creatorLabel={fullCreatorLabel}
                  itemTypeLabels={itemTypeLabels}
                  disabled={isBatching}
                />
              </div>
              <div className="flex shrink-0 justify-end gap-2 border-t border-border-300/80 px-5 py-4">
                <Dialog.Close asChild>
                  <Button type="button" variant="outline">
                    {t('Cancel')}
                  </Button>
                </Dialog.Close>
                <Button
                  type="button"
                  disabled={!mergeSurvivorId || isBatching}
                  onClick={() => void mergeSelectedItems()}
                >
                  <Merge className="size-4" aria-hidden="true" />
                  {t('Merge references')}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

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
              recordImportRequest.current += 1
              setRecordImport(undefined)
            }}
            onImport={() => void commitRecordImport()}
          />
        ) : null}

        <Dialog.Root
          open={isCreatingItem}
          onOpenChange={(open) => {
            if (!open && !isSavingNewItem) {
              closeItemEditor()
            }
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content
              className={dialogPanelClassName('flex w-[min(640px,calc(100vw-2rem))] flex-col p-0')}
            >
              {discardMetadataDialog}
              <div className={dialogHeaderClassName}>
                <div>
                  <Dialog.Title className={dialogTitleClassName}>
                    {dialogItemEditor?.file ? t('Import PDF') : t('Add reference')}
                  </Dialog.Title>
                  <Dialog.Description className={dialogDescriptionClassName}>
                    {dialogItemEditor?.file
                      ? t('Review reference details before importing {{name}}.', {
                          name: dialogItemEditor?.file.name
                        })
                      : t('Create a reference in your library.')}
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={dialogCloseButtonClassName}
                    disabled={isSavingNewItem}
                    aria-label={t('Close')}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </Dialog.Close>
              </div>
              {isSavingNewItem ? pdfUploadNotice : null}
              {dialogItemEditor?.file &&
              !dialogItemEditor.reading &&
              dialogItemEditor.metadataNotice ? (
                <p className="px-5 py-2 text-sm text-muted-foreground" role="status">
                  {dialogItemEditor.metadataNotice}
                </p>
              ) : null}
              {dialogItemEditor?.file && dialogItemEditor?.reading ? (
                <div
                  className="grid min-h-80 place-items-center text-sm text-muted-foreground"
                  role="status"
                >
                  <span className="inline-flex items-center gap-2">
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {t('Reading…')}
                  </span>
                </div>
              ) : (
                <LiteratureMetadataEditor
                  onDirtyChange={trackNewMetadataDirty}
                  className="min-h-0"
                  beforeFields={
                    <LiteratureDuplicatePolicyField
                      value={dialogItemEditor?.duplicatePolicy ?? duplicatePolicy}
                      onChange={setDuplicatePolicy}
                      disabled={isSavingNewItem || Boolean(dialogItemEditor?.createdItemId)}
                    />
                  }
                  key={dialogItemEditor?.file?.name ?? 'manual-reference'}
                  item={
                    dialogItemEditor?.draft ?? {
                      ...emptyLiteratureItem(),
                      title: dialogItemEditor?.file
                        ? titleFromPdfFilename(dialogItemEditor?.file.name)
                        : ''
                    }
                  }
                  saving={isSavingNewItem}
                  error={dialogItemEditor?.error}
                  onRetry={createdItemId ? () => void createManualItem() : undefined}
                  onCancel={closeItemEditor}
                  onSave={(item) => {
                    if (isCreatingItem) void createManualItem(item)
                  }}
                />
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <Dialog.Root
          open={selectedCandidate !== undefined}
          onOpenChange={(open) => {
            if (!open) setSelectedCandidate(undefined)
          }}
        >
          {selectedCandidate ? (
            <Dialog.Portal>
              <Dialog.Overlay className={dialogOverlayClassName} />
              <Dialog.Content
                className={dialogPanelClassName(
                  'flex w-[min(620px,calc(100vw-2rem))] flex-col p-0'
                )}
              >
                <div className={cn(dialogHeaderClassName, 'px-5 py-3')}>
                  <div className="min-w-0">
                    <Dialog.Title className={cn(dialogTitleClassName, 'truncate')}>
                      {selectedCandidate.candidate.item.title}
                    </Dialog.Title>
                    <Dialog.Description
                      className={cn(dialogDescriptionClassName, 'mt-0.5 truncate text-xs')}
                    >
                      {itemDescription(selectedCandidate.candidate.item) ||
                        itemTypeLabels[selectedCandidate.candidate.item.itemType]}
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className={dialogCloseButtonClassName}
                      aria-label={t('Close')}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </Dialog.Close>
                </div>
                <div className="relative min-h-0 max-h-[70vh] divide-y divide-border-300/80 overflow-y-auto px-5 text-sm">
                  {candidateProjectNames(selectedCandidate).length > 0 ? (
                    <p className="py-4 text-sm leading-6 text-muted-foreground">
                      {t('Accepting will link to: {{projects}}', {
                        projects: candidateProjectNames(selectedCandidate).join(', ')
                      })}
                    </p>
                  ) : null}
                  {selectedCandidate.candidate.item.abstract ? (
                    <section className="py-4">
                      <h3 className="font-medium">{t('Abstract')}</h3>
                      <p className="mt-2 whitespace-pre-wrap leading-6 text-muted-foreground">
                        {selectedCandidate.candidate.item.abstract}
                      </p>
                    </section>
                  ) : null}
                  {selectedCandidate.pdfs?.length ? (
                    <section className="py-4">
                      <h3 className="font-medium">{t('Attachments')}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('PDFs will be attached when you accept this reference.')}
                      </p>
                      <ul className="mt-2 space-y-2">
                        {selectedCandidate.pdfs.map((pdf) => (
                          <li key={pdf.id} className="text-xs">
                            <p className="break-words">{pdf.filename}</p>
                            <ExternalTextLink href={pdf.sourceUrl} className="text-xs">
                              {t('Open source')}
                            </ExternalTextLink>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  <section className="py-4">
                    <h3 className="font-medium">{t('Provider')}</h3>
                    <p className="mt-1 text-muted-foreground">
                      {inboxProviderLabel(selectedCandidate.candidate.source.provider)}
                    </p>
                    {selectedCandidate.candidate.source.sourceUrl ? (
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {getExternalLiteratureUrl(selectedCandidate.candidate.source.sourceUrl) ? (
                          <ExternalTextLink href={selectedCandidate.candidate.source.sourceUrl}>
                            {selectedCandidate.candidate.source.sourceUrl}
                          </ExternalTextLink>
                        ) : (
                          selectedCandidate.candidate.source.sourceUrl
                        )}
                      </p>
                    ) : null}
                  </section>
                  {selectedCandidate.candidate.item.identifiers.length > 0 ? (
                    <section className="py-4">
                      <h3 className="font-medium">{t('Identifiers')}</h3>
                      <dl className="mt-2 space-y-2">
                        {selectedCandidate.candidate.item.identifiers.map((identifier) => {
                          const value = normalizeLiteratureIdentifierValue(
                            identifier.scheme,
                            identifier.value
                          )
                          const href = createLiteratureIdentifierUrl(identifier.scheme, value)
                          return (
                            <div
                              key={`${identifier.scheme}:${identifier.value}`}
                              className="flex gap-3"
                            >
                              <dt className="w-16 shrink-0 uppercase text-muted-foreground">
                                {identifier.scheme}
                              </dt>
                              <dd className="min-w-0 break-all">
                                {href ? (
                                  <ExternalTextLink
                                    href={href}
                                    aria-label={`${identifier.scheme.toUpperCase()}: ${value}`}
                                  >
                                    {value}
                                  </ExternalTextLink>
                                ) : (
                                  value
                                )}
                              </dd>
                            </div>
                          )
                        })}
                      </dl>
                    </section>
                  ) : null}
                </div>
                <div className="flex shrink-0 justify-end gap-2 border-t border-border-300/80 px-5 py-4">
                  {selectedCandidate.state === 'dismissed' ? (
                    <Button
                      type="button"
                      disabled={isBatching || Boolean(pendingCandidateId)}
                      onClick={() =>
                        void restoreDismissedCandidates([selectedCandidate.id]).then((restored) => {
                          if (restored) setSelectedCandidate(undefined)
                        })
                      }
                    >
                      <RotateCcw className="size-3.5" aria-hidden="true" />
                      {t('Restore')}
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isBatching || Boolean(pendingCandidateId) || entriesFailed}
                        onClick={() => {
                          void changeCandidateState(selectedCandidate.id, 'dismiss-candidate').then(
                            (updated) => {
                              if (updated) setSelectedCandidate(undefined)
                            }
                          )
                        }}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                        {t('Dismiss')}
                      </Button>
                      <Button
                        type="button"
                        disabled={isBatching || Boolean(pendingCandidateId) || entriesFailed}
                        onClick={() => {
                          void changeCandidateState(selectedCandidate.id, 'accept-candidate').then(
                            (updated) => {
                              if (updated) setSelectedCandidate(undefined)
                            }
                          )
                        }}
                      >
                        <Check className="size-3.5" aria-hidden="true" />
                        {t('Accept')}
                      </Button>
                    </>
                  )}
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          ) : null}
        </Dialog.Root>

        <LiteratureDetailBoundary controller={detailController}>
          {({ item: selectedItem, open, generation }) => (
            <Dialog.Root open={open}>
              {selectedItem ? (
                <Dialog.Portal>
                  {/* Keep the panel and scrim mounted while the portaled preview owns focus.
                    Only release Radix's scroll lock: changing Root.modal remounts Content. */}
                  {!previewItem ? <Dialog.Overlay className="hidden" /> : null}
                  <div
                    aria-hidden="true"
                    data-state={open ? 'open' : 'closed'}
                    className={cn(dialogOverlayClassName, 'pointer-events-auto')}
                    onPointerDownCapture={(event) => {
                      const dialogBounds = selectedItemDialogRef.current?.getBoundingClientRect()
                      const pointInsideDialog = Boolean(
                        dialogBounds &&
                        event.clientX >= dialogBounds.left &&
                        event.clientX <= dialogBounds.right &&
                        event.clientY >= dialogBounds.top &&
                        event.clientY <= dialogBounds.bottom
                      )

                      if (pointInsideDialog) {
                        event.preventDefault()
                        event.stopPropagation()
                      }
                    }}
                    onClick={(event) => {
                      const dialogBounds = selectedItemDialogRef.current?.getBoundingClientRect()
                      const pointInsideDialog = Boolean(
                        dialogBounds &&
                        event.clientX >= dialogBounds.left &&
                        event.clientX <= dialogBounds.right &&
                        event.clientY >= dialogBounds.top &&
                        event.clientY <= dialogBounds.bottom
                      )

                      if (
                        pointInsideDialog ||
                        detailTagMenuOpenRef.current ||
                        detailSelectOpenRef.current ||
                        Date.now() <= childLayerDismissGuardUntilRef.current ||
                        hasLiteratureDetailChildLayer()
                      ) {
                        return
                      }

                      closeSelectedItemDetail()
                    }}
                  />
                  <Dialog.Content
                    ref={selectedItemDialogRef}
                    onCloseAutoFocus={(event) => {
                      event.preventDefault()
                      if (detailController.getSnapshot().open || previewItem) return
                      const initiator = detailInitiatorRef.current
                      if (initiator?.isConnected && !initiator.closest('[inert], [hidden]')) {
                        initiator.focus()
                        if (document.activeElement === initiator && initiator !== document.body)
                          return
                      }
                      libraryEntryRef.current?.focus()
                    }}
                    className={dialogPanelClassName(
                      cn(
                        'flex w-[min(760px,calc(100vw-2rem))] flex-col p-0',
                        metadata.mode === 'full-text'
                          ? 'max-h-[calc(100vh-2rem)]'
                          : 'h-[min(840px,calc(100vh-2rem))]'
                      )
                    )}
                    onInteractOutside={(event) => {
                      event.preventDefault()
                    }}
                    onEscapeKeyDown={(event) => {
                      event.preventDefault()
                      if (
                        detailSelectOpenRef.current ||
                        detailTagMenuOpenRef.current ||
                        Date.now() <= childLayerDismissGuardUntilRef.current
                      ) {
                        return
                      }
                      closeSelectedItemDetail()
                    }}
                  >
                    {discardMetadataDialog}
                    <div className={cn(dialogHeaderClassName, 'shrink-0 items-start px-5 py-3')}>
                      <div className="flex min-w-0 flex-1 items-start gap-2">
                        {metadata.mode !== 'view' ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0"
                            aria-label={t('Back')}
                            disabled={metadata.saving}
                            onClick={leaveMetadataEditor}
                          >
                            <ArrowLeft className="size-4" aria-hidden="true" />
                          </Button>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          {metadata.mode !== 'view' ? (
                            <>
                              <Dialog.Title className={cn(dialogTitleClassName, 'truncate')}>
                                {metadata.mode === 'edit'
                                  ? t('Edit metadata')
                                  : metadata.mode === 'complete'
                                    ? t('Complete metadata')
                                    : metadata.mode === 'full-text'
                                      ? t('Find full-text PDF')
                                      : t('Citation')}
                              </Dialog.Title>
                              <Dialog.Description
                                className={cn(
                                  dialogDescriptionClassName,
                                  'mt-0.5 truncate text-xs'
                                )}
                              >
                                {selectedItem.item.title}
                              </Dialog.Description>
                            </>
                          ) : (
                            <>
                              <div className="mb-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                <span className="rounded bg-bg-200 px-1.5 py-0.5 font-medium text-foreground">
                                  {itemTypeLabels[selectedItem.item.itemType]}
                                </span>
                                {publicationSummary(selectedItem.item) ? (
                                  <span className="min-w-0 break-words">
                                    {publicationSummary(selectedItem.item)}
                                  </span>
                                ) : null}
                              </div>
                              <Dialog.Title
                                className={cn(
                                  dialogTitleClassName,
                                  'line-clamp-3 break-words leading-snug'
                                )}
                              >
                                {selectedItem.item.title}
                              </Dialog.Title>
                              <Dialog.Description className="sr-only">
                                {fullCreatorLabel(selectedItem.item) ||
                                  itemTypeLabels[selectedItem.item.itemType]}
                              </Dialog.Description>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {metadata.mode === 'view' ? (
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="transition-none"
                                aria-label={t('More actions')}
                              >
                                <MoreHorizontal className="size-4" aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() => {
                                  changeDetailMode('edit')
                                }}
                              >
                                <Pencil className="mr-2 size-4" aria-hidden="true" />
                                {t('Edit metadata')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  metadata.resetCompletion()
                                  changeDetailMode('complete')
                                }}
                              >
                                <Search className="mr-2 size-4" aria-hidden="true" />
                                {t('Complete metadata')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => changeDetailMode('full-text')}>
                                <Download className="mr-2 size-4" aria-hidden="true" />
                                {t('Find full-text PDF')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  changeDetailMode('citation')
                                }}
                              >
                                <Quote className="mr-2 size-4" aria-hidden="true" />
                                {t('Citation')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className={dialogCloseButtonClassName}
                          aria-label={t('Close')}
                          disabled={isAddingPdf || metadata.saving}
                          onClick={closeSelectedItemDetail}
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                    {isAddingPdf ? pdfUploadNotice : null}
                    {metadata.mode === 'full-text' ? (
                      <LiteratureFullTextLookup
                        key={`${selectedItem.id}:${selectedItem.metadataRevision}`}
                        item={selectedItem}
                        onCompleteMetadata={() => changeDetailMode('complete')}
                        onUpload={() => {
                          changeDetailMode('view')
                          requestAnimationFrame(() => pdfInputRef.current?.click())
                        }}
                        onAdded={(updated) => {
                          updateMetadataItem(updated)
                          if (detailController.getSnapshot().generation === generation) {
                            detailController.replace(updated)
                            changeDetailMode('view')
                          }
                          void loadEntries(true)
                        }}
                      />
                    ) : metadata.mode === 'edit' ? (
                      <>
                        {metadata.awaitingReload || metadata.externallyUpdated() ? (
                          <ErrorNotice
                            className="mx-5 mt-4 w-auto shrink-0"
                            role="alert"
                            tone="amber"
                            description={
                              metadata.awaitingReload
                                ? t('The reference was saved, but could not be reloaded.')
                                : t(
                                    'This reference changed while you were editing. Your draft has been kept.'
                                  )
                            }
                            primaryButton={
                              metadata.awaitingReload
                                ? {
                                    label: t('Retry'),
                                    loading: metadata.saving,
                                    onClick: () => void metadata.reloadSaved()
                                  }
                                : {
                                    label: t('Load latest version'),
                                    disabled: metadata.saving,
                                    description: t(
                                      'Discard this draft and load the latest saved metadata.'
                                    ),
                                    onClick: metadata.loadLatest
                                  }
                            }
                          />
                        ) : null}
                        <LiteratureMetadataEditor
                          onDirtyChange={trackMetadataDirty}
                          key={`${selectedItem.id}:${metadata.editBase?.metadataRevision}`}
                          item={metadata.editBase?.item ?? selectedItem.item}
                          saving={metadata.saving || metadata.awaitingReload}
                          saveDisabled={
                            metadata.externallyUpdated() || removedDetailItemId === selectedItem.id
                          }
                          error={
                            removedDetailItemId === selectedItem.id
                              ? t('This reference is no longer in your Library.')
                              : metadata.awaitingReload || metadata.externallyUpdated()
                                ? undefined
                                : metadata.error
                          }
                          className="min-h-0 flex-1 max-h-none"
                          onCancel={leaveMetadataEditor}
                          onSave={(item) => void metadata.save(item)}
                        />
                      </>
                    ) : metadata.mode === 'complete' ? (
                      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 text-sm">
                        <LiteratureMetadataLookup
                          key={selectedItem.id}
                          busy={metadata.completing}
                          error={
                            metadata.completionError?.itemId === selectedItem.id
                              ? metadata.completionError.message
                              : undefined
                          }
                          hasResult={Boolean(activeMetadataCompletion)}
                          item={selectedItem}
                          onOpenChange={handleDetailSelectOpenChange}
                          onReset={() => {
                            metadata.resetCompletion()
                          }}
                          onSearch={(identifier) => void metadata.complete('preview', identifier)}
                        >
                          {activeMetadataCompletion ? (
                            <div className="space-y-4">
                              {activeMetadataCompletion.sources?.map((source, index) => (
                                <p key={index} className="text-xs text-muted-foreground">
                                  <ExternalTextLink
                                    href={source.sourceUrl ?? activeMetadataCompletion.sourceUrl}
                                  >
                                    {literatureMetadataProviderLabel(source.provider)}
                                  </ExternalTextLink>
                                </p>
                              ))}
                              {activeMetadataCompletion.failures?.length ? (
                                <p role="status" className="text-sm text-muted-foreground">
                                  {t('Some sources were unavailable. Results may be incomplete.')}
                                </p>
                              ) : null}
                              {activeMetadataCompletion.filled.length > 0 ? (
                                <div>
                                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {activeMetadataCompletion.mode === 'commit'
                                      ? t('Fields completed: {{total}}', {
                                          total: activeMetadataCompletion.filled.length
                                        })
                                      : t('Fields to add: {{total}}', {
                                          total: activeMetadataCompletion.filled.length
                                        })}
                                  </p>
                                  <dl className="mt-2 divide-y divide-border-300/70 rounded-lg border border-border-300/70 bg-bg-000">
                                    {activeMetadataCompletion.filled.map(({ field, value }) => (
                                      <div
                                        key={`${field}:${value}`}
                                        className="grid grid-cols-[7rem_1fr] gap-3 px-3 py-2"
                                      >
                                        <dt className="text-xs text-muted-foreground">
                                          {metadataFieldLabel(field)}
                                        </dt>
                                        <dd className="min-w-0 break-words text-xs">{value}</dd>
                                      </div>
                                    ))}
                                  </dl>
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground">
                                  {t('No missing metadata was found.')}
                                </p>
                              )}
                              {activeMetadataCompletion.conflicts.length > 0 ? (
                                <div>
                                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {t('Existing values kept')}
                                  </p>
                                  <div className="mt-2 space-y-2">
                                    {activeMetadataCompletion.conflicts.map(
                                      ({ currentValue, field, value }) => {
                                        const valuesMatch = metadataValuesMatch(currentValue, value)
                                        const providerLabel = [
                                          ...new Set(
                                            (
                                              activeMetadataCompletion.sources ?? [
                                                { provider: activeMetadataCompletion.provider }
                                              ]
                                            ).map((source) =>
                                              literatureMetadataProviderLabel(source.provider)
                                            )
                                          )
                                        ].join(' / ')
                                        return (
                                          <div
                                            key={field}
                                            className="rounded-lg border border-border-300/70 bg-bg-000 px-3 py-2 text-xs"
                                          >
                                            <p
                                              id={`${accessibilityId}-${field}-label`}
                                              className="font-medium"
                                            >
                                              {metadataFieldLabel(field)}
                                            </p>
                                            <div className="mt-2 grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
                                              <span className="py-1 text-muted-foreground">
                                                {t('Kept')}
                                              </span>
                                              <p className="min-w-0 break-words py-1 leading-5 text-foreground">
                                                {currentValue}
                                              </p>
                                              <span aria-hidden="true" />
                                              <span className="py-1 text-muted-foreground">
                                                {providerLabel}
                                              </span>
                                              <p
                                                id={`${accessibilityId}-${field}-candidate`}
                                                className="min-w-0 break-words py-1 leading-5 text-foreground"
                                              >
                                                {value}
                                              </p>
                                              {valuesMatch ? (
                                                <span className="self-start rounded-full bg-bg-200 px-2 py-1 text-[11px] font-medium text-muted-foreground">
                                                  {t('Unchanged')}
                                                </span>
                                              ) : (
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="sm"
                                                  className="h-8 self-start px-3 text-xs"
                                                  aria-pressed={metadata.overwriteFields.has(field)}
                                                  aria-describedby={`${accessibilityId}-${field}-label ${accessibilityId}-${field}-candidate`}
                                                  onClick={() => metadata.toggleOverwrite(field)}
                                                >
                                                  {metadata.overwriteFields.has(field) ? (
                                                    <Check className="size-3" aria-hidden="true" />
                                                  ) : null}
                                                  {providerLabel === 'PubMed'
                                                    ? t('Use PubMed')
                                                    : providerLabel === 'Crossref'
                                                      ? t('Use Crossref')
                                                      : t('Use {{source}}', {
                                                          source: providerLabel
                                                        })}
                                                </Button>
                                              )}
                                            </div>
                                          </div>
                                        )
                                      }
                                    )}
                                  </div>
                                </div>
                              ) : null}
                              {activeMetadataCompletion.mode === 'preview' &&
                              (activeMetadataCompletion.filled.length > 0 ||
                                metadata.overwriteFields.size > 0) ? (
                                <div className="flex justify-end gap-2 border-t border-border-300/80 pt-4">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={metadata.completing}
                                    onClick={() => metadata.resetCompletion()}
                                  >
                                    {t('Cancel')}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={metadata.completing}
                                    onClick={() => void metadata.complete('commit')}
                                  >
                                    {metadata.completing ? (
                                      <LoaderCircle
                                        className="size-3.5 animate-spin motion-reduce:animate-none"
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <Check className="size-3.5" aria-hidden="true" />
                                    )}
                                    {t('Apply metadata')}
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </LiteratureMetadataLookup>
                      </div>
                    ) : metadata.mode === 'citation' ? (
                      <LiteratureCitationPanel
                        key={`${selectedItem.id}:${selectedItem.metadataRevision}`}
                        initialStyle={citationStyleRef.current}
                        itemId={selectedItem.id}
                        locale={citationLocale}
                        styles={citationStyles}
                        onOpenChange={handleDetailSelectOpenChange}
                        onStyleChange={(style) => {
                          citationStyleRef.current = style
                        }}
                        onManageStyles={() => {
                          closeSelectedItemDetail()
                          setCitationStylesOpen(true)
                        }}
                      />
                    ) : (
                      <div className="relative min-h-0 flex-1 divide-y divide-border-300/80 overflow-y-auto px-5 text-sm">
                        {selectedCollection?.smart && (
                          <section className="space-y-3 py-4">
                            <h3 className="font-medium">{t('Collection decision')}</h3>
                            <SmartRuleSummary rule={selectedCollection.description} />
                            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                              <div className="min-w-0 max-w-full">
                                <SmartCollectionAssessment
                                  inline
                                  onUpdate={() => void updateSmartEvidence()}
                                  updateDisabled={
                                    isBatching ||
                                    smartTableBlocked ||
                                    !smartView?.configured ||
                                    !smartView?.sourceAvailable
                                  }
                                  row={
                                    items.find((item) => item.id === selectedItem.id)
                                      ?.smartDecision ?? selectedItem.smartDecision
                                  }
                                />
                              </div>
                              <SmartCollectionDecisionActions
                                completed={
                                  completedReevaluation?.collectionId === collectionId &&
                                  completedReevaluation?.itemId === selectedItem.id
                                }
                                evaluating={
                                  singleReevaluation?.collectionId === collectionId &&
                                  singleReevaluation?.itemId === selectedItem.id
                                }
                                onReevaluate={() =>
                                  void prepareSmartReevaluation([selectedItem.id])
                                }
                                row={
                                  items.find((item) => item.id === selectedItem.id)
                                    ?.smartDecision ?? selectedItem.smartDecision
                                }
                                disabled={
                                  isBatching ||
                                  pendingDecisions.has(`${collectionId}:${selectedItem.id}`) ||
                                  smartRunningCollection === collectionId
                                }
                                onDecision={(decision) =>
                                  void confirmSmartDecision(decision, [selectedItem.id], true)
                                }
                              />
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {t(
                                'Manual decisions are retained when the collection is updated. Use model decision restores automatic classification.'
                              )}
                            </p>
                          </section>
                        )}
                        {fullCreatorLabel(selectedItem.item) ? (
                          <section className="py-4">
                            <h3 className="font-medium">{t('Authors')}</h3>
                            <CollapsibleAuthors text={fullCreatorLabel(selectedItem.item)} />
                          </section>
                        ) : null}
                        {selectedItem.item.abstract ? (
                          <section className="py-4">
                            <h3 className="font-medium">{t('Abstract')}</h3>
                            <CollapsibleAbstract text={selectedItem.item.abstract} />
                          </section>
                        ) : null}
                        <section className="py-4">
                          <h3 className="font-medium">{t('Publication metadata')}</h3>
                          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                            {[
                              [t('Reference type'), itemTypeLabels[selectedItem.item.itemType]],
                              [t('Year'), selectedItem.item.issuedYear?.toString() ?? ''],
                              [t('Publication'), selectedItem.item.containerTitle],
                              [t('Publisher'), typeFieldText(selectedItem.item, 'publisher')],
                              [t('Volume'), typeFieldText(selectedItem.item, 'volume')],
                              [t('Issue'), typeFieldText(selectedItem.item, 'issue')],
                              [t('Pages'), typeFieldText(selectedItem.item, 'pages')],
                              [t('Language'), selectedItem.item.language]
                            ]
                              .filter((entry): entry is [string, string] => Boolean(entry[1]))
                              .map(([label, value]) => (
                                <div key={label} className="min-w-0">
                                  <dt className="text-xs text-muted-foreground">{label}</dt>
                                  <dd className="mt-0.5 truncate" title={value}>
                                    {value}
                                  </dd>
                                </div>
                              ))}
                          </dl>
                          {selectedItem.item.identifiers.length > 0 ? (
                            <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-border-300/70 pt-3">
                              {selectedItem.item.identifiers.map((identifier) => {
                                const value = normalizeLiteratureIdentifierValue(
                                  identifier.scheme,
                                  identifier.value
                                )
                                const href = createLiteratureIdentifierUrl(identifier.scheme, value)
                                return (
                                  <div
                                    key={`${identifier.scheme}:${identifier.value}`}
                                    className="flex min-w-0 items-baseline gap-2"
                                  >
                                    <dt className="text-xs uppercase text-muted-foreground">
                                      {identifier.scheme}
                                    </dt>
                                    <dd className="min-w-0 break-all">
                                      {href ? (
                                        <ExternalTextLink
                                          href={href}
                                          aria-label={`${identifier.scheme.toUpperCase()}: ${value}`}
                                        >
                                          {value}
                                        </ExternalTextLink>
                                      ) : (
                                        value
                                      )}
                                    </dd>
                                  </div>
                                )
                              })}
                            </dl>
                          ) : null}
                        </section>
                        <LiteratureSources
                          key={`${selectedItem.id}:${selectedItem.metadataRevision}`}
                          itemId={selectedItem.id}
                        />
                        <div className="py-4">
                          <ResourceTagSummary
                            reference={{
                              resourceType: 'literature.item',
                              resourceId: selectedItem.id
                            }}
                            onMenuOpenChange={handleDetailTagMenuOpenChange}
                            keepMenuOpenOnSelect
                          />
                        </div>
                        <div className="grid divide-y divide-border-300/80 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                          <section className="min-w-0 py-4 sm:pr-4">
                            <h3 className="font-medium">{t('Projects')}</h3>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {t('Use this reference in projects.')}
                            </p>
                            <LiteratureDetailLinkList
                              key={`${selectedItem.id}:projects`}
                              checkedIds={selectedItem.projectIds}
                              entries={activeProjects}
                              error={projectLinkError}
                              kind="projects"
                              loaded={projectsLoaded}
                              onCheckedChange={setProjectLink}
                            />
                          </section>
                          <section className="py-4 sm:pl-4">
                            <h3 className="font-medium">{t('Collections')}</h3>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {t('Use this reference in collections.')}
                            </p>
                            <LiteratureDetailLinkList
                              key={`${selectedItem.id}:collections`}
                              checkedIds={selectedItem.collectionIds}
                              entries={displayCollections.filter((collection) => !collection.smart)}
                              error={collectionLinkError}
                              kind="collections"
                              onCheckedChange={setCollectionLink}
                            />
                          </section>
                        </div>
                        <section className="py-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <h3 className="font-medium">{t('Attachments')}</h3>
                            <Button
                              variant="outline"
                              size="sm"
                              className="ml-auto"
                              onClick={() => changeDetailMode('full-text')}
                            >
                              <Download className="size-3.5" aria-hidden="true" />
                              {t('Find full-text PDF')}
                            </Button>
                            {selectedItem.attachments.length > 0 ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={isAddingPdf}
                                onClick={() => pdfInputRef.current?.click()}
                              >
                                {isAddingPdf ? (
                                  <LoaderCircle
                                    className="size-3.5 animate-spin motion-reduce:animate-none"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <FilePlus2 className="size-3.5" aria-hidden="true" />
                                )}
                                {t('Add PDF')}
                              </Button>
                            ) : null}
                            <input
                              ref={pdfInputRef}
                              type="file"
                              accept="application/pdf,.pdf"
                              className="sr-only"
                              aria-label={t('Add PDF')}
                              onChange={(event) => {
                                const file = event.currentTarget.files?.[0]
                                event.currentTarget.value = ''
                                if (file) void addPdf(file)
                              }}
                            />
                          </div>
                          {pdfError ? (
                            <p role="alert" className="mt-2 text-sm text-danger-000">
                              {pdfError}
                            </p>
                          ) : null}
                          <LiteratureAttachments
                            readItem={detailController.read}
                            key={selectedItem.id}
                            item={selectedItem}
                            onPreview={(version) => {
                              const attachment = selectedItem.attachments.find((candidate) =>
                                candidate.versions.some(
                                  (candidateVersion) => candidateVersion.id === version.id
                                )
                              )
                              if (!attachment) return
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
                            }}
                          />
                          {selectedItem.attachments.length === 0 ? (
                            <button
                              type="button"
                              data-slot="literature-pdf-drop-zone"
                              {...pdfDropZoneProps}
                              disabled={isAddingPdf}
                              className="relative mt-2 flex w-full cursor-pointer flex-col items-center gap-2 overflow-hidden rounded-lg border border-dashed border-border bg-muted/20 px-6 py-8 text-center transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
                              onClick={() => pdfInputRef.current?.click()}
                            >
                              {isDraggingPdf ? (
                                <FileDropOverlay
                                  label={t('Drop to upload')}
                                  className="rounded-lg"
                                />
                              ) : null}
                              <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                {isAddingPdf ? (
                                  <LoaderCircle
                                    className="size-4 animate-spin motion-reduce:animate-none"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Upload className="size-4" aria-hidden="true" />
                                )}
                              </span>
                              <span className="text-sm font-medium text-foreground">
                                {t('Add PDF')}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {t('Drag and drop or click to upload')}
                              </span>
                            </button>
                          ) : null}
                        </section>
                      </div>
                    )}
                  </Dialog.Content>
                </Dialog.Portal>
              ) : null}
            </Dialog.Root>
          )}
        </LiteratureDetailBoundary>
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
        <AlertDialog.Root
          open={Boolean(collectionPendingDelete)}
          onOpenChange={(open) => {
            if (!open && !isDeletingCollection) setCollectionPendingDelete(undefined)
          }}
        >
          <AlertDialog.Portal>
            <AlertDialog.Overlay className={dialogOverlayClassName} />
            <AlertDialog.Content
              className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
            >
              <div className={dialogHeaderClassName}>
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Delete “{{name}}”?', {
                    name: dialogCollectionDeletion?.collection.name ?? ''
                  })}
                </AlertDialog.Title>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={dialogCloseButtonClassName}
                  aria-label={t('Close')}
                  disabled={isDeletingCollection}
                  onClick={() => setCollectionPendingDelete(undefined)}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <div className={dialogBodyClassName}>
                <AlertDialog.Description className={dialogDescriptionClassName}>
                  {t(
                    'References in this collection will remain in All references. This action cannot be undone.'
                  )}
                </AlertDialog.Description>
                {promotedCollections.length ? (
                  <div className="mt-3 space-y-2 text-sm">
                    <p>{t('Child collections will move to the top level.')}</p>
                    <ul className="space-y-2">
                      {promotedCollections.map((child) => (
                        <li
                          key={child.id}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span className="min-w-0 break-words">{child.name}</span>
                          {conflictingCollections.some(({ id }) => id === child.id) ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={isDeletingCollection}
                              onClick={() => {
                                setCollectionPendingDelete(undefined)
                                openEditCollection(child)
                              }}
                            >
                              {t('Rename conflicting collection')}
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {conflictingCollections.length ? (
                      <p role="alert">
                        {t(
                          'A child collection would duplicate a top-level name. Rename it before deleting this collection.'
                        )}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {collectionDeleteError ? (
                  <p className="mt-3 text-sm text-danger-000" role="alert">
                    {collectionDeleteError}
                  </p>
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
                    disabled={isDeletingCollection}
                  >
                    {t('Cancel')}
                  </Button>
                </AlertDialog.Cancel>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isDeletingCollection || conflictingCollections.length > 0}
                  onClick={() => void deleteCollection()}
                >
                  {isDeletingCollection ? (
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : null}
                  {t('Delete collection')}
                </Button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
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
        <Dialog.Root
          open={Boolean(pendingLiteratureReading) && !readingProjectFormDialog.dialogProps.open}
          onOpenChange={(open) => {
            if (open || startingReadingProjectId) return
            setReadingProjectQuery('')
            setPendingLiteratureReading(undefined)
            setReadingProjectError(undefined)
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content
              className={dialogPanelClassName(
                'flex max-h-[calc(100svh-2rem)] w-[min(440px,calc(100vw-2rem))] flex-col p-0'
              )}
            >
              <div className={cn(dialogHeaderClassName, 'shrink-0')}>
                <div>
                  <Dialog.Title className={dialogTitleClassName}>
                    {t('Read with agent')}
                  </Dialog.Title>
                  <Dialog.Description className={dialogDescriptionClassName}>
                    {t('Choose a project for this Reading session.')}
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('Close')}
                    disabled={Boolean(startingReadingProjectId)}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </Dialog.Close>
              </div>
              <ScrollArea className="grid min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:h-auto [&>[data-slot=scroll-area-viewport]]:min-h-0">
                <div className={dialogBodyClassName}>
                  {readingProjectError ? (
                    <div className="mb-3">
                      <p role="alert" className="text-sm text-danger-000">
                        {readingProjectError}
                      </p>
                      {readingSelectionEntries ? (
                        <Button
                          className="mt-2"
                          variant="outline"
                          size="sm"
                          disabled={Boolean(startingReadingProjectId)}
                          onClick={() => {
                            setPendingLiteratureReading(undefined)
                            setReadingProjectError(undefined)
                            setBatchReading({ entries: readingSelectionEntries })
                          }}
                        >
                          {t('Back')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {projectsLoaded ? (
                    activeProjects.length > 0 ? (
                      <ProjectPicker
                        projects={activeProjects}
                        query={readingProjectQuery}
                        onQueryChange={setReadingProjectQuery}
                        disabled={Boolean(startingReadingProjectId)}
                        pendingId={startingReadingProjectId}
                        onSelect={(id) => void startReadingInProject(id)}
                      />
                    ) : (
                      <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border-300/80 bg-bg-100 p-4">
                        <FolderPlus className="size-5 text-muted-foreground" aria-hidden="true" />
                        <div>
                          <h3 className="text-sm font-medium">{t('No projects yet')}</h3>
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                            {pendingLiteratureReading && pendingLiteratureReading.length > 1
                              ? t(
                                  'Create a project to keep these papers and their Reading session together.'
                                )
                              : t(
                                  'Create a project to keep this paper and its Reading session together.'
                                )}
                          </p>
                        </div>
                        <Button
                          type="button"
                          disabled={Boolean(startingReadingProjectId)}
                          onClick={readingProjectFormDialog.openCreateDialog}
                        >
                          <FolderPlus className="size-4" aria-hidden="true" />
                          {t('Create project')}
                        </Button>
                      </div>
                    )
                  ) : (
                    <p role="status" className="text-sm text-muted-foreground">
                      {t('Loading…')}
                    </p>
                  )}
                </div>
              </ScrollArea>
              {projectsLoaded && activeProjects.length > 0 ? (
                <div
                  className={`${dialogFooterClassName} shrink-0 flex-wrap items-center [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:h-auto [&_button]:min-h-8 [&_button]:py-1`}
                >
                  <Button
                    type="button"
                    variant="outline"
                    disabled={Boolean(startingReadingProjectId)}
                    onClick={readingProjectFormDialog.openCreateDialog}
                  >
                    <FolderPlus className="size-4" aria-hidden="true" />
                    {t('New project')}
                  </Button>
                </div>
              ) : null}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <ProjectFormDialog {...readingProjectFormDialog.dialogProps} />
        {batchReading ? (
          <LiteratureReadingDialog
            {...batchReading}
            onClose={() => {
              batchReadingRequest.current += 1
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
