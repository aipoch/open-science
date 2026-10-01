import Papa from 'papaparse'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  JOURNAL_IMPORT_MAX_BYTES,
  journalExternalIdSchema,
  type JournalDataset,
  type JournalField,
  type JournalImportRow,
  type JournalResult
} from '../../../../shared/journal-attributes'
import { refreshJournalAttributes } from './journal-attribute-store'
import { importJournalBundle, readJournalBundle } from './journal-bundle'
import {
  journalColumns,
  suggestJournalHeader,
  suggestJournalSource,
  suggestJournalYear,
  type JournalColumn,
  type JournalSheet
} from './journal-import-file'

const REVIEW_PAGE_SIZE = 25

/** Own the import draft, parser, staged token and receipt until commit or discard. */
export function useJournalImport({
  dataset,
  remoteDatasets,
  busy,
  setBusy,
  setError,
  setMessage,
  mounted,
  cancelled: cancelledRef,
  catalogGeneration: catalogGenerationRef,
  setDatasets,
  setSelected,
  setFieldDraft,
  setRemoteDatasets,
  setOffset,
  setQuery,
  setSortField,
  bodyScroll: bodyScrollRef,
  reviewScroll: reviewScrollRef,
  fail,
  statuses,
  warnings
}: {
  dataset: JournalDataset | undefined
  remoteDatasets: JournalDataset[] | undefined
  busy: boolean
  setBusy: (value: boolean) => void
  setError: (message: string) => void
  setMessage: (message: string) => void
  mounted: React.RefObject<boolean>
  cancelled: React.RefObject<boolean>
  catalogGeneration: React.RefObject<number>
  setDatasets: React.Dispatch<React.SetStateAction<JournalDataset[]>>
  setSelected: React.Dispatch<React.SetStateAction<string>>
  setFieldDraft: React.Dispatch<React.SetStateAction<JournalField[] | undefined>>
  setRemoteDatasets: React.Dispatch<React.SetStateAction<JournalDataset[] | undefined>>
  setOffset: React.Dispatch<React.SetStateAction<number>>
  setQuery: React.Dispatch<React.SetStateAction<string>>
  setSortField: React.Dispatch<React.SetStateAction<string | undefined>>
  bodyScroll: React.RefObject<HTMLDivElement | null>
  reviewScroll: React.RefObject<HTMLDivElement | null>
  fail: (error: unknown) => void
  statuses: Record<NonNullable<JournalResult['rows']>[number]['status'], string>
  warnings: Record<NonNullable<JournalResult['rows']>[number]['warnings'][number], string>
}): {
  file: File | undefined
  sheet: JournalSheet | undefined
  setSheet: React.Dispatch<React.SetStateAction<JournalSheet | undefined>>
  header: number
  columns: JournalColumn[]
  showSkippedColumns: boolean
  setShowSkippedColumns: React.Dispatch<React.SetStateAction<boolean>>
  showFilePreview: boolean
  setShowFilePreview: React.Dispatch<React.SetStateAction<boolean>>
  source: string
  sourceSuggested: boolean
  setSourceSuggested: React.Dispatch<React.SetStateAction<boolean>>
  setSource: React.Dispatch<React.SetStateAction<string>>
  year: string
  yearSuggested: boolean
  setYearSuggested: React.Dispatch<React.SetStateAction<boolean>>
  setYear: React.Dispatch<React.SetStateAction<string>>
  policy: 'fill' | 'replace'
  setPolicy: React.Dispatch<React.SetStateAction<'fill' | 'replace'>>
  review: JournalResult | undefined
  setReview: React.Dispatch<React.SetStateAction<JournalResult | undefined>>
  reviewOffset: number
  reviewPageLoading: boolean
  skipProblems: boolean
  setSkipProblems: React.Dispatch<React.SetStateAction<boolean>>
  problemsOnly: boolean
  committing: boolean
  reviewing: boolean
  progress: string
  canCancel: boolean
  readDroppedFile: (file: File) => void
  read: (file: File, selectedSheet?: string) => Promise<void>
  remap: (rows: string[][], header: number, width?: number) => void
  updateColumn: (index: number, patch: Partial<JournalColumn>) => void
  startReview: () => Promise<void>
  commit: () => Promise<void>
  changePage: (offset: number, nextProblemsOnly?: boolean) => Promise<void>
  resetInheritedFields: () => void
  exportProblems: () => Promise<void>
  discard: () => void
  disposeParser: () => void
  cancelImport: () => void
} {
  const { t } = useTranslation()
  const api = window.api.literature.journals
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
  const [policy, setPolicy] = useState<'fill' | 'replace'>('fill')
  const [review, setReview] = useState<JournalResult>()
  const [reviewOffset, setReviewOffset] = useState(0)
  const [reviewPageLoading, setReviewPageLoading] = useState(false)
  const [skipProblems, setSkipProblems] = useState(true)
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [progress, setProgress] = useState('')
  const [canCancel, setCanCancel] = useState(false)
  const preparing = useRef(false)
  const exporting = useRef(false)
  const token = useRef<string | undefined>(undefined)
  const worker = useRef<Worker | undefined>(undefined)
  const abortParser = useRef<(() => void) | undefined>(undefined)
  const discard = (): void => {
    if (token.current) void api({ action: 'discard', token: token.current }).catch(() => {})
    token.current = undefined
  }
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
    cancelledRef.current = false
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
          () => cancelledRef.current || !mounted.current,
          () => setCanCancel(false)
        )
        if (!mounted.current) return
        catalogGenerationRef.current++
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
      if (!mounted.current || cancelledRef.current) {
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
      if (!mounted.current || cancelledRef.current) return
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
      if (!cancelledRef.current && mounted.current && /\.json$/i.test(file.name)) {
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
    cancelledRef.current = false
    setBusy(true)
    setReviewing(true)
    setProgress(t('Reviewing import…'))
    if (bodyScrollRef.current) bodyScrollRef.current.scrollTop = 0
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
      if (cancelledRef.current || !mounted.current) {
        discard()
        return
      }
      const importToken = result.token!
      let chunk: JournalImportRow[] = []
      let offset = 0
      let chunkBytes = 0
      const append = async (): Promise<void> => {
        if (!chunk.length) return
        if (cancelledRef.current || !mounted.current) throw new Error('Import cancelled')
        await api({ action: 'append', token: importToken, offset, rows: chunk })
        if (cancelledRef.current || !mounted.current) throw new Error('Import cancelled')
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
      if (cancelledRef.current || !mounted.current) {
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
      if (mounted.current && !cancelledRef.current) {
        if (bodyScrollRef.current) bodyScrollRef.current.scrollTop = 0
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
    cancelledRef.current = false
    setBusy(true)
    setCommitting(true)
    setProgress(t('Importing…'))
    setError('')
    catalogGenerationRef.current++
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
    cancelledRef.current = false
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
      if (reviewScrollRef.current) reviewScrollRef.current.scrollTop = 0
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
      setReviewPageLoading(false)
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
  const exportProblems = async (): Promise<void> => {
    if (!review?.digest || !review.problems || !token.current || !sheet) return
    exporting.current = true
    setBusy(true)
    setError('')
    preparing.current = true
    cancelledRef.current = false
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
        if (cancelledRef.current || !mounted.current) return
        const page = await api({
          action: 'preview',
          token: importToken,
          offset,
          problemsOnly: true
        })
        if (page.digest !== review.digest)
          throw new Error('Journal data changed. Review the import again.')
        if (cancelledRef.current || !mounted.current) return
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
  const disposeParser = (): void => {
    abortParser.current?.()
    worker.current?.terminate()
  }
  const cancelImport = (): void => {
    cancelledRef.current = true
    abortParser.current?.()
    if (!exporting.current) discard()
    setProgress(t('Cancelling…'))
  }
  const readDroppedFile = (file: File): void => {
    if (!preparing.current) void read(file)
  }
  return {
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
  }
}
