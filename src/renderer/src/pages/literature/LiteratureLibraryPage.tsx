import type { TFunction } from 'i18next'
import { LiteratureAttachments } from './LiteratureAttachments'
import { LITERATURE_JOB_MAX_ITEMS } from '../../../../shared/literature-jobs'
import {
  LITERATURE_COLLECTION_NAME_CONFLICT,
  LITERATURE_IMPORT_IDENTITY_CONFLICT
} from '../../../../shared/literature'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { AlertDialog } from 'radix-ui'
import * as Dialog from '@/components/ui/dialog'
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
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { FileDropOverlay } from '@/components/FileDropOverlay'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { ActionToast } from '@/components/ActionToast'
import { ErrorNotice } from '@/components/error-notice'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { Button } from '@/components/ui/button'
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
import { formatUploadSizeLimit } from '../../../../shared/uploads'
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

  return children(collapsed, () => setCollapsed((current) => !current))
}

function LiteratureAddMenu({
  onAddReference,
  onImportPdf,
  onImportReferences
}: Readonly<{
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
          {t('Add')}
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
        <DropdownMenuItem className="gap-2.5" aria-label={t('Import PDF')} onSelect={onImportPdf}>
          <FilePlus2 className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex flex-col">
            <span>{t('Import PDF')}</span>
            <span className="text-xs text-muted-foreground">
              {t('Create a reference from a PDF')}
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
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
          <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void runExport('bibtex')}>
          <FileText className="mr-2 size-4" aria-hidden="true" />
          {t('BibTeX')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void runExport('ris')}>
          <FileText className="mr-2 size-4" aria-hidden="true" />
          {t('RIS')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LiteratureLibraryActionsMenu({
  exportDisabled,
  onExport
}: Readonly<{
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          disabled={status === 'loading'}
          aria-label={t('More actions')}
          title={t('More actions')}
          aria-invalid={status === 'error' || undefined}
          aria-busy={status === 'loading'}
          data-state={status}
        >
          {status === 'loading' ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : status === 'success' ? (
            <Check className="size-4 text-primary" aria-hidden="true" />
          ) : (
            <SlidersHorizontal className="size-4" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>{t('Export')}</DropdownMenuLabel>
        <DropdownMenuItem disabled={exportDisabled} onSelect={() => void runExport('bibtex')}>
          <FileText className="mr-2 size-4" aria-hidden="true" />
          {t('BibTeX')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={exportDisabled} onSelect={() => void runExport('ris')}>
          <FileText className="mr-2 size-4" aria-hidden="true" />
          {t('RIS')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LiteratureRatingControl({
  value,
  onCommit
}: Readonly<{
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
            disabled={isSaving}
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
  onCommit
}: Readonly<{
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
      disabled={isSaving}
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
  onCommit
}: Readonly<{
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
    if (savingRef.current) return
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
        readOnly={isSaving}
        aria-label={t('Note for {{title}}', { title: entry.item.title })}
        aria-busy={isSaving}
        aria-invalid={failed || undefined}
        placeholder={t('Add a note…')}
        className="h-8 border-transparent bg-transparent px-2 text-xs placeholder:text-muted-foreground/70 hover:border-border hover:bg-bg-100 focus-visible:border-border focus-visible:bg-bg-000"
        onFocus={() => {
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
        onBlur={() => void commitNote()}
      />
      {failed ? (
        <div className="flex items-center gap-2 px-2 text-xs text-status-warning-foreground">
          <p role="alert" className="truncate" title={t('Draft preserved. Escape to discard.')}>
            {t('Draft preserved. Escape to discard.')}
          </p>
          <button
            type="button"
            className="shrink-0 underline"
            disabled={isSaving}
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
  const publication = item.shortTitle || item.containerTitle
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
    .trim()

const LITERATURE_REVIEW_CTA_ATTENTION_KEY = 'open-science:literature-review-cta-attention-seen'

const LiteratureLibraryPage = (): React.JSX.Element => {
  const { i18n, t } = useTranslation()
  const goHome = useNavigationStore((state) => state.goHome)
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
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)
  const [shouldCueLiteratureReview, setShouldCueLiteratureReview] = useState(
    () => window.sessionStorage.getItem(LITERATURE_REVIEW_CTA_ATTENTION_KEY) !== 'true'
  )
  const [collectionId, setCollectionId] = useState<string>()
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
  const [isBatching, setIsBatching] = useState(false)
  const [batchLookup, setBatchLookup] = useState<{
    mode: BatchLookupMode
    itemIds: string[]
    jobId?: string
  }>()
  const [permanentDeleteIds, setPermanentDeleteIds] = useState<string[]>([])
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
  const [collections, setCollections] = useState<LiteratureCollectionView[]>([])
  const [projectItemCounts, setProjectItemCounts] = useState<Record<string, number>>({})
  const [selectedCandidate, setSelectedCandidate] = useState<LiteratureInboxCandidateView>()
  const [detailController] = useState(createLiteratureDetailController)
  const selectedItem = detailController.getSnapshot().item
  const selectedItemId = selectedItem?.id
  const [isCreatingItem, setIsCreatingItem] = useState(false)
  const [isSavingNewItem, setIsSavingNewItem] = useState(false)
  const [createItemError, setCreateItemError] = useState<string>()
  const [pendingImportPdf, setPendingImportPdf] = useState<File>()
  const [pendingImportDraft, setPendingImportDraft] = useState<LiteratureItemInput>()
  const [isReadingImportMetadata, setIsReadingImportMetadata] = useState(false)
  const [recordImport, setRecordImport] = useState<RecordImportDraft>()
  const [duplicatePolicy, setDuplicatePolicy] = useState<LiteratureDuplicatePolicy>('reuse')
  const recordImportRequest = useRef(0)

  const [isImportingRecords, setIsImportingRecords] = useState(false)
  const [entriesPageSize, setEntriesPageSize] = useState<LiteraturePageSize>(
    LITERATURE_DEFAULT_PAGE_SIZE
  )
  const [entriesOffset, setEntriesOffset] = useState(0)
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
  const [pdfError, setPdfError] = useState<string>()
  const [projectLinkError, setProjectLinkError] = useState<string>()
  const [collectionLinkError, setCollectionLinkError] = useState<string>()
  const [previewItem, setPreviewItem] = useState<PreviewFileItem>()
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

  const detailInteractionRef = useRef(0)
  const openSelectedItemDetail = useCallback(
    (item: LiteratureItemView): void => {
      detailInteractionRef.current += 1
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
      void window.api.literature.get(itemId).then(
        (item) => {
          if (!active) return
          if (detailInteractionRef.current !== interaction) {
            consumeLiteratureItem(itemId)
            return
          }
          if (item) openSelectedItemDetail(item)
          else setLinkedItemError(t('This reference is no longer in your Library.'))
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
  }, [clearSelection, consumeLiteratureItem, openSelectedItemDetail, pendingLiteratureItemId, t])

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
      setCollectionId(nextCollectionId)
      setProjectId(undefined)
      clearSelection()
      consumeLiteratureCollection(nextCollectionId)
    })
  }, [clearSelection, consumeLiteratureCollection, pendingLiteratureCollectionId])

  const collectionsGenerationRef = useRef(0)
  const loadCollections = useCallback(async (): Promise<void> => {
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
  }, [])

  const loadInboxPendingCount = useCallback(async (): Promise<void> => {
    const page = await window.api.literature.search({
      scope: 'inbox',
      inboxState: 'pending',
      limit: 1
    })
    setInboxPendingCount(page.totalCount ?? page.entries.length)
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
  const entriesKey = useMemo(
    () =>
      JSON.stringify({
        section,
        collectionId,
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
      filterHasPdf,
      entriesPageSize,
      filterItemType,
      filterYearFrom,
      filterYearTo,
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
            inboxState: 'pending',
            query,
            offset,
            limit: entriesPageSize
          }
        : {
            scope: 'library',
            collectionId: section === 'library' ? collectionId : undefined,
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
      entriesOffset,
      entriesPageSize,
      filterHasPdf,
      filterItemType,
      filterYearFrom,
      filterYearTo,
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
      if (request.scope === 'inbox' && !request.query) setInboxPendingCount(totalCount)
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
  const entriesRequest = useMemo(() => buildEntriesRequest(), [buildEntriesRequest])
  const {
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
    onEmptyPage: setEntriesOffset,
    onError: receiveEntriesError
  })
  const updateMetadataItem = (updated: LiteratureItemView): void => {
    const current = detailController.getSnapshot().item
    const latest =
      current?.id === updated.id && current.metadataRevision > updated.metadataRevision
        ? current
        : updated
    void refreshItems([updated.id], [latest])
    setDuplicatesRevision((value) => value + 1)
  }
  const metadata = useLiteratureMetadata(detailController, updateMetadataItem)
  const { changeMode: changeDetailMode } = metadata

  const closeSelectedItemDetail = useCallback((): void => {
    detailInteractionRef.current += 1
    detailTagMenuOpenRef.current = false
    detailSelectOpenRef.current = false
    childLayerDismissGuardUntilRef.current = 0
    detailController.close()
    startTransition(() => {
      setPdfError(undefined)
      changeDetailMode('view')
      setProjectLinkError(undefined)
      setCollectionLinkError(undefined)
    })
  }, [changeDetailMode, detailController])

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
    (force = false, preservePage = false): Promise<void> => {
      if (force) {
        setDuplicatesRevision((value) => value + 1)
        setLibraryCountRevision((value) => value + 1)
      }
      return reloadEntries(force, preservePage)
    },
    [reloadEntries]
  )
  const receiveBackgroundItems = useCallback(
    (itemIds: string[]): void => {
      setDuplicatesRevision((value) => value + 1)
      void Promise.allSettled(itemIds.map((id) => window.api.literature.get(id))).then(
        (results) => {
          const updated = results.flatMap((result) =>
            result.status === 'fulfilled' && result.value ? [result.value] : []
          )
          void refreshItems(itemIds, updated)
          // Data publication follows item identity/revision, not the opening that started the read.
          updated.forEach((item) => detailController.replace(item))
          if (results.some((result) => result.status === 'rejected'))
            setError(t('Literature could not be loaded.'))
        }
      )
    },
    [detailController, refreshItems, t]
  )

  useEffect(() => {
    const loadNavigation = async (): Promise<void> => {
      try {
        await Promise.all([loadCollections(), loadInboxPendingCount(), loadProjectCounts()])
      } catch {
        setError(t('Literature could not be loaded.'))
      }
    }
    void loadNavigation()
  }, [loadCollections, loadInboxPendingCount, loadProjectCounts, t])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setEntriesOffset(0)
      clearSelection()
      setLifecycleFailure(undefined)
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
    section === 'library' && Boolean(reviewProjectId && (selectedProject || selectedCollection))

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
    () => displayCollections.filter((collection) => collection.id !== collectionId),
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
  const visibleOrderedTableColumns = tableColumnOrder.filter((column) =>
    visibleTableColumns.has(column)
  )
  const activeFilterCount =
    (tagId !== 'all' ? 1 : 0) +
    (filterItemType !== 'all' ? 1 : 0) +
    (yearFilter.draftFrom ? 1 : 0) +
    (yearFilter.draftTo ? 1 : 0) +
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
      await loadInboxPendingCount()
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
    setDismissedCandidateUndo((current) => current && { ...current, needsRecheck: true })
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

  const restoreDismissedCandidates = async (): Promise<void> => {
    if (!dismissedCandidateUndo || isBatching || pendingCandidateId) return
    setIsBatching(true)
    setError(undefined)
    setUndoNotice(undefined)
    let remaining = [...dismissedCandidateUndo.candidateIds]
    try {
      if (dismissedCandidateUndo.needsRecheck) {
        await recheckDismissedCandidates(remaining)
        return
      }
      while (remaining.length) {
        const batch = remaining.slice(0, LITERATURE_INBOX_COMMAND_SIZE)
        try {
          await window.api.literature.transact({ kind: 'restore-candidates', candidateIds: batch })
        } catch {
          await recheckDismissedCandidates(remaining)
          return
        }
        remaining = remaining.slice(batch.length)
        setDismissedCandidateUndo(dismissedUndo(remaining))
        setInboxPendingCount((current) =>
          current === undefined ? current : current + batch.length
        )
      }
      await loadEntries(true)
    } finally {
      setIsBatching(false)
    }
  }

  const openCreateCollection = (): void => {
    collectionEditorRef.current?.openCreate()
  }

  const openEditCollection = (collection: LiteratureCollectionView): void => {
    collectionEditorRef.current?.openEdit(collection)
  }

  const deleteCollection = async (): Promise<void> => {
    if (!collectionPendingDelete || isDeletingCollection) return
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
    } finally {
      setIsDeletingCollection(false)
    }
  }

  const selectLibrary = (nextCollectionId?: string): void => {
    setCitationStylesOpen(false)
    setDuplicatesOpen(false)
    setSection('library')
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
    if (!current || isAddingPdf) return
    setIsAddingPdf(true)
    setPdfError(undefined)
    const transferId = crypto.randomUUID()
    let staged: Awaited<ReturnType<typeof stageComposerFile>> | undefined
    try {
      staged = await stageComposerFile(file, window.api.uploads, {
        transferId,
        name: file.name
      })
      await window.api.uploads.claimLocalFile?.({ transferId })
      const receipt = await window.api.literature.importPdf({
        itemId: current.id,
        attachment: staged
      })
      // An attachment receipt may predate metadata edits in a reopened detail. Re-read rather
      // than using metadataRevision as an attachment version or rolling metadata backwards.
      const updated = await window.api.literature.get(current.id).catch(() => undefined)
      detailController.replace(updated ?? receipt.item)
      await loadEntries(true)
    } catch (error) {
      if (detailController.getSnapshot().generation === generation)
        setPdfError(pdfImportErrorMessage(error, t))
    } finally {
      if (staged)
        await window.api.uploads.deleteUpload({ path: staged.path }).catch(() => undefined)
      setIsAddingPdf(false)
    }
  }

  const { isDragging: isDraggingPdf, dropZoneProps: pdfDropZoneProps } = useFileDropZone({
    enabled: !isAddingPdf,
    onFiles: (files) => {
      const pdf = files.find(
        (file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      )
      if (pdf) void addPdf(pdf)
      else setPdfError(t('PDF could not be added.'))
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
          const updated = await window.api.literature.get(entry.id)
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

  const createManualItem = async (item: LiteratureItemInput): Promise<void> => {
    if (isSavingNewItem) return
    setIsSavingNewItem(true)
    setCreateItemError(undefined)
    const file = pendingImportPdf
    const transferId = crypto.randomUUID()
    let staged: Awaited<ReturnType<typeof stageComposerFile>> | undefined
    let createdItemId: string | undefined
    try {
      const receipt = await window.api.literature.transact({
        kind: 'create-item',
        item,
        ...(duplicatePolicy === 'reuse' ? {} : { duplicatePolicy })
      })
      createdItemId = receipt.id
      if (projectId) {
        await window.api.literature.transact({
          kind: 'set-project-item',
          projectId,
          itemId: receipt.id,
          included: true,
          source: 'library'
        })
      } else if (collectionId) {
        await window.api.literature.transact({
          kind: 'set-collection-item',
          collectionId,
          itemId: receipt.id,
          included: true
        })
      }
      const created = file
        ? await (async (): Promise<LiteratureItemView> => {
            staged = await stageComposerFile(file, window.api.uploads, {
              transferId,
              name: file.name
            })
            await window.api.uploads.claimLocalFile?.({ transferId })
            return (
              await window.api.literature.importPdf({ itemId: receipt.id, attachment: staged })
            ).item
          })()
        : await window.api.literature.get(receipt.id)
      if (!created) throw new Error('Literature Item is unavailable after creating.')
      setItems((entries) =>
        entries.some((entry) => entry.id === created.id)
          ? entries.map((entry) => (entry.id === created.id ? created : entry))
          : [created, ...entries]
      )
      if (collectionId) await loadCollections()
      if (projectId) await loadProjectCounts()
      setIsCreatingItem(false)
      setPendingImportPdf(undefined)
      setPendingImportDraft(undefined)
      openSelectedItemDetail(created)
    } catch (error) {
      if (file && createdItemId) {
        const created = await window.api.literature.get(createdItemId).catch(() => undefined)
        if (created) {
          setIsCreatingItem(false)
          setPendingImportPdf(undefined)
          setPendingImportDraft(undefined)
          openSelectedItemDetail(created)
          setPdfError(pdfImportErrorMessage(error, t))
        } else {
          setCreateItemError(t('Literature could not be created.'))
        }
      } else {
        setCreateItemError(t('Literature could not be created.'))
      }
    } finally {
      if (staged)
        await window.api.uploads.deleteUpload({ path: staged.path }).catch(() => undefined)
      if (createdItemId) void loadEntries(true)
      setIsSavingNewItem(false)
    }
  }

  const beginPdfImport = (file: File): void => {
    setDuplicatePolicy('reuse')
    const fallback = { ...emptyLiteratureItem(), title: titleFromPdfFilename(file.name) }
    const generation = ++importMetadataGenerationRef.current
    setPendingImportPdf(file)
    setPendingImportDraft(fallback)
    setCreateItemError(undefined)
    setIsReadingImportMetadata(true)
    setIsCreatingItem(true)
    void import('./literature-pdf-metadata')
      .then(async ({ extractLiteraturePdfDraft, completeLiteraturePdfDraft }) => {
        const local = await extractLiteraturePdfDraft(file, fallback)
        if (importMetadataGenerationRef.current !== generation) return local
        return completeLiteraturePdfDraft(local)
      })
      .then((draft) => {
        if (importMetadataGenerationRef.current === generation) setPendingImportDraft(draft)
      })
      .catch(() => undefined)
      .finally(() => {
        if (importMetadataGenerationRef.current === generation) setIsReadingImportMetadata(false)
      })
  }

  const closeItemEditor = (): void => {
    setDuplicatePolicy('reuse')
    importMetadataGenerationRef.current += 1
    setIsCreatingItem(false)
    setPendingImportPdf(undefined)
    setPendingImportDraft(undefined)
    setIsReadingImportMetadata(false)
    setCreateItemError(undefined)
  }

  const previewRecordImport = async (file: File): Promise<void> => {
    setDuplicatePolicy('reuse')
    const request = ++recordImportRequest.current
    if (file.size > LITERATURE_RECORD_IMPORT_MAX_BYTES) {
      setRecordImport({
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
      setRecordImport({ fileName: file.name, content })
      const preview = await window.api.literature.importRecords({ mode: 'preview', content })
      if (request !== recordImportRequest.current) return
      setRecordImport({ fileName: file.name, content, preview })
    } catch {
      if (request !== recordImportRequest.current) return
      setRecordImport({
        fileName: file.name,
        content: '',
        error: t('Reference file could not be read.')
      })
    }
  }

  const commitRecordImport = async (): Promise<void> => {
    if (!recordImport?.preview || recordImport.preview.items.length === 0) return
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

  const deleteItemsPermanently = async (): Promise<void> => {
    if (permanentDeleteIds.length === 0 || isBatching) return
    setIsBatching(true)
    setError(undefined)
    try {
      await window.api.literature.transact({
        kind: 'delete-items-permanently',
        itemIds: permanentDeleteIds
      })
      clearSelection()
      setPermanentDeleteIds([])
      await Promise.all([loadEntries(true), loadCollections(), loadProjectCounts()])
      await loadTags()
    } catch {
      setError(t('Literature could not be deleted permanently.'))
    } finally {
      setIsBatching(false)
    }
  }

  const previewFirstAttachment = (entry: LiteratureItemView): void => {
    const version = entry.attachments.find((attachment) => attachment.versions[0])?.versions[0]
    if (!version || version.availability === 'unavailable') return
    setPreviewItem({
      id: `literature:${version.id}`,
      sessionId: LITERATURE_PREVIEW_SESSION_ID,
      title: version.filename,
      type: 'file',
      source: 'literature',
      path: createLiteratureAttachmentVersionReference(version.id),
      format: 'pdf',
      name: version.filename,
      mimeType: version.contentType,
      size: version.sizeBytes,
      versionNumber: version.versionNumber
    })
  }

  const requestReadWithAgent = (item: PreviewFileItem): void => {
    setReadingSelectionEntries(undefined)
    const source = resolvePdfContextTarget(item)
    if (!source) return
    setPreviewItem(undefined)
    setReadingProjectError(undefined)
    const reading = [{ item, source }]
    if (selectedProject) {
      void startReadingInProject(selectedProject.id, reading)
      return
    }
    setPendingLiteratureReading(reading)
  }

  const startReadingInProject = async (
    targetProjectId: string,
    reading = pendingLiteratureReading
  ): Promise<void> => {
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
  }

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
            const entry =
              items.find((item) => item.id === id) ?? (await window.api.literature.get(id))
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
          const page = await window.api.literature.search(buildEntriesRequest(offset))
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
          const entries = await Promise.all(batch.map((id) => window.api.literature.get(id)))
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
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border-300/80 bg-bg-000 px-3 py-2">
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
      </div>
    ) : null

  return (
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
                      <h1 className="truncate text-sm font-semibold">{t('Literature library')}</h1>
                      <p className="truncate text-xs text-muted-foreground">
                        {t('Your research references')}
                      </p>
                    </div>
                  </>
                ) : null}
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
                  title={sidebarCollapsed ? t('Expand sidebar panel') : t('Collapse sidebar panel')}
                  onClick={toggleSidebar}
                >
                  <PanelLeft className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <div className="mb-3 border-b border-border-300/80 pb-3">
                <button
                  type="button"
                  className={navButtonClassName}
                  aria-label={t('Back to Home')}
                  title={sidebarCollapsed ? t('Back to Home') : undefined}
                  onClick={() => goHome('user')}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  {!sidebarCollapsed ? <span>{t('Back to Home')}</span> : null}
                </button>
              </div>
              <nav
                id="literature-sidebar-navigation"
                className="space-y-1"
                aria-label={t('Literature library')}
              >
                <button
                  type="button"
                  className={cn(
                    navButtonClassName,
                    !duplicatesOpen && section === 'inbox' && 'bg-bg-300 font-medium'
                  )}
                  aria-label={t('Inbox')}
                  title={sidebarCollapsed ? t('Inbox') : undefined}
                  onClick={() => selectSection('inbox')}
                >
                  <Inbox className="size-4" aria-hidden="true" />
                  {!sidebarCollapsed ? <span>{t('Inbox')}</span> : null}
                  {!sidebarCollapsed && inboxPendingCount !== undefined && inboxPendingCount > 0 ? (
                    <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                      {inboxPendingCount}
                    </span>
                  ) : null}
                  {sidebarCollapsed && inboxPendingCount !== undefined && inboxPendingCount > 0 ? (
                    <span
                      className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
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
                  aria-label={t('All references')}
                  title={sidebarCollapsed ? t('All references') : undefined}
                  onClick={() => selectLibrary()}
                >
                  <BookOpenText className="size-4" aria-hidden="true" />
                  {!sidebarCollapsed ? <span>{t('All references')}</span> : null}
                  <LiteratureLibraryCount
                    revision={libraryCountRevision}
                    hidden={sidebarCollapsed}
                  />
                </button>
                <button
                  type="button"
                  className={cn(navButtonClassName, duplicatesOpen && 'bg-bg-300 font-medium')}
                  aria-label={t('Duplicates')}
                  title={sidebarCollapsed ? t('Duplicates') : undefined}
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
                <button
                  type="button"
                  className={cn(
                    navButtonClassName,
                    !duplicatesOpen && section === 'trash' && 'bg-bg-300 font-medium'
                  )}
                  aria-label={t('Trash')}
                  title={sidebarCollapsed ? t('Trash') : undefined}
                  onClick={() => selectSection('trash')}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  {!sidebarCollapsed ? <span>{t('Trash')}</span> : null}
                </button>
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
                    <button
                      key={project.id}
                      type="button"
                      className={cn(
                        navButtonClassName,
                        !duplicatesOpen && projectId === project.id && 'bg-bg-300 font-medium'
                      )}
                      aria-label={project.name}
                      title={sidebarCollapsed ? project.name : undefined}
                      onClick={() => selectProject(project.id)}
                    >
                      <GalleryVerticalEnd className="size-4" aria-hidden="true" />
                      {!sidebarCollapsed ? (
                        <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                      ) : null}
                      {!sidebarCollapsed ? (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {projectItemCounts[project.id] ?? 0}
                        </span>
                      ) : null}
                    </button>
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      className="text-muted-foreground hover:bg-bg-300 hover:text-foreground active:bg-bg-300 transition-none"
                      aria-label={t('New collection')}
                      aria-haspopup="dialog"
                      title={t('New collection')}
                      onClick={openCreateCollection}
                    >
                      {sidebarCollapsed ? (
                        <FolderPlus className="size-4" aria-hidden="true" />
                      ) : (
                        <Plus className="size-4" aria-hidden="true" />
                      )}
                    </Button>
                  }
                  navButtonClassName={navButtonClassName}
                  selectedId={duplicatesOpen ? undefined : collectionId}
                  showAllLabel={t('Show all collections')}
                  showAllText={t('Show all')}
                  showFewerLabel={t('Show fewer collections')}
                  showLessText={t('Show less')}
                  renderEntry={(collection) => (
                    <button
                      key={collection.id}
                      type="button"
                      className={cn(
                        navButtonClassName,
                        !duplicatesOpen && collectionId === collection.id && 'bg-bg-300 font-medium'
                      )}
                      aria-label={collection.name}
                      title={sidebarCollapsed ? collection.name : undefined}
                      onClick={() => selectLibrary(collection.id)}
                    >
                      <FolderOpen className="size-4" aria-hidden="true" />
                      {!sidebarCollapsed ? (
                        <span className="min-w-0 flex-1 truncate text-left">{collection.name}</span>
                      ) : null}
                      {!sidebarCollapsed ? (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {collection.itemCount}
                        </span>
                      ) : null}
                    </button>
                  )}
                />
              </div>
              <div
                className={cn(
                  'mt-auto space-y-1 border-t border-border-300/80 pt-2',
                  sidebarCollapsed && 'flex flex-col items-center'
                )}
              >
                <button
                  type="button"
                  className={cn(navButtonClassName, citationStylesOpen && 'bg-bg-300 font-medium')}
                  aria-current={citationStylesOpen ? 'page' : undefined}
                  aria-label={t('Settings')}
                  title={sidebarCollapsed ? t('Settings') : undefined}
                  onClick={() => setCitationStylesOpen(true)}
                >
                  <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
                  {!sidebarCollapsed ? <span>{t('Settings')}</span> : null}
                </button>
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
          <div className="flex flex-wrap items-end justify-between gap-4">
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
                      : (selectedProject?.name ?? selectedCollection?.name ?? t('All references'))}
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
                {section === 'library' && selectedCollection ? (
                  <TooltipProvider delayDuration={300}>
                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0"
                              aria-label={t('Collection actions')}
                              onFocus={(event) => {
                                if (!event.currentTarget.matches(':focus-visible')) {
                                  event.preventDefault()
                                }
                              }}
                            >
                              <MoreHorizontal className="size-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent>{t('Collection actions')}</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent align="start" className="min-w-44">
                        <DropdownMenuItem
                          className="gap-2"
                          onSelect={() => openEditCollection(selectedCollection)}
                        >
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            <Pencil className="size-4" aria-hidden="true" />
                          </span>
                          {t('Edit collection')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="gap-2 text-danger-000 focus:bg-danger-900 focus:text-danger-000"
                          onSelect={() => {
                            setCollectionDeleteError(undefined)
                            setCollectionPendingDelete(selectedCollection)
                          }}
                        >
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            <Trash2 className="size-4" aria-hidden="true" />
                          </span>
                          {t('Delete collection')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TooltipProvider>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {section === 'inbox'
                  ? t('Review references found by Agents before they enter your library.')
                  : section === 'trash'
                    ? t('Restore references or delete them permanently.')
                    : selectedProject
                      ? t('References linked to this project.')
                      : selectedCollection
                        ? selectedCollection.description ||
                          t('References saved in this collection.')
                        : t('Search and organize the references you use across projects.')}
              </p>
            </div>
            <div className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-2 sm:w-auto">
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
              {section === 'library' ? (
                <div>
                  <input
                    ref={importPdfInputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    className="sr-only"
                    aria-label={t('Import PDF')}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      event.currentTarget.value = ''
                      if (!file) return
                      beginPdfImport(file)
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

          <div
            data-slot="literature-action-rail"
            className={section === 'inbox' ? 'hidden' : 'mt-4 min-h-12 shrink-0'}
          >
            <LiteratureSelectionBoundary store={selectionStore}>
              {(selection) => {
                const hasSelection = selection.allMatchingSelected || selection.selectedIds.size > 0
                const selectedItemCount = selection.allMatchingSelected
                  ? Math.max(0, entriesTotalCount - selection.excludedMatchingIds.size)
                  : selection.selectedIds.size
                const allLoadedItemsSelected =
                  items.length > 0 &&
                  items.every((item) => isLiteratureItemSelected(selection, item.id))
                return (
                  <div className="flex min-h-12 flex-wrap items-center justify-end gap-2">
                    <LiteratureBackgroundTasks
                      hidden={hasSelection || section === 'inbox'}
                      onOpen={(job) =>
                        setBatchLookup({ mode: job.mode, jobId: job.id, itemIds: [] })
                      }
                      onChanged={receiveBackgroundItems}
                    />
                    {section !== 'inbox' &&
                      (!hasSelection ? (
                        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                          <Select
                            value={sortBy}
                            onValueChange={(value) => {
                              setSortBy(value as typeof sortBy)
                              clearSelection()
                            }}
                          >
                            <SelectTrigger aria-label={t('Sort references')} className="w-52">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="updated">{t('Recently updated')}</SelectItem>
                              <SelectItem value="created">{t('Recently added')}</SelectItem>
                              <SelectItem value="created-asc">{t('First added')}</SelectItem>
                              <SelectItem value="title">{t('Title: A–Z')}</SelectItem>
                              <SelectItem value="title-desc">{t('Title: Z–A')}</SelectItem>
                              <SelectItem value="year">{t('Year: newest first')}</SelectItem>
                              <SelectItem value="year-asc">{t('Year: oldest first')}</SelectItem>
                              <SelectItem value="rating">{t('Highest rated')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button type="button" variant="outline" className="relative">
                                <SlidersHorizontal className="size-4" aria-hidden="true" />
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
                              className="w-72 space-y-4 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-menu"
                            >
                              <p className="text-sm font-medium">{t('Filters')}</p>
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
                                      setFilterItemType(value as LiteratureItemType | 'all')
                                      clearSelection()
                                    }}
                                  >
                                    <SelectTrigger aria-label={t('Reference type')}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="all">{t('All')}</SelectItem>
                                      {Object.entries(itemTypeLabels).map(([value, label]) => (
                                        <SelectItem key={value} value={value}>
                                          {label}
                                        </SelectItem>
                                      ))}
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
                                      <SelectItem value="with">{t('With PDF')}</SelectItem>
                                      <SelectItem value="without">{t('Without PDF')}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                              </>
                              <div className="border-t border-border pt-3">
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="w-full"
                                  disabled={activeFilterCount === 0}
                                  onClick={clearFilters}
                                >
                                  {t('Clear filters')}
                                </Button>
                              </div>
                            </PopoverContent>
                          </Popover>
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
                      ) : (
                        <div
                          data-slot="literature-selection-toolbar"
                          className="flex min-h-12 w-full min-w-0 flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-2 py-1.5"
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
                          <span
                            className="ml-auto hidden h-5 w-px shrink-0 bg-border sm:block"
                            aria-hidden="true"
                          />
                          {section === 'library' ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="shrink-0 whitespace-nowrap"
                              disabled={isBatching || Boolean(startingReadingProjectId)}
                              onClick={() => void requestReadSelection()}
                            >
                              <BookOpenText className="size-3.5" aria-hidden="true" />
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
                              onCreateProject={batchProjectFormDialog.openCreateDialog}
                              onSelectCollection={(id) => void moveSelectedItems(id)}
                              onSelectProject={(id) => void addSelectedItemsToProject(id)}
                            />
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={isBatching}
                              onClick={() => void runLifecycleAction('active')}
                            >
                              <RotateCcw className="size-3.5" aria-hidden="true" />
                              {t('Restore')}
                            </Button>
                          )}
                          <LiteratureExportMenu
                            disabled={isBatching}
                            onExport={exportSelectedItems}
                          />
                          {section === 'library' ||
                          (section === 'trash' &&
                            !selection.allMatchingSelected &&
                            selection.selectedIds.size <= LITERATURE_BATCH_COMMAND_SIZE) ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  className="shrink-0"
                                  aria-label={t('More actions')}
                                  title={t('More actions')}
                                  disabled={isBatching}
                                >
                                  <MoreHorizontal className="size-3.5" aria-hidden="true" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {section === 'library' ? (
                                  <>
                                    <DropdownMenuItem
                                      onSelect={() => void requestBatchLookup('metadata')}
                                    >
                                      <Search className="mr-2 size-4" aria-hidden="true" />
                                      {t('Complete metadata')}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() => void requestBatchLookup('full-text')}
                                    >
                                      <Download className="mr-2 size-4" aria-hidden="true" />
                                      {t('Find full-text PDF')}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {!selection.allMatchingSelected &&
                                    selection.selectedIds.size > 1 &&
                                    selection.selectedIds.size <= 20 ? (
                                      <>
                                        <DropdownMenuItem
                                          onSelect={() => {
                                            const firstSelected = items.find((item) =>
                                              selection.selectedIds.has(item.id)
                                            )
                                            setMergeSurvivorId(firstSelected?.id ?? '')
                                            setMergeFieldSources({})
                                            setMergeError(undefined)
                                            setMergeOpen(true)
                                          }}
                                        >
                                          <Merge className="mr-2 size-4" aria-hidden="true" />
                                          {t('Merge')}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                      </>
                                    ) : null}
                                    <DropdownMenuItem
                                      onSelect={() => void runLifecycleAction('deleted')}
                                    >
                                      <Trash2 className="mr-2 size-4" aria-hidden="true" />
                                      {t('Move to Trash')}
                                    </DropdownMenuItem>
                                  </>
                                ) : (
                                  <>
                                    <DropdownMenuItem
                                      className="text-danger-000 focus:text-danger-000"
                                      onSelect={() =>
                                        setPermanentDeleteIds([...selection.selectedIds])
                                      }
                                    >
                                      <Trash2 className="mr-2 size-4" aria-hidden="true" />
                                      {t('Delete permanently')}
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </div>
                      ))}
                  </div>
                )
              }}
            </LiteratureSelectionBoundary>
          </div>
          {batchLookup ? (
            <LiteratureBatchLookupDialog
              key={batchLookup.jobId ?? `${batchLookup.mode}:${batchLookup.itemIds.join(',')}`}
              {...batchLookup}
              initialItems={items}
              fieldLabel={metadataFieldLabel}
              onClose={() => setBatchLookup(undefined)}
              onChanged={receiveBackgroundItems}
            />
          ) : null}
          {linkFailure && linkFailure.scopeKey === entriesKey ? (
            <div className="mt-2">
              <LiteratureErrorNotice
                className="w-fit max-w-full rounded-md px-3 py-1.5 [&>div]:items-center"
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
                    ? t('The update could not be confirmed. Check the Inbox before trying again.')
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
          {(linkedItemError || error) &&
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
                            loadInboxPendingCount(),
                            loadProjectCounts()
                          ]).catch(() => setError(t('Literature could not be loaded.')))
                        }
                      }
                    : undefined
                }
              />
            </div>
          ) : null}

          <div className="mt-6 flex min-h-0 flex-1 flex-col gap-2">
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
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={isBatching || Boolean(pendingCandidateId)}
                                  onClick={() => void settleSelectedCandidates('dismissed')}
                                >
                                  <X className="size-3.5" aria-hidden="true" />
                                  {t('Dismiss')}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={isBatching || Boolean(pendingCandidateId)}
                                  onClick={() => void settleSelectedCandidates('accepted')}
                                >
                                  <Check className="size-3.5" aria-hidden="true" />
                                  {t('Accept')}
                                </Button>
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
                                  provider: inboxProviderLabel(candidate.candidate.source.provider)
                                })}
                              </span>
                            </div>
                            {item.abstract ? (
                              <p className="mt-3 line-clamp-2 text-[0.8125rem] leading-5 text-muted-foreground">
                                {item.abstract}
                              </p>
                            ) : null}
                          </div>
                          <div className="relative z-10 col-start-2 grid grid-cols-2 gap-2 self-center sm:col-start-auto sm:grid-cols-1">
                            <Button
                              type="button"
                              variant="outline"
                              className="w-full"
                              disabled={isBatching || Boolean(pendingCandidateId)}
                              onClick={() =>
                                void changeCandidateState(candidate.id, 'dismiss-candidate')
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
                                void changeCandidateState(candidate.id, 'accept-candidate')
                              }
                            >
                              <Check className="size-3.5" aria-hidden="true" />
                              {t('Accept')}
                            </Button>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                  {entriesPagination}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-border py-20 text-center">
                  <Inbox className="mx-auto size-7 text-muted-foreground" aria-hidden="true" />
                  <h3 className="mt-3 font-medium">{t('Inbox is clear')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('New Agent discoveries will appear here for review.')}
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
                      style={{ minWidth: tableMinWidth }}
                    >
                      <thead className="sticky top-0 z-40 border-b border-border-300/80 bg-bg-200 text-xs font-medium text-muted-foreground">
                        <tr>
                          <th className="w-11 px-3 py-2.5">
                            <LiteratureSelectPageCheckbox
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
                      <tbody className="divide-y divide-border-300/70">
                        {items.map((entry, itemIndex) => {
                          const attachmentVersion = entry.attachments.find(
                            (attachment) => attachment.versions[0]
                          )?.versions[0]
                          const hasUnavailableAttachment = entry.attachments.some((attachment) =>
                            attachment.versions.some(
                              (version) => version.availability === 'unavailable'
                            )
                          )
                          const rowNumber = entriesOffset + itemIndex + 1
                          return (
                            <tr
                              key={entry.id}
                              className="group h-16 bg-bg-000 hover:bg-bg-200 focus-within:bg-bg-200"
                            >
                              <td className="px-3 py-2 align-middle">
                                <LiteratureSelectionCheckbox
                                  itemId={entry.id}
                                  label={t('Select {{title}}', { title: entry.item.title })}
                                  store={selectionStore}
                                  className="size-4"
                                />
                              </td>
                              <td
                                data-row-number={rowNumber}
                                className="px-2 py-2 text-center align-middle text-xs tabular-nums text-muted-foreground"
                              >
                                {rowNumber}
                              </td>
                              <td className="p-0 align-middle">
                                <LiteratureTextTooltip text={entry.item.title}>
                                  <button
                                    type="button"
                                    className="flex h-full min-h-16 w-full min-w-0 items-center gap-2 px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                    onClick={() => openSelectedItemDetail(entry)}
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
                              {visibleOrderedTableColumns.map((column) => {
                                switch (column) {
                                  case 'abstract':
                                    return (
                                      <LiteratureTextTooltip
                                        key={column}
                                        text={entry.item.abstract}
                                      >
                                        <td
                                          tabIndex={entry.item.abstract ? 0 : undefined}
                                          className="px-3 py-2 align-middle text-muted-foreground"
                                        >
                                          <span className="line-clamp-2 leading-5">
                                            {entry.item.abstract || '—'}
                                          </span>
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
                                      <LiteratureTextTooltip
                                        key={column}
                                        text={entry.item.containerTitle}
                                      >
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
                                      <LiteratureTextTooltip
                                        key={column}
                                        text={fullCreatorLabel(entry.item)}
                                      >
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
                                          key={`${entry.id}:${entry.metadataRevision}:type`}
                                          value={entry.item.itemType}
                                          title={entry.item.title}
                                          labels={itemTypeLabels}
                                          onCommit={(itemType) =>
                                            persistInlineItem(entry, { itemType })
                                          }
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
                                          key={`${entry.id}:${entry.metadataRevision}:rating`}
                                          value={entry.item.rating ?? 0}
                                          onCommit={(rating) =>
                                            persistInlineItem(entry, { rating })
                                          }
                                        />
                                      </td>
                                    )
                                  case 'notes':
                                    return (
                                      <td key={column} className="px-2 py-2 align-middle">
                                        <LiteratureNoteControl
                                          key={entry.id}
                                          entry={entry}
                                          onCommit={(base, personalNote, onPersisted) =>
                                            persistInlineItem(base, { personalNote }, onPersisted)
                                          }
                                        />
                                      </td>
                                    )
                                  case 'url': {
                                    const externalUrl = getExternalLiteratureUrl(entry.item.url)
                                    return (
                                      <td
                                        key={column}
                                        className="px-2 py-2 text-center align-middle text-muted-foreground"
                                      >
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
                                      disabled={attachmentVersion.availability === 'unavailable'}
                                      onClick={() => previewFirstAttachment(entry)}
                                    >
                                      <Paperclip
                                        className="size-4 text-primary"
                                        aria-hidden="true"
                                      />
                                    </Button>
                                  </LiteratureTextTooltip>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                                {hasUnavailableAttachment ? (
                                  <button
                                    type="button"
                                    className="block w-full text-xs text-danger-000"
                                    onClick={() => openSelectedItemDetail(entry)}
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
                                        className="transition-none"
                                      >
                                        <MoreHorizontal className="size-4" aria-hidden="true" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        onSelect={() => openSelectedItemDetail(entry)}
                                      >
                                        <Pencil className="mr-2 size-4" aria-hidden="true" />
                                        {t('Edit')}
                                      </DropdownMenuItem>
                                      {section === 'trash' ? (
                                        <>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem
                                            disabled={isBatching}
                                            onSelect={() =>
                                              void setItemsLifecycle([entry.id], 'active')
                                            }
                                          >
                                            <RotateCcw className="mr-2 size-4" aria-hidden="true" />
                                            {t('Restore')}
                                          </DropdownMenuItem>
                                        </>
                                      ) : null}
                                      {section !== 'trash' ? (
                                        <>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem
                                            disabled={isBatching}
                                            onSelect={() =>
                                              void setItemsLifecycle([entry.id], 'deleted')
                                            }
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
                                            onSelect={() => setPermanentDeleteIds([entry.id])}
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
                        })}
                      </tbody>
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
            ) : (
              <div className="rounded-2xl border border-dashed border-border py-20 text-center">
                <BookOpenText className="mx-auto size-7 text-muted-foreground" aria-hidden="true" />
                <h3 className="mt-3 font-medium">{t('No references found')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('Try a different search or add references from a research session.')}
                </p>
              </div>
            )}
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
          <Dialog.Content className={dialogPanelClassName('w-[min(960px,calc(100vw-2rem))] p-0')}>
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
            <div className="max-h-[60vh] space-y-5 overflow-y-auto p-5">
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
            <div className="flex justify-end gap-2 border-t border-border-300/80 px-5 py-4">
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

      {recordImport ? (
        <LiteratureRecordImportDialog
          recordImport={recordImport}
          duplicatePolicy={duplicatePolicy}
          onDuplicatePolicyChange={setDuplicatePolicy}
          isImportingRecords={isImportingRecords}
          destination={selectedProject?.name ?? selectedCollection?.name ?? t('All references')}
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
          <Dialog.Content className={dialogPanelClassName('w-[min(640px,calc(100vw-2rem))] p-0')}>
            <div className={dialogHeaderClassName}>
              <div>
                <Dialog.Title className={dialogTitleClassName}>
                  {pendingImportPdf ? t('Import PDF') : t('Add reference')}
                </Dialog.Title>
                <Dialog.Description className={dialogDescriptionClassName}>
                  {pendingImportPdf
                    ? t('Review reference details before importing {{name}}.', {
                        name: pendingImportPdf.name
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
            {pendingImportPdf && isReadingImportMetadata ? (
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
                beforeFields={
                  <LiteratureDuplicatePolicyField
                    value={duplicatePolicy}
                    onChange={setDuplicatePolicy}
                    disabled={isSavingNewItem}
                  />
                }
                key={pendingImportPdf?.name ?? 'manual-reference'}
                item={
                  pendingImportDraft ?? {
                    ...emptyLiteratureItem(),
                    title: pendingImportPdf ? titleFromPdfFilename(pendingImportPdf.name) : ''
                  }
                }
                saving={isSavingNewItem}
                error={createItemError}
                onCancel={closeItemEditor}
                onSave={(item) => void createManualItem(item)}
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
            <Dialog.Content className={dialogPanelClassName('w-[min(620px,calc(100vw-2rem))] p-0')}>
              <div className={cn(dialogHeaderClassName, 'px-5 py-3')}>
                <div className="min-w-0">
                  <Dialog.Title className={cn(dialogTitleClassName, 'truncate text-base')}>
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
              <div className="max-h-[70vh] divide-y divide-border-300/80 overflow-y-auto px-5 text-sm">
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
              <div className="flex justify-end gap-2 border-t border-border-300/80 px-5 py-4">
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
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </Dialog.Root>

      <LiteratureDetailBoundary controller={detailController}>
        {({ item: selectedItem, open, generation }) => (
          // The portaled file preview owns focus while open. A lower modal's scroll lock would
          // reject its wheel/touch events because the preview is outside the detail content.
          <Dialog.Root open={open} modal={!previewItem}>
            {selectedItem ? (
              <Dialog.Portal>
                <Dialog.Overlay
                  className={dialogOverlayClassName}
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
                  <div className={cn(dialogHeaderClassName, 'shrink-0 items-start px-5 py-3')}>
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                      {metadata.mode !== 'view' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                          aria-label={t('Back')}
                          onClick={() => {
                            changeDetailMode('view')
                          }}
                        >
                          <ArrowLeft className="size-4" aria-hidden="true" />
                        </Button>
                      ) : null}
                      <div className="min-w-0 flex-1">
                        {metadata.mode !== 'view' ? (
                          <>
                            <Dialog.Title
                              className={cn(dialogTitleClassName, 'truncate text-base')}
                            >
                              {metadata.mode === 'edit'
                                ? t('Edit metadata')
                                : metadata.mode === 'complete'
                                  ? t('Complete metadata')
                                  : metadata.mode === 'full-text'
                                    ? t('Find full-text PDF')
                                    : t('Citation')}
                            </Dialog.Title>
                            <Dialog.Description
                              className={cn(dialogDescriptionClassName, 'mt-0.5 truncate text-xs')}
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
                                'line-clamp-3 break-words text-base leading-snug'
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
                        onClick={closeSelectedItemDetail}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
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
                        key={`${selectedItem.id}:${metadata.editBase?.metadataRevision}`}
                        item={metadata.editBase?.item ?? selectedItem.item}
                        saving={metadata.saving || metadata.awaitingReload}
                        saveDisabled={metadata.externallyUpdated()}
                        error={
                          metadata.awaitingReload || metadata.externallyUpdated()
                            ? undefined
                            : metadata.error
                        }
                        className="min-h-0 flex-1 max-h-none"
                        onCancel={() => changeDetailMode('view')}
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
                                      const providerLabel =
                                        activeMetadataCompletion.provider === 'pubmed'
                                          ? 'PubMed'
                                          : 'Crossref'
                                      return (
                                        <div
                                          key={field}
                                          className="rounded-lg border border-border-300/70 bg-bg-000 px-3 py-2 text-xs"
                                        >
                                          <p className="font-medium">{metadataFieldLabel(field)}</p>
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
                                            <p className="min-w-0 break-words py-1 leading-5 text-foreground">
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
                                                onClick={() => metadata.toggleOverwrite(field)}
                                              >
                                                {metadata.overwriteFields.has(field) ? (
                                                  <Check className="size-3" aria-hidden="true" />
                                                ) : null}
                                                {activeMetadataCompletion.provider === 'pubmed'
                                                  ? t('Use PubMed')
                                                  : t('Use Crossref')}
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
                    <div className="min-h-0 flex-1 divide-y divide-border-300/80 overflow-y-auto px-5 text-sm">
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
                            entries={displayCollections}
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
                          key={selectedItem.id}
                          item={selectedItem}
                          onChanged={(updated) => {
                            if (detailController.getSnapshot().item?.id === updated.id)
                              detailController.replace(updated)
                            updateMetadataItem(updated)
                            void loadEntries(true)
                          }}
                          onPreview={(version) =>
                            setPreviewItem({
                              id: `literature:${version.id}`,
                              sessionId: LITERATURE_PREVIEW_SESSION_ID,
                              title: version.filename,
                              type: 'file',
                              source: 'literature',
                              path: createLiteratureAttachmentVersionReference(version.id),
                              format: 'pdf',
                              name: version.filename,
                              mimeType: version.contentType,
                              size: version.sizeBytes,
                              versionNumber: version.versionNumber
                            })
                          }
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
                              <FileDropOverlay label={t('Drop to upload')} className="rounded-lg" />
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
        onSaved={({ id, name, description }) => {
          if (id) {
            setCollections((current) =>
              current.map((collection) =>
                collection.id === id
                  ? { ...collection, name, description, updatedAt: Date.now() }
                  : collection
              )
            )
          }
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
                {t('Delete “{{name}}”?', { name: collectionPendingDelete?.name ?? '' })}
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
                disabled={isDeletingCollection}
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
                  'This will permanently delete the selected references, their metadata, and attached files. This action cannot be undone.'
                )}
              </AlertDialog.Description>
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
                disabled={isBatching}
                onClick={() => void deleteItemsPermanently()}
              >
                {isBatching ? t('Deleting…') : t('Delete permanently')}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <Dialog.Root
        open={Boolean(pendingLiteratureReading) && !readingProjectFormDialog.dialogProps.open}
        onOpenChange={(open) => {
          if (open || startingReadingProjectId) return
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
                <Dialog.Title className={dialogTitleClassName}>{t('Read with agent')}</Dialog.Title>
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
                    <div className="grid gap-2">
                      {activeProjects.map((project) => (
                        <Button
                          key={project.id}
                          type="button"
                          variant="outline"
                          className="min-w-0 justify-start"
                          disabled={Boolean(startingReadingProjectId)}
                          onClick={() => void startReadingInProject(project.id)}
                        >
                          {startingReadingProjectId === project.id ? (
                            <LoaderCircle
                              className="size-4 animate-spin motion-reduce:animate-none"
                              aria-hidden="true"
                            />
                          ) : (
                            <FolderOpen className="size-4" aria-hidden="true" />
                          )}
                          <span className="truncate">{project.name}</span>
                        </Button>
                      ))}
                    </div>
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
            setReadingProjectError(undefined)
            if (selectedProject) void startReadingInProject(selectedProject.id, documents)
            else setPendingLiteratureReading(documents)
          }}
        />
      ) : null}
      <ProjectFormDialog {...batchProjectFormDialog.dialogProps} />
      <FilePreviewDialog
        item={previewItem}
        allowReadingContext={false}
        onReadWithAgent={requestReadWithAgent}
        onClose={() => {
          setPreviewItem(undefined)
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
        }}
      />
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
          />
        </fieldset>
      ) : null}
    </main>
  )
}

export { LiteratureLibraryPage }
