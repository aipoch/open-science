import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { ComparisonMatrixValue } from './ComparisonMatrixValue'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useTranslation } from 'react-i18next'
import type { LiteratureJobSummary } from '@aipoch/literature-discovery/jobs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Columns3,
  Grid2X2,
  ChevronDown,
  ChevronRight,
  Download,
  FileSearch,
  FolderOpen,
  SlidersHorizontal,
  Info,
  Ellipsis,
  Pencil,
  Plus,
  RotateCw,
  X
} from 'lucide-react'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ErrorNotice } from '@/components/error-notice'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import * as Dialog from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  dialogCloseButtonClassName,
  dialogPanelClassName,
  dialogOverlayClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogBodyClassName,
  dialogFooterClassName,
  dialogDescriptionClassName
} from '@/components/ui/dialog-chrome'
import type {
  ComparisonCell,
  ComparisonLaunchRequest,
  ComparisonRequest,
  ComparisonResult,
  ComparisonTable
} from '../../../../../shared/literature-comparison'
import { LiteratureTable, LiteratureTableScrollArea } from '../LiteratureTable'
import { createLiteratureSelectionStore } from '../list/literature-selection'
import {
  LiteratureSelectPageCheckbox,
  LiteratureSelectionCheckbox
} from '../list/LiteratureSelection'
import { LiteratureSearchInput } from '../list/LiteratureSearchInput'
import { LiteraturePagination } from '../list/LiteraturePagination'
import { LiteratureBackgroundTasks } from '../workflows/LiteratureBackgroundTasks'
import { ComparisonMemberPicker } from './ComparisonMemberPicker'
import { ComparisonCellReview } from './ComparisonCellReview'
import { ComparisonExportDialog } from './ComparisonExportDialog'
import { comparisonCellView, type ComparisonEvidenceTarget } from './comparison-display'
import {
  isPendingComparisonCell,
  isUnattemptedComparisonCell
} from '../../../../../shared/literature-comparison'

const frozenColumnEdge =
  'after:pointer-events-none after:absolute after:inset-y-0 after:left-full after:w-2 after:bg-linear-to-r after:from-foreground/5 after:to-transparent after:opacity-0 group-data-[overflow-left=true]/journal-scroll:after:opacity-100'

export function LiteratureComparisonPage({
  table,
  loadingTableName,
  requestedAction,
  comparisons,
  loadCellHistory,
  loadError,
  onRetryLoad,
  command,
  onChooseReferences,
  onOpenItem,
  onOpenDiscovery,
  onOpenComparison,
  onDraftStatusChange,
  reviewRef
}: {
  comparisons?: React.ComponentProps<typeof LiteratureBackgroundTasks>['comparisons']
  table?: ComparisonTable
  requestedAction?: { tableId: string; action: 'configure' | 'export' }
  loadingTableName?: string
  loadCellHistory?: (tableId: string, cellId: string) => Promise<ComparisonCell>
  loadError?: boolean
  onRetryLoad?: () => void
  command: (request: ComparisonRequest) => Promise<ComparisonResult>
  onChooseReferences: () => void
  onOpenItem: (target: ComparisonEvidenceTarget, onReturn?: () => void) => void | Promise<void>
  onOpenDiscovery: (job: LiteratureJobSummary) => void
  onDraftStatusChange?: (status: { pending: boolean; failed: boolean }) => void
  onOpenComparison: (id: string) => void
  reviewRef?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(table?.name ?? '')
  const [fields, setFields] = useState(
    table?.fields.map(({ id, name, rule }) => ({ id, name, rule })) ?? []
  )
  const [expandedFieldId, setExpandedFieldId] = useState<string | undefined>(fields[0]?.id)
  const fieldNameInput = useRef<HTMLInputElement>(null)
  const [totalsOpen, setTotalsOpen] = useState(false)
  const [policy, setPolicy] = useState(table?.sourcePolicy ?? 'abstract')
  const [editing, setEditing] = useState(!table?.fields.length)
  const [fieldsSaveFailed, setFieldsSaveFailed] = useState(false)
  const [configurationRevision, setConfigurationRevision] = useState(table?.revision ?? 1)
  const [configurationConflict, setConfigurationConflict] = useState(false)
  const configureTrigger = useRef<HTMLButtonElement | null>(null)
  const addFieldOrigin = useRef<HTMLButtonElement | null>(null)
  const [fieldDraft, setFieldDraft] = useState<{
    id: string
    name: string
    rule: string
    revision: number
    ruleOnly: boolean
  }>()
  const [fieldSaveFailed, setFieldSaveFailed] = useState(false)
  const fieldTrigger = useRef<HTMLButtonElement | null>(null)
  const fieldNameErrorId = useId()
  const fieldEditorRef = useRef<HTMLDivElement | null>(null)
  const [picker, setPicker] = useState(false)
  const [sampleOpen, setSampleOpen] = useState(false)
  const [sampleIds, setSampleIds] = useState<string[]>(table?.itemIds.slice(0, 2) ?? [])
  const [selection] = useState(createLiteratureSelectionStore)
  const { selectedIds } = useSyncExternalStore(selection.subscribe, selection.getSnapshot)
  const selectionHintId = useId()
  const [selectedFailures, setSelectedFailures] = useState<string[]>([])
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [query, setQuery] = useState('')
  const [tableView, setTableView] = useState<'all' | 'pending' | 'review' | 'failed'>('all')
  const [reviewStatus, setReviewStatus] = useState({ pending: false, failed: false })
  const [exportBusy, setExportBusy] = useState(false)
  const draftStatus = useRef({
    review: reviewStatus,
    exportBusy: false,
    field: { pending: false, failed: false }
  })
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const reportDraftStatus = useCallback(() => {
    const { review, exportBusy, field } = draftStatus.current
    onDraftStatusChange?.({
      pending: review.pending || exportBusy || field.pending,
      failed: review.failed || field.failed
    })
  }, [onDraftStatusChange])
  const reportReviewStatus = useCallback(
    (status: { pending: boolean; failed: boolean }) => {
      if (!mounted.current) return
      if (
        draftStatus.current.review.pending === status.pending &&
        draftStatus.current.review.failed === status.failed
      )
        return
      draftStatus.current.review = status
      setReviewStatus(status)
      reportDraftStatus()
    },
    [reportDraftStatus]
  )
  const reportExportBusy = useCallback(
    (pending: boolean) => {
      if (!mounted.current) return
      draftStatus.current.exportBusy = pending
      setExportBusy(pending)
      reportDraftStatus()
    },
    [reportDraftStatus]
  )
  const wide = useMediaQuery('(min-width: 1200px)')
  const [selectedCellId, setSelectedCellId] = useState<string>()
  const [cellId, setCellId] = useState<string>()
  const matrixScrollRef = useRef<HTMLDivElement>(null)
  const reviewMatrixPosition = useRef({ left: 0, top: 0 })
  const reviewTrigger = useRef<HTMLButtonElement | null>(null)
  const cellTriggers = useRef(new Map<string, HTMLButtonElement>())
  const filterTrigger = useRef<HTMLButtonElement>(null)
  const [commandBusy, setBusy] = useState(false)
  const busy = commandBusy || exportBusy
  const draftField = table?.fields.find((field) => field.id === fieldDraft?.id)
  const fieldDraftMissing = Boolean(fieldDraft && table && !draftField)
  const fieldDraftChanged = Boolean(
    draftField &&
    fieldDraft &&
    (draftField.name !== fieldDraft.name.trim() || draftField.rule !== fieldDraft.rule.trim())
  )
  const fieldPending = Boolean(
    fieldDraft && (fieldDraftChanged || fieldDraftMissing || commandBusy)
  )
  const fieldFailed = Boolean(fieldDraft && fieldSaveFailed)
  useLayoutEffect(() => {
    const previous = draftStatus.current.field
    if (previous.pending === fieldPending && previous.failed === fieldFailed) return
    draftStatus.current.field = { pending: fieldPending, failed: fieldFailed }
    reportDraftStatus()
  }, [fieldPending, fieldFailed, reportDraftStatus])
  const [error, setError] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    request?: ComparisonLaunchRequest
    singleCell?: boolean
    revision: number
  }>()
  const [sourceChecks, setSourceChecks] = useState<ComparisonResult['sourceChecks']>()
  const [exportOpen, setExportOpen] = useState(false)
  const checkGeneration = useRef(0)
  const resumeTrigger = useRef<HTMLButtonElement | null>(null)
  const taskStatus = useRef<HTMLDivElement | null>(null)
  const currentAdmission = useRef({ table, reviewStatus, editing })
  useLayoutEffect(() => {
    currentAdmission.current = { table, reviewStatus, editing }
  }, [table, reviewStatus, editing])
  const { cellsByItem, memberOrder, matrixCells, fieldsById, membersById } = useMemo(() => {
    const members = table?.members ?? []
    const fields = table?.fields ?? []
    const cells = table?.cells ?? []
    const cellsByItem = new Map<string, Map<string, ComparisonCell>>()
    for (const cell of cells) {
      let byField = cellsByItem.get(cell.itemId)
      if (!byField) {
        byField = new Map()
        cellsByItem.set(cell.itemId, byField)
      }
      byField.set(cell.fieldId, cell)
    }
    const memberOrder = new Map(members.map((member, index) => [member.itemId, index]))
    const fieldOrder = new Map(fields.map((field, index) => [field.id, index]))
    const matrixCells = cells
      .filter((cell) => memberOrder.has(cell.itemId) && fieldOrder.has(cell.fieldId))
      .sort(
        (left, right) =>
          memberOrder.get(left.itemId)! - memberOrder.get(right.itemId)! ||
          fieldOrder.get(left.fieldId)! - fieldOrder.get(right.fieldId)!
      )
    return {
      cellsByItem,
      memberOrder,
      matrixCells,
      fieldsById: new Map(fields.map((field) => [field.id, field])),
      membersById: new Map(members.map((member) => [member.itemId, member]))
    }
  }, [table?.cells, table?.fields, table?.members])
  const running = table?.state === 'running'
  const pausing = table?.state === 'paused' && table.cells.some((cell) => cell.status === 'running')
  const taskActive = running || pausing
  const configure = useCallback(
    (addField = false) => {
      if (!table) return
      setConfigurationRevision(table.revision)
      setConfigurationConflict(false)
      setName(table.name)
      const existing = table.fields.map(({ id, name, rule }) => ({ id, name, rule }))
      const added = addField ? { id: crypto.randomUUID(), name: '', rule: '' } : undefined
      setFields(added ? [...existing, added] : existing)
      setExpandedFieldId(added?.id ?? existing[0]?.id)
      setPolicy(table.sourcePolicy)
      setEditing(true)
      setFieldsSaveFailed(false)
    },
    [table]
  )
  const openExport = useCallback(() => {
    setError(false)
    setExportOpen(true)
  }, [])
  const [handledAction, setHandledAction] = useState<typeof requestedAction>()
  const commitSearch = useCallback(
    (value: string) => {
      setQuery(value.trim().toLocaleLowerCase())
      if (!draftStatus.current.review.pending && !draftStatus.current.review.failed) {
        setCellId(undefined)
        setSelectedCellId(undefined)
      }
      setOffset(0)
      selection.clear()
      setSelectedFailures([])
      if (matrixScrollRef.current) matrixScrollRef.current.scrollTop = 0
    },
    [selection]
  )
  const searchMatches = useMemo(() => {
    if (!query) return undefined
    const ids = new Set<string>()
    for (const member of membersById.values()) {
      if (member.title.toLocaleLowerCase().includes(query)) ids.add(member.itemId)
    }
    for (const cell of matrixCells) {
      if (ids.has(cell.itemId)) continue
      const field = fieldsById.get(cell.fieldId)!
      if (
        comparisonCellView(cell, field, membersById.get(cell.itemId)?.sourceKey)
          .value.toLocaleLowerCase()
          .includes(query)
      )
        ids.add(cell.itemId)
    }
    return ids
  }, [query, matrixCells, membersById, fieldsById])
  if (table && requestedAction && requestedAction !== handledAction) {
    setHandledAction(requestedAction)
    if (!busy && !reviewStatus.pending && !reviewStatus.failed) {
      if (requestedAction.action === 'configure' && !taskActive) configure()
      if (requestedAction.action === 'export') {
        setEditing(false)
        openExport()
      }
    }
  }
  if (!table && loadError)
    return (
      <ErrorNotice
        title={t('Comparison table could not be updated.')}
        primaryButton={{ label: t('Retry'), onClick: () => onRetryLoad?.() }}
      />
    )
  if (!table)
    return (
      <div role="status" aria-label={t('Loading')} className="min-w-0 flex-1 p-6">
        <p className="text-xs font-medium text-muted-foreground">{t('Comparison tables')}</p>
        {loadingTableName && <h1 className="mt-1 text-xl font-semibold">{loadingTableName}</h1>}
        <div aria-hidden="true" className="mt-4 border-t border-border pt-3">
          <div className="mb-4 h-7 w-28 rounded bg-muted" />
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="h-10 bg-muted" />
            {[1, 2, 3].map((row) => (
              <div key={row} className="flex h-9 items-center gap-8 border-t border-border px-4">
                <span className="h-2 w-1/4 rounded bg-muted" />
                <span className="h-2 w-1/6 rounded bg-muted" />
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  const run = async (request: ComparisonRequest): Promise<boolean> => {
    if (draftStatus.current.exportBusy) return false
    setBusy(true)
    setError(false)
    try {
      await command(request)
      return true
    } catch (error) {
      if (request.action === 'update')
        setConfigurationConflict(
          error instanceof Error && error.message.includes('comparison-config-changed')
        )
      setError(true)
      return false
    } finally {
      setBusy(false)
    }
  }

  const resumable = !pausing && ['paused', 'interrupted'].includes(table.state)
  const latestSaved = table.cells
    .flatMap((cell) =>
      cell.history
        .filter(
          (attempt) => attempt.status === 'succeeded' && Number.isFinite(Date.parse(attempt.at))
        )
        .map((attempt) => ({ cell, attempt }))
    )
    .sort((a, b) => Date.parse(b.attempt.at) - Date.parse(a.attempt.at))[0]
  const latestSavedMember = table.members.find(
    (member) => member.itemId === latestSaved?.cell.itemId
  )
  const latestSavedField =
    latestSaved?.attempt.fieldSnapshot ??
    table.fields.find((field) => field.id === latestSaved?.cell.fieldId)
  const taskCellIds = table.taskSources
    ? new Set(table.taskSources.map((source) => source.cellId))
    : undefined
  const remainingTaskCellIds = new Set(table.remainingCellIds)
  const committedTaskCells = taskCellIds
    ? [...taskCellIds].filter((id) => !remainingTaskCellIds.has(id)).length
    : undefined
  const fieldNameDuplicate = Boolean(
    fieldDraft &&
    table.fields.some(
      (field) =>
        field.id !== fieldDraft.id &&
        field.name.trim().toLowerCase() === fieldDraft.name.trim().toLowerCase()
    )
  )
  const fieldDraftValid = Boolean(
    draftField && fieldDraft?.name.trim() && fieldDraft.rule.trim() && !fieldNameDuplicate
  )
  const protectedFieldIds = editing
    ? new Set(
        table.cells.filter((cell) => cell.history.length || cell.manual).map((cell) => cell.fieldId)
      )
    : undefined
  const dismissSourceCheck = (): void => {
    if (busy && sourceChecks) return
    checkGeneration.current++
    setConfirmation(undefined)
    setBusy(false)
  }
  const launchBlocked = taskActive || table.remainingCellIds.length > 0
  const prepare = async (request?: ComparisonLaunchRequest, singleCell = false): Promise<void> => {
    setSampleOpen(false)
    setTotalsOpen(false)
    if (draftStatus.current.exportBusy) return
    const generation = ++checkGeneration.current
    if (request?.action !== 'resume')
      setConfirmation({ request, revision: table.revision, singleCell })
    setSourceChecks(undefined)
    setBusy(true)
    setError(false)
    try {
      const resumeItemIds =
        request?.action === 'resume'
          ? [
              ...new Set(
                table.cells
                  .filter((cell) => table.remainingCellIds.includes(cell.id))
                  .map((cell) => cell.itemId)
              )
            ]
          : undefined
      const itemIds =
        request?.action === 'run' || (singleCell && request?.action === 'rerun-field')
          ? request.itemIds
          : resumeItemIds
      const result = await command({
        action: 'check-sources',
        tableId: table.id,
        ...(itemIds && { itemIds })
      })
      if (
        !result.sourceChecks ||
        result.sourceChecks.length !== (itemIds?.length ?? table.members.length) ||
        itemIds?.some((id) => !result.sourceChecks?.some((check) => check.itemId === id))
      )
        throw new Error('Missing source checks')
      if (!mounted.current || generation !== checkGeneration.current) return
      setSourceChecks(result.sourceChecks)
      if (request?.action === 'resume') {
        const remaining = table.cells.filter((cell) => table.remainingCellIds.includes(cell.id))
        const unchanged =
          remaining.length > 0 &&
          remaining.every((cell) => {
            const admitted = table.taskSources?.find((source) => source.cellId === cell.id)
            const source = result.sourceChecks?.find((check) => check.itemId === cell.itemId)
            return (
              admitted &&
              source?.status === 'available' &&
              admitted.sourceKey === source.sourceKey &&
              admitted.fieldVersion === fieldsById.get(cell.fieldId)?.version
            )
          })
        if (
          unchanged &&
          currentAdmission.current.table?.id === table.id &&
          currentAdmission.current.table.revision === table.revision &&
          !currentAdmission.current.editing &&
          !currentAdmission.current.reviewStatus.pending &&
          !currentAdmission.current.reviewStatus.failed
        ) {
          await command({
            ...request,
            expectedRevision: table.revision,
            expectedSources: result.sourceChecks.map(({ itemId, sourceKey }) => ({
              itemId,
              sourceKey
            })),
            useCurrentSources: false
          })
          if (
            mounted.current &&
            (document.activeElement === resumeTrigger.current ||
              document.activeElement === document.body)
          )
            taskStatus.current?.focus()
        } else {
          setConfirmation({ request, revision: table.revision })
        }
      }
    } catch {
      if (mounted.current && generation === checkGeneration.current) {
        setError(true)
        if (request?.action === 'resume') {
          setConfirmation({ request, revision: table.revision })
          onRetryLoad?.()
        }
      }
    } finally {
      if (mounted.current && generation === checkGeneration.current) setBusy(false)
    }
  }
  const request = confirmation?.request
  const targetCells = !confirmation
    ? []
    : table.cells.filter((cell) => {
        if (!request) return true
        if (request.action === 'resume') return table.remainingCellIds.includes(cell.id)
        if (request.action === 'retry') return request.cellIds.includes(cell.id)
        if (request.action === 'rerun-field')
          return (
            cell.fieldId === request.fieldId &&
            (!request.itemIds || request.itemIds.includes(cell.itemId))
          )
        return (
          request.action === 'run' &&
          (request.unattemptedOnly
            ? isUnattemptedComparisonCell(cell)
            : isPendingComparisonCell(cell)) &&
          (!request.itemIds || request.itemIds.includes(cell.itemId))
        )
      })
  const readyCells = targetCells.filter((cell) =>
    sourceChecks?.some((source) => source.itemId === cell.itemId && source.status === 'available')
  )
  const changedRemaining =
    request?.action === 'resume' &&
    targetCells.some((cell) => {
      const admitted = table.taskSources?.find((source) => source.cellId === cell.id)
      const current = sourceChecks?.find((source) => source.itemId === cell.itemId)
      return (
        admitted &&
        current &&
        (admitted.sourceKey !== current.sourceKey ||
          admitted.fieldVersion !== fieldsById.get(cell.fieldId)?.version)
      )
    })
  const activeCell = table.cells.find((cell) => cell.id === cellId)
  const activeField = table.fields.find((field) => field.id === activeCell?.fieldId)

  const sampleReviewed =
    sampleIds.length > 0 &&
    table.cells
      .filter((cell) => sampleIds.includes(cell.itemId))
      .every((cell) => {
        const field = fieldsById.get(cell.fieldId)
        return (
          field &&
          comparisonCellView(cell, field, membersById.get(cell.itemId)?.sourceKey).confirmed
        )
      })
  const currentResults = table.cells.filter((cell) => {
    const field = fieldsById.get(cell.fieldId)
    return (
      cell.status === 'succeeded' &&
      field &&
      !comparisonCellView(cell, field, membersById.get(cell.itemId)?.sourceKey).stale
    )
  })
  const pendingReview = currentResults.filter((cell) => {
    const field = fieldsById.get(cell.fieldId)!
    return !comparisonCellView(cell, field, membersById.get(cell.itemId)?.sourceKey).confirmed
  })
  const confirmedCount = currentResults.length - pendingReview.length
  const currentResultSet = new Set(currentResults)
  const awaitingReviewCount = table.cells.filter((cell) => {
    const field = fieldsById.get(cell.fieldId)
    if (!field) return false
    const view = comparisonCellView(cell, field, membersById.get(cell.itemId)?.sourceKey)
    return view.needsReview || (currentResultSet.has(cell) && !view.confirmed)
  }).length
  const outdatedRuleCount = table.cells.filter((cell) => {
    const field = fieldsById.get(cell.fieldId)
    return (
      field &&
      ((cell.history.at(-1) && cell.history.at(-1)!.fieldVersion !== field.version) ||
        (cell.manual && cell.manual.fieldVersion !== field.version))
    )
  }).length
  const waitingCount = table.cells.filter((cell) => cell.status === 'unavailable').length
  const pendingCells = table.cells.filter(isPendingComparisonCell)
  const pendingExtractionCount = table.cells.filter((cell) => cell.status === 'pending').length
  const pendingItemIds = new Set(pendingCells.map((cell) => cell.itemId))
  const failedCount = table.cells.filter((cell) => cell.status === 'failed').length
  const reviewItemIds = new Set(pendingReview.map((cell) => cell.itemId))
  const failedItemIds = new Set(
    table.cells
      .filter((cell) => ['failed', 'unavailable'].includes(cell.status))
      .map((cell) => cell.itemId)
  )
  const searchedMembers = searchMatches
    ? table.members.filter((member) => searchMatches.has(member.itemId))
    : table.members
  const byStatus = { pending: pendingItemIds, review: reviewItemIds, failed: failedItemIds }
  const filteredMembers =
    tableView === 'all'
      ? searchedMembers
      : searchedMembers.filter((member) => byStatus[tableView].has(member.itemId))
  const filteredItemIds = new Set(filteredMembers.map((member) => member.itemId))
  const scopedPendingIds = filteredMembers
    .filter((member) => pendingItemIds.has(member.itemId))
    .map((member) => member.itemId)
  const selectedMembers = filteredMembers.filter((member) => selectedIds.has(member.itemId))
  const scopedFailures = selectedFailures.length
    ? matrixCells
        .filter(
          (cell) =>
            cell.status === 'failed' &&
            filteredItemIds.has(cell.itemId) &&
            selectedFailures.includes(cell.id)
        )
        .map((cell) => cell.id)
    : []
  const filtered = Boolean(query) || tableView !== 'all'
  const sampleInScope = !filtered || sampleIds.every((id) => filteredItemIds.has(id))
  // Retain the review row when confirming a cell moves it out of the status filter.
  const visibleMembers = table.members.filter(
    (member) => filteredItemIds.has(member.itemId) || member.itemId === activeCell?.itemId
  )
  const activeRow = visibleMembers.findIndex((member) => member.itemId === activeCell?.itemId)
  // Keep a final one or two references with the preceding page.
  const pageCount = Math.max(1, Math.ceil((visibleMembers.length - 2) / pageSize))
  const lastOffset = (pageCount - 1) * pageSize
  const pageOffset = Math.min(
    lastOffset,
    activeRow >= 0 ? Math.floor(activeRow / pageSize) * pageSize : offset
  )
  const pageMembers = visibleMembers.slice(
    pageOffset,
    pageOffset === lastOffset ? undefined : pageOffset + pageSize
  )
  const pageItemIds = new Set(pageMembers.map((member) => member.itemId))
  const visibleItemIds = new Set(visibleMembers.map((member) => member.itemId))
  const reviewCells = matrixCells.filter((cell) => visibleItemIds.has(cell.itemId))
  const pendingReviewIds = new Set(pendingReview.map((cell) => cell.id))
  const isAwaitingReview = (cell: ComparisonCell): boolean =>
    filteredItemIds.has(cell.itemId) && pendingReviewIds.has(cell.id)
  const awaitingReviewCells = matrixCells.filter(isAwaitingReview)
  const reviewPosition = reviewCells.findIndex((cell) => cell.id === cellId)
  const reviewedCells = reviewCells.filter((cell) => {
    const field = fieldsById.get(cell.fieldId)
    const source = membersById.get(cell.itemId)?.sourceKey
    return field && comparisonCellView(cell, field, source).confirmed
  }).length
  const reviewBlocked = (): boolean =>
    busy || draftStatus.current.review.pending || draftStatus.current.review.failed
  const openReview = (id: string): void => {
    if (reviewBlocked()) return
    setSampleOpen(false)
    setTotalsOpen(false)
    if (!cellId) {
      reviewMatrixPosition.current = {
        left: matrixScrollRef.current?.scrollLeft ?? 0,
        top: matrixScrollRef.current?.scrollTop ?? 0
      }
    }
    setSelectedCellId(id)
    setCellId(id)
    reviewTrigger.current = cellTriggers.current.get(id) ?? reviewTrigger.current
  }
  const closeReview = (): void => {
    setOffset(pageOffset)
    setCellId(undefined)
    requestAnimationFrame(() => {
      if (!wide && matrixScrollRef.current) {
        matrixScrollRef.current.scrollLeft = reviewMatrixPosition.current.left
        matrixScrollRef.current.scrollTop = reviewMatrixPosition.current.top
      }
      const target = [
        cellTriggers.current.get(cellId ?? ''),
        filterTrigger.current,
        reviewTrigger.current
      ].find((node) => node?.isConnected)
      target?.focus({ preventScroll: !wide })
    })
  }
  const changePage = (nextOffset: number): void => {
    if (reviewBlocked()) return
    setOffset(nextOffset)
    setCellId(undefined)
    setSelectedCellId(undefined)
    selection.clear()
    if (matrixScrollRef.current) matrixScrollRef.current.scrollTop = 0
  }
  const navigateReview = (offset: number): void => {
    const next = reviewCells[reviewPosition + offset]
    if (next) openReview(next.id)
  }
  const activePosition = matrixCells.findIndex((cell) => cell.id === cellId)
  const nextAwaitingReview =
    matrixCells.find((cell, index) => index > activePosition && isAwaitingReview(cell)) ??
    awaitingReviewCells.find((cell) => cell.id !== cellId)
  const extractionFinished =
    table.cells.length > 0 &&
    table.cells.every((cell) => !['pending', 'running'].includes(cell.status))
  const taskCompleted =
    table.state === 'completed' &&
    Boolean(table.taskId) &&
    !table.remainingCellIds.length &&
    !table.cells.some((cell) => cell.status === 'running')
  const showSampleSetup =
    !taskActive && !resumable && (!taskCompleted || (!sampleReviewed && pendingCells.length > 0))
  const allReviewed =
    currentResults.length === table.cells.length &&
    table.cells.length > 0 &&
    pendingReview.length === 0
  const duplicateFieldNames = new Set(
    fields
      .map((field) => field.name.trim().toLowerCase())
      .filter((name, index, names) => name && names.indexOf(name) !== index)
  )
  const valid = Boolean(
    name.trim() &&
    fields.length &&
    fields.every((field) => field.name.trim() && field.rule.trim()) &&
    !duplicateFieldNames.size
  )
  const editDisabled = busy || taskActive || editing || reviewStatus.pending || reviewStatus.failed
  const openField = (field: ComparisonTable['fields'][number], ruleOnly: boolean): void => {
    setConfigurationConflict(false)
    setFieldDraft({
      id: field.id,
      name: field.name,
      rule: field.rule,
      revision: table.revision,
      ruleOnly
    })
    setFieldSaveFailed(false)
  }
  const fieldEditor = fieldDraft && draftField && (
    <PopoverContent
      ref={fieldEditorRef}
      data-slot="field-editor-popover"
      aria-labelledby={`${fieldNameErrorId}-title`}
      aria-describedby={fieldDraft.ruleOnly ? undefined : `${fieldNameErrorId}-description`}
      side="bottom"
      align="start"
      sideOffset={6}
      collisionPadding={16}
      className="flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden p-0 text-sm"
      onEscapeKeyDown={(event) => {
        if (event.isComposing || busy) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (busy || fieldDraftChanged || fieldSaveFailed) event.preventDefault()
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        if (fieldTrigger.current?.isConnected) fieldTrigger.current.focus()
      }}
    >
      <div className="shrink-0 border-b border-border px-4 py-2.5">
        <h2 id={`${fieldNameErrorId}-title`} className="text-sm font-semibold">
          {fieldDraft.ruleOnly ? draftField.name : t('Edit {{field}}', { field: draftField.name })}
        </h2>
      </div>
      <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-3">
        {!fieldDraft.ruleOnly && (
          <>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="ml-1 inline-flex flex-wrap gap-x-3 gap-y-1">
                  <span>{t('Current rule: v{{version}}', { version: draftField.version })}</span>
                  {fieldDraftChanged && (
                    <span>
                      {t('After saving: v{{version}}', { version: draftField.version + 1 })}
                    </span>
                  )}
                </span>
              </summary>
              <p id={`${fieldNameErrorId}-description`} className="mt-2 leading-relaxed">
                {t(
                  'Saving a rule revision marks only this column’s previous results as outdated. Manual edits are retained for review.'
                )}
              </p>
            </details>
            <label className="block text-sm font-medium">
              {t('Field name')}
              <Input
                className="mt-1"
                value={fieldDraft.name}
                maxLength={120}
                disabled={busy}
                aria-invalid={fieldNameDuplicate || undefined}
                aria-describedby={fieldNameDuplicate ? fieldNameErrorId : undefined}
                onChange={(event) => setFieldDraft({ ...fieldDraft, name: event.target.value })}
              />
            </label>
          </>
        )}
        {!fieldDraft.ruleOnly && fieldNameDuplicate && (
          <p id={fieldNameErrorId} role="alert" className="text-xs text-destructive">
            {t('Field names must be unique.')}
          </p>
        )}
        <label className="block text-sm font-medium">
          {t('Extraction requirements')}
          <Textarea
            className="mt-1"
            rows={fieldDraft.ruleOnly ? 4 : undefined}
            value={fieldDraft.rule}
            maxLength={4000}
            disabled={busy}
            onChange={(event) => setFieldDraft({ ...fieldDraft, rule: event.target.value })}
          />
        </label>
        {!fieldDraft.ruleOnly && (
          <p className="text-xs text-muted-foreground">
            {t('Answer format: text. List groups and time points separately when needed.')}
          </p>
        )}
        {fieldSaveFailed && (
          <ErrorNotice
            inline
            title={
              configurationConflict
                ? t(
                    'This table changed while you were editing. Copy your draft, then cancel and reopen the editor to load the latest configuration.'
                  )
                : t('Comparison table could not be updated.')
            }
          />
        )}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button variant="ghost" disabled={busy} onClick={() => setFieldDraft(undefined)}>
          {t('Cancel')}
        </Button>
        <Button
          disabled={
            busy ||
            taskActive ||
            !fieldDraftValid ||
            !fieldDraftChanged ||
            reviewStatus.pending ||
            reviewStatus.failed
          }
          onClick={() => {
            setFieldSaveFailed(false)
            void run({
              action: 'update',
              expectedRevision: fieldDraft.revision,
              tableId: table.id,
              name: table.name,
              sourcePolicy: table.sourcePolicy,
              fields: table.fields.map(({ id, name, rule }) =>
                id === fieldDraft.id
                  ? { id, name: fieldDraft.name.trim(), rule: fieldDraft.rule.trim() }
                  : { id, name, rule }
              )
            }).then((saved) => {
              if (!mounted.current) return
              if (saved) setFieldDraft(undefined)
              else setFieldSaveFailed(true)
            })
          }}
        >
          {fieldDraft.ruleOnly ? t('Save') : t('Save rule revision')}
        </Button>
      </div>
    </PopoverContent>
  )
  const protectFieldDraft = (event: React.SyntheticEvent<HTMLDivElement>): void => {
    if (!fieldDraft || (!fieldDraftChanged && !fieldDraftMissing && !fieldSaveFailed && !busy))
      return
    const target = event.target as Node
    if (fieldEditorRef.current?.contains(target)) return
    // A protected draft must not be lost to a background action in the same pointer/keyboard click.
    event.preventDefault()
    event.stopPropagation()
  }
  const sampleReviewTarget = awaitingReviewCells.find((cell) => sampleIds.includes(cell.itemId))
  const sampleStep =
    showSampleSetup &&
    sampleIds.length > 0 &&
    table.fields.length > 0 &&
    (currentResults.length === 0 || (pendingCells.length > 0 && !sampleReviewed))
  const extractSample = (
    <Button
      variant={sampleStep && !sampleReviewTarget ? 'default' : 'outline'}
      disabled={
        busy ||
        launchBlocked ||
        editing ||
        !sampleInScope ||
        !table.fields.length ||
        !sampleIds.length ||
        sampleIds.length > 2
      }
      onClick={() => {
        void prepare({ action: 'run', tableId: table.id, itemIds: sampleIds })
      }}
    >
      {t('Extract sample')}
    </Button>
  )
  const reviewSample = (
    <Button
      variant={sampleStep && sampleReviewTarget ? 'default' : 'outline'}
      disabled={
        busy ||
        !sampleInScope ||
        !sampleReviewTarget ||
        taskActive ||
        editing ||
        reviewStatus.pending ||
        reviewStatus.failed
      }
      onClick={(event) => {
        reviewTrigger.current = event.currentTarget
        if (sampleReviewTarget) openReview(sampleReviewTarget.id)
      }}
    >
      {t('Review sample')}
    </Button>
  )
  const rerunSelected = (fieldId: string): void => {
    void prepare({
      action: 'rerun-field',
      tableId: table.id,
      fieldId,
      itemIds: selectedMembers.map((member) => member.itemId)
    })
  }
  const sampleControls = showSampleSetup && (
    <div className="min-w-0 text-sm">
      <p className="my-2 text-xs text-muted-foreground">
        {t('Select one or two references, then use the selection as a sample.')}
      </p>
      <p className="mb-3 text-xs text-muted-foreground">
        {t('Sample references: {{sample}}', { sample: sampleIds.length })}
        {': '}
        {table.members
          .filter((member) => sampleIds.includes(member.itemId))
          .map((member) => member.title)
          .join(', ')}
      </p>
      <div className="mb-2 flex flex-wrap gap-2">
        {!sampleStep && extractSample}
        {!sampleStep && reviewSample}
      </div>
    </div>
  )
  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-1"
      onKeyDown={(event) => {
        if (
          wide &&
          cellId &&
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          event.currentTarget.contains(event.target as Node) &&
          !reviewBlocked()
        ) {
          event.stopPropagation()
          closeReview()
        }
      }}
      onPointerDownCapture={protectFieldDraft}
      onClickCapture={protectFieldDraft}
    >
      <div className="@container/matrix flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 pt-6 pb-2">
        <header className="mb-3 flex shrink-0 flex-wrap @min-[27rem]/matrix:flex-nowrap items-center justify-between gap-x-3 gap-y-2 border-b border-border pb-3">
          <div className="min-w-0 flex-1 basis-40 @min-[27rem]/matrix:basis-0">
            <h1 className="truncate text-xl font-semibold" title={table.name}>
              {table.name}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span className="hidden @min-[45rem]/matrix:inline">{t('Comparison tables')}</span>
              <Popover open={totalsOpen} onOpenChange={setTotalsOpen}>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-1 text-xs font-normal text-muted-foreground"
                  >
                    <span className="sr-only @min-[45rem]/matrix:not-sr-only">
                      {t('Table totals')} ·{' '}
                    </span>
                    {t('Extracted cells: {{extracted}} / {{total}}', {
                      extracted: currentResults.length,
                      total: table.cells.length
                    })}
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  aria-label={t('Table totals')}
                  className="w-[min(24rem,calc(100vw-2rem))] max-h-[var(--radix-popover-content-available-height)] overflow-auto p-4"
                >
                  <ul
                    aria-label={t('Table totals')}
                    className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground"
                  >
                    <li>{t('Reviewed cells: {{reviewed}}', { reviewed: confirmedCount })}</li>
                    <li>
                      <span>{t('Needs review')}</span>
                      {': '}
                      <span>{awaitingReviewCount}</span>
                    </li>
                    <li>
                      {t('Pending extraction: {{pending}}', { pending: pendingExtractionCount })}
                    </li>
                    <li>
                      {t('Outdated rule cells: {{outdated}}', { outdated: outdatedRuleCount })}
                    </li>
                    <li>
                      <span>{t('Waiting for source')}</span>
                      {': '}
                      <span>{waitingCount}</span>
                    </li>
                    <li>
                      <span>{t('Failed')}</span>
                      {': '}
                      <span>{failedCount}</span>
                    </li>
                  </ul>
                  {!sampleStep && sampleControls}
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <div className="ml-auto flex max-w-full @min-[27rem]/matrix:max-w-[75%] flex-wrap items-center justify-end gap-1.5">
            <>
              {sampleStep && (
                <>
                  {sampleReviewTarget ? reviewSample : extractSample}
                  <Popover open={sampleOpen} onOpenChange={setSampleOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-muted-foreground"
                        title={t('Sample references: {{sample}}', { sample: sampleIds.length })}
                      >
                        <span className="sr-only @min-[45rem]/matrix:not-sr-only">
                          {t('Sample references: {{sample}}', { sample: sampleIds.length })}
                        </span>
                        <span
                          aria-hidden="true"
                          className="flex items-center gap-1 @min-[45rem]/matrix:hidden"
                        >
                          <BookOpen className="size-4" />
                          {sampleIds.length}
                        </span>
                        <ChevronDown className="size-3.5" aria-hidden="true" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      aria-label={t('Sample references: {{sample}}', { sample: sampleIds.length })}
                      className="w-[min(22rem,calc(100vw-2rem))] p-3"
                    >
                      {sampleControls}
                      {sampleReviewTarget && extractSample}
                    </PopoverContent>
                  </Popover>
                </>
              )}
              {!sampleStep && !taskActive && !resumable && scopedPendingIds.length > 0 && (
                <Button
                  variant={sampleReviewed && pendingCells.length > 0 ? 'default' : 'outline'}
                  disabled={
                    busy ||
                    launchBlocked ||
                    editing ||
                    reviewStatus.pending ||
                    reviewStatus.failed ||
                    !sampleReviewed ||
                    !pendingCells.length
                  }
                  onClick={() =>
                    void prepare({
                      action: 'run',
                      tableId: table.id,
                      ...(filtered && { itemIds: scopedPendingIds })
                    })
                  }
                >
                  {t('Extract remaining')}
                </Button>
              )}
              {!taskActive && pendingReview.length > 0 && (
                <Button
                  variant={
                    resumable || sampleStep || (sampleReviewed && pendingCells.length)
                      ? 'outline'
                      : 'default'
                  }
                  disabled={
                    busy ||
                    editing ||
                    reviewStatus.pending ||
                    reviewStatus.failed ||
                    !awaitingReviewCells.length
                  }
                  onClick={(event) => {
                    reviewTrigger.current = event.currentTarget
                    if (awaitingReviewCells[0]) openReview(awaitingReviewCells[0].id)
                  }}
                >
                  {t('Start review ({{count}} cells)', {
                    count: awaitingReviewCells.length,
                    defaultValue_one: 'Start review ({{count}} cell)'
                  })}
                </Button>
              )}
              {running ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run({ action: 'pause', tableId: table.id })}
                >
                  {t('Pause after current cell')}
                </Button>
              ) : (
                !pausing &&
                ['paused', 'interrupted'].includes(table.state) && (
                  <Button
                    ref={resumeTrigger}
                    disabled={
                      busy ||
                      editing ||
                      reviewStatus.pending ||
                      reviewStatus.failed ||
                      !table.remainingCellIds.length
                    }
                    onClick={() => void prepare({ action: 'resume', tableId: table.id })}
                  >
                    {busy
                      ? t('Checking sources…')
                      : t('Continue {{count}} cells', {
                          count: table.remainingCellIds.length,
                          defaultValue_one: 'Continue {{count}} cell'
                        })}
                  </Button>
                )
              )}
              {!taskActive && !resumable && failedCount > 0 && (
                <Button
                  variant="outline"
                  disabled={busy || launchBlocked || editing || !scopedFailures.length}
                  onClick={() => {
                    void prepare({ action: 'retry', tableId: table.id, cellIds: scopedFailures })
                  }}
                >
                  {t('Retry selected cells')}
                </Button>
              )}
            </>
            {!taskActive && (
              <Button
                variant="outline"
                className="px-2 @min-[45rem]/matrix:px-3"
                title={t('Choose references')}
                disabled={busy}
                onClick={() => setPicker(true)}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                <span className="sr-only @min-[45rem]/matrix:not-sr-only">
                  {t('Choose references')}
                </span>
              </Button>
            )}
            <LiteratureBackgroundTasks
              comparisons={comparisons}
              compact
              onOpen={onOpenDiscovery}
              onOpenComparison={onOpenComparison}
              onOpenItem={(itemId, onReturn) => onOpenItem({ kind: 'reference', itemId }, onReturn)}
            />
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={configureTrigger}
                  variant="outline"
                  size="icon"
                  aria-label={t('More actions')}
                  title={t('More actions')}
                  disabled={exportBusy}
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!taskActive && (
                  <DropdownMenuItem className="gap-2" disabled={busy} onSelect={() => configure()}>
                    <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
                    {t('Table settings')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="gap-2"
                  disabled={busy || reviewStatus.pending || reviewStatus.failed}
                  onSelect={openExport}
                >
                  <Download className="size-4 shrink-0" aria-hidden="true" />
                  {t('Export')}
                </DropdownMenuItem>
                {!taskActive && (
                  <DropdownMenuItem
                    className="gap-2"
                    disabled={busy || editing}
                    onSelect={() => void prepare()}
                  >
                    <FileSearch className="size-4 shrink-0" aria-hidden="true" />
                    {t('Check sources')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="gap-2" onSelect={onChooseReferences}>
                  <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
                  {t('Browse collections')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {(error || loadError) && (
          <ErrorNotice
            title={t('Comparison table could not be updated.')}
            primaryButton={{
              label: t('Retry'),
              onClick: () => {
                setError(false)
                window.dispatchEvent(new Event('literature-comparisons-changed'))
              }
            }}
          />
        )}
        {table.issue && (
          <ErrorNotice
            level="warning"
            title={
              table.issue === 'comparison-history-limit'
                ? t('A cell reached the extraction history limit. Its saved history is retained.')
                : t('Extraction stopped. Review the task before continuing.')
            }
          />
        )}
        {editing && (
          <Dialog.Root open onOpenChange={(open) => !open && !busy && setEditing(false)}>
            <Dialog.Portal>
              <Dialog.Overlay className={dialogOverlayClassName} />
              <Dialog.Content
                className={dialogPanelClassName(
                  'flex flex-col overflow-hidden w-[min(42rem,calc(100vw-2rem))] p-0'
                )}
                onOpenAutoFocus={(event) => {
                  if (addFieldOrigin.current && fieldNameInput.current) {
                    event.preventDefault()
                    fieldNameInput.current.focus()
                  }
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault()
                  const origin = addFieldOrigin.current
                  addFieldOrigin.current = null
                  if (origin?.isConnected && !origin.disabled) origin.focus()
                  else configureTrigger.current?.focus()
                }}
              >
                <div className={dialogHeaderClassName}>
                  <Dialog.Title className={dialogTitleClassName}>
                    {t('Table settings')}
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className={dialogCloseButtonClassName}
                      disabled={busy}
                      aria-label={t('Close')}
                      title={t('Close')}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </Dialog.Close>
                </div>
                <div className="shrink-0 grid grid-cols-[minmax(0,1fr)_minmax(8rem,0.5fr)] gap-3 px-5 pt-3">
                  <label className="block text-sm font-medium">
                    {t('Table name')}
                    <Input
                      className="mt-2"
                      value={name}
                      maxLength={160}
                      disabled={busy}
                      aria-invalid={!name.trim() || undefined}
                      aria-describedby={!name.trim() ? `${fieldNameErrorId}-table` : undefined}
                      onChange={(e) => {
                        setName(e.target.value)
                      }}
                    />
                    {!name.trim() && (
                      <span
                        id={`${fieldNameErrorId}-table`}
                        className="mt-1 block text-xs text-destructive"
                      >
                        {t('Required')}
                      </span>
                    )}
                  </label>
                  <label className="block text-sm font-medium">
                    {t('Source policy')}
                    <Select
                      value={policy}
                      disabled={busy}
                      onValueChange={(value) => {
                        setPolicy(value as typeof policy)
                      }}
                    >
                      <SelectTrigger
                        aria-label={t('Source policy')}
                        className="mt-2"
                        title={t(
                          'Actual coverage is recorded for every result. Missing full text waits for a source.'
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="abstract">{t('Abstract only')}</SelectItem>
                        <SelectItem value="full-text">{t('Require full text')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </div>
                <div className="flex shrink-0 items-center justify-between px-5 py-2">
                  <h3 className="text-sm font-medium">{t('Fields')}</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || fields.length >= 12}
                    onClick={() => {
                      const empty = fields.find((entry) => !entry.name.trim() || !entry.rule.trim())
                      const id = empty?.id ?? crypto.randomUUID()
                      if (!empty) {
                        setFields((list) => [...list, { id, name: '', rule: '' }])
                      }
                      setExpandedFieldId(id)
                      requestAnimationFrame(() => fieldNameInput.current?.focus())
                    }}
                  >
                    <Plus aria-hidden="true" />
                    {t('Add field')}
                  </Button>
                </div>
                <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-4">
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {fields.map((field, index) => (
                      <div key={field.id}>
                        {expandedFieldId !== field.id ? (
                          <button
                            type="button"
                            className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm hover:bg-muted/40"
                            aria-expanded={false}
                            onClick={() => setExpandedFieldId(field.id)}
                          >
                            <ChevronRight
                              aria-hidden="true"
                              className="size-4 text-muted-foreground"
                            />
                            {field.name || t('Field name')}
                          </button>
                        ) : (
                          <div className="grid gap-2 p-3">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('Field name')}
                            </span>
                            <div className="flex gap-2">
                              <Input
                                aria-label={t('Field name')}
                                placeholder={t('Field name')}
                                ref={fieldNameInput}
                                value={field.name}
                                maxLength={120}
                                disabled={busy}
                                aria-invalid={
                                  !field.name.trim() ||
                                  duplicateFieldNames.has(field.name.trim().toLowerCase()) ||
                                  undefined
                                }
                                aria-describedby={
                                  !field.name.trim() ||
                                  duplicateFieldNames.has(field.name.trim().toLowerCase())
                                    ? `${fieldNameErrorId}-${field.id}-name`
                                    : undefined
                                }
                                onChange={(e) => {
                                  setFields((list) =>
                                    list.map((entry, i) =>
                                      i === index ? { ...entry, name: e.target.value } : entry
                                    )
                                  )
                                }}
                              />
                              <Button
                                variant="ghost"
                                disabled={busy || protectedFieldIds?.has(field.id)}
                                onClick={() => {
                                  setExpandedFieldId((fields[index + 1] ?? fields[index - 1])?.id)
                                  setFields((list) => list.filter((entry) => entry.id !== field.id))
                                }}
                              >
                                {t('Remove')}
                              </Button>
                            </div>
                            {(!field.name.trim() ||
                              duplicateFieldNames.has(field.name.trim().toLowerCase())) && (
                              <p
                                id={`${fieldNameErrorId}-${field.id}-name`}
                                className="text-xs text-destructive"
                              >
                                {field.name.trim()
                                  ? t('Field names must be unique.')
                                  : t('Required')}
                              </p>
                            )}
                            {protectedFieldIds?.has(field.id) && (
                              <p className="text-xs text-muted-foreground">
                                {t(
                                  'Fields with extraction history or manual edits cannot be removed.'
                                )}
                              </p>
                            )}
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('Extraction requirements')}
                            </span>
                            <Textarea
                              aria-label={t('Extraction requirements')}
                              placeholder={t('Extraction requirements')}
                              value={field.rule}
                              maxLength={4000}
                              disabled={busy}
                              aria-invalid={!field.rule.trim() || undefined}
                              aria-describedby={
                                !field.rule.trim()
                                  ? `${fieldNameErrorId}-${field.id}-rule`
                                  : undefined
                              }
                              onChange={(e) => {
                                setFields((list) =>
                                  list.map((entry, i) =>
                                    i === index ? { ...entry, rule: e.target.value } : entry
                                  )
                                )
                              }}
                            />
                            {!field.rule.trim() && (
                              <p
                                id={`${fieldNameErrorId}-${field.id}-rule`}
                                className="text-xs text-destructive"
                              >
                                {t('Required')}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {fieldsSaveFailed && (
                    <ErrorNotice
                      inline
                      title={
                        configurationConflict
                          ? t(
                              'This table changed while you were editing. Copy your draft, then cancel and reopen the editor to load the latest configuration.'
                            )
                          : t('Comparison table could not be updated.')
                      }
                    />
                  )}
                </div>
                <div className={dialogFooterClassName}>
                  <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                    {t('Cancel')}
                  </Button>
                  <Button
                    disabled={!valid || busy || reviewStatus.pending || reviewStatus.failed}
                    onClick={() => {
                      setFieldsSaveFailed(false)
                      void run({
                        action: 'update',
                        expectedRevision: configurationRevision,
                        tableId: table.id,
                        name: name.trim(),
                        sourcePolicy: policy,
                        fields
                      }).then((saved) => {
                        if (!mounted.current) return
                        if (saved) setEditing(false)
                        else setFieldsSaveFailed(true)
                      })
                    }}
                  >
                    {t('Save')}
                  </Button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
        <section
          className={
            taskActive || resumable || waitingCount > 0 || failedCount > 0
              ? 'mb-3 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2'
              : 'sr-only'
          }
        >
          <h2 className={taskActive || resumable ? 'text-sm font-semibold' : 'sr-only'}>
            {table.state === 'interrupted'
              ? t('Previous extraction was interrupted')
              : resumable
                ? t('Paused')
                : taskCompleted
                  ? pendingReview.length > 0
                    ? t('Current task finished; results need review')
                    : t('Current task finished')
                  : taskActive
                    ? t('Status')
                    : t('Extract and review')}
          </h2>
          <div
            ref={taskStatus}
            tabIndex={-1}
            className={taskActive || resumable ? 'text-xs text-muted-foreground' : 'sr-only'}
            role="status"
            aria-live="polite"
          >
            {busy && resumable && <p>{t('Checking sources…')}</p>}
            {!resumable && (
              <p className="font-medium">
                {pausing
                  ? t('Saving the current cell before pausing…')
                  : running
                    ? t('Running')
                    : table.state === 'paused'
                      ? t('Paused')
                      : table.state === 'interrupted'
                        ? t('Interrupted')
                        : extractionFinished && pendingReview.length > 0
                          ? t('Awaiting review')
                          : allReviewed
                            ? t('Completed')
                            : waitingCount > 0
                              ? t('Waiting for source')
                              : failedCount > 0
                                ? t('Failed')
                                : t('Ready')}
              </p>
            )}
            {table.taskId && (
              <p className="text-xs text-muted-foreground">
                {t('Task: {{id}}', { id: table.taskId })}
              </p>
            )}
            {table.taskId && (
              <p className="text-xs text-muted-foreground">
                {taskCellIds && committedTaskCells !== undefined
                  ? t('Current task progress: {{done}} / {{total}}', {
                      done: committedTaskCells,
                      total: taskCellIds.size
                    })
                  : t('Current task progress unavailable.')}
              </p>
            )}
            {taskActive && (
              <p className="text-xs text-muted-foreground">
                {t('Extraction continues when you leave this page.')}
              </p>
            )}
          </div>

          {waitingCount > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                '{{count}} cells are waiting for sources, separate from failed requests. Add or repair their sources to continue extraction.',
                {
                  count: waitingCount,
                  defaultValue_one:
                    '{{count}} cell is waiting for a source, separate from failed requests. Add or repair its source to continue extraction.'
                }
              )}
            </p>
          )}
          {resumable && (
            <div className={taskActive || resumable ? 'text-xs text-muted-foreground' : 'sr-only'}>
              <p>
                {t(
                  'Saved results and manual edits are retained. {{count}} cells remain in this task.',
                  {
                    count: table.remainingCellIds.length,
                    defaultValue_one:
                      'Saved results and manual edits are retained. {{count}} cell remains in this task.'
                  }
                )}
              </p>
              {latestSavedMember && latestSavedField && (
                <p>
                  {t('Most recently saved: {{reference}} / {{field}}', {
                    reference: latestSavedMember.title,
                    field: latestSavedField.name
                  })}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t(
                  'Only unfinished cells continue. A request whose result has not been saved may be sent again. You can resume after restarting the app.'
                )}
              </p>
            </div>
          )}
          {failedCount > 0 && !resumable && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                'Select failed requests to retry. Insufficient evidence needs review; missing sources need repair.'
              )}
            </p>
          )}
        </section>
        {!table.itemIds.length && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <h2 className="font-medium">{t('Add references to begin')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('You can configure the fields before adding references.')}
            </p>
          </div>
        )}
        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
          {selectedMembers.length > 0 && (
            <>
              <span
                role="status"
                className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
              >
                {t('Selected references: {{selected}}', {
                  selected: String(selectedMembers.length).padStart(
                    String(pageMembers.length).length,
                    '\u2007'
                  )
                })}
              </span>
              {table.fields.length > 0 && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy ||
                        launchBlocked ||
                        editing ||
                        reviewStatus.pending ||
                        reviewStatus.failed
                      }
                    >
                      {t('Re-extract a column')}
                      <ChevronDown aria-hidden="true" className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {table.fields.map((field) => (
                      <DropdownMenuItem key={field.id} onSelect={() => rerunSelected(field.id)}>
                        {field.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button size="sm" variant="ghost" onClick={() => selection.clear()}>
                {t('Clear selection')}
              </Button>
              {showSampleSetup && selectedMembers.length <= 2 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || editing || reviewStatus.pending || reviewStatus.failed}
                  onClick={() => {
                    setSampleIds(selectedMembers.map((member) => member.itemId))
                    selection.clear()
                  }}
                >
                  {t('Use selection as sample')}
                </Button>
              )}
            </>
          )}
          {!selectedMembers.length &&
            scopedPendingIds.length > 0 &&
            (!sampleStep || tableView === 'pending') && (
              <Button
                disabled={
                  busy ||
                  launchBlocked ||
                  editing ||
                  !sampleReviewed ||
                  !pendingCells.length ||
                  reviewStatus.pending ||
                  reviewStatus.failed
                }
                onClick={() =>
                  void prepare({
                    action: 'run',
                    tableId: table.id,
                    itemIds: scopedPendingIds
                  })
                }
              >
                {t('Extract pending references')} ({scopedPendingIds.length})
              </Button>
            )}
          <div className="ml-auto flex w-[29.5rem] min-w-0 max-w-full items-center justify-end gap-2">
            <LiteratureSearchInput
              className="w-auto sm:w-auto sm:flex-1"
              label={t('Search titles and results')}
              initialValue={query}
              resetRevision={0}
              onDraftChange={selection.clear}
              onCommit={commitSearch}
            />
            <Select
              value={tableView}
              onValueChange={(value) => {
                setOffset(0)
                setSelectedFailures([])
                selection.clear()
                setTableView(value as typeof tableView)
              }}
            >
              <SelectTrigger
                ref={filterTrigger}
                aria-label={t('Filters')}
                className="w-auto max-w-[52%] shrink-0 sm:min-w-36"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All references')}</SelectItem>
                <SelectItem value="pending">
                  {t('Pending references')} (
                  {searchedMembers.filter((member) => pendingItemIds.has(member.itemId)).length})
                </SelectItem>
                <SelectItem value="review">
                  {t('Ready for review')} (
                  {searchedMembers.filter((member) => reviewItemIds.has(member.itemId)).length})
                </SelectItem>
                <SelectItem value="failed">
                  {t('Failed / unavailable')} (
                  {searchedMembers.filter((member) => failedItemIds.has(member.itemId)).length})
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {filtered && !visibleMembers.length && (
            <p role="status" className="w-full text-sm">
              {!query && tableView === 'pending'
                ? t('No references awaiting extraction.')
                : t('No matching references')}
            </p>
          )}
        </div>
        <div
          className={`isolate flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border-300/80 bg-bg-000 ${pageMembers.length > 3 ? 'min-h-40' : 'shrink-0'}`}
        >
          <LiteratureTableScrollArea
            viewportRef={matrixScrollRef}
            data-slot="comparison-matrix-scroll"
            aria-label={t('Comparison matrix')}
            className="relative flex-auto [scrollbar-gutter:auto]"
          >
            <div
              aria-hidden="true"
              data-slot="comparison-horizontal-scroll-hint"
              className="pointer-events-none absolute inset-y-0 right-0 z-20 flex w-8 items-center justify-center bg-linear-to-l from-bg-000 via-bg-000/80 to-transparent text-muted-foreground/70 opacity-0 transition-opacity group-data-[overflow-right=true]/journal-scroll:opacity-100"
            >
              <ChevronRight className="size-4" />
            </div>
            <LiteratureTable
              className="w-full table-fixed border-separate border-spacing-0 text-left text-sm [--record-width:clamp(9rem,20cqw,15rem)]"
              style={{
                minWidth: `calc(var(--record-width) + ${5 + (table.fields.length < 12 ? 2.5 : 0) + table.fields.length * 10}rem)`
              }}
            >
              <caption className="sr-only">{t('Comparison matrix')}</caption>
              <colgroup>
                <col className="w-10" />
                <col className="w-10" />
                <col className="w-[var(--record-width)]" />
                {table.fields.map((field) => (
                  <col key={field.id} />
                ))}
                {table.fields.length < 12 && <col className="w-10" />}
              </colgroup>
              <thead className="bg-bg-200 text-xs font-medium text-muted-foreground [&_th]:border-b [&_th]:border-border-300/80">
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 top-0 z-30 w-10 min-w-10 max-w-10 border-r border-border-300/80 bg-bg-200 px-1 text-center tabular-nums"
                  >
                    <LiteratureSelectPageCheckbox
                      store={selection}
                      itemIds={[...pageItemIds]}
                      label={t('Select all references')}
                      disabled={busy || taskActive || !pageMembers.length}
                      className="size-4 align-middle"
                    />
                  </th>
                  <th
                    scope="col"
                    className="sticky left-10 top-0 z-30 w-10 min-w-10 max-w-10 border-r border-border-300/80 bg-bg-200 px-1 text-center tabular-nums"
                  >
                    #
                  </th>
                  <th
                    scope="col"
                    className={`sticky left-20 top-0 z-30 border-r border-border bg-bg-200 px-2 py-2 ${frozenColumnEdge}`}
                  >
                    {t('Bibliographic record')}
                  </th>
                  {table.fields.map((field) => (
                    <th
                      key={field.id}
                      scope="col"
                      aria-label={field.name}
                      className={`sticky top-0 z-20 border-l border-border bg-bg-200 px-3 py-1.5`}
                    >
                      <div className="flex min-w-0 items-center gap-1">
                        <Popover
                          open={fieldDraft?.id === field.id}
                          onOpenChange={(open) => {
                            if (busy) return
                            if (open) openField(field, false)
                            else setFieldDraft(undefined)
                          }}
                        >
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              aria-label={t('Edit field')}
                              title={field.name}
                              className="min-w-0 truncate rounded-sm text-left font-semibold focus-visible:keyboard-focus"
                              disabled={editDisabled}
                              onClick={(event) => {
                                fieldTrigger.current = event.currentTarget
                              }}
                            >
                              {field.name}
                            </button>
                          </PopoverTrigger>
                          {fieldDraft?.id === field.id && fieldEditor}
                        </Popover>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                aria-label={`${field.name} · ${t('Extraction requirements')}`}
                                aria-disabled={editDisabled}
                                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:keyboard-focus"
                                onFocus={(event) => {
                                  if (!event.currentTarget.matches(':focus-visible'))
                                    event.preventDefault()
                                }}
                                onClick={(event) => {
                                  if (!editDisabled) {
                                    fieldTrigger.current = event.currentTarget
                                    openField(field, true)
                                  }
                                }}
                              >
                                <Info aria-hidden="true" className="size-3.5" />
                              </button>
                            </TooltipTrigger>
                            {fieldDraft?.id !== field.id && (
                              <TooltipContent
                                side="top"
                                className="max-h-64 max-w-sm overflow-y-auto whitespace-pre-wrap"
                              >
                                <span className="block font-medium">
                                  {t('Rule v{{version}}', { version: field.version })}
                                </span>
                                {field.rule}
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </TooltipProvider>
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`${field.name} · ${t('More actions')}`}
                              className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded hover:bg-background/60 focus-visible:keyboard-focus aria-expanded:bg-background/60"
                              onPointerDown={(e) => {
                                if (!fieldDraft) fieldTrigger.current = e.currentTarget
                              }}
                              onKeyDown={(e) => {
                                if (!fieldDraft) fieldTrigger.current = e.currentTarget
                              }}
                            >
                              <ChevronDown aria-hidden="true" className="size-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            onCloseAutoFocus={(event) => {
                              if (fieldEditorRef.current) event.preventDefault()
                            }}
                          >
                            <DropdownMenuItem
                              className="gap-2"
                              disabled={editDisabled}
                              onSelect={() => openField(field, false)}
                            >
                              <Pencil className="size-4 shrink-0" aria-hidden="true" />
                              {t('Edit field')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2"
                              disabled={editDisabled}
                              onSelect={() => openField(field, true)}
                            >
                              <Info className="size-4 shrink-0" aria-hidden="true" />
                              {t('Extraction requirements')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2"
                              disabled={busy || launchBlocked || editing || !selectedMembers.length}
                              aria-describedby={
                                !selectedMembers.length ? selectionHintId : undefined
                              }
                              onSelect={() => rerunSelected(field.id)}
                            >
                              <RotateCw className="size-4 shrink-0" aria-hidden="true" />
                              {t('Rerun column')}
                            </DropdownMenuItem>
                            {!selectedMembers.length && (
                              <p
                                id={selectionHintId}
                                className="max-w-60 px-2 py-1 text-xs text-muted-foreground"
                              >
                                {t('Select references in the matrix before rerunning a column.')}
                              </p>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </th>
                  ))}
                  {table.fields.length < 12 && (
                    <th
                      scope="col"
                      className="sticky top-0 z-20 w-10 border-l border-border bg-bg-200 px-1 text-center"
                    >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={editDisabled}
                        aria-label={t('Add field')}
                        title={t('Add field')}
                        onClick={(event) => {
                          addFieldOrigin.current = event.currentTarget
                          configure(true)
                        }}
                      >
                        <Plus aria-hidden="true" />
                      </Button>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="[&_tr+tr>td]:border-t [&_tr+tr>th]:border-t [&_tr+tr>*]:border-border-300/70">
                {pageMembers.map((member) => (
                  <tr key={member.itemId} className="border-t border-border">
                    <td className="sticky left-0 z-10 w-10 min-w-10 max-w-10 border-r border-border-300/80 bg-bg-000 px-1 text-center text-xs tabular-nums text-muted-foreground">
                      <LiteratureSelectionCheckbox
                        store={selection}
                        itemId={member.itemId}
                        label={t('Select {{title}}', { title: member.title })}
                        disabled={taskActive || busy}
                        className="size-4 align-middle"
                      />
                    </td>
                    <td className="sticky left-10 z-10 w-10 min-w-10 max-w-10 border-r border-border-300/80 bg-bg-000 px-1 text-center text-xs tabular-nums text-muted-foreground">
                      {memberOrder.get(member.itemId)! + 1}
                    </td>
                    <th
                      scope="row"
                      className={`sticky left-20 z-10 border-r border-border bg-background px-2 py-1.5 font-normal ${frozenColumnEdge}`}
                    >
                      <div className="flex items-center">
                        <button
                          type="button"
                          title={member.title}
                          aria-label={t('Open reference: {{title}}', { title: member.title })}
                          className="max-w-full truncate rounded-sm text-left hover:text-primary hover:underline focus-visible:keyboard-focus"
                          onClick={() => onOpenItem({ kind: 'reference', itemId: member.itemId })}
                        >
                          {member.title}
                        </button>
                      </div>
                    </th>
                    {table.fields.map((field) => {
                      const cell = cellsByItem.get(member.itemId)?.get(field.id)
                      if (!cell)
                        return (
                          <td key={field.id} className="border-l border-border p-3">
                            {t('Pending')}
                          </td>
                        )
                      return (
                        <td
                          key={field.id}
                          className={`border-l border-border align-middle ${selectedCellId === cell.id ? 'ring-2 ring-inset ring-primary' : ''}`}
                          onClick={(event) => {
                            if (
                              (event.target as Node) === event.currentTarget ||
                              cellTriggers.current.get(cell.id)?.contains(event.target as Node)
                            )
                              openReview(cell.id)
                          }}
                          onKeyDown={(event) => {
                            if (event.target !== cellTriggers.current.get(cell.id)) return
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              openReview(cell.id)
                              return
                            }
                            const row = visibleMembers.findIndex(
                              (entry) => entry.itemId === cell.itemId
                            )
                            const column = table.fields.findIndex(
                              (entry) => entry.id === cell.fieldId
                            )
                            const offset = {
                              ArrowLeft: [0, -1],
                              ArrowRight: [0, 1],
                              ArrowUp: [-1, 0],
                              ArrowDown: [1, 0]
                            }[event.key]
                            if (!offset) return
                            event.preventDefault()
                            if (reviewBlocked()) return
                            const member = visibleMembers[row + offset[0]]
                            const field = table.fields[column + offset[1]]
                            const next =
                              member && field && cellsByItem.get(member.itemId)?.get(field.id)
                            if (next) {
                              if (wide && cellId) openReview(next.id)
                              else setSelectedCellId(next.id)
                              const focusNext = (): void => {
                                const target = cellTriggers.current.get(next.id)
                                target?.focus({ preventScroll: true })
                                target?.scrollIntoView?.({
                                  block: 'nearest',
                                  inline: 'nearest'
                                })
                              }
                              if (pageItemIds.has(next.itemId)) focusNext()
                              else {
                                setOffset(Math.floor((row + offset[0]) / pageSize) * pageSize)
                                requestAnimationFrame(focusNext)
                              }
                            }
                          }}
                        >
                          <ComparisonMatrixValue
                            cell={cell}
                            field={field}
                            sourceKey={member.sourceKey}
                            selected={selectedCellId === cell.id}
                            expanded={cellId === cell.id}
                            cellTriggers={cellTriggers}
                            onTooltipEscape={
                              wide && cellId === cell.id
                                ? () => {
                                    if (
                                      document.activeElement ===
                                        cellTriggers.current.get(cell.id) &&
                                      !reviewBlocked()
                                    )
                                      closeReview()
                                  }
                                : undefined
                            }
                          />
                          {cell.status === 'unavailable' && (
                            <div className="px-2 pb-2 text-xs text-muted-foreground">
                              <p>
                                {cell.history.at(-1)?.issue === 'source-changed'
                                  ? t(
                                      'The source changed. Rerun this cell and review its evidence.'
                                    )
                                  : cell.history.at(-1)?.issue === 'source-unavailable'
                                    ? t(
                                        'Restore the source or check the reference, then retry this cell.'
                                      )
                                    : cell.history.at(-1)?.issue === 'full-text-insufficient'
                                      ? t(
                                          'The source has too little readable text. Check the source, then retry this cell.'
                                        )
                                      : cell.history.at(-1)?.issue === 'abstract-unavailable' ||
                                          (table.sourcePolicy === 'abstract' &&
                                            cell.history.at(-1)?.issue !== 'full-text-unavailable')
                                        ? t(
                                            'Add an abstract to the reference, or change the source policy to require full text. Then retry this cell.'
                                          )
                                        : t(
                                            'Full text is required. Add a PDF to the reference, then retry this cell.'
                                          )}
                              </p>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  onOpenItem({ kind: 'reference', itemId: cell.itemId })
                                }
                              >
                                {t('Open reference')}
                              </Button>
                            </div>
                          )}
                          {cell.status === 'failed' && (
                            <p className="px-2 pb-2 text-xs text-muted-foreground">
                              {t(
                                'Extraction did not finish. Check the model and source, then retry this cell.'
                              )}
                            </p>
                          )}
                          {cell.status === 'unavailable' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy || launchBlocked || editing}
                              onClick={() =>
                                void prepare({
                                  action: 'retry',
                                  tableId: table.id,
                                  cellIds: [cell.id]
                                })
                              }
                            >
                              {t('Check source and retry')}
                            </Button>
                          )}
                          {cell.status === 'failed' && (
                            <label className="flex items-center gap-2 p-2 text-xs">
                              <input
                                type="checkbox"
                                disabled={busy || launchBlocked || editing}
                                checked={selectedFailures.includes(cell.id)}
                                onChange={(e) =>
                                  setSelectedFailures((ids) =>
                                    e.target.checked
                                      ? [...ids, cell.id]
                                      : ids.filter((id) => id !== cell.id)
                                  )
                                }
                              />
                              {t('Retry')}
                            </label>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </LiteratureTable>
          </LiteratureTableScrollArea>
          {(pageCount > 1 || (pageSize !== 25 && visibleMembers.length > 27)) && (
            <LiteraturePagination
              total={visibleMembers.length}
              offset={pageOffset}
              pageSize={pageSize}
              displayedCount={pageMembers.length}
              pageCount={pageCount}
              countLabel={t('{{count}} references', {
                count: visibleMembers.length,
                defaultValue_one: '{{count}} reference'
              })}
              pageSizeLabel={t('References per page')}
              disabled={busy || reviewStatus.pending || reviewStatus.failed}
              onOffsetChange={changePage}
              onPageSizeChange={(size) => {
                if (!reviewBlocked()) {
                  setPageSize(size)
                  changePage(0)
                }
              }}
            />
          )}
        </div>
      </div>
      {activeCell && activeField && (
        <ComparisonCellReview
          inline={wide}
          panelRef={reviewRef}
          navigation={{
            position: reviewPosition + 1,
            total: reviewCells.length,
            reviewed: reviewedCells,
            onPrevious: () => navigateReview(-1),
            onNext: () => navigateReview(1),
            hasNextAwaiting: Boolean(nextAwaitingReview),
            onNextAwaiting: () => nextAwaitingReview && openReview(nextAwaitingReview.id)
          }}
          referenceTitle={
            table.members.find((member) => member.itemId === activeCell.itemId)?.title ?? ''
          }
          tableId={table.id}
          sourceKey={
            table.members.find((member) => member.itemId === activeCell.itemId)?.sourceKey ?? ''
          }
          extractionBlocked={
            busy || launchBlocked || editing || reviewStatus.pending || reviewStatus.failed
          }
          onExtractCell={() => {
            if (reviewBlocked() || launchBlocked || editing) return
            void prepare(
              {
                action: 'rerun-field',
                tableId: table.id,
                fieldId: activeCell.fieldId,
                itemIds: [activeCell.itemId]
              },
              true
            )
          }}
          loadCellHistory={loadCellHistory}
          cell={activeCell}
          field={activeField}
          command={command}
          onDraftStatusChange={reportReviewStatus}
          onClose={closeReview}
          onOpenItem={onOpenItem}
        />
      )}
      {fieldDraftMissing && fieldDraft && (
        <Dialog.Root open onOpenChange={(open) => !open && !busy && setFieldDraft(undefined)}>
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content
              ref={fieldEditorRef}
              className={dialogPanelClassName('max-w-lg space-y-4')}
            >
              <Dialog.Title className={dialogTitleClassName}>
                {t('Edit {{field}}', { field: fieldDraft.name })}
              </Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t(
                  'This table changed while you were editing. Copy your draft, then cancel and reopen the editor to load the latest configuration.'
                )}
              </Dialog.Description>
              <Input aria-label={t('Field name')} value={fieldDraft.name} readOnly />
              <Textarea
                aria-label={t('Extraction requirements')}
                value={fieldDraft.rule}
                readOnly
              />
              <Button variant="ghost" disabled={busy} onClick={() => setFieldDraft(undefined)}>
                {t('Cancel')}
              </Button>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      {picker && (
        <ComparisonMemberPicker
          existing={table.itemIds}
          onClose={() => setPicker(false)}
          onAdd={async (itemIds) => {
            await command({ action: 'add-members', tableId: table.id, itemIds })
          }}
        />
      )}
      {exportOpen && (
        <ComparisonExportDialog
          table={table}
          summary={{
            references: table.members.length,
            fields: table.fields.length,
            total: table.cells.length,
            extracted: currentResults.length,
            awaitingReview: awaitingReviewCount,
            outdatedRule: outdatedRuleCount,
            waiting: waitingCount,
            failed: failedCount,
            pendingExtraction: pendingExtractionCount
          }}
          command={command}
          blocked={reviewStatus.pending || reviewStatus.failed}
          triggerRef={configureTrigger}
          onBusyChange={reportExportBusy}
          onClose={() => setExportOpen(false)}
        />
      )}
      {confirmation && (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open) dismissSourceCheck()
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content className={dialogPanelClassName('w-[min(40rem,calc(100vw-2rem))] p-0')}>
              <div className={dialogHeaderClassName}>
                <Dialog.Title className={dialogTitleClassName}>
                  {request?.action === 'resume'
                    ? t('Resume extraction')
                    : confirmation.singleCell
                      ? t('Extract this cell')
                      : request?.action === 'rerun-field'
                        ? t('Confirm rerun scope')
                        : t('Confirm sources and scope')}
                </Dialog.Title>
              </div>
              <div className={`${dialogBodyClassName} max-h-[60vh] overflow-y-auto`}>
                <Dialog.Description className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                  <FileSearch className="size-4" aria-hidden="true" />
                  {table.sourcePolicy === 'abstract' ? t('Abstract only') : t('Require full text')}
                </Dialog.Description>
                {confirmation.singleCell && request?.action === 'rerun-field' && (
                  <p className="mt-3 font-medium">{fieldsById.get(request.fieldId)?.name}</p>
                )}
                {request?.action === 'run' && (
                  <dl className="my-3 grid grid-cols-3 divide-x divide-border rounded-lg border border-border py-3">
                    {[
                      {
                        Icon: BookOpen,
                        label: t('Literature'),
                        count: new Set(targetCells.map((cell) => cell.itemId)).size
                      },
                      {
                        Icon: Columns3,
                        label: t('Fields'),
                        count: new Set(targetCells.map((cell) => cell.fieldId)).size
                      },
                      { Icon: Grid2X2, label: t('Cells'), count: targetCells.length }
                    ].map(({ Icon, label, count }) => (
                      <div className="min-w-0 px-4" key={label}>
                        <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Icon aria-hidden="true" className="size-3.5" />
                          {label}
                        </dt>
                        <dd className="mt-1 text-lg font-semibold tabular-nums">{count}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {!confirmation.singleCell && request?.action === 'rerun-field' && (
                  <p className="my-3 font-medium">
                    {t('Rerun scope: {{selected}} × 1 (references × fields)', {
                      selected: request.itemIds?.length ?? table.itemIds.length
                    })}
                    {': '}
                    {table.fields.find((field) => field.id === request.fieldId)?.name}
                  </p>
                )}
                {!sourceChecks && !busy && (
                  <ErrorNotice
                    title={t('Source checks failed.')}
                    primaryButton={{
                      label: t('Retry'),
                      onClick: () => void prepare(request, confirmation.singleCell)
                    }}
                  />
                )}
                {busy && !sourceChecks && <p role="status">{t('Checking sources…')}</p>}
                {sourceChecks && (
                  <>
                    <div
                      className="my-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
                      role="status"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <CheckCircle2 aria-hidden="true" className="size-4 text-muted-foreground" />
                        {t('Ready cells')}: {readyCells.length}
                      </span>
                      {targetCells.length > readyCells.length && (
                        <span className="inline-flex items-center gap-1.5 text-status-warning-foreground">
                          <CircleAlert aria-hidden="true" className="size-4" />
                          {t('Waiting for source')}: {targetCells.length - readyCells.length}
                        </span>
                      )}
                    </div>
                    <ul className="divide-y divide-border">
                      {table.members
                        .filter(
                          (member) =>
                            (!confirmation.singleCell &&
                              request?.action === 'rerun-field' &&
                              filteredItemIds.has(member.itemId)) ||
                            !request ||
                            targetCells.some((cell) => cell.itemId === member.itemId)
                        )
                        .map((member) => {
                          const source = sourceChecks.find(
                            (source) => source.itemId === member.itemId
                          )
                          return (
                            <li
                              key={member.itemId}
                              className="flex flex-wrap items-center justify-between gap-2 py-3"
                            >
                              <label className="flex items-center gap-2">
                                {!confirmation.singleCell && request?.action === 'rerun-field' && (
                                  <input
                                    type="checkbox"
                                    aria-label={t('Select {{title}} for rerun', {
                                      title: member.title
                                    })}
                                    checked={request.itemIds?.includes(member.itemId) ?? true}
                                    disabled={busy}
                                    onChange={(event) =>
                                      setConfirmation({
                                        ...confirmation,
                                        request: {
                                          ...request,
                                          itemIds: event.target.checked
                                            ? [...(request.itemIds ?? []), member.itemId]
                                            : request.itemIds?.filter((id) => id !== member.itemId)
                                        }
                                      })
                                    }
                                  />
                                )}
                                {member.title}
                              </label>
                              {source?.status === 'available' ? (
                                <span
                                  className="ml-auto text-muted-foreground"
                                  title={t('Readable source')}
                                >
                                  <CheckCircle2 className="size-4" aria-hidden="true" />
                                  <span className="sr-only">{t('Readable source')}</span>
                                </span>
                              ) : (
                                <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-status-warning-foreground">
                                  <CircleAlert className="size-4" aria-hidden="true" />
                                  {source?.status === 'missing'
                                    ? t('Missing source')
                                    : t('Source could not be read')}
                                </span>
                              )}
                              {source?.status !== 'available' && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => {
                                    setConfirmation(undefined)
                                    onOpenItem({ kind: 'reference', itemId: member.itemId })
                                  }}
                                >
                                  {t('Open reference')}
                                </Button>
                              )}
                            </li>
                          )
                        })}
                    </ul>
                    {!confirmation.singleCell && request?.action === 'rerun-field' && (
                      <p className="mt-3 text-xs text-muted-foreground">
                        {t(
                          'Other columns will not run. Previous machine results and manual edits are retained; edits need review after rerunning.'
                        )}
                      </p>
                    )}
                  </>
                )}
                {changedRemaining && (
                  <ErrorNotice
                    level="warning"
                    title={t('Sources or rules changed for unfinished cells.')}
                    description={t(
                      'Continue these cells with the latest sources and rules. Saved cells are not rerun; previous results and manual edits remain available.'
                    )}
                  />
                )}
                {confirmation.revision !== table.revision && (
                  <ErrorNotice
                    level="warning"
                    title={t('The table changed. Close this dialog and check the scope again.')}
                  />
                )}
              </div>
              <div className={dialogFooterClassName}>
                <Button
                  variant="ghost"
                  disabled={busy && Boolean(sourceChecks)}
                  onClick={dismissSourceCheck}
                >
                  {request ? t('Cancel') : t('Close')}
                </Button>
                {request && (
                  <Button
                    disabled={
                      busy ||
                      (request.action !== 'resume' && launchBlocked) ||
                      !sourceChecks ||
                      !(request.action === 'resume' ? targetCells.length : readyCells.length) ||
                      confirmation.revision !== table.revision ||
                      reviewStatus.pending ||
                      reviewStatus.failed
                    }
                    onClick={() =>
                      void run({
                        ...request,
                        expectedRevision: confirmation.revision,
                        expectedSources: sourceChecks?.map(({ itemId, sourceKey }) => ({
                          itemId,
                          sourceKey
                        })),
                        ...(request.action === 'resume'
                          ? { useCurrentSources: Boolean(changedRemaining) }
                          : {})
                      }).then((started) => {
                        setConfirmation(undefined)
                        if (started) setSelectedFailures([])
                        else onRetryLoad?.()
                      })
                    }
                  >
                    {changedRemaining
                      ? t('Continue with latest sources and rules')
                      : t('Confirm and start')}
                  </Button>
                )}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  )
}
