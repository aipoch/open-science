import { FileDropOverlay } from '@/components/FileDropOverlay'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  LoaderCircle,
  Plus,
  Settings2,
  Upload
} from 'lucide-react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseApplicationCommandError } from '../../../../shared/application-command-contract'
import {
  journalColumnKey,
  journalDatasetLabel,
  selectJournalDatasets,
  type JournalDataset
} from '../../../../shared/journal-attributes'
import { type TagColorKey } from '../../../../shared/tags'
import { CollectionOptionHelp } from './CollectionOptionHelp'
import { JournalColumnEditor } from './JournalColumnEditor'
import { JournalDatasetActions } from './JournalDatasetActions'
import { JournalEntriesTable } from './JournalEntriesTable'
import { JournalImportMapping } from './JournalImportMapping'
import { JournalImportReview } from './JournalImportReview'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { LiteratureImportDialogFrame } from './LiteratureImportDialogFrame'
import {
  refreshJournalAttributes,
  setJournalSourceYear,
  useJournalSourceYears
} from './journal-attribute-store'
import { downloadJournalTemplate } from './journal-template'
import { useJournalDatasetActions } from './useJournalDatasetActions'
import { useJournalEditing } from './useJournalEditing'
import { useJournalEntries } from './useJournalEntries'
import { useJournalImport } from './useJournalImport'

const REVIEW_PAGE_SIZE = 25

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
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25)
  const [sortField, setSortField] = useState<string>()
  const [descending, setDescending] = useState(false)
  const bodyScroll = useRef<HTMLDivElement>(null)
  const errorNotice = useRef<HTMLDivElement>(null)
  const reviewScroll = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!error) return
    if (bodyScroll.current) bodyScroll.current.scrollTop = 0
    errorNotice.current?.focus({ preventScroll: true })
  }, [error])
  const cancelled = useRef(false)

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
  const {
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
  } = useJournalEditing({
    dataset,
    remoteDatasets,
    cancelled,
    catalogGeneration,
    setBusy,
    setError,
    setMessage,
    setRemoteDatasets,
    setDatasets,
    setSortField,
    setOffset,
    fail
  })
  const {
    readDroppedFile,
    file,
    sheet,
    setSheet,
    header,
    columns,
    showSkippedColumns,
    setShowSkippedColumns,
    showFilePreview,
    setShowFilePreview,
    source,
    sourceSuggested,
    setSourceSuggested,
    setSource,
    year,
    yearSuggested,
    setYearSuggested,
    setYear,
    policy,
    setPolicy,
    review,
    setReview,
    reviewOffset,
    reviewPageLoading,
    skipProblems,
    setSkipProblems,
    problemsOnly,
    committing,
    reviewing,
    progress,
    canCancel,
    read,
    remap,
    updateColumn,
    startReview,
    commit,
    changePage,
    resetInheritedFields,
    exportProblems,
    discard,
    disposeParser,
    cancelImport
  } = useJournalImport({
    dataset,
    remoteDatasets,
    busy,
    setBusy,
    setError,
    setMessage,
    mounted,
    cancelled,
    catalogGeneration,
    setDatasets,
    setSelected,
    setFieldDraft,
    setRemoteDatasets,
    setOffset,
    setQuery,
    setSortField,
    bodyScroll,
    reviewScroll,
    fail,
    statuses,
    warnings
  })
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
      disposeParser()
      discard()
    }
    // The command adapter has stable identity for the lifetime of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const { entries, entriesOffset, entriesLoading, entriesFailed } = useJournalEntries({
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
  })

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

  const { confirmRemove, setConfirmRemove, removal, remove, reviewRemoval, exportBundle } =
    useJournalDatasetActions({
      dataset,
      cancelled,
      setBusy,
      setError,
      catalogGeneration,
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
    })

  const { isDragging, dropZoneProps } = useFileDropZone({
    enabled: isActive && !busy && !sheet && !review && !editing && !entryEditing && !remoteDatasets,
    onFiles: (files) => {
      if (files.length !== 1) {
        setError(t('Choose one journal file at a time.'))
        return
      }
      readDroppedFile(files[0])
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
    () => (
      <JournalEntriesTable
        dataset={dataset}
        identityColumns={identityColumns}
        sortField={sortField}
        descending={descending}
        busy={busy}
        editing={editing}
        entryDraft={entryDraft}
        setSortField={setSortField}
        setDescending={setDescending}
        setOffset={setOffset}
        persistFields={persistFields}
        entries={{ entries: entries.entries, total: entries.total }}
        entriesOffset={entriesOffset}
        remoteDatasets={remoteDatasets}
        setEntryDraft={setEntryDraft}
        saveEntry={saveEntry}
        entriesFailed={entriesFailed}
        offset={offset}
        pageSize={pageSize}
        entriesLoading={entriesLoading}
        setPageSize={setPageSize}
      />
    ),
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
      setEntryDraft,
      persistFields
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
                onClick={() => void downloadJournalTemplate(fail)}
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
                cancelImport()
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
                  onClick={() => void downloadJournalTemplate(fail)}
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
                <JournalColumnEditor
                  identityDraft={identityDraft}
                  busy={busy}
                  setIdentityDraft={setIdentityDraft}
                  fieldDraft={fieldDraft}
                  choiceField={choiceField}
                  choiceResult={choiceResult}
                  setFieldDraft={setFieldDraft}
                  moveField={moveField}
                  kinds={kinds}
                  setChoiceField={setChoiceField}
                  setChoiceQuery={setChoiceQuery}
                  setChoiceOffset={setChoiceOffset}
                  choiceQuery={choiceQuery}
                  dataset={dataset}
                  colors={colors}
                  choiceOffset={choiceOffset}
                  setChoicePage={setChoicePage}
                  remoteDatasets={remoteDatasets}
                  saveFields={saveFields}
                />
              ) : null}
              {entriesTable}
            </>
          ) : null}
        </>
      ) : review ? (
        <JournalImportReview
          review={review}
          skipProblems={skipProblems}
          busy={busy}
          discard={discard}
          setReview={setReview}
          problemsOnly={problemsOnly}
          changePage={changePage}
          setSkipProblems={setSkipProblems}
          commitDisabledReason={commitDisabledReason}
          reviewScroll={reviewScroll}
          reviewPageLoading={reviewPageLoading}
          embedded={embedded}
          columns={columns}
          statuses={statuses}
          warnings={warnings}
          policy={policy}
          source={source}
          year={year}
        />
      ) : (
        <JournalImportMapping
          file={file}
          sheet={sheet}
          busy={busy}
          read={read}
          header={header}
          remap={remap}
          setSheet={setSheet}
          previewRows={previewRows}
          setShowFilePreview={setShowFilePreview}
          showFilePreview={showFilePreview}
          skippedColumns={skippedColumns}
          showSkippedColumns={showSkippedColumns}
          setShowSkippedColumns={setShowSkippedColumns}
          previewTotal={previewTotal}
          previewWidth={previewWidth}
          previewStart={previewStart}
          sourceSuggested={sourceSuggested}
          source={source}
          dataset={dataset}
          resetInheritedFields={resetInheritedFields}
          setSourceSuggested={setSourceSuggested}
          setSource={setSource}
          yearSuggested={yearSuggested}
          year={year}
          setYearSuggested={setYearSuggested}
          setYear={setYear}
          previousDataset={previousDataset}
          policy={policy}
          setPolicy={setPolicy}
          visibleColumns={visibleColumns}
          updateColumn={updateColumn}
          roles={roles}
          availableFields={availableFields}
          kinds={kinds}
        />
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
