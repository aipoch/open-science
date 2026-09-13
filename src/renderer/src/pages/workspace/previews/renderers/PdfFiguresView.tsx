import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import {
  ImageIcon,
  Table2,
  ArrowUpRight,
  ScanSearch,
  RefreshCw,
  LoaderCircle,
  CircleCheck
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  LOCAL_MODEL_NOT_INSTALLED,
  PDF_MODEL_CHANGED,
  type LocalModelSnapshot
} from '../../../../../../shared/local-models'
import type { PdfStructureResult } from '../../../../../../shared/pdf-structure'
import { copyPdfTable, pdfTableLayout } from '../../../../../../shared/pdf-table-copy'

const formatBytes = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MiB`
type Selection = { result: PdfStructureResult; element: PdfStructureResult['elements'][number] }

const CandidateDetails = ({
  selected,
  attachmentVersionId,
  onNavigate
}: {
  selected: Selection
  attachmentVersionId: string
  onNavigate: (page: number) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { result, element } = selected
  const [image, setImage] = useState<string>()
  const [imageFailed, setImageFailed] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [copyStatus, setCopyStatus] = useState<string>()
  const [showImage, setShowImage] = useState(false)
  const table = element.table
  const missing = t('[Missing]')
  const grid =
    table && table.rowCount <= 256 && table.columnCount <= 128 ? pdfTableLayout(table) : undefined
  useEffect(() => {
    let live = true
    if (element.thumbnailId)
      void window.api.pdfStructure
        .readThumbnail({
          attachmentVersionId,
          page: element.regions[0].page,
          extractionId: result.extractionId,
          thumbnailId: element.thumbnailId
        })
        .then((url) => {
          if (live) {
            setImage(url)
            setImageFailed(!url)
          }
        })
        .catch(() => {
          if (live) setImageFailed(true)
        })
    return () => {
      live = false
    }
  }, [attachmentVersionId, element, result.extractionId])
  const copy = async (format: 'tsv' | 'markdown' | 'html'): Promise<void> => {
    if (!table || !reviewed) return
    try {
      if (format === 'html') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([copyPdfTable(table, 'html', missing)], { type: 'text/html' }),
            'text/plain': new Blob([copyPdfTable(table, 'tsv', missing, true)], {
              type: 'text/plain'
            })
          })
        ])
      } else await navigator.clipboard.writeText(copyPdfTable(table, format, missing))
      setCopyStatus(t('Copied'))
    } catch {
      setCopyStatus(t('Could not copy the table. Try again.'))
    }
  }
  return (
    <article className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-200 pb-2">
        <div className="flex items-center gap-3">
          <span className="font-medium">
            {element.kind === 'figure' ? t('Figure') : t('Table')}
          </span>
          <span className="text-xs text-text-300">
            {t('Page {{page}}', { page: element.regions[0].page })}
          </span>
        </div>
        {grid ? (
          <div role="group" aria-label={t('Table preview')} className="flex gap-1">
            <Button
              size="sm"
              variant={!showImage ? 'secondary' : 'ghost'}
              aria-pressed={!showImage}
              onClick={() => setShowImage(false)}
            >
              {t('Table')}
            </Button>
            <Button
              size="sm"
              variant={showImage ? 'secondary' : 'ghost'}
              aria-pressed={showImage}
              onClick={() => setShowImage(true)}
            >
              {t('Image')}
            </Button>
          </div>
        ) : null}
        <Button
          className="ml-auto"
          variant="ghost"
          size="sm"
          onClick={() => onNavigate(element.regions[0].page)}
        >
          {t('Show in PDF')}
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      {!grid || showImage ? (
        image ? (
          <img
            src={image}
            alt={t('Extracted region preview')}
            className="mx-auto max-h-[55vh] max-w-full rounded object-contain bg-white"
          />
        ) : (
          <p className="text-muted-foreground">
            {imageFailed ? t('Preview unavailable. Open the original page.') : t('Loading…')}
          </p>
        )
      ) : null}
      <p className="whitespace-normal break-words leading-6 text-text-100" data-pdf-caption>
        {element.caption?.text ?? t('No reliable caption association.')}
      </p>
      {element.issues.length > 0 ? (
        <p className="text-xs text-status-warning-foreground">
          {grid && !showImage && table?.unassignedText.length
            ? t('Some text could not be placed in the table. Review it below before copying.')
            : t('Check extracted content against the original PDF.')}
        </p>
      ) : null}
      {grid && !showImage ? (
        <>
          <div className="overflow-x-auto rounded-md border border-border-200">
            <table
              className="w-full border-collapse text-sm tabular-nums"
              aria-label={t('Candidate table')}
            >
              <tbody>
                {grid.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, column) =>
                      cell === null ? null : (
                        <td
                          key={column}
                          rowSpan={cell?.rowSpan}
                          colSpan={cell?.columnSpan}
                          className="min-w-24 border border-border-200 px-3 py-2 align-top"
                        >
                          {cell ? cell.text || '\u00a0' : missing}
                        </td>
                      )
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table!.unassignedText.length ? (
            <div className="space-y-1 rounded-md border border-border-200 bg-bg-20 p-3">
              <p className="font-medium">{t('Unplaced table text')}</p>
              <p className="text-xs leading-5 text-text-200">
                {t(
                  'Found in the table region, but its cell could not be determined. This text is not included when copying the table.'
                )}
              </p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {table!.unassignedText.map(({ text }) => text).join('\n')}
              </p>
            </div>
          ) : null}
          {table?.notes?.length ? (
            <section className="space-y-1 text-xs text-text-200">
              <h4 className="font-medium">{t('Table notes')}</h4>
              {table.notes.map((note, index) => (
                <p key={index} className="whitespace-normal leading-5">
                  {note.text}
                </p>
              ))}
            </section>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-200 pt-3">
            <label className="flex items-start gap-2 text-xs text-text-200">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
                className="mt-0.5"
              />
              {t('I checked the table against the PDF.')}
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!reviewed}
                onClick={() => void copy('html')}
              >
                {t('Copy formatted table')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!reviewed}
                onClick={() => void copy('tsv')}
              >
                {t('Copy TSV')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!reviewed}
                onClick={() => void copy('markdown')}
              >
                {t('Copy Markdown')}
              </Button>
            </div>
          </div>
          {copyStatus ? (
            <p role="status" className="text-xs">
              {copyStatus}
            </p>
          ) : null}
        </>
      ) : element.kind === 'table' && !grid ? (
        <p>{t('Structured cells are unavailable for this candidate.')}</p>
      ) : null}
    </article>
  )
}

export const PdfFiguresView = ({
  attachmentVersionId,
  pageCount,
  onNavigate
}: {
  attachmentVersionId: string
  pageCount: number
  onNavigate: (page: number) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [model, setModel] = useState<LocalModelSnapshot>()
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(0)
  const [results, setResults] = useState<PdfStructureResult[]>([])
  const [failed, setFailed] = useState<number[]>([])
  const [error, setError] = useState(false)
  const [selected, setSelected] = useState<Selection>()
  const [limited, setLimited] = useState(false)
  const generation = useRef(0)
  const requestId = useRef<string | undefined>(undefined)
  const installation = useRef<Promise<void> | undefined>(undefined)
  const mounted = useRef(true)
  const cancel = (): void => {
    generation.current++
    if (requestId.current)
      void window.api.pdfStructure.cancel(requestId.current).catch(() => undefined)
    requestId.current = undefined
    setBusy(false)
  }
  useEffect(() => {
    mounted.current = true
    const taskGeneration = generation
    let live = true
    const poll = (): void => {
      void window.api.localModels
        .getSnapshot()
        .then((next) => {
          if (live) setModel(next)
        })
        .catch(() => {
          if (live) setError(true)
        })
    }
    poll()
    const timer = setInterval(poll, 1000)
    return () => {
      live = false
      mounted.current = false
      clearInterval(timer)
      taskGeneration.current++
      if (requestId.current)
        void window.api.pdfStructure.cancel(requestId.current).catch(() => undefined)
    }
  }, [])
  const extract = async (): Promise<void> => {
    const own = ++generation.current
    setBusy(true)
    setError(false)
    setResults([])
    setFailed([])
    setCompleted(0)
    setSelected(undefined)
    setLimited(false)
    let totalBytes = 0
    let totalElements = 0
    try {
      // Join cancellation of an earlier install before starting a new one.
      await installation.current
      if (own !== generation.current) return
      const snapshot = await window.api.localModels.getSnapshot()
      if (own !== generation.current) return
      let needsInstall = !snapshot.installedRevision || snapshot.updateAvailable
      const install = async (): Promise<void> => {
        needsInstall = false
        const operation = async (): Promise<void> => {
          let installed = await window.api.localModels.install()
          while (installed.availability === 'installing' && own === generation.current) {
            setModel(installed)
            await new Promise((resolve) => setTimeout(resolve, 1000))
            if (own !== generation.current) break
            installed = await window.api.localModels.getSnapshot()
          }
          if (own !== generation.current) {
            // Leaving a document cancels its continuation, not an app-wide download another
            // document or Settings may now be using. Explicit Cancel still stops this live view.
            if (mounted.current) await window.api.localModels.cancel()
            return
          }
          setModel(installed)
          if (!installed.installedRevision || installed.updateAvailable)
            throw new Error('Model unavailable')
        }
        const pending = operation()
        installation.current = pending
        try {
          await pending
        } finally {
          if (installation.current === pending) installation.current = undefined
        }
      }
      for (let page = 1; page <= pageCount && own === generation.current; page++) {
        const id = crypto.randomUUID()
        requestId.current = id
        try {
          const request = { attachmentVersionId, page, requestId: id }
          // Cached results remain readable after the optional package is removed.
          const result = await window.api.pdfStructure.parse(request).catch(async (error) => {
            const message = error instanceof Error ? error.message : ''
            if (
              !needsInstall ||
              own !== generation.current ||
              ![LOCAL_MODEL_NOT_INSTALLED, PDF_MODEL_CHANGED].some((code) => message.endsWith(code))
            )
              throw error
            await install()
            if (own !== generation.current) throw error
            return window.api.pdfStructure.parse(request)
          })
          if (own !== generation.current) return
          totalBytes += JSON.stringify(result).length * 2
          totalElements += result.elements.length
          if (totalBytes > 32 * 1024 ** 2 || totalElements > 512) {
            setLimited(true)
            break
          }
          setResults((current) => [...current, result])
        } catch {
          if (own !== generation.current) return
          setFailed((current) => [...current, page])
        }
        if (own === generation.current) setCompleted(page)
      }
    } catch {
      if (own === generation.current) setError(true)
    } finally {
      if (own === generation.current) {
        requestId.current = undefined
        setBusy(false)
      }
    }
  }
  const entries = results.flatMap((result) =>
    result.elements.map((element) => ({ result, element }))
  )
  const analysisComplete =
    !busy && !error && !limited && failed.length === 0 && results.length === pageCount
  const analysisIncomplete = !busy && (completed > 0 || error || limited)
  const needsDownload = model && (!model.installedRevision || model.updateAvailable)
  const active = selected ?? entries[0]
  const downloading = model?.availability === 'installing'
  const progressValue = downloading ? model.transferredBytes : completed
  const progressTotal = downloading ? model.downloadBytes : pageCount
  const percent =
    progressTotal > 0 ? Math.min(100, Math.round((progressValue / progressTotal) * 100)) : 0
  const busyLabel = downloading ? t('Downloading and verifying…') : t('Analyzing PDF…')
  const progress = (
    <div className="w-full space-y-2 text-left">
      <div className="flex flex-wrap justify-between gap-2 text-xs text-text-200 tabular-nums">
        <span>
          {downloading
            ? `${formatBytes(model.transferredBytes)} / ${formatBytes(model.downloadBytes)}`
            : t('Processed {{completed}} / {{total}} pages', { completed, total: pageCount })}
        </span>
        <span>{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={downloading ? t('Model download progress') : t('PDF extraction progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg-300"
      >
        <div
          className="h-full origin-left rounded-full bg-primary transition-transform duration-150 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      </div>
    </div>
  )
  return (
    <div
      className="@container flex size-full flex-col overflow-hidden bg-bg-000 text-text-000"
      data-pdf-figures-content
    >
      {completed > 0 && (analysisComplete || entries.length > 0) ? (
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-200 px-4 py-1.5">
          <p className="text-xs text-text-200">
            {busy
              ? busyLabel
              : completed > 0
                ? t('Processed {{completed}} / {{total}} pages', { completed, total: pageCount })
                : t('Browse figures, captions and copyable tables.')}
          </p>
          {busy ? (
            <Button size="sm" variant="outline" onClick={cancel}>
              {model?.availability === 'installing' ? t('Cancel download') : t('Cancel')}
            </Button>
          ) : completed > 0 ? (
            <Button size="sm" variant="ghost" disabled={!model} onClick={() => void extract()}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {t('Analyze again')}
            </Button>
          ) : null}
        </header>
      ) : null}
      {busy && entries.length > 0 ? (
        <div className="shrink-0 border-b border-border-200 px-5 py-3">{progress}</div>
      ) : null}
      {error ? (
        <ErrorNotice
          title={t('PDF extraction is unavailable')}
          description={t('Check local model installation and try again.')}
          tone="amber"
        />
      ) : null}
      {failed.length ? (
        <p
          role="status"
          className="border-b border-border-200 px-5 py-2 text-xs text-status-warning-foreground"
        >
          {t('Could not extract pages: {{pages}}', { pages: failed.join(', ') })}
        </p>
      ) : null}
      {limited ? (
        <p role="status" className="px-5 py-2 text-xs">
          {t('Display limit reached. Remaining pages were not processed.')}
        </p>
      ) : null}
      {entries.length ? (
        <div className="flex min-h-0 flex-1 flex-col @min-[640px]:flex-row">
          <nav
            className="max-h-40 shrink-0 overflow-y-auto border-b border-border-200 bg-bg-20 p-2 @min-[640px]:max-h-none @min-[640px]:w-60 @min-[640px]:border-r @min-[640px]:border-b-0"
            aria-label={t('Figure and table index')}
          >
            {entries.map((entry) => {
              const Icon = entry.element.kind === 'figure' ? ImageIcon : Table2
              return (
                <button
                  key={`${entry.result.extractionId}:${entry.element.id}`}
                  type="button"
                  className={cn(
                    'mb-1 flex w-full gap-2 rounded-lg border border-transparent p-2.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-bg-200',
                    active?.element === entry.element && 'border-primary/20 bg-primary/8'
                  )}
                  aria-pressed={active?.element === entry.element}
                  onClick={() => setSelected(entry)}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-text-300" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex justify-between gap-2 font-medium">
                      <span>{entry.element.kind === 'figure' ? t('Figure') : t('Table')}</span>
                      <span className="shrink-0 font-normal text-text-300">
                        {t('Page {{page}}', { page: entry.element.regions[0].page })}
                      </span>
                    </span>
                    <span className="mt-1 line-clamp-2 leading-4 text-text-200">
                      {entry.element.caption?.text ?? t('No reliable caption association.')}
                    </span>
                  </span>
                </button>
              )
            })}
          </nav>
          <div
            key={active ? `${active.result.extractionId}:${active.element.id}` : undefined}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg-000 p-4"
            data-pdf-figure-detail
          >
            {active ? (
              <CandidateDetails
                key={`${active.result.extractionId}:${active.element.id}`}
                selected={active}
                attachmentVersionId={attachmentVersionId}
                onNavigate={onNavigate}
              />
            ) : null}
          </div>
        </div>
      ) : busy ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <div className="w-full max-w-sm space-y-5 text-center">
            <LoaderCircle
              className="mx-auto size-8 animate-spin text-primary motion-reduce:animate-none"
              aria-hidden="true"
            />
            <h3 role="status" className="text-base font-medium">
              {busyLabel}
            </h3>
            {progress}
            <Button size="sm" variant="outline" onClick={cancel}>
              {downloading ? t('Cancel download') : t('Cancel')}
            </Button>
          </div>
        </div>
      ) : analysisComplete ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <div role="status" className="max-w-md text-center">
            <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-full bg-primary/8">
              <CircleCheck className="size-8 text-primary" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-primary">{t('Analysis complete')}</p>
            <h3 className="mt-2 text-xl font-medium">{t('No figures or tables detected')}</h3>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <div className="max-w-md space-y-5 text-center">
            <ScanSearch className="mx-auto size-9 text-primary" aria-hidden="true" />
            <h3 className="text-[17px] font-medium">
              {analysisIncomplete ? t('Analysis incomplete') : t('Figures and tables')}
            </h3>
            <p className="text-sm leading-6 text-text-200">
              {analysisIncomplete
                ? t('Processed {{completed}} / {{total}} pages', { completed, total: pageCount })
                : t('Browse figures, captions and copyable tables.')}
            </p>
            {!busy ? (
              <Button disabled={!model} onClick={() => void extract()}>
                {needsDownload
                  ? t('Download and continue')
                  : analysisIncomplete
                    ? t('Analyze again')
                    : t('Analyze PDF')}
              </Button>
            ) : null}
            {needsDownload ? (
              <p className="text-xs text-text-300">
                {t('Download size')}: {formatBytes(model.downloadBytes)}
              </p>
            ) : null}
            <p className="text-xs leading-5 text-text-300">
              {t('Scanned and rotated pages are not supported yet.')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
