import { ColumnVisibility } from './LiteratureColumnCustomizer'
import { parseApplicationCommandError } from '../../../../shared/application-command-contract'
import { JournalEntryRow } from './JournalEntryRow'
import { exportJournalBundle, importJournalBundle, readJournalBundle } from './journal-bundle'
import { JournalFieldRow } from './JournalFieldRow'
import { CollectionOptionHelp } from './CollectionOptionHelp'
import { LiteraturePagination } from './LiteraturePagination'
import * as Checkbox from '@radix-ui/react-checkbox'
import {
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronDown,
  X,
  ChevronRight,
  Database,
  Download,
  Eye,
  EyeOff,
  Hash,
  List,
  ListChecks,
  LoaderCircle,
  Palette,
  Plus,
  Settings2,
  Type,
  Upload,
  type LucideIcon
} from 'lucide-react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TAG_COLORS } from '@/pages/settings/tag-presentation'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { FileDropOverlay } from '@/components/FileDropOverlay'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { LiteratureImportDialogFrame } from './LiteratureImportDialogFrame'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { ActionMenuProvider } from '@/components/action-menu'
import { JournalColumnHeader } from './JournalColumnHeader'
import { JournalDatasetActions } from './JournalDatasetActions'
import { JournalAttributeValue } from './JournalAttributes'
import {
  refreshJournalAttributes,
  useJournalSourceYears,
  setJournalSourceYear
} from './journal-attribute-store'
import {
  LiteratureTable,
  LiteratureTableScrollArea,
  LiteratureTextTooltip
} from './LiteratureTable'
import {
  journalColumns,
  suggestJournalSource,
  suggestJournalHeader,
  suggestJournalYear,
  type JournalColumn,
  type JournalSheet
} from './journal-import-file'
import {
  journalDatasetLabel,
  journalExternalIdSchema,
  selectJournalDatasets,
  JOURNAL_FIELD_KINDS,
  JOURNAL_EXTERNAL_ID_NAMESPACES,
  JOURNAL_IMPORT_MAX_BYTES,
  missingJournalValue,
  journalColumnKey,
  type JournalDataset,
  type JournalField,
  type JournalImportRow,
  type JournalResult
} from '../../../../shared/journal-attributes'
import { TAG_COLOR_KEYS, type TagColorKey } from '../../../../shared/tags'

const REVIEW_PAGE_SIZE = 25

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

const journalFieldKindIcons: Record<JournalField['kind'], LucideIcon> = {
  text: Type,
  number: Hash,
  singleSelect: List,
  multiSelect: ListChecks
}

export const JournalManager = memo(function JournalManager({
  onClose,
  onOpenItem,
  embedded = false,
  active: isActive = true
}: {
  onClose: () => void
  onOpenItem: (id: string, initiator?: HTMLElement) => void | Promise<void>
  embedded?: boolean
  active?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const uploadDescriptionId = useId()
  const visibilityId = useId()
  const sourceYears = useJournalSourceYears()
  const [datasets, setDatasets] = useState<JournalDataset[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [catalogTick, setCatalogTick] = useState(0)
  const [entriesTick, setEntriesTick] = useState(0)
  const activeRef = useRef(isActive)
  const refreshPending = useRef(false)
  useEffect(() => {
    activeRef.current = isActive
    if (isActive && refreshPending.current) {
      refreshPending.current = false
      setCatalogTick((tick) => tick + 1)
      setEntriesTick((tick) => tick + 1)
    }
  }, [isActive])
  const [remoteDatasets, setRemoteDatasets] = useState<JournalDataset[]>()
  const [selected, setSelected] = useState('')
  const dataset = useMemo(() => datasets.find(({ id }) => id === selected), [datasets, selected])
  const [loadedEntries, setEntries] = useState<{
    datasetId: string
    offset: number
    result: JournalResult
  }>()
  const entries: JournalResult =
    loadedEntries?.datasetId === dataset?.id ? (loadedEntries?.result ?? {}) : {}
  const entriesOffset = loadedEntries?.offset ?? 0
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25)
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [entriesFailed, setEntriesFailed] = useState(false)
  const [sortField, setSortField] = useState<string>()
  const [descending, setDescending] = useState(false)
  const [file, setFile] = useState<File>()
  const [sheet, setSheet] = useState<JournalSheet>()
  const [header, setHeader] = useState(-1)
  const [columns, setColumns] = useState<JournalColumn[]>([])
  const [showSkippedColumns, setShowSkippedColumns] = useState(true)
  const [showFilePreview, setShowFilePreview] = useState(false)
  const [source, setSource] = useState('')
  const [sourceSuggested, setSourceSuggested] = useState(false)
  const [year, setYear] = useState('')
  const [yearSuggested, setYearSuggested] = useState(false)
  const previousDataset = datasets.find(
    (entry) => entry.source === source.trim() && entry.year < Number(year)
  )
  const availableFields =
    dataset?.fields ??
    previousDataset?.fields.map((field) => ({
      ...field,
      columnKey: journalColumnKey(previousDataset.id, field)
    })) ??
    []
  const [policy, setPolicy] = useState<'fill' | 'replace'>('fill')
  const [review, setReview] = useState<JournalResult>()
  const [reviewOffset, setReviewOffset] = useState(0)
  const [reviewPageLoading, setReviewPageLoading] = useState(false)
  const bodyScroll = useRef<HTMLDivElement>(null)
  const errorNotice = useRef<HTMLDivElement>(null)
  const reviewScroll = useRef<HTMLDivElement>(null)
  const [skipProblems, setSkipProblems] = useState(true)
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
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
  useEffect(() => {
    if (!error) return
    if (bodyScroll.current) bodyScroll.current.scrollTop = 0
    errorNotice.current?.focus({ preventScroll: true })
  }, [error])
  const [progress, setProgress] = useState('')
  const [canCancel, setCanCancel] = useState(false)
  const preparing = useRef(false)
  const exporting = useRef(false)
  const cancelled = useRef(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removal, setRemoval] = useState<JournalResult['removal']>()
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
  const token = useRef<string | undefined>(undefined)
  const worker = useRef<Worker | undefined>(undefined)
  const abortParser = useRef<(() => void) | undefined>(undefined)
  const mounted = useRef(true)
  const fileInput = useRef<HTMLInputElement>(null)
  const api = window.api.literature.journals
  const kinds = {
    text: t('Text'),
    number: t('Number'),
    singleSelect: t('Single choice'),
    multiSelect: t('Multiple choices')
  }
  const roles = {
    ignore: t('Skip'),
    name: t('Journal name'),
    alias: t('Abbreviation'),
    issn: t('ISSN'),
    externalId: t('External journal ID'),
    attribute: t('Journal attribute')
  }
  const statuses = {
    matched: t('Matched'),
    new: t('New'),
    ambiguous: t('Ambiguous match'),
    invalid: t('Invalid'),
    duplicate: t('Duplicate')
  }
  const warnings = {
    'invalid-issn': t('Invalid ISSN'),
    'invalid-value': t('Invalid attribute value'),
    'missing-identity': t('Missing journal identity'),
    'identity-conflict': t('Conflicting journal identities'),
    'identity-limit': t('Too many journal aliases or identifiers'),
    'duplicate-row': t('Duplicate journal rows')
  }
  const colors: Record<TagColorKey, string> = {
    gray: t('Gray'),
    red: t('Red'),
    orange: t('Orange'),
    amber: t('Amber'),
    green: t('Green'),
    blue: t('Blue'),
    purple: t('Purple'),
    pink: t('Pink')
  }

  const fail = useCallback(
    (error: unknown): void => {
      if (cancelled.current) return
      console.error('Journal attributes operation failed', error)
      const commandError = parseApplicationCommandError(error)
      if (
        mounted.current &&
        (commandError?.code === 'invalid-command-arguments' ||
          commandError?.code === 'invalid-command-result')
      ) {
        setError(
          t(
            'The journal request was rejected. Restart the app, then check the mapping and try again.'
          )
        )
        return
      }
      const reason =
        commandError?.message ?? (error instanceof Error ? error.message : String(error))
      if (mounted.current && /changed|expired/i.test(reason)) {
        setError(
          t('Journal data changed or the import expired. Reload and review the import again.')
        )
        return
      }
      if (
        mounted.current &&
        /too large|too long|at most|distinct|mapping|already exist/i.test(reason)
      ) {
        setError(
          t(
            'Check the source, year and column mapping. Use distinct attributes and stay within the import limits.'
          )
        )
        return
      }
      if (mounted.current && /malformed|parsing|encoded|encoding|empty|worksheet/i.test(reason)) {
        setError(
          t(
            'The file could not be read. Check the worksheet or save the file as UTF-8 CSV or XLSX.'
          )
        )
        return
      }
      if (mounted.current)
        setError(
          t(
            'Could not complete the journal operation. Check the file and mapping, then reload or try again.'
          )
        )
    },
    [t]
  )
  const catalogGeneration = useRef(0)
  const discard = (): void => {
    if (token.current) void api({ action: 'discard', token: token.current }).catch(() => {})
    token.current = undefined
  }
  useEffect(() => {
    mounted.current = true
    cancelled.current = false
    const generation = ++catalogGeneration.current
    void api({ action: 'list' }).then(
      (result) => {
        if (mounted.current && generation === catalogGeneration.current) {
          setDatasets(result.datasets ?? [])
          setSelected(result.datasets?.[0]?.id ?? '')
          setCatalogLoaded(true)
        }
      },
      (error) => {
        if (mounted.current) {
          setCatalogLoaded(true)
          fail(error)
        }
      }
    )
    const changed = (): void => {
      if (!activeRef.current) {
        refreshPending.current = true
        return
      }
      setCatalogTick((tick) => tick + 1)
      setEntriesTick((tick) => tick + 1)
    }
    const unsubscribe = window.api.literature.onChanged?.((event) => {
      if (!event?.itemIds?.length && !event?.collectionIds?.length && !event?.candidateIds?.length)
        changed()
    })
    const visible = (): void => {
      if (document.visibilityState === 'visible') changed()
    }
    window.addEventListener('focus', changed)
    window.addEventListener('open-science:web-events-open', changed)
    document.addEventListener('visibilitychange', visible)
    return () => {
      unsubscribe?.()
      window.removeEventListener('focus', changed)
      window.removeEventListener('open-science:web-events-open', changed)
      document.removeEventListener('visibilitychange', visible)
      mounted.current = false
      cancelled.current = true
      abortParser.current?.()
      worker.current?.terminate()
      discard()
    }
    // The command adapter has stable identity for the lifetime of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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

  useEffect(() => {
    if (!isActive || !catalogTick || busy) return
    const generation = ++catalogGeneration.current
    let active = true
    const timer = setTimeout(() => {
      void api({ action: 'list' }).then(
        (result) => {
          if (!active || generation !== catalogGeneration.current) return
          const next = (result.datasets ?? []).map(
            (entry) =>
              datasets.find((old) => old.id === entry.id && old.revision === entry.revision) ??
              entry
          )
          if (
            next.length === datasets.length &&
            next.every((entry, index) => entry === datasets[index])
          ) {
            setRemoteDatasets(undefined)
            return
          }
          const current = next.find(({ id }) => id === selected)
          if (
            (editing || entryEditing || sheet) &&
            (!selected || current?.revision !== dataset?.revision)
          ) {
            setRemoteDatasets(next)
            return
          }
          setRemoteDatasets(undefined)
          setDatasets(next)
          if (selected && !current) {
            setSelected(next[0]?.id ?? '')
            setQuery('')
            setOffset(0)
            setSortField(undefined)
          }
        },
        (error: unknown) => {
          if (active) console.warn('Could not refresh journal datasets', error)
        }
      )
    }, 100)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [
    api,
    isActive,
    catalogTick,
    busy,
    editing,
    entryEditing,
    sheet,
    datasets,
    selected,
    dataset?.revision
  ])

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

  const remap = (rows: string[][], header: number, width?: number): void => {
    const mapped = journalColumns(rows, header, width)
    setColumns(
      mapped.map((column) => {
        const existing = dataset?.fields.find(
          (field) => field.label.toLocaleLowerCase() === column.label.toLocaleLowerCase()
        )
        return existing ? { ...column, role: 'attribute', field: existing } : column
      })
    )
    setHeader(header)
    setReview(undefined)
    discard()
  }
  const read = async (file: File, selectedSheet?: string): Promise<void> => {
    setError('')
    setMessage('')
    setBusy(true)
    cancelled.current = false
    preparing.current = true
    setCanCancel(true)
    discard()
    setReview(undefined)
    setShowSkippedColumns(true)
    setShowFilePreview(false)
    try {
      if (file.size > JOURNAL_IMPORT_MAX_BYTES) throw new Error('File too large')
      if (/\.json$/i.test(file.name)) {
        const bundle = readJournalBundle(await file.arrayBuffer())
        const result = await importJournalBundle(
          api,
          bundle,
          () => cancelled.current || !mounted.current,
          () => setCanCancel(false)
        )
        if (!mounted.current) return
        catalogGeneration.current++
        setDatasets(result.datasets ?? [])
        setSelected(
          result.datasets?.find(
            (entry) => entry.source === bundle.dataset.source && entry.year === bundle.dataset.year
          )?.id ?? ''
        )
        setSheet(undefined)
        setFieldDraft(undefined)
        setRemoteDatasets(undefined)
        setOffset(0)
        setQuery('')
        setSortField(undefined)
        setMessage(t('Journal attributes imported.'))
        refreshJournalAttributes()
        return
      }
      worker.current?.terminate()
      const parser = new Worker(new URL('./journal-import.worker.ts', import.meta.url), {
        type: 'module'
      })
      worker.current = parser
      const bytes = await file.arrayBuffer()
      if (!mounted.current || cancelled.current) {
        parser.terminate()
        return
      }
      const result = await new Promise<JournalSheet>((resolve, reject) => {
        const timeout = setTimeout(() => {
          parser.terminate()
          reject(new Error('Journal parsing timed out'))
        }, 30_000)
        abortParser.current = () => {
          clearTimeout(timeout)
          parser.terminate()
          reject(new Error('Import cancelled'))
        }
        parser.onmessage = (event: MessageEvent<{ result?: JournalSheet; error?: string }>) => {
          clearTimeout(timeout)
          parser.terminate()
          event.data.result ? resolve(event.data.result) : reject(new Error(event.data.error))
        }
        parser.onerror = () => {
          clearTimeout(timeout)
          parser.terminate()
          reject(new Error('Journal parsing failed'))
        }
        parser.postMessage({ bytes, name: file.name, sheet: selectedSheet }, [bytes])
      })
      if (!mounted.current || cancelled.current) return
      const suggestedHeader = suggestJournalHeader(result.rows)
      const inferredSource = dataset?.source ?? suggestJournalSource(file.name)
      const inferredYear = dataset
        ? String(dataset.year)
        : suggestJournalYear(result.rows, suggestedHeader, file.name)
      setFile(file)
      setSheet(result)
      remap(result.rows, suggestedHeader, result.width)
      setSource(inferredSource)
      setSourceSuggested(!dataset && Boolean(inferredSource))
      setYear(inferredYear)
      setYearSuggested(!dataset && Boolean(inferredYear))
    } catch (error) {
      if (!cancelled.current && mounted.current && /\.json$/i.test(file.name)) {
        setError(
          error instanceof Error && error.message.includes('This source and year already exist')
            ? t('A dataset with this source and year already exists.')
            : t('Could not import this journal bundle. Check the file and try again.')
        )
      } else fail(error)
    } finally {
      preparing.current = false
      setCanCancel(false)
      abortParser.current = undefined
      if (mounted.current) {
        setBusy(false)
        setProgress('')
      }
    }
  }
  const updateColumn = (index: number, patch: Partial<JournalColumn>): void =>
    setColumns((columns) =>
      columns.map((column) => (column.index === index ? { ...column, ...patch } : column))
    )

  const startReview = async (): Promise<void> => {
    if (!sheet || preparing.current || remoteDatasets) return
    preparing.current = true
    setCanCancel(true)
    cancelled.current = false
    setBusy(true)
    setReviewing(true)
    setProgress(t('Reviewing import…'))
    if (bodyScroll.current) bodyScroll.current.scrollTop = 0
    setError('')
    discard()
    try {
      const selectedFields = columns.filter(({ role }) => role === 'attribute')
      const fields = selectedFields.map(({ field }) => field)
      if (
        !fields.length ||
        fields.length > 64 ||
        new Set(fields.map(({ id }) => id)).size !== fields.length ||
        !Number.isInteger(Number(year)) ||
        Number(year) < 1800 ||
        Number(year) > 9999 ||
        fields.some((field) => !field.label.trim()) ||
        columns.filter(({ role }) => role === 'name').length > 1 ||
        !columns.some(({ role }) => role === 'name' || role === 'issn' || role === 'externalId')
      )
        throw new Error('Check column mapping')
      const byRole = (role: JournalColumn['role']): number[] =>
        columns.filter((column) => column.role === role).map(({ index }) => index)
      const nameColumns = byRole('name')
      const aliasColumns = byRole('alias')
      const issnColumns = byRole('issn')
      const externalIdColumns = columns.filter(({ role }) => role === 'externalId')
      if (
        externalIdColumns.some(
          ({ externalNamespace }) =>
            !journalExternalIdSchema.shape.namespace.safeParse(externalNamespace).success
        )
      )
        throw new Error('Choose an external identifier namespace')
      const result = await api({
        action: 'begin',
        definition: { source, year: Number(year), fields },
        datasetId: dataset?.id,
        expectedRevision: dataset?.revision,
        policy
      })
      token.current = result.token
      if (cancelled.current || !mounted.current) {
        discard()
        return
      }
      const importToken = result.token!
      let chunk: JournalImportRow[] = []
      let offset = 0
      let chunkBytes = 0
      const append = async (): Promise<void> => {
        if (!chunk.length) return
        if (cancelled.current || !mounted.current) throw new Error('Import cancelled')
        await api({ action: 'append', token: importToken, offset, rows: chunk })
        if (cancelled.current || !mounted.current) throw new Error('Import cancelled')
        setProgress(
          t('Preparing journal rows: {{processed}}', { processed: offset + chunk.length })
        )
        offset += chunk.length
        chunk = []
        chunkBytes = 0
      }
      for (let index = header + 1; index < sheet.rows.length; index++) {
        const cells = sheet.rows[index]
        if (!cells.some(Boolean)) continue
        const selected = (indexes: number[]): string[] =>
          indexes.map((index) => cells[index] ?? '').filter(Boolean)
        const row = {
          row: index + 1,
          name: selected(nameColumns)[0] ?? '',
          aliases: selected(aliasColumns),
          issns: selected(issnColumns).flatMap((value) =>
            value
              .split(/[,;|]/)
              .map((part) => part.trim())
              .filter(Boolean)
          ),
          externalIds: externalIdColumns.flatMap((column) =>
            selected([column.index]).map((value) => ({
              namespace: column.externalNamespace!,
              value
            }))
          ),
          values: Object.fromEntries(
            selectedFields.map((column) => [column.field.id, cells[column.index] ?? ''])
          )
        }
        const bytes = new TextEncoder().encode(JSON.stringify(row)).length
        if (chunk.length === 100 || chunkBytes + bytes > 512 * 1024) await append()
        chunk.push(row)
        chunkBytes += bytes
      }
      await append()
      if (cancelled.current || !mounted.current) {
        discard()
        return
      }
      setProgress(t('Reviewing import…'))
      const preview = await api({
        action: 'preview',
        token: importToken,
        offset: 0,
        limit: REVIEW_PAGE_SIZE
      })
      if (mounted.current && !cancelled.current) {
        if (bodyScroll.current) bodyScroll.current.scrollTop = 0
        setReview(preview)
        setReviewOffset(0)
        setSkipProblems(true)
        setProblemsOnly(false)
      }
    } catch (error) {
      discard()
      fail(error)
    } finally {
      preparing.current = false
      setCanCancel(false)
      if (mounted.current) {
        setBusy(false)
        setProgress('')
      }
      setReviewing(false)
    }
  }
  const commit = async (): Promise<void> => {
    if (preparing.current || busy || !review?.digest || !token.current || remoteDatasets) return
    preparing.current = true
    cancelled.current = false
    setBusy(true)
    setCommitting(true)
    setProgress(t('Importing…'))
    setError('')
    catalogGeneration.current++
    try {
      const result = await api({
        action: 'commit',
        token: token.current,
        digest: review.digest,
        skipProblems
      })
      token.current = undefined
      if (!mounted.current) return
      setDatasets(result.datasets ?? [])
      setQuery('')
      setSortField(undefined)
      setSelected(
        result.datasets?.find((entry) => entry.source === source && entry.year === Number(year))
          ?.id ?? ''
      )
      setSheet(undefined)
      setReview(undefined)
      setOffset(0)
      setMessage(t('Journal attributes imported.'))
      refreshJournalAttributes()
    } catch (error) {
      fail(error)
    } finally {
      preparing.current = false
      setCommitting(false)
      setProgress('')
      setBusy(false)
    }
  }
  const changePage = async (offset: number, nextProblemsOnly = problemsOnly): Promise<void> => {
    if (busy || !token.current) return
    const previewToken = token.current
    cancelled.current = false
    setBusy(true)
    setReviewPageLoading(true)
    setError('')
    try {
      const next = await api({
        action: 'preview',
        token: previewToken,
        offset,
        limit: REVIEW_PAGE_SIZE,
        problemsOnly: nextProblemsOnly
      })
      if (!mounted.current || token.current !== previewToken) return
      setReview(next)
      setReviewOffset(offset)
      setProblemsOnly(nextProblemsOnly)
      if (reviewScroll.current) reviewScroll.current.scrollTop = 0
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
      setReviewPageLoading(false)
    }
  }
  const persistFields = useCallback(
    async (fields: JournalField[]): Promise<string | undefined> => {
      if (!dataset || remoteDatasets) return t('Journal data changed. Reload the dataset.')
      cancelled.current = false
      setBusy(true)
      setError('')
      catalogGeneration.current++
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
    [api, dataset, remoteDatasets, t]
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
    cancelled.current = false
    setBusy(true)
    setError('')
    catalogGeneration.current++
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
  }, [api, dataset, entryDraft, fail, remoteDatasets, t])
  const remove = async (): Promise<void> => {
    if (!dataset || !removal) return
    cancelled.current = false
    setBusy(true)
    setError('')
    catalogGeneration.current++
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
  const resetInheritedFields = (): void =>
    setColumns((columns) =>
      columns.map((column) => {
        if (!column.field.columnKey) return column
        const field = { ...column.field, columnKey: undefined }
        return { ...column, field: { ...field, id: crypto.randomUUID() } }
      })
    )
  const exportBundle = async (): Promise<void> => {
    if (!dataset || busy) return
    setBusy(true)
    setError('')
    cancelled.current = false
    try {
      const bytes = await exportJournalBundle(
        api,
        dataset,
        () => cancelled.current || !mounted.current
      )
      await window.api.saveBlobFile({
        suggestedName: `${journalDatasetLabel(dataset).replace(/[\\/:*?"<>|]/g, '-')}.journal.json`,
        mimeType: 'application/json',
        data: bytes.buffer
      })
    } catch {
      if (mounted.current && !cancelled.current)
        setError(t('Could not export this journal bundle. Reload the dataset and try again.'))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const template = async (): Promise<void> => {
    try {
      const spreadsheet = await import('styled-exceljs')
      const workbook = spreadsheet.utils.book_new()
      spreadsheet.utils.book_append_sheet(
        workbook,
        spreadsheet.utils.aoa_to_sheet([
          [
            'Journal name',
            'Alias',
            'ISSN',
            'eISSN',
            'Custom attribute 1',
            'Custom attribute 2',
            'Custom attribute 3'
          ]
        ]),
        'Journal data'
      )
      spreadsheet.utils.book_append_sheet(
        workbook,
        spreadsheet.utils.aoa_to_sheet([
          ['How to fill this template'],
          ['One journal per row. Keep the first row as the header.'],
          ['Journal name', 'Use the journal title when ISSN/eISSN is unavailable.'],
          ['Alias', 'Optional abbreviation or alternate journal title.'],
          ['ISSN / eISSN', 'Use the 8-digit identifier, with or without a hyphen.'],
          ['JIF', 'Enter a number, for example 3.2.'],
          ['JCR quartile / Scopus quartile', 'Use Q1, Q2, Q3 or Q4.'],
          [
            'Custom attributes',
            'Rename the custom attribute columns or add more columns using the names from your source.'
          ],
          [
            'Categorical values',
            'Values such as Q1–Q4 or 1区–4区 can be color-tagged after import.'
          ],
          [
            'External provider IDs',
            'Optional advanced fields. They only match records that already contain the same ID; no ID is looked up automatically.'
          ],
          ['Notes', 'Optional free text; it is not used for matching.'],
          ['Metric year', 'Choose the year in the import screen; it applies to the whole file.'],
          [
            'Matching order',
            'External ID when both sides have it → ISSN/eISSN → journal name and aliases.'
          ],
          ['Before importing', 'Remove any example rows and review the column mapping.']
        ]),
        'Instructions'
      )
      spreadsheet.utils.book_append_sheet(
        workbook,
        spreadsheet.utils.aoa_to_sheet([
          [
            'Journal name',
            'Alias',
            'ISSN',
            'eISSN',
            'Custom attribute 1',
            'Custom attribute 2',
            'Custom attribute 3'
          ],
          ['Example Journal Alpha', 'EJA', '1234-5679', '2345-6785', '3.2', 'Q1', '1区']
        ]),
        'Example'
      )
      const bytes = spreadsheet.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
      await window.api.saveBlobFile({
        suggestedName: 'journal-attributes-template.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: bytes
      })
    } catch (error) {
      fail(error)
    }
  }
  const exportProblems = async (): Promise<void> => {
    if (!review?.digest || !review.problems || !token.current || !sheet) return
    exporting.current = true
    setBusy(true)
    setError('')
    preparing.current = true
    cancelled.current = false
    setCanCancel(true)
    const importToken = token.current
    const fields = columns.filter(({ role }) => role === 'attribute')
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode(
        '\uFEFF' +
          Papa.unparse(
            [
              [
                t('Row'),
                t('Status'),
                t('Journal name'),
                t('Abbreviation'),
                t('ISSN'),
                t('Import problems'),
                ...fields.map(({ field }) => field.label)
              ]
            ],
            { escapeFormulae: true }
          )
      )
    ]
    try {
      for (let offset = 0; offset < review.problems; offset += 50) {
        if (cancelled.current || !mounted.current) return
        const page = await api({
          action: 'preview',
          token: importToken,
          offset,
          problemsOnly: true
        })
        if (page.digest !== review.digest)
          throw new Error('Journal data changed. Review the import again.')
        if (cancelled.current || !mounted.current) return
        const table = (page.rows ?? []).map((row) => [
          String(row.row),
          statuses[row.status],
          row.name,
          row.aliases.join('; '),
          row.issns.join('; '),
          row.warnings.map((warning) => warnings[warning]).join('; '),
          ...fields.map(({ field }) => row.values[field.id] ?? '')
        ])
        if (table.length)
          chunks.push(encoder.encode('\r\n' + Papa.unparse(table, { escapeFormulae: true })))
        setProgress(
          t('Preparing journal rows: {{processed}}', {
            processed: Math.min(offset + 50, review.problems)
          })
        )
      }
      // Encode each page separately so a large export never builds one giant CSV string.
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
      let position = 0
      for (const chunk of chunks) {
        bytes.set(chunk, position)
        position += chunk.length
      }
      await window.api.saveBlobFile({
        suggestedName: 'journal-import-problems.csv',
        mimeType: 'text/csv;charset=utf-8',
        data: bytes.buffer
      })
    } catch (error) {
      fail(error)
    } finally {
      preparing.current = false
      exporting.current = false
      if (mounted.current) {
        setBusy(false)
        setCanCancel(false)
        setProgress('')
      }
    }
  }
  const { isDragging, dropZoneProps } = useFileDropZone({
    enabled: isActive && !busy && !sheet && !review && !editing && !entryEditing && !remoteDatasets,
    onFiles: (files) => {
      if (files.length !== 1) {
        setError(t('Choose one journal file at a time.'))
        return
      }
      if (!preparing.current) void read(files[0])
    }
  })
  const pageOffset = review ? reviewOffset : offset
  const total = review
    ? ((problemsOnly ? review.problems : review.total) ?? 0)
    : (entries.total ?? 0)
  const skippedColumns = columns.filter(({ role }) => role === 'ignore')
  const visibleColumns = showSkippedColumns
    ? columns
    : columns.filter(({ role }) => role !== 'ignore')
  const reviewDisabledReason = sheet
    ? !source.trim()
      ? t('Enter a source name to continue.')
      : !year.trim()
        ? t('Enter the metric year to continue.')
        : !Number.isInteger(Number(year)) || Number(year) < 1800 || Number(year) > 9999
          ? t('Enter a metric year between 1800 and 9999.')
          : !columns.some(({ role }) => role === 'attribute')
            ? t('Choose at least one column as a journal attribute.')
            : columns.filter(({ role }) => role === 'name').length > 1
              ? t('Choose only one column as the journal name.')
              : !columns.some(
                    ({ role }) => role === 'name' || role === 'issn' || role === 'externalId'
                  )
                ? t('Choose a journal name, ISSN or external ID column to match journals.')
                : columns.some(
                      ({ role, externalNamespace }) =>
                        role === 'externalId' && !externalNamespace?.trim()
                    )
                  ? t('Choose a namespace for each external identifier column.')
                  : columns.some(({ role, field }) => role === 'attribute' && !field.label.trim())
                    ? t('Give each journal attribute a name.')
                    : new Set(
                          columns
                            .filter(({ role }) => role === 'attribute')
                            .map(({ field }) => field.id)
                        ).size !== columns.filter(({ role }) => role === 'attribute').length
                      ? t('Choose a different attribute for each selected column.')
                      : ''
    : ''
  const commitDisabledReason = review
    ? !review.ready
      ? t('Import is unavailable until all rows are ready.')
      : review.problems && !skipProblems
        ? t('Skip the rows needing attention to enable import.')
        : ''
    : ''
  const previewStart = header >= 0 ? header + 1 : 0
  const previewWidth = sheet?.width ?? sheet?.rows[0]?.length ?? 0
  const previewRows = sheet?.rows.slice(previewStart, previewStart + 5) ?? []
  const previewTotal = Math.max((sheet?.rows.length ?? 0) - previewStart, 0)
  const showPagination = total > REVIEW_PAGE_SIZE && (!sheet || Boolean(review))
  const actionDisabledReason = busy
    ? committing
      ? t('Importing…')
      : reviewing
        ? t('Reviewing import…')
        : progress || t('Loading…')
    : remoteDatasets
      ? t(
          'Journal data changed in another window. Your draft is preserved. Cancel this draft to load the latest data.'
        )
      : review
        ? commitDisabledReason
        : reviewDisabledReason
  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-4">
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex size-4">
          {reviewPageLoading ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              role="status"
              aria-label={t('Loading')}
            />
          ) : null}
        </span>
        {total
          ? t('{{start}}–{{end}} of {{total}}', {
              start: pageOffset + 1,
              end: Math.min(pageOffset + REVIEW_PAGE_SIZE, total),
              total
            })
          : ''}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {sheet && !review && reviewDisabledReason && !busy && !remoteDatasets ? (
          <span className="max-w-md self-center text-xs text-muted-foreground" role="status">
            {reviewDisabledReason}
          </span>
        ) : null}
        {showPagination ? (
          <div className="flex items-center gap-1 border-r border-border pr-2">
            <Button
              variant="ghost"
              disabled={busy || pageOffset === 0}
              aria-label={t('Previous page')}
              onClick={() =>
                review
                  ? void changePage(pageOffset - REVIEW_PAGE_SIZE)
                  : setOffset(pageOffset - REVIEW_PAGE_SIZE)
              }
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              {t('Previous page')}
            </Button>
            <Button
              variant="ghost"
              disabled={busy || pageOffset + REVIEW_PAGE_SIZE >= total}
              aria-label={t('Next page')}
              onClick={() =>
                review
                  ? void changePage(pageOffset + REVIEW_PAGE_SIZE)
                  : setOffset(pageOffset + REVIEW_PAGE_SIZE)
              }
            >
              {t('Next page')}
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
        {sheet ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              discard()
              setSheet(undefined)
              setReview(undefined)
              setError('')
            }}
          >
            {t('Cancel')}
          </Button>
        ) : null}
        {review?.problems ? (
          <Button
            variant="outline"
            disabled={busy || Boolean(remoteDatasets)}
            onClick={() => void exportProblems()}
          >
            {t('Export problem rows')}
          </Button>
        ) : null}
        {sheet || review ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                asChild
                onPointerDown={(event) => {
                  if (actionDisabledReason) {
                    event.preventDefault()
                    event.stopPropagation()
                  }
                }}
                onClick={(event) => {
                  if (actionDisabledReason) {
                    event.preventDefault()
                    event.stopPropagation()
                  }
                }}
              >
                <span
                  className={`inline-flex rounded-lg focus-visible:keyboard-focus ${actionDisabledReason ? 'cursor-not-allowed' : ''}`}
                  aria-disabled={Boolean(actionDisabledReason)}
                  tabIndex={actionDisabledReason ? 0 : undefined}
                  aria-label={
                    actionDisabledReason
                      ? review
                        ? t('Import attributes')
                        : t('Review import')
                      : undefined
                  }
                >
                  <Button
                    disabled={Boolean(actionDisabledReason)}
                    aria-busy={committing || undefined}
                    onClick={() => (review ? void commit() : void startReview())}
                  >
                    {committing || reviewing ? (
                      <LoaderCircle
                        className="size-4 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : null}
                    {committing
                      ? t('Importing…')
                      : reviewing
                        ? t('Reviewing import…')
                        : review
                          ? t('Import attributes')
                          : t('Review import')}
                  </Button>
                </span>
              </TooltipTrigger>
              {actionDisabledReason ? (
                <TooltipContent>{actionDisabledReason}</TooltipContent>
              ) : null}
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Button disabled={busy} onClick={onClose}>
            {t('Done')}
          </Button>
        )}
      </div>
    </div>
  )
  const entriesTable = useMemo(
    () =>
      dataset ? (
        <ActionMenuProvider>
          <div className="isolate flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-300/80 bg-bg-000">
            <LiteratureTableScrollArea>
              <LiteratureTable
                className="w-full table-fixed text-left text-xs"
                style={{
                  minWidth:
                    388 +
                    (identityColumns.issn ? 180 : 0) +
                    (identityColumns.externalIds ? 160 : 0) +
                    dataset.fields
                      .filter((field) => field.visible)
                      .reduce(
                        (width, field) =>
                          width +
                          (field.kind === 'number'
                            ? 170
                            : field.kind === 'singleSelect'
                              ? 180
                              : 180),
                        0
                      )
                }}
              >
                <colgroup>
                  <col style={{ width: 48 }} />
                  <col />
                  {identityColumns.issn ? <col style={{ width: 180 }} /> : null}
                  {identityColumns.externalIds ? <col style={{ width: 160 }} /> : null}
                  {dataset.fields
                    .filter((field) => field.visible)
                    .map((field) => (
                      <col
                        key={field.id}
                        style={{
                          width:
                            field.kind === 'number'
                              ? 170
                              : field.kind === 'singleSelect'
                                ? 180
                                : 180
                        }}
                      />
                    ))}
                  <col style={{ width: 80 }} />
                </colgroup>
                <thead className="sticky top-0 z-40 border-b border-border-300/80 bg-bg-200 text-xs font-medium text-muted-foreground">
                  <tr>
                    <th
                      scope="col"
                      className="w-12 min-w-12 max-w-12 px-2 py-2.5 text-center tabular-nums"
                    >
                      #
                    </th>
                    <th
                      aria-sort={sortField ? 'none' : descending ? 'descending' : 'ascending'}
                      className="px-3 py-2.5"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto max-w-full truncate px-0 font-medium"
                        disabled={busy || editing || Boolean(entryDraft)}
                        onClick={() => {
                          setSortField(undefined)
                          setDescending(sortField ? false : !descending)
                          setOffset(0)
                        }}
                      >
                        <Type className="size-3.5 shrink-0" aria-hidden="true" />
                        {t('Journal name')}
                        {sortField ? (
                          <ArrowUpDown
                            className="size-3.5 shrink-0 opacity-60"
                            aria-hidden="true"
                          />
                        ) : descending ? (
                          <ArrowDown
                            className="size-3.5 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                        ) : (
                          <ArrowUp className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                        )}
                      </Button>
                    </th>
                    {identityColumns.issn ? (
                      <th className="px-3 py-2.5">
                        <span className="flex items-center gap-2">
                          <Type className="size-3.5 shrink-0" aria-hidden="true" />
                          {t('ISSN')}
                        </span>
                      </th>
                    ) : null}
                    {identityColumns.externalIds ? (
                      <th className="px-3 py-2.5">
                        <span className="flex items-center gap-2">
                          <Type className="size-3.5 shrink-0" aria-hidden="true" />
                          {t('External IDs')}
                        </span>
                      </th>
                    ) : null}
                    {dataset.fields
                      .filter(({ visible }) => visible)
                      .map((field) => (
                        <th
                          key={field.id}
                          aria-sort={
                            sortField === field.id
                              ? descending
                                ? 'descending'
                                : 'ascending'
                              : 'none'
                          }
                          className="px-3 py-2.5"
                        >
                          <JournalColumnHeader
                            identity={`${dataset.id}:${field.id}`}
                            label={field.label}
                            icon={journalFieldKindIcons[field.kind]}
                            direction={
                              sortField === field.id
                                ? descending
                                  ? 'descending'
                                  : 'ascending'
                                : undefined
                            }
                            disabled={busy || editing || Boolean(entryDraft)}
                            onSort={(nextDescending) => {
                              setSortField(field.id)
                              setDescending(nextDescending)
                              setOffset(0)
                            }}
                            field={field}
                            onSave={(next) =>
                              persistFields(
                                dataset.fields.map((entry) =>
                                  entry.id === field.id ? next : entry
                                )
                              )
                            }
                            onHide={async () => {
                              await persistFields(
                                dataset.fields.map((entry) =>
                                  entry.id === field.id ? { ...entry, visible: false } : entry
                                )
                              )
                            }}
                          />
                        </th>
                      ))}
                    <th className="sticky right-0 z-30 w-20 min-w-20 max-w-20 border-l border-transparent bg-bg-200 group-data-[overflow-right=true]/journal-scroll:border-border-300/60 px-2 py-2.5 text-right before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-2 before:bg-linear-to-l before:from-foreground/5 before:to-transparent before:opacity-0 group-data-[overflow-right=true]/journal-scroll:before:opacity-100" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-300/70">
                  {entries.entries?.map((entry, index) => (
                    <JournalEntryRow
                      key={entry.id}
                      entry={entry}
                      number={entriesOffset + index + 1}
                      dataset={dataset}
                      showIssn={identityColumns.issn}
                      showExternalIds={identityColumns.externalIds}
                      draft={entryDraft?.id === entry.id ? entryDraft : undefined}
                      disabled={busy || editing || Boolean(entryDraft)}
                      busy={busy}
                      saveDisabled={entryDraft?.id === entry.id && Boolean(remoteDatasets)}
                      onDraft={setEntryDraft}
                      onSave={entryDraft?.id === entry.id ? saveEntry : undefined}
                    />
                  ))}
                </tbody>
              </LiteratureTable>
            </LiteratureTableScrollArea>
            {!entriesFailed && entries.total !== undefined ? (
              <LiteraturePagination
                total={entries.total ?? 0}
                offset={offset}
                pageSize={pageSize}
                displayedCount={entries.entries?.length ?? 0}
                countLabel={t('{{count}} journals', {
                  count: entries.total ?? 0,
                  defaultValue_one: '{{count}} journal'
                })}
                pageSizeLabel={t('Journals per page')}
                disabled={busy || editing || Boolean(entryDraft)}
                loading={entriesLoading}
                onOffsetChange={setOffset}
                onPageSizeChange={(size) => {
                  setOffset(0)
                  setPageSize(size as 25 | 50 | 100)
                }}
              />
            ) : null}
          </div>
        </ActionMenuProvider>
      ) : null,
    [
      dataset,
      entries.entries,
      entriesOffset,
      entries.total,
      identityColumns,
      offset,
      pageSize,
      entriesLoading,
      entriesFailed,
      busy,
      editing,
      entryDraft,
      remoteDatasets,
      sortField,
      descending,
      saveEntry,
      persistFields,
      t
    ]
  )
  const datasetSelector = datasets.length ? (
    <Select
      value={selected || 'new'}
      disabled={busy || editing || Boolean(entryDraft)}
      onValueChange={(value) => {
        setSelected(value === 'new' ? '' : value)
        setOffset(0)
        setConfirmRemove(false)
        setQuery('')
        setSortField(undefined)
      }}
    >
      <SelectTrigger
        aria-label={t('Journal dataset')}
        className="w-56 max-w-full bg-muted font-medium shadow-xs [&>span:first-of-type]:flex-1 [&>span:first-of-type]:text-left"
      >
        <Database className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {datasets.map((entry) => (
          <SelectItem
            key={entry.id}
            value={entry.id}
            icon={<Database className="size-4 text-muted-foreground" aria-hidden="true" />}
          >
            {journalDatasetLabel(entry)}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value="new" icon={<Plus className="size-4" aria-hidden="true" />}>
          {t('New dataset')}
        </SelectItem>
      </SelectContent>
    </Select>
  ) : null
  const datasetVisibility = dataset ? (
    <div className="flex items-center gap-2 text-sm">
      <Switch
        id={visibilityId}
        checked={selectJournalDatasets(datasets, sourceYears).some(({ id }) => id === dataset.id)}
        onCheckedChange={(checked) =>
          setJournalSourceYear(dataset.source, checked ? dataset.year : null)
        }
      />
      <label htmlFor={visibilityId} className="cursor-pointer">
        {t('Show in literature')}
      </label>
      <CollectionOptionHelp label={t('Show in literature')}>
        <p>{t('Applies to all references, collections, projects and reference details.')}</p>
        <p className="mt-2">
          {t(
            'Only one year per source is shown. Enabling this dataset replaces the selected year for this source.'
          )}
        </p>
      </CollectionOptionHelp>
    </div>
  ) : null
  const body = (
    <div
      ref={bodyScroll}
      className={
        embedded && (review || (dataset && !sheet))
          ? 'flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-6 lg:px-6 lg:py-8'
          : embedded
            ? 'min-h-0 flex-1 space-y-4 overflow-auto px-4 py-6 lg:px-6 lg:py-8'
            : 'min-h-0 space-y-4 overflow-auto px-4 py-6 lg:px-6 lg:py-8'
      }
    >
      {embedded ? (
        <div className="flex shrink-0 flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 flex-1 basis-80">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">{t('Journals')}</h2>
              {!sheet ? datasetSelector : null}
              {!sheet ? datasetVisibility : null}
            </div>
            <p
              className="mt-1 truncate text-sm text-muted-foreground"
              title={t(
                'Add journal metrics and classifications such as JIF, quartiles, and rankings to your references.'
              )}
            >
              {t(
                'Add journal metrics and classifications such as JIF, quartiles, and rankings to your references.'
              )}
            </p>
          </div>
          {!sheet ? (
            <div className="flex flex-wrap items-center gap-2">
              {datasets.length > 0 ? (
                <Button
                  disabled={busy || editing || Boolean(entryDraft)}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload className="size-4" aria-hidden="true" />
                  {dataset ? t('Update dataset') : t('Import attributes')}
                </Button>
              ) : null}
              <Button
                variant="outline"
                disabled={busy || Boolean(entryDraft)}
                onClick={() => void template()}
              >
                <Download className="size-4" aria-hidden="true" />
                {t('Download template')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {remoteDatasets ? (
        <LiteratureErrorNotice
          tone="amber"
          title={t(
            'Journal data changed in another window. Your draft is preserved. Cancel this draft to load the latest data.'
          )}
        />
      ) : null}
      {error ? (
        <div ref={errorNotice} tabIndex={-1} className="shrink-0 outline-none">
          <LiteratureErrorNotice
            tone="amber"
            title={error}
            secondaryButton={{
              label: t('Reload'),
              disabled: busy,
              onClick: async () => {
                cancelled.current = false
                setBusy(true)
                try {
                  const result = await api({ action: 'list' })
                  if (!mounted.current) return
                  setDatasets(result.datasets ?? [])
                  setFieldDraft(undefined)
                  setEntryDraft(undefined)
                  setReview(undefined)
                  discard()
                  setError('')
                } catch (error) {
                  fail(error)
                } finally {
                  if (mounted.current) setBusy(false)
                }
              }
            }}
          />
        </div>
      ) : null}
      {message && (!dataset || sheet || review) ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {busy && !reviewPageLoading && (sheet || review || !dataset || canCancel) ? (
        <div
          aria-busy="true"
          className={
            !sheet && !dataset
              ? 'flex min-h-64 shrink-0 flex-col items-center justify-center gap-4 rounded-lg border border-border bg-muted/20 px-6 py-10 text-center'
              : 'flex shrink-0 items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3'
          }
        >
          <div
            role="status"
            className={
              !sheet && !dataset
                ? 'flex min-w-0 flex-col items-center gap-3'
                : 'flex min-w-0 flex-1 items-center gap-3'
            }
          >
            <span
              className={
                !sheet && !dataset
                  ? 'flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-primary'
                  : 'flex size-5 shrink-0 items-center justify-center text-primary'
              }
            >
              <LoaderCircle
                className="size-5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            </span>
            <span className="min-w-0 break-words text-sm font-medium">
              {progress || t('Loading…')}
            </span>
          </div>
          {canCancel ? (
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => {
                cancelled.current = true
                abortParser.current?.()
                if (!exporting.current) discard()
                setProgress(t('Cancelling…'))
              }}
            >
              {t('Cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!sheet ? (
        <>
          <div className={embedded ? 'hidden' : 'flex flex-wrap items-center gap-2'}>
            {!embedded ? (
              <>
                {datasetSelector}
                {datasetVisibility}
                <Button
                  disabled={busy || editing || Boolean(entryDraft)}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload className="size-4" aria-hidden="true" />
                  {dataset ? t('Update dataset') : t('Import attributes')}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || Boolean(entryDraft)}
                  onClick={() => void template()}
                >
                  <Download className="size-4" aria-hidden="true" />
                  {t('Download template')}
                </Button>
              </>
            ) : null}
            <input
              ref={fileInput}
              className="hidden"
              type="file"
              accept=".csv,.tsv,.xlsx,.json,application/json"
              aria-label={t('Import journal file')}
              onChange={(event) => {
                const selected = event.target.files?.[0]
                event.target.value = ''
                if (selected) void read(selected)
              }}
            />
          </div>
          {catalogLoaded && !busy && (datasets.length === 0 || !dataset) ? (
            <div className="space-y-3">
              <div
                {...dropZoneProps}
                className="group relative rounded-lg border border-dashed border-border bg-muted/20 transition-colors motion-reduce:transition-none hover:bg-muted/40"
              >
                <Button
                  variant="ghost"
                  className="absolute inset-0 size-full rounded-lg hover:bg-transparent"
                  aria-label={t('Import attributes')}
                  aria-describedby={uploadDescriptionId}
                  disabled={busy || editing || Boolean(remoteDatasets)}
                  onClick={() => fileInput.current?.click()}
                />
                {isDragging ? (
                  <FileDropOverlay label={t('Drop to upload')} className="rounded-lg" />
                ) : null}
                <div className="pointer-events-none relative flex min-h-64 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
                  <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Upload className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="text-sm font-medium">{t('Drag and drop or click to upload')}</h3>
                  <p id={uploadDescriptionId} className="text-xs leading-5 text-muted-foreground">
                    {t(
                      'Match journals by title, ISSN/eISSN or external ID, then choose which columns to add.'
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('CSV, TSV, XLSX or journal bundle, up to 32 MB.')}
                  </p>
                  <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                    {t('Journal bundles include data and column settings.')}
                  </p>
                </div>
              </div>
            </div>
          ) : null}
          {dataset ? (
            <>
              <div className="mb-2 flex min-h-12 shrink-0 flex-wrap items-center justify-end gap-2">
                {message ? (
                  <span
                    role="status"
                    className="mr-auto min-w-0 flex-1 truncate text-xs text-muted-foreground"
                    title={message}
                  >
                    {message}
                  </span>
                ) : null}
                <Input
                  aria-label={t('Search journals')}
                  placeholder={t('Search journals')}
                  className="w-full sm:w-80 sm:max-w-full"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setOffset(0)
                  }}
                />
                <Button
                  variant="outline"
                  disabled={busy || Boolean(entryDraft)}
                  onClick={() => {
                    setIdentityDraft(identityColumns)
                    setFieldDraft(editing ? undefined : dataset.fields)
                    setChoiceField('')
                    setChoicePage(undefined)
                  }}
                >
                  <Settings2 className="size-4" aria-hidden="true" />
                  {t('Customize columns')}
                </Button>
                <JournalDatasetActions
                  key={dataset.id}
                  dataset={dataset}
                  loading={busy}
                  disabled={busy || editing || Boolean(entryDraft)}
                  onRenamed={(next) => {
                    catalogGeneration.current++
                    setDatasets(next)
                    setRemoteDatasets(undefined)
                    refreshJournalAttributes()
                  }}
                  onExport={() => void exportBundle()}
                  onDelete={() => void reviewRemoval()}
                  onOpenItem={onOpenItem}
                />
              </div>
              {confirmRemove ? (
                <div className="space-y-2 rounded border border-border p-3">
                  <p className="text-sm">
                    {t('Remove this journal dataset? References will be kept.')}
                  </p>
                  <p className="text-sm">
                    {t('Journal identities to remove: {{total}}', {
                      total: removal?.journals ?? 0
                    })}
                  </p>
                  <p className="text-sm">
                    {t('Manual confirmations to remove: {{total}}', {
                      total: removal?.bindings ?? 0
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('Importing the dataset again will not restore removed confirmations.')}
                  </p>
                  <div className="flex justify-end gap-2 pt-1">
                    <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
                      {t('Cancel')}
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={busy || !removal}
                      onClick={() => void remove()}
                    >
                      {t('Delete')}
                    </Button>
                  </div>
                </div>
              ) : null}
              {editing ? (
                <div className="flex max-h-[45vh] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
                  <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
                    <p className="text-sm font-medium">{t('Customize columns')}</p>
                    <div className="flex flex-wrap items-center gap-4">
                      {(['issn', 'externalIds'] as const).map((key) => (
                        <div key={key} className="flex items-center gap-1 text-sm">
                          <ColumnVisibility
                            label={key === 'issn' ? t('ISSN') : t('External IDs')}
                            checked={identityDraft[key]}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              setIdentityDraft((current) => ({ ...current, [key]: checked }))
                            }
                          />
                          <span>{key === 'issn' ? t('ISSN') : t('External IDs')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="min-h-0 space-y-1 overflow-y-auto p-2">
                    {fieldDraft?.map((field) => {
                      const categorical =
                        field.kind === 'singleSelect' || field.kind === 'multiSelect'
                      const choices = choiceField === field.id ? (choiceResult?.choices ?? []) : []
                      const update = (patch: Partial<typeof field>): void =>
                        setFieldDraft((fields) =>
                          fields?.map((value) =>
                            value.id === field.id ? { ...value, ...patch } : value
                          )
                        )
                      return (
                        <JournalFieldRow
                          key={field.id}
                          id={field.id}
                          name={field.label}
                          disabled={busy}
                          onMove={moveField}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <ColumnVisibility
                              label={field.label}
                              checked={field.visible}
                              disabled={busy}
                              onCheckedChange={(visible) => update({ visible })}
                            />
                            <div className="min-w-36 flex-1 text-sm">
                              <Input
                                aria-label={t('Attribute name')}
                                value={field.label}
                                disabled={busy}
                                maxLength={100}
                                onChange={(event) => update({ label: event.target.value })}
                              />
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Select
                                value={field.kind}
                                disabled={busy}
                                onValueChange={(value) =>
                                  update({ kind: value as JournalField['kind'] })
                                }
                              >
                                <SelectTrigger aria-label={t('Attribute type')} className="w-44">
                                  <span className="flex min-w-0 items-center gap-2 [&>svg]:shrink-0">
                                    {(() => {
                                      const Icon = journalFieldKindIcons[field.kind]
                                      return (
                                        <Icon
                                          className="size-4 text-muted-foreground"
                                          aria-hidden="true"
                                        />
                                      )
                                    })()}
                                    <SelectValue className="truncate" />
                                  </span>
                                </SelectTrigger>
                                <SelectContent>
                                  {JOURNAL_FIELD_KINDS.map((kind) => {
                                    const Icon = journalFieldKindIcons[kind]
                                    return (
                                      <SelectItem
                                        key={kind}
                                        value={kind}
                                        icon={
                                          <Icon
                                            className="size-4 text-muted-foreground"
                                            aria-hidden="true"
                                          />
                                        }
                                      >
                                        {kinds[kind]}
                                      </SelectItem>
                                    )
                                  })}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="flex w-44 shrink-0 items-center">
                              {categorical ? (
                                <Popover
                                  open={choiceField === field.id}
                                  onOpenChange={(open) => {
                                    setChoiceField(open ? field.id : '')
                                    if (open) {
                                      setChoiceQuery('')
                                      setChoiceOffset(0)
                                    }
                                  }}
                                >
                                  <PopoverTrigger asChild>
                                    <Button variant="outline" size="sm" disabled={busy}>
                                      <Palette className="size-4" aria-hidden="true" />
                                      {t('Edit category colors')}
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    align="end"
                                    className="flex w-60 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border border-border bg-card p-3 text-sm text-foreground shadow-dialog"
                                    aria-label={`${field.label}: ${t('Edit category colors')}`}
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="truncate font-medium">{field.label}</p>
                                        <p className="text-xs text-muted-foreground">
                                          {t('Edit category colors')}
                                        </p>
                                      </div>
                                      <PopoverClose asChild>
                                        <Button variant="ghost" size="icon" aria-label={t('Close')}>
                                          <X className="size-4" aria-hidden="true" />
                                        </Button>
                                      </PopoverClose>
                                    </div>
                                    <Input
                                      aria-label={t('Search choices')}
                                      placeholder={t('Search choices')}
                                      value={choiceQuery}
                                      disabled={busy}
                                      onChange={(event) => {
                                        setChoiceQuery(event.target.value)
                                        setChoiceOffset(0)
                                      }}
                                    />
                                    <div
                                      className="max-h-64 min-h-12 overflow-y-auto space-y-1"
                                      aria-busy={!choiceResult}
                                    >
                                      {!choiceResult ? (
                                        <p
                                          role="status"
                                          className="flex items-center gap-2 p-2 text-xs text-muted-foreground"
                                        >
                                          <LoaderCircle
                                            className="size-4 animate-spin motion-reduce:animate-none"
                                            aria-hidden="true"
                                          />
                                          {t('Loading…')}
                                        </p>
                                      ) : null}
                                      {choiceResult && !choices.length ? (
                                        <p className="p-2 text-xs text-muted-foreground">
                                          {t('No results found')}
                                        </p>
                                      ) : null}
                                      {choices.map((choice) => (
                                        <JournalChoiceColor
                                          key={choice}
                                          choice={choice}
                                          field={field}
                                          dataset={dataset}
                                          disabled={busy}
                                          labels={colors}
                                          onChange={(color) => {
                                            const next = { ...field.colors }
                                            if (color === undefined) delete next[choice]
                                            else next[choice] = color
                                            update({ colors: next })
                                          }}
                                        />
                                      ))}
                                    </div>
                                    {(choiceResult?.total ?? 0) > 50 || choiceOffset > 0 ? (
                                      <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
                                        <Button
                                          variant="outline"
                                          size="icon"
                                          aria-label={t('Previous')}
                                          disabled={busy || !choiceResult || choiceOffset === 0}
                                          onClick={() => setChoiceOffset(choiceOffset - 50)}
                                        >
                                          <ChevronLeft className="size-4" aria-hidden="true" />
                                        </Button>
                                        {choiceResult?.total ? (
                                          <span className="text-xs text-muted-foreground">
                                            {t('{{start}}–{{end}} of {{total}}', {
                                              start: choiceOffset + 1,
                                              end: Math.min(choiceOffset + 50, choiceResult.total),
                                              total: choiceResult.total
                                            })}
                                          </span>
                                        ) : null}
                                        <Button
                                          variant="outline"
                                          size="icon"
                                          aria-label={t('Next')}
                                          disabled={
                                            busy ||
                                            !choiceResult ||
                                            choiceOffset + 50 >= (choiceResult.total ?? 0)
                                          }
                                          onClick={() => setChoiceOffset(choiceOffset + 50)}
                                        >
                                          <ChevronRight className="size-4" aria-hidden="true" />
                                        </Button>
                                      </div>
                                    ) : null}
                                  </PopoverContent>
                                </Popover>
                              ) : null}
                            </div>
                          </div>
                        </JournalFieldRow>
                      )
                    })}
                  </div>
                  <div className="flex shrink-0 justify-end gap-2 border-t border-border px-3 py-2">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setFieldDraft(undefined)
                        setChoiceField('')
                        setChoicePage(undefined)
                      }}
                    >
                      {t('Cancel')}
                    </Button>
                    <Button
                      disabled={
                        busy ||
                        Boolean(remoteDatasets) ||
                        fieldDraft?.some((field) => !field.label.trim())
                      }
                      onClick={() => void saveFields()}
                    >
                      {busy ? (
                        <LoaderCircle
                          className="size-4 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : null}
                      {busy ? t('Saving…') : t('Save')}
                    </Button>
                  </div>
                </div>
              ) : null}
              {entriesTable}
            </>
          ) : null}
        </>
      ) : review ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <p className="text-sm">
                {t('{{ready}} ready; {{problems}} need attention.', {
                  ready: review.ready,
                  problems: review.problems
                })}
              </p>
              <CollectionOptionHelp label={t('Review import')}>
                <div className="space-y-2">
                  <p>
                    {t(
                      'Only selected attributes are saved. Empty values never erase existing data.'
                    )}
                  </p>
                  {review.problems && skipProblems ? (
                    <p>
                      {t('Rows to skip: {{total}}. Only ready rows will be imported.', {
                        total: review.problems
                      })}
                    </p>
                  ) : null}
                </div>
              </CollectionOptionHelp>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                className="shrink-0 self-start"
                disabled={busy}
                onClick={() => {
                  discard()
                  setReview(undefined)
                }}
              >
                {t('Edit mapping')}
              </Button>
              {review.problems ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  aria-pressed={problemsOnly}
                  onClick={() => void changePage(0, !problemsOnly)}
                >
                  {problemsOnly ? t('Show all rows') : t('Show problem rows')}
                </Button>
              ) : null}
            </div>
          </div>
          {review.problems ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox.Root
                checked={skipProblems}
                disabled={busy}
                onCheckedChange={(checked) => setSkipProblems(checked === true)}
                aria-label={t('Skip ambiguous, invalid and duplicate rows')}
                className="flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <Checkbox.Indicator>
                  <Check className="size-3" aria-hidden="true" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              {t('Skip ambiguous, invalid and duplicate rows')}
            </label>
          ) : null}
          {commitDisabledReason ? (
            <LiteratureErrorNotice inline role="status" tone="amber" title={commitDisabledReason} />
          ) : null}
          <div
            ref={reviewScroll}
            aria-busy={reviewPageLoading}
            className={`isolate overflow-auto rounded-xl border border-border-300/80 bg-bg-000 ${embedded ? 'min-h-0 flex-1' : 'max-h-[min(60vh,42rem)]'}`}
          >
            <LiteratureTable
              className="w-full table-fixed text-left text-xs"
              style={{
                minWidth: 540 + columns.filter(({ role }) => role === 'attribute').length * 170
              }}
            >
              <colgroup>
                <col style={{ width: 60 }} />
                <col style={{ width: 300 }} />
                <col style={{ width: 180 }} />
                {columns
                  .filter(({ role }) => role === 'attribute')
                  .map(({ field }) => (
                    <col key={field.id} />
                  ))}
              </colgroup>
              <thead className="sticky top-0 z-10 border-b border-border-300/80 bg-bg-200 text-xs font-medium text-muted-foreground">
                <tr>
                  <th className="h-11 px-3 font-medium">{t('Row')}</th>
                  <th className="h-11 px-3 font-medium">
                    <span className="flex items-center gap-1.5">
                      <Type className="size-3.5 shrink-0" aria-hidden="true" />
                      {t('Journal name')}
                    </span>
                  </th>
                  <th className="h-11 px-3 font-medium">{t('Status')}</th>
                  {columns
                    .filter(({ role }) => role === 'attribute')
                    .map(({ field }) => {
                      const Icon = journalFieldKindIcons[field.kind]
                      return (
                        <th key={field.id} className="h-11 px-3 font-medium">
                          <span className="flex items-center gap-1.5">
                            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                            <LiteratureTextTooltip text={field.label}>
                              <span className="truncate">{field.label}</span>
                            </LiteratureTextTooltip>
                          </span>
                        </th>
                      )
                    })}
                </tr>
              </thead>
              <tbody>
                {review.rows?.map((row) => (
                  <tr
                    key={row.row}
                    className="border-b border-border-300/80 bg-bg-000 last:border-b-0 hover:bg-bg-100"
                  >
                    <td className="h-16 px-3 py-3 text-muted-foreground tabular-nums">{row.row}</td>
                    <td className="px-3 py-3">
                      <LiteratureTextTooltip text={row.name || row.issns.join(', ')}>
                        <span className="block truncate">{row.name || row.issns.join(', ')}</span>
                      </LiteratureTextTooltip>
                    </td>
                    <td className="px-3 py-3">
                      {statuses[row.status]}
                      {row.warnings.map((warning) => (
                        <p key={warning} className="mt-1 text-muted-foreground">
                          {warnings[warning]}
                        </p>
                      ))}
                    </td>
                    {columns
                      .filter(({ role }) => role === 'attribute')
                      .map(({ field }) => {
                        const previous = row.previous?.[field.id] ?? ''
                        const value =
                          missingJournalValue(row.values[field.id] ?? '') ||
                          (policy === 'fill' && !missingJournalValue(previous))
                            ? previous || '—'
                            : row.values[field.id]
                        return (
                          <td key={field.id} className="px-3 py-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              {!missingJournalValue(previous) && previous !== value ? (
                                <span
                                  className="max-w-full truncate text-muted-foreground"
                                  title={previous}
                                >
                                  {previous}
                                  {' → '}
                                </span>
                              ) : null}
                              <LiteratureTextTooltip text={value}>
                                <span className="min-w-0 max-w-full">
                                  <JournalAttributeValue
                                    attribute={{
                                      ...field,
                                      key: field.id,
                                      value,
                                      source,
                                      year: Number(year)
                                    }}
                                    singleLine
                                  />
                                </span>
                              </LiteratureTextTooltip>
                            </div>
                          </td>
                        )
                      })}
                  </tr>
                ))}
              </tbody>
            </LiteratureTable>
          </div>
        </>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{file?.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('Import settings')}</p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                {sheet.names.length > 1 ? (
                  <label className="space-y-1 text-xs">
                    {t('Worksheet')}
                    <Select
                      value={sheet.selected}
                      disabled={busy}
                      onValueChange={(value) => {
                        if (file) void read(file, value)
                      }}
                    >
                      <SelectTrigger className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sheet.names.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : null}
                <label className="space-y-1 text-xs">
                  {t('Header row')}
                  <Input
                    type="number"
                    min={0}
                    max={sheet.rows.length}
                    value={header + 1}
                    disabled={busy}
                    onChange={(event) =>
                      remap(
                        sheet.rows,
                        Math.max(
                          -1,
                          Math.min(sheet.rows.length - 1, Number(event.target.value) - 1)
                        )
                      )
                    }
                  />
                </label>
                <Button
                  variant="outline"
                  disabled={busy || sheet.rows.length > 256}
                  onClick={() => {
                    const width = sheet.width ?? sheet.rows[0]?.length ?? 0
                    const rows = Array.from({ length: width }, (_, index) =>
                      sheet.rows.map((row) => row[index] ?? '')
                    )
                    setSheet({ ...sheet, rows, width: sheet.rows.length })
                    remap(rows, suggestJournalHeader(rows), sheet.rows.length)
                  }}
                >
                  {t('Transpose')}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !previewRows.length}
                  onClick={() => setShowFilePreview((value) => !value)}
                >
                  <Eye className="size-4" aria-hidden="true" />
                  {t(showFilePreview ? 'Hide preview' : 'Preview')}
                </Button>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t(
                'The first row is treated as column names. Change it if needed; enter 0 when the file has no column names.'
              )}
            </p>
            {skippedColumns.length ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-pressed={!showSkippedColumns}
                onClick={() => setShowSkippedColumns((value) => !value)}
              >
                {showSkippedColumns ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
                {t(showSkippedColumns ? 'Hide skipped columns' : 'Show skipped columns')} (
                {skippedColumns.length})
              </Button>
            ) : null}
          </div>
          {showFilePreview ? (
            <div className="space-y-2 rounded-lg border border-border bg-muted/10 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{t('File preview')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('Table preview: showing first {{shown}} of {{total}} rows.', {
                    shown: previewRows.length,
                    total: previewTotal
                  })}{' '}
                  {t('Hover a cell to see its full value.')}
                </p>
              </div>
              <div className="max-h-72 overflow-auto rounded-md border border-border">
                <LiteratureTable className="w-full min-w-max text-left text-xs">
                  <thead className="sticky top-0 bg-muted shadow-sm">
                    <tr>
                      <th className="whitespace-nowrap p-2">{t('Row')}</th>
                      {Array.from({ length: previewWidth }, (_, index) => (
                        <th key={index} className="max-w-48 truncate p-2">
                          {header >= 0
                            ? sheet?.rows[header]?.[index] ||
                              t('Column {{number}}', { number: index + 1 })
                            : t('Column {{number}}', { number: index + 1 })}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, rowIndex) => (
                      <tr key={previewStart + rowIndex} className="border-t border-border">
                        <td className="whitespace-nowrap p-2 text-muted-foreground">
                          {previewStart + rowIndex + 1}
                        </td>
                        {Array.from({ length: previewWidth }, (_, columnIndex) => {
                          const value = row[columnIndex] ?? ''
                          return (
                            <td key={columnIndex} className="max-w-48 p-2">
                              <LiteratureTextTooltip text={value}>
                                <span className="block max-w-48 truncate">{value || '—'}</span>
                              </LiteratureTextTooltip>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </LiteratureTable>
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-xs">
              <span className="flex min-h-6 items-center gap-2 font-medium">
                {t('Source')}
                {sourceSuggested ? (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[0.7rem] font-normal text-muted-foreground">
                    {t('Suggested')}
                  </span>
                ) : null}
              </span>
              <span className="block flex-1 text-muted-foreground">
                {t('Name of the source for this dataset.')}
              </span>
              <Input
                aria-label={t('Source')}
                value={source}
                maxLength={100}
                disabled={busy || Boolean(dataset)}
                onChange={(event) => {
                  resetInheritedFields()
                  setSourceSuggested(false)
                  setSource(event.target.value)
                }}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs">
              <span className="flex min-h-6 items-center gap-2 font-medium">
                {t('Metric year')}
                {yearSuggested ? (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[0.7rem] font-normal text-muted-foreground">
                    {t('Suggested')}
                  </span>
                ) : null}
              </span>
              <span className="block flex-1 text-muted-foreground">
                {t('Year the values describe; it can differ from the file release year.')}
              </span>
              <Input
                aria-label={t('Metric year')}
                type="number"
                min={1800}
                max={9999}
                value={year}
                disabled={busy || Boolean(dataset)}
                onChange={(event) => {
                  resetInheritedFields()
                  setYearSuggested(false)
                  setYear(event.target.value)
                }}
              />
            </label>
          </div>
          {!dataset && previousDataset ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'Choose an earlier attribute to keep its type, colors and table column selection across years.'
              )}
            </p>
          ) : null}
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              {t(
                'Use identity columns to match journals. Choose Journal attribute for values to show and filter in the literature table, such as impact factor or quartile.'
              )}
            </p>
            <p>
              {t(
                'Saved name and Value type apply only to journal attributes. Skipped columns are not saved.'
              )}
            </p>
          </div>
          {dataset ? (
            <label className="flex items-center gap-2 text-xs">
              {t('Existing values')}
              <Select
                value={policy}
                disabled={busy}
                onValueChange={(value) => setPolicy(value as 'fill' | 'replace')}
              >
                <SelectTrigger className="w-auto min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fill">{t('Fill missing values')}</SelectItem>
                  <SelectItem value="replace">{t('Replace selected values')}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          ) : null}
          <div className="overflow-auto rounded-xl border border-border-300/80 bg-bg-000">
            <LiteratureTable className="w-full min-w-[920px] table-fixed text-left text-xs">
              <thead className="border-b border-border-300/80 bg-bg-200 text-xs font-medium text-muted-foreground [&_th]:h-11 [&_th]:font-medium">
                <tr>
                  <th className="w-[18%] p-2">{t('Original column')}</th>
                  <th className="w-[22%] p-2">{t('Example value')}</th>
                  <th className="w-[18%] p-2">{t('Import as')}</th>
                  <th className="w-[25%] p-2">{t('Saved name')}</th>
                  <th className="w-[17%] p-2">{t('Value type')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleColumns.map((column) => {
                  const label = column.label || t('Column {{number}}', { number: column.index + 1 })
                  const example = sheet.rows[header + 1]?.[column.index] ?? ''
                  return (
                    <tr
                      className="border-t border-border-300/80 hover:bg-bg-100"
                      key={column.index}
                    >
                      <td className="p-2">
                        <LiteratureTextTooltip text={label}>
                          <span className="block truncate">{label}</span>
                        </LiteratureTextTooltip>
                      </td>
                      <td className="p-2">
                        <LiteratureTextTooltip text={example}>
                          <span className="block truncate">{example || '—'}</span>
                        </LiteratureTextTooltip>
                      </td>
                      <td className="p-2">
                        <Select
                          value={column.role}
                          disabled={busy}
                          onValueChange={(value) =>
                            updateColumn(column.index, { role: value as JournalColumn['role'] })
                          }
                        >
                          <SelectTrigger
                            aria-label={t('Role for column {{number}}', {
                              number: column.index + 1
                            })}
                            className="w-full max-w-40 min-w-0"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-[min(28rem,var(--radix-select-content-available-height))] w-72 max-w-[calc(100vw-2rem)]">
                            <SelectItem value="ignore" className="pl-4">
                              {roles.ignore}
                            </SelectItem>
                            <SelectSeparator />
                            <SelectGroup>
                              <div className="mb-1 px-2 py-2">
                                <SelectLabel className="p-0 text-xs font-semibold text-muted-foreground">
                                  {t('Identify journals')}
                                </SelectLabel>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {t('Used for matching, not as attribute columns.')}
                                </p>
                              </div>
                              {(['name', 'alias', 'issn', 'externalId'] as const).map((value) => (
                                <SelectItem key={value} value={value} className="pl-4">
                                  {roles[value]}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                            <SelectSeparator />
                            <SelectGroup>
                              <div className="mb-1 px-2 py-2">
                                <SelectLabel className="p-0 text-xs font-semibold text-muted-foreground">
                                  {t('Save as attribute columns')}
                                </SelectLabel>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {t('Show and filter these columns in the literature table.')}
                                </p>
                              </div>
                              <SelectItem value="attribute" className="pl-4">
                                {roles.attribute}
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="p-2">
                        {column.role === 'externalId' ? (
                          <div className="space-y-1">
                            <Select
                              value={
                                column.customExternalNamespace
                                  ? 'custom'
                                  : column.externalNamespace || 'none'
                              }
                              disabled={busy}
                              onValueChange={(value) =>
                                updateColumn(column.index, {
                                  customExternalNamespace: value === 'custom',
                                  externalNamespace:
                                    value === 'none' || value === 'custom' ? '' : value
                                })
                              }
                            >
                              <SelectTrigger
                                aria-label={t('External identifier namespace')}
                                className="w-full max-w-44 min-w-0"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">{t('Choose namespace')}</SelectItem>
                                {JOURNAL_EXTERNAL_ID_NAMESPACES.map((namespace) => (
                                  <SelectItem key={namespace} value={namespace}>
                                    {namespace.toUpperCase()}
                                  </SelectItem>
                                ))}
                                <SelectItem value="custom">{t('Custom namespace')}</SelectItem>
                              </SelectContent>
                            </Select>
                            {column.customExternalNamespace ? (
                              <Input
                                aria-label={t('Custom namespace')}
                                placeholder="publisher-id"
                                disabled={busy}
                                maxLength={80}
                                value={column.externalNamespace ?? ''}
                                onChange={(event) =>
                                  updateColumn(column.index, {
                                    externalNamespace: event.target.value
                                  })
                                }
                              />
                            ) : null}
                          </div>
                        ) : column.role === 'attribute' ? (
                          <div className="space-y-1">
                            {availableFields.length ? (
                              <Select
                                value={
                                  availableFields.some(({ id }) => id === column.field.id)
                                    ? column.field.id
                                    : 'new'
                                }
                                disabled={busy}
                                onValueChange={(value) => {
                                  const existing = availableFields.find(({ id }) => id === value)
                                  const fresh = { ...column.field, columnKey: undefined }
                                  updateColumn(column.index, {
                                    field: existing ?? { ...fresh, id: crypto.randomUUID() }
                                  })
                                }}
                              >
                                <SelectTrigger
                                  aria-label={t('Journal attribute')}
                                  className="w-full max-w-44 min-w-0"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="new">{t('New')}</SelectItem>
                                  {availableFields.map((field) => (
                                    <SelectItem key={field.id} value={field.id}>
                                      {field.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : null}
                            <Input
                              aria-label={t('Attribute name')}
                              value={column.field.label}
                              disabled={busy}
                              maxLength={100}
                              className="w-full max-w-56 min-w-0"
                              onChange={(event) =>
                                updateColumn(column.index, {
                                  field: { ...column.field, label: event.target.value }
                                })
                              }
                            />
                          </div>
                        ) : null}
                      </td>
                      <td className="p-2">
                        {column.role === 'attribute' ? (
                          <Select
                            value={column.field.kind}
                            disabled={
                              busy || availableFields.some(({ id }) => id === column.field.id)
                            }
                            onValueChange={(value) =>
                              updateColumn(column.index, {
                                field: {
                                  ...column.field,
                                  kind: value as JournalColumn['field']['kind']
                                }
                              })
                            }
                          >
                            <SelectTrigger
                              aria-label={t('Attribute type')}
                              className="w-full max-w-40 min-w-0"
                            >
                              <span className="flex min-w-0 items-center gap-2 [&>svg]:shrink-0">
                                {(() => {
                                  const Icon = journalFieldKindIcons[column.field.kind]
                                  return (
                                    <Icon
                                      className="size-4 text-muted-foreground"
                                      aria-hidden="true"
                                    />
                                  )
                                })()}
                                <SelectValue className="truncate" />
                              </span>
                            </SelectTrigger>
                            <SelectContent>
                              {JOURNAL_FIELD_KINDS.map((kind) => {
                                const Icon = journalFieldKindIcons[kind]
                                return (
                                  <SelectItem
                                    key={kind}
                                    value={kind}
                                    icon={
                                      <Icon
                                        className="size-4 text-muted-foreground"
                                        aria-hidden="true"
                                      />
                                    }
                                  >
                                    {kinds[kind]}
                                  </SelectItem>
                                )
                              })}
                            </SelectContent>
                          </Select>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </LiteratureTable>
          </div>
        </>
      )}
    </div>
  )

  if (embedded) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
        {body}
        {sheet || review ? footer : null}
      </div>
    )
  }

  return (
    <LiteratureImportDialogFrame
      title={t('Journals')}
      description={t('Import your own journal attributes and choose where they appear.')}
      busy={busy}
      onClose={onClose}
      footer={sheet || review ? footer : null}
    >
      {body}
    </LiteratureImportDialogFrame>
  )
})

function JournalChoiceColor({
  choice,
  field,
  dataset,
  disabled,
  labels,
  onChange
}: {
  choice: string
  field: JournalField
  dataset: Pick<JournalDataset, 'source' | 'year'>
  disabled: boolean
  labels: Record<TagColorKey, string>
  onChange: (color: TagColorKey | undefined) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const selected = field.colors[choice]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          disabled={disabled}
          aria-label={t('Color for {{value}}', { value: choice })}
          className="h-10 w-full justify-start gap-2 px-2"
        >
          <JournalAttributeValue
            attribute={{
              key: field.id,
              label: field.label,
              kind: 'singleSelect',
              value: choice,
              colors: field.colors,
              source: dataset.source,
              year: dataset.year
            }}
            singleLine
          />
          <ChevronDown
            className="ml-auto size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="left"
        className="w-48 space-y-3 rounded-xl border border-border bg-card p-3 text-sm text-foreground shadow-dialog"
        aria-label={t('Color for {{value}}', { value: choice })}
      >
        <div className="grid grid-cols-4 gap-2">
          {TAG_COLOR_KEYS.map((color) => (
            <button
              key={color}
              type="button"
              disabled={disabled}
              aria-label={labels[color]}
              title={labels[color]}
              aria-pressed={selected === color}
              className={`flex size-8 items-center justify-center rounded-md border focus-visible:keyboard-focus hover:ring-2 hover:ring-ring/40 ${TAG_COLORS[color]} ${selected === color ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : ''}`}
              onClick={() => {
                onChange(color)
                setOpen(false)
              }}
            >
              {selected === color ? <Check className="size-4" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          className="w-full justify-start"
          disabled={disabled}
          aria-pressed={selected === undefined}
          onClick={() => {
            onChange(undefined)
            setOpen(false)
          }}
        >
          {t('Automatic')}
          {selected === undefined ? <Check className="ml-auto size-4" aria-hidden="true" /> : null}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
