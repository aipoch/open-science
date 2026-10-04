import { useEffect, useMemo, useRef, useState } from 'react'
import './pdf-research-table.css'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { ZoomablePreview } from './ZoomablePreview'
import { PdfPreviewImageCache } from './pdf-preview-image-cache'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ErrorNotice } from '@/components/error-notice'
import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import {
  ImageIcon,
  Table2,
  ListOrdered,
  ArrowUpRight,
  ScanSearch,
  RefreshCw,
  LoaderCircle,
  Ellipsis,
  ImageOff,
  ChevronLeft,
  ChevronRight,
  Expand,
  Copy,
  Download,
  X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  LOCAL_MODEL_NOT_INSTALLED,
  PDF_MODEL_CHANGED,
  localModelDownloadProgress,
  type LocalModelSnapshot
} from '../../../../../../shared/local-models'
import {
  PDF_CLEANUP_PENDING,
  type PdfStructureSource,
  type PdfStructureResult
} from '../../../../../../shared/pdf-structure'
import { copyPdfTable, pdfTableLayout } from '../../../../../../shared/pdf-table-copy'

const formatBytes = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MiB`
import { groupPdfFigureSelections, type Selection } from './pdf-figure-selections'

type TableData = NonNullable<PdfStructureResult['elements'][number]['table']>

const TableDetails = ({
  table,
  title,
  sharedNotes,
  downloadName
}: {
  table: TableData
  title?: string
  sharedNotes?: TableData['notes']
  downloadName: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [reviewed, setReviewed] = useState(false)
  const [copyStatus, setCopyStatus] = useState<string>()
  const [format, setFormat] = useState<'html' | 'tsv' | 'markdown'>('tsv')
  const [action, setAction] = useState<'copy' | 'download' | null>(null)
  const actionPending = useRef(false)
  const missing = t('[Missing]')
  const grid = useMemo(
    () =>
      table && table.rowCount <= 256 && table.columnCount <= 128
        ? pdfTableLayout(table)
        : undefined,
    [table]
  )
  const exportTable = async (requestedAction: 'copy' | 'download'): Promise<void> => {
    if (!table || !reviewed || actionPending.current) return
    actionPending.current = true
    setAction(requestedAction)
    setCopyStatus(undefined)
    const copyTable = { ...table, notes: [...(table.notes ?? []), ...(sharedNotes ?? [])] }
    try {
      if (requestedAction === 'download') {
        let content = copyPdfTable(copyTable, format, missing, true)
        if (format === 'html')
          content = content.replace(
            '<html><body>',
            '<!doctype html><html><head><meta charset="utf-8"></head><body>'
          )
        const { saved } = await window.api.saveBlobFile({
          suggestedName: `${downloadName}.${format === 'markdown' ? 'md' : format}`,
          mimeType: {
            html: 'text/html',
            tsv: 'text/tab-separated-values',
            markdown: 'text/markdown'
          }[format],
          data: new TextEncoder().encode(content).buffer
        })
        if (saved) setCopyStatus(t('Saved'))
        return
      }
      if (format === 'html') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([copyPdfTable(copyTable, 'html', missing)], {
              type: 'text/html'
            }),
            'text/plain': new Blob([copyPdfTable(copyTable, 'tsv', missing, true)], {
              type: 'text/plain'
            })
          })
        ])
      } else await navigator.clipboard.writeText(copyPdfTable(copyTable, format, missing))
      setCopyStatus(t('Copied'))
    } catch {
      setCopyStatus(
        requestedAction === 'copy'
          ? t('Could not copy the table. Try again.')
          : t('Could not save the table. Try again.')
      )
    } finally {
      actionPending.current = false
      setAction(null)
    }
  }
  return (
    <section className="space-y-3" aria-label={title}>
      {title ? <h3 className="font-medium">{title}</h3> : null}
      {grid ? (
        <>
          <div
            className="pdf-research-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={t('Candidate table')}
          >
            <table className="pdf-research-table" aria-label={t('Candidate table')}>
              <tbody>
                {grid.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, column) =>
                      cell === null ? null : (
                        <td
                          key={column}
                          rowSpan={cell?.rowSpan}
                          colSpan={cell?.columnSpan}
                          data-numeric={
                            cell &&
                            column > 0 &&
                            cell.columnSpan === 1 &&
                            /\d/.test(cell.text) &&
                            /^[\s\d.,%‰+−–—\-±×/():;<>=≤≥∞*†‡eE]+$/.test(cell.text)
                              ? true
                              : undefined
                          }
                        >
                          {cell?.textRuns
                            ? cell.textRuns.map((run, index) =>
                                run.position === 'superscript' ? (
                                  <sup key={index}>{run.text}</sup>
                                ) : run.position === 'subscript' ? (
                                  <sub key={index}>{run.text}</sub>
                                ) : (
                                  run.text
                                )
                              )
                            : cell
                              ? cell.text || '\u00a0'
                              : missing}
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
            <div className="grid w-full grid-cols-2 items-center gap-2 @min-[480px]:flex @min-[480px]:w-auto">
              <Select
                value={format}
                disabled={action !== null}
                onValueChange={(value) => {
                  if (value === 'html' || value === 'tsv' || value === 'markdown') {
                    setFormat(value)
                    setCopyStatus(undefined)
                  }
                }}
              >
                <SelectTrigger
                  className="col-span-2 w-full @min-[480px]:w-32"
                  aria-label={t('Table export format')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  <SelectItem value="tsv">{t('TSV')}</SelectItem>
                  <SelectItem value="html">{t('HTML')}</SelectItem>
                  <SelectItem value="markdown">{t('Markdown', { ns: 'common' })}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={!reviewed || action !== null}
                onClick={() => void exportTable('copy')}
                aria-busy={Boolean(action === 'copy')}
              >
                <span key={String(action === 'copy')} className="button-feedback">
                  {action === 'copy' ? (
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                  {t('Copy')}
                </span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!reviewed || action !== null}
                onClick={() => void exportTable('download')}
                aria-busy={Boolean(action === 'download')}
              >
                <span key={String(action === 'download')} className="button-feedback">
                  {action === 'download' ? (
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <Download className="size-4" aria-hidden="true" />
                  )}
                  {t('Download')}
                </span>
              </Button>
            </div>
          </div>
          {copyStatus ? (
            <p role="status" className="text-xs">
              {copyStatus}
            </p>
          ) : null}
        </>
      ) : (
        <p>{t('Structured cells are unavailable for this candidate.')}</p>
      )}
    </section>
  )
}

const CandidateDetails = ({
  selected,
  source,
  imageCache,
  onNavigate,
  hideCaption = false,
  showPage = false,
  imageOnly = false,
  analysisOptions
}: {
  selected: Selection
  source: PdfStructureSource
  imageCache: PdfPreviewImageCache
  onNavigate: (page: number) => void
  hideCaption?: boolean
  showPage?: boolean
  imageOnly?: boolean
  analysisOptions?: React.ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { result, element } = selected
  const table = selected.combinedTable ?? element.table
  const imageRequest = {
    ...source,
    page: element.regions[0].page,
    extractionId: result.extractionId,
    thumbnailId: element.thumbnailId ?? ''
  }
  const [image, setImage] = useState(() => imageCache.peek(imageRequest)?.url)
  const [imageFailed, setImageFailed] = useState(!element.thumbnailId)
  const [imageReady, setImageReady] = useState(() => imageCache.peek(imageRequest)?.ready ?? false)
  const [imageAttempt, setImageAttempt] = useState(0)
  const [showImage, setShowImage] = useState(false)
  const [imageAction, setImageAction] = useState<'copy' | 'download' | null>(null)
  const imageActionPending = useRef(false)
  const [imageActionStatus, setImageActionStatus] = useState('')
  const exportImage = async (action: 'copy' | 'download'): Promise<void> => {
    if (!image || imageActionPending.current) return
    imageActionPending.current = true
    setImageAction(action)
    setImageActionStatus('')
    try {
      // readThumbnail returns PNG data URLs; decode locally because the renderer CSP
      // deliberately disallows fetching data: URLs through connect-src.
      const prefix = 'data:image/png;base64,'
      if (!image.startsWith(prefix)) throw new Error('Expected a PNG image')
      const bytes = Uint8Array.from(atob(image.slice(prefix.length)), (char) => char.charCodeAt(0))
      if (action === 'copy') {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })
        ])
        setImageActionStatus(t('Copied'))
      } else {
        const { saved } = await window.api.saveBlobFile({
          suggestedName: `pdf-${element.id}-page-${element.regions[0].page}.png`,
          mimeType: 'image/png',
          data: bytes.buffer
        })
        if (saved) setImageActionStatus(t('Saved'))
      }
    } catch {
      setImageActionStatus(
        action === 'copy'
          ? t('Could not copy the image. Try again.')
          : t('Could not save the image. Try again.')
      )
    } finally {
      imageActionPending.current = false
      setImageAction(null)
    }
  }
  const hasTable =
    !imageOnly &&
    (element.tableParts?.map((part) => part.table) ?? (table ? [table] : [])).some(
      (table) => table.rowCount <= 256 && table.columnCount <= 128
    )
  const hasUnassigned =
    table?.unassignedText.length ||
    element.tableParts?.some((part) => part.table.unassignedText.length)
  const needsImage = !hasTable || showImage
  const thumbnail = result.thumbnails.find(({ id }) => id === element.thumbnailId)
  const region = element.regions[0]
  const page = result.pages.find(({ page }) => page === region.page)
  const aspectRatio = thumbnail
    ? thumbnail.width / thumbnail.height
    : (region.width * (page?.width ?? 1)) / (region.height * (page?.height ?? 1))
  useEffect(() => {
    let live = true
    if (element.thumbnailId && needsImage)
      void imageCache
        .load({
          ...source,
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
  }, [source, element, result.extractionId, imageAttempt, imageCache, needsImage])
  return (
    <article className="space-y-3 text-sm">
      <div
        className={cn(
          'flex flex-wrap items-center gap-3 border-b border-border-200 pb-2',
          !hasTable && !showPage && '@max-[640px]:hidden'
        )}
      >
        <div className={cn('items-center gap-3 @min-[640px]:flex', showPage ? 'flex' : 'hidden')}>
          <span className="font-medium">
            {element.kind === 'algorithm'
              ? t('Algorithm')
              : element.kind === 'figure'
                ? t('Figure')
                : t('Table')}
          </span>
          <span className="text-xs text-text-300">
            {selected.combinedTable && selected.continuations?.length
              ? t('Pages {{start}}–{{end}}', {
                  start: element.regions[0].page,
                  end: selected.continuations.at(-1)!.element.regions.at(-1)!.page
                })
              : t('Page {{page}}', { page: element.regions[0].page })}
          </span>
        </div>
        {hasTable ? (
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
          className="ml-auto hidden @min-[640px]:inline-flex"
          variant="ghost"
          size="sm"
          onClick={() => onNavigate(element.regions[0].page)}
        >
          {t('Show in PDF')}
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Button>
        {analysisOptions ? (
          <div className="hidden @min-[640px]:block">{analysisOptions}</div>
        ) : null}
      </div>
      {!hasTable || showImage ? (
        <div
          data-pdf-image-frame
          aria-busy={!imageReady && !imageFailed}
          className="relative mx-auto min-h-24 max-h-[55vh] max-w-full overflow-hidden rounded bg-bg-200"
          style={{
            aspectRatio,
            width: `min(100%, ${55 * aspectRatio}vh)`,
            minWidth: 'min(100%, 10rem)'
          }}
        >
          {image && !imageFailed ? (
            <img
              key={imageAttempt}
              src={image}
              alt={t('Extracted region preview')}
              onLoad={() => {
                imageCache.markReady(imageRequest)
                setImageReady(true)
              }}
              onError={() => {
                imageCache.invalidate(imageRequest)
                setImageFailed(true)
              }}
              className={cn(
                'absolute inset-0 size-full bg-white object-contain',
                !imageReady && 'invisible'
              )}
            />
          ) : null}
          {image && imageReady && !imageFailed ? (
            <Dialog.Root onOpenChange={() => setImageActionStatus('')}>
              <Dialog.Trigger asChild>
                <button
                  type="button"
                  aria-label={t('Enlarge image')}
                  className="group absolute inset-0 cursor-zoom-in rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-md border border-border bg-bg-000/90 text-text-100 shadow-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
                    <Expand className="size-4" aria-hidden="true" />
                  </span>
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[70]')} />
                <Dialog.Content
                  aria-describedby={undefined}
                  className={dialogPanelClassName(
                    'z-[71] flex h-[90vh] w-[94vw] max-w-[1600px] flex-col p-0'
                  )}
                >
                  <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
                    <Dialog.Title className="min-w-0 truncate text-sm font-medium">
                      {t('Image preview')}
                    </Dialog.Title>
                    <span
                      className="min-w-0 flex-1 truncate text-xs text-text-200"
                      title={element.caption?.text}
                    >
                      {element.caption?.text}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      aria-label={t('Download image')}
                      title={t('Download image')}
                      disabled={imageAction !== null}
                      onClick={() => void exportImage('download')}
                      aria-busy={Boolean(imageAction === 'download')}
                    >
                      <span key={String(imageAction === 'download')} className="button-feedback">
                        {imageAction === 'download' ? (
                          <LoaderCircle
                            className="size-4 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        ) : (
                          <Download className="size-4" aria-hidden="true" />
                        )}
                        <span className="hidden sm:inline">{t('Download image')}</span>
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      aria-label={t('Copy image')}
                      title={t('Copy image')}
                      disabled={imageAction !== null}
                      onClick={() => void exportImage('copy')}
                      aria-busy={Boolean(imageAction === 'copy')}
                    >
                      <span key={String(imageAction === 'copy')} className="button-feedback">
                        {imageAction === 'copy' ? (
                          <LoaderCircle
                            className="size-4 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        ) : (
                          <Copy className="size-4" aria-hidden="true" />
                        )}
                        <span className="hidden sm:inline">{t('Copy image')}</span>
                      </span>
                    </Button>
                    <Dialog.Close asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={t('Close')}>
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    </Dialog.Close>
                  </div>
                  <p
                    role="status"
                    className={cn(
                      'shrink-0 px-4 py-2 text-xs text-text-200',
                      !imageActionStatus && 'sr-only'
                    )}
                  >
                    {imageActionStatus}
                  </p>
                  <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-200">
                    <ZoomablePreview tooltipClassName="z-[80]">
                      <img
                        src={image}
                        alt={element.caption?.text ?? t('Extracted region preview')}
                        className="size-full object-contain"
                        draggable={false}
                      />
                    </ZoomablePreview>
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          ) : null}
          {imageFailed ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-2">
              <ImageOff className="size-7 text-text-300" aria-hidden="true" />
              <span className="sr-only">{t('Image unavailable')}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (!element.thumbnailId) return onNavigate(region.page)
                  imageCache.invalidate(imageRequest)
                  setImage(undefined)
                  setImageReady(false)
                  setImageFailed(false)
                  setImageAttempt((attempt) => attempt + 1)
                }}
              >
                {element.thumbnailId ? t('Reload image') : t('Show in PDF')}
              </Button>
            </div>
          ) : !imageReady ? (
            <div
              role="status"
              aria-label={t('Loading image…')}
              className="absolute inset-0 flex animate-pulse items-center justify-center bg-bg-200 motion-reduce:animate-none"
            >
              <ImageIcon className="size-7 text-text-300" aria-hidden="true" />
            </div>
          ) : null}
        </div>
      ) : null}
      {!hideCaption ? (
        <p className="whitespace-normal break-words leading-6 text-text-100" data-pdf-caption>
          {element.caption?.text ?? t('No reliable caption association.')}
        </p>
      ) : null}
      {element.issues.length > 0 ? (
        <p className="text-xs text-status-warning-foreground">
          {hasTable && !showImage && hasUnassigned
            ? t('Some text could not be placed in the table. Review it below before copying.')
            : t('Check extracted content against the original PDF.')}
        </p>
      ) : null}
      {hasTable ? (
        <div hidden={showImage} className="space-y-3">
          {element.tableParts ? (
            element.tableParts.map((part, index) => (
              <TableDetails
                key={index}
                table={part.table}
                title={part.title}
                sharedNotes={element.tableNotes}
                downloadName={`pdf-${element.id}-page-${element.regions[0].page}-part-${index + 1}`}
              />
            ))
          ) : table ? (
            <TableDetails
              key={selected.continuations?.length ?? 0}
              table={table}
              sharedNotes={element.tableNotes}
              downloadName={`pdf-${element.id}-page-${element.regions[0].page}`}
            />
          ) : null}
          {element.tableNotes?.length ? (
            <section className="space-y-1 text-xs text-text-200">
              <h4 className="font-medium">{t('Table notes')}</h4>
              {element.tableNotes.map((note, index) => (
                <p key={index} className="whitespace-normal leading-5">
                  {note.text}
                </p>
              ))}
            </section>
          ) : null}
        </div>
      ) : element.kind === 'table' && !hasTable && !imageOnly ? (
        <p>{t('Structured cells are unavailable for this candidate.')}</p>
      ) : null}
    </article>
  )
}

export const PdfFiguresView = ({
  source,
  pageCount,
  active: visible = true,
  onBusyChange,
  onNavigate
}: {
  source: PdfStructureSource
  pageCount: number
  active?: boolean
  onBusyChange?: (busy: boolean) => void
  onNavigate: (page: number) => void
}): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const [model, setModel] = useState<LocalModelSnapshot>()
  const [busy, setBusy] = useState(false)
  const [concurrency, setConcurrency] = useState<1 | 2 | 4>(1)
  const [completed, setCompleted] = useState(0)
  const [remainingSeconds, setRemainingSeconds] = useState<number>()
  const [results, setResults] = useState<PdfStructureResult[]>([])
  const [failed, setFailed] = useState<number[]>([])
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<Selection>()
  const [limited, setLimited] = useState(false)
  const [imageCache] = useState(() => new PdfPreviewImageCache())
  const [restoring, setRestoring] = useState(true)
  const [cacheChecked, setCacheChecked] = useState(false)
  const returningSelectFocus = useRef(false)
  const generation = useRef(0)
  const requestIds = useRef(new Set<string>())
  const installation = useRef<Promise<void> | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  useEffect(() => {
    if (!visible || cacheChecked) return
    let live = true
    const own = generation.current
    const restore = async (): Promise<void> => {
      const cached: PdfStructureResult[] = []
      let bytes = 0,
        elements = 0
      try {
        for (let page = 1; page <= pageCount; page += 4) {
          // Bound disk/RPC work while preserving physical page order and display limits.
          const batch = await Promise.all(
            Array.from({ length: Math.min(4, pageCount - page + 1) }, (_, offset) =>
              window.api.pdfStructure.readCached({ ...source, page: page + offset })
            )
          )
          if (!live || own !== generation.current) return
          for (const result of batch) {
            if (!result) continue
            bytes += JSON.stringify(result).length * 2
            elements += result.elements.length
            if (bytes > 32 * 1024 ** 2 || elements > 512) break
            cached.push(result)
          }
          setResults([...cached])
          setCompleted(cached.length)
          if (bytes > 32 * 1024 ** 2 || elements > 512) {
            setLimited(true)
            break
          }
        }
      } catch (cause) {
        if (live && own === generation.current)
          setError(cause instanceof Error ? cause.message : 'unavailable')
      } finally {
        if (live && own === generation.current) {
          setRestoring(false)
          setCacheChecked(true)
        }
      }
    }
    void restore()
    return () => {
      live = false
    }
  }, [visible, cacheChecked, source, pageCount])
  const cancel = (): void => {
    generation.current++
    for (const id of requestIds.current)
      void window.api.pdfStructure.cancel(id).catch(() => undefined)
    requestIds.current.clear()
    setBusy(false)
  }
  useEffect(() => {
    mounted.current = true
    const taskGeneration = generation
    return () => {
      mounted.current = false
      imageCache.clear()
      taskGeneration.current++
      for (const id of requestIds.current)
        void window.api.pdfStructure.cancel(id).catch(() => undefined)
      requestIds.current.clear()
    }
  }, [imageCache])
  useEffect(() => {
    if (!visible || busy) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      void window.api.localModels
        .getSnapshot()
        .then((next) => {
          if (live)
            setModel((current) =>
              JSON.stringify(current) === JSON.stringify(next) ? current : next
            )
        })
        .catch(() => {
          if (live) setError('unavailable')
        })
        .finally(() => {
          if (live) timer = setTimeout(poll, 1000)
        })
    }
    poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [visible, busy])
  const extract = async (): Promise<void> => {
    const own = ++generation.current
    imageCache.clear()
    setBusy(true)
    setError(undefined)
    setResults([])
    setFailed([])
    setCompleted(0)
    setRemainingSeconds(undefined)
    setSelected(undefined)
    setLimited(false)
    let totalBytes = 0
    let totalElements = 0
    const ids = new Set<string>()
    requestIds.current = ids
    let stopped = false
    let finishStopping: (() => void) | undefined
    const stopRequests = (): void => {
      stopped = true
      finishStopping?.()
      for (const id of ids) void window.api.pdfStructure.cancel(id).catch(() => undefined)
      ids.clear()
    }
    const startedAt = performance.now()
    let installationMs = 0
    let settled = 0
    try {
      // Join cancellation of an earlier install before starting a new one.
      await installation.current
      if (own !== generation.current) return
      const snapshot = await window.api.localModels.getSnapshot()
      if (own !== generation.current) return
      const needsInstall = !snapshot.installedRevision || snapshot.updateAvailable
      let modelReady: Promise<void> | undefined
      const install = async (): Promise<void> => {
        const installStartedAt = performance.now()
        const operation = async (): Promise<void> => {
          let installed = await window.api.localModels.install()
          while (
            installed.availability === 'installing' &&
            own === generation.current &&
            !stopped
          ) {
            setModel(installed)
            await new Promise((resolve) => setTimeout(resolve, 1000))
            if (own !== generation.current || stopped) break
            installed = await window.api.localModels.getSnapshot()
          }
          if (own !== generation.current) {
            // Leaving a document cancels its continuation, not an app-wide download another
            // document or Settings may now be using. Explicit Cancel still stops this live view.
            if (mounted.current) await window.api.localModels.cancel()
            return
          }
          if (stopped) return
          setModel(installed)
          if (!installed.installedRevision || installed.updateAvailable)
            throw new Error('Model unavailable')
        }
        const pending = operation()
        installation.current = pending
        try {
          await pending
        } finally {
          installationMs += performance.now() - installStartedAt
          if (installation.current === pending) installation.current = undefined
        }
      }
      const parsePage = async (
        page: number
      ): Promise<{ result?: PdfStructureResult; error?: string }> => {
        const id = crypto.randomUUID()
        ids.add(id)
        let outcome: { result?: PdfStructureResult; error?: string }
        try {
          const request = { ...source, page, requestId: id }
          // Try the cache first, even without a model. All misses join one installation.
          const result = await window.api.pdfStructure.parse(request).catch(async (error) => {
            const message = error instanceof Error ? error.message : ''
            if (
              !needsInstall ||
              own !== generation.current ||
              stopped ||
              ![LOCAL_MODEL_NOT_INSTALLED, PDF_MODEL_CHANGED].some((code) => message.endsWith(code))
            )
              throw error
            modelReady ??= install().catch(() => {
              // A shared prerequisite failure must stop every page, not become a page error.
              throw new Error(LOCAL_MODEL_NOT_INSTALLED)
            })
            await modelReady
            if (own !== generation.current || stopped) throw error
            return window.api.pdfStructure.parse(request)
          })
          outcome = { result }
        } catch (cause) {
          outcome = { error: cause instanceof Error ? cause.message : 'unavailable' }
        } finally {
          ids.delete(id)
        }
        if (own !== generation.current || stopped) return outcome
        settled++
        setCompleted(settled)
        if (
          outcome.error &&
          [PDF_CLEANUP_PENDING, LOCAL_MODEL_NOT_INSTALLED, PDF_MODEL_CHANGED].some((code) =>
            outcome.error!.endsWith(code)
          )
        ) {
          setError(outcome.error)
          stopRequests()
        } else if (settled >= 2 && !installation.current) {
          const elapsed = performance.now() - startedAt - installationMs
          setRemainingSeconds((elapsed / settled / 1000) * (pageCount - settled))
        }
        return outcome
      }
      // A sliding window bounds both active requests and completed results waiting for an
      // earlier page. Publish in physical order so continuations and display limits are stable.
      const pending = new Map<number, ReturnType<typeof parsePage>>()
      let next = 1
      for (let page = 1; page <= pageCount && own === generation.current && !stopped; page++) {
        while (next <= pageCount && next < page + concurrency) {
          pending.set(next, parsePage(next))
          next++
        }
        const stopping = new Promise<undefined>((resolve) => {
          finishStopping = () => resolve(undefined)
        })
        const outcome = await Promise.race([pending.get(page)!, stopping])
        finishStopping = undefined
        pending.delete(page)
        if (own !== generation.current || stopped || !outcome) break
        if (outcome.result) {
          totalBytes += JSON.stringify(outcome.result).length * 2
          totalElements += outcome.result.elements.length
          if (totalBytes > 32 * 1024 ** 2 || totalElements > 512) {
            setLimited(true)
            stopRequests()
            break
          }
          setResults((current) => [...current, outcome.result!])
        } else {
          setFailed((current) => [...current, page])
        }
      }
    } catch {
      if (own === generation.current) setError('unavailable')
    } finally {
      if (own === generation.current) {
        stopRequests()
        setBusy(false)
      }
    }
  }
  const entries = useMemo(() => groupPdfFigureSelections(results), [results])
  const analysisComplete =
    !restoring && !busy && !error && !limited && failed.length === 0 && results.length === pageCount
  const analysisIncomplete = !busy && (completed > 0 || error || limited)
  const cleanupBlocked = error?.endsWith(PDF_CLEANUP_PENDING)
  const needsDownload = model && (!model.installedRevision || model.updateAvailable)
  const active = entries.find((entry) => entry.element === selected?.element) ?? entries[0]
  const activeIndex = entries.findIndex((entry) => entry.element === active?.element)
  const entryKey = (entry: Selection): string => `${entry.result.extractionId}:${entry.element.id}`
  const entryPageLabel = (entry: Selection): string =>
    entry.continuations?.length
      ? t('Pages {{start}}–{{end}}', {
          start: entry.element.regions[0].page,
          end: entry.continuations.at(-1)!.element.regions.at(-1)!.page
        })
      : t('Page {{page}}', { page: entry.element.regions[0].page })
  const entryLabel = (entry: Selection): string =>
    entry.element.caption?.text ??
    (entry.element.kind === 'algorithm'
      ? t('Algorithm')
      : entry.element.kind === 'figure'
        ? t('Figure')
        : t('Table'))
  const downloading = model?.availability === 'installing'
  const percent = pageCount > 0 ? Math.min(100, Math.round((completed / pageCount) * 100)) : 0
  const busyLabel = downloading ? t('Downloading and verifying…') : t('Analyzing PDF…')
  const remainingLabel =
    remainingSeconds === undefined
      ? t('Estimating time remaining…')
      : t('About {{duration}} remaining', {
          duration: new Intl.NumberFormat(i18n.language, {
            style: 'unit',
            unit: remainingSeconds >= 60 ? 'minute' : 'second',
            unitDisplay: 'short'
          }).format(
            remainingSeconds >= 60
              ? Math.ceil(remainingSeconds / 60)
              : Math.max(10, Math.ceil(remainingSeconds / 10) * 10)
          )
        })
  const concurrencySelect = (
    <TooltipProvider>
      <Select
        value={String(concurrency)}
        onValueChange={(value) => {
          if (value === '1' || value === '2' || value === '4')
            setConcurrency(Number(value) as 1 | 2 | 4)
        }}
        disabled={busy || restoring}
      >
        <Tooltip>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (returningSelectFocus.current || !event.currentTarget.matches(':focus-visible'))
                event.preventDefault()
              returningSelectFocus.current = false
            }}
          >
            <SelectTrigger className="w-20 shrink-0" aria-label={t('Parallel pages')}>
              <SelectValue />
            </SelectTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {t(
              '1x, 2x, or 4x analyzes 1, 2, or 4 pages at a time. Higher settings can be faster but use more memory. Results stay in page order.'
            )}
          </TooltipContent>
        </Tooltip>
        <SelectContent
          onCloseAutoFocus={() => {
            // Select can retain :focus-visible after pointer selection. Keep its focus return,
            // but do not reopen the tooltip until the user next hovers or tabs to the control.
            returningSelectFocus.current = true
          }}
        >
          {[1, 2, 4].map((value) => (
            <SelectItem key={value} value={String(value)}>{`${value}x`}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </TooltipProvider>
  )
  const analysisOptions = (
    <Popover>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('PDF analysis options')}>
                <Ellipsis className="size-4" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('PDF analysis options')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="end"
        className="w-60 space-y-3 border border-border bg-popover p-3 text-popover-foreground"
        aria-label={t('PDF analysis options')}
      >
        <div className="flex items-center justify-between gap-3">
          <span>{t('Parallel pages')}</span>
          {concurrencySelect}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={!model || restoring}
          onClick={() => void extract()}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {t('Analyze again')}
        </Button>
      </PopoverContent>
    </Popover>
  )
  const progressTrack = (
    <div
      role="progressbar"
      aria-label={t('PDF extraction progress')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1 w-full overflow-hidden rounded-full bg-bg-300"
    >
      <div
        className="h-full origin-left rounded-full bg-primary transition-transform duration-150 ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${percent / 100})` }}
      />
    </div>
  )
  const progress = downloading ? (
    <div className="w-full text-left">
      <DownloadProgressLine progress={localModelDownloadProgress(model)} />
    </div>
  ) : (
    <div className="w-full space-y-2 text-left">
      {progressTrack}
      <div className="flex items-start justify-between gap-4 text-xs text-text-200 tabular-nums">
        <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
          <span>
            {t('Attempted {{completed}} / {{total}} pages', { completed, total: pageCount })}
          </span>
          <span>{remainingLabel}</span>
        </span>
        <span className="shrink-0">{percent}%</span>
      </div>
    </div>
  )
  return (
    <div
      className="@container flex size-full flex-col overflow-hidden bg-bg-000 text-text-000"
      data-pdf-figures-content
    >
      <span role="status" aria-atomic="true" className="sr-only">
        {analysisComplete ? t('Analysis complete') : null}
      </span>
      {!analysisComplete && ((completed > 0 && entries.length > 0) || (error && !busy)) ? (
        <header
          className={cn(
            'shrink-0 space-y-2 border-b border-border-200 px-3 @min-[640px]:px-4',
            busy ? 'py-2' : 'py-1.5'
          )}
        >
          <div className="flex items-center justify-between gap-4">
            <p
              role="status"
              aria-atomic="true"
              className="min-w-0 text-xs text-text-200 @min-[640px]:text-sm"
              title={t('Extracted {{completed}} / {{total}} pages', {
                completed: results.length,
                total: pageCount
              })}
            >
              <span className="inline-flex items-center gap-2 font-medium text-text-000">
                {busy || restoring ? (
                  <LoaderCircle
                    className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {restoring
                  ? t('Loading…')
                  : busy
                    ? busyLabel
                    : t('Extracted {{completed}} / {{total}} pages', {
                        completed: results.length,
                        total: pageCount
                      })}
              </span>
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {busy ? (
                <Button size="sm" variant="outline" onClick={cancel}>
                  {model?.availability === 'installing' ? t('Cancel download') : t('Cancel')}
                </Button>
              ) : completed > 0 || error ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('Analyze again')}
                  title={t('Analyze again')}
                  className="max-w-7 @min-[640px]:max-w-none"
                  disabled={!model || restoring}
                  onClick={() => void extract()}
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  <span className="hidden @min-[640px]:inline">{t('Analyze again')}</span>
                </Button>
              ) : null}
              {concurrencySelect}
            </div>
          </div>
          {busy && !restoring ? progress : null}
        </header>
      ) : null}
      {error && !busy ? (
        <ErrorNotice
          role="alert"
          className="m-4 w-auto shrink-0"
          title={cleanupBlocked ? t('PDF analysis is blocked') : t('PDF extraction is unavailable')}
          description={
            cleanupBlocked
              ? t(
                  'A previous PDF task could not finish cleanup. Analyze again to retry cleanup safely. If cleanup still fails, report the issue.'
                )
              : t(
                  'PDF analysis could not continue. Check the local model installation and try again.'
                )
          }
          help={{
            whyLabel: t('Extraction progress'),
            why: t('Extracted {{completed}} / {{total}} pages', {
              completed: results.length,
              total: pageCount
            }),
            howLabel: t('Remaining pages'),
            how: t('Pages not yet attempted: {{remaining}}', { remaining: pageCount - completed })
          }}
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
          {t('Display limit reached. Some analyzed pages are not shown.')}
        </p>
      ) : null}
      {restoring && !entries.length ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-text-200"
          role="status"
        >
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t('Loading…')}
        </div>
      ) : entries.length ? (
        <div className="flex min-h-0 flex-1 flex-col @min-[640px]:flex-row">
          <div className="flex shrink-0 items-center gap-1 border-b border-border-200 px-3 py-1.5 @min-[640px]:hidden">
            <Select
              value={active ? entryKey(active) : undefined}
              onValueChange={(value) =>
                setSelected(entries.find((entry) => entryKey(entry) === value))
              }
            >
              <SelectTrigger className="min-w-0 flex-1" aria-label={t('Figure and table index')}>
                <SelectValue>
                  {active ? (
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{entryLabel(active)}</span>
                      <span className="shrink-0 text-xs text-text-300">
                        {entryPageLabel(active)}
                      </span>
                    </span>
                  ) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="z-[70] max-w-[var(--radix-select-trigger-width)]">
                {entries.map((entry) => (
                  <SelectItem
                    key={entryKey(entry)}
                    value={entryKey(entry)}
                    textValue={entryLabel(entry)}
                    className="[&>span:first-child]:min-w-0 [&>span:first-child]:flex-1"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="min-w-0 flex-1 truncate">{entryLabel(entry)}</span>
                      <span className="shrink-0 text-xs text-text-300">
                        {entryPageLabel(entry)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('Previous figure or table')}
              disabled={activeIndex <= 0}
              onClick={() => setSelected(entries[activeIndex - 1])}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('Next figure or table')}
              disabled={activeIndex >= entries.length - 1}
              onClick={() => setSelected(entries[activeIndex + 1])}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('Show in PDF')}
              title={t('Show in PDF')}
              disabled={!active}
              onClick={() => active && onNavigate(active.element.regions[0].page)}
            >
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Button>
            {analysisComplete ? analysisOptions : null}
          </div>
          <nav
            className="hidden shrink-0 overflow-y-auto border-r border-border-200 bg-bg-20 p-2 @min-[640px]:block @min-[640px]:w-60"
            aria-label={t('Figure and table index')}
            onKeyDown={(event) => {
              if (
                event.defaultPrevented ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
              )
                return
              const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
              const current = buttons.indexOf((event.target as HTMLElement).closest('button')!)
              if (current < 0) return
              event.preventDefault()
              const next = Math.max(
                0,
                Math.min(entries.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))
              )
              setSelected(entries[next])
              buttons[next]?.focus()
            }}
          >
            {entries.map((entry) => {
              const Icon =
                entry.element.kind === 'algorithm'
                  ? ListOrdered
                  : entry.element.kind === 'figure'
                    ? ImageIcon
                    : Table2
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
                      <span>
                        {entry.element.kind === 'algorithm'
                          ? t('Algorithm')
                          : entry.element.kind === 'figure'
                            ? t('Figure')
                            : t('Table')}
                      </span>
                      <span className="shrink-0 font-normal text-text-300">
                        {entryPageLabel(entry)}
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
            className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg-000 p-3 @min-[640px]:p-4"
            data-pdf-figure-detail
          >
            {active
              ? [active, ...(active.continuations ?? [])].map((part, index, parts) => (
                  <CandidateDetails
                    key={`${part.result.extractionId}:${part.element.id}`}
                    selected={part}
                    imageCache={imageCache}
                    source={source}
                    onNavigate={onNavigate}
                    showPage={parts.length > 1}
                    analysisOptions={analysisComplete && index === 0 ? analysisOptions : undefined}
                    hideCaption={active.combinedTable ? index > 0 : index < parts.length - 1}
                    imageOnly={!!active.combinedTable && index > 0}
                  />
                ))
              : null}
          </div>
        </div>
      ) : error && !busy ? null : busy ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <div className="w-full max-w-sm space-y-5 text-center">
            {downloading ? (
              <LoaderCircle
                className="mx-auto size-8 animate-spin text-primary motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <svg
                viewBox="0 0 80 80"
                className="mx-auto size-20 text-primary"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M23 8h25l12 12v48a4 4 0 0 1-4 4H23a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Z"
                  fill="currentColor"
                  fillOpacity="0.04"
                  strokeOpacity="0.45"
                />
                <path d="M48 8v12h12" strokeOpacity="0.45" />
                <g className="pdf-scan-text">
                  <path d="M28 30h23" />
                  <path d="M28 39h18" />
                  <path d="M28 48h23" />
                  <path d="M28 57h14" />
                </g>
                <g className="pdf-scan-beam">
                  <path d="M15 40h50" strokeWidth="8" strokeOpacity="0.08" />
                  <path d="M14 40h52" />
                </g>
              </svg>
            )}
            <h3 role="status" className="text-base font-medium">
              {busyLabel}
            </h3>
            {progress}
            <div className="flex items-center justify-center gap-2">
              <Button size="sm" variant="outline" onClick={cancel}>
                {downloading ? t('Cancel download') : t('Cancel')}
              </Button>
              {concurrencySelect}
            </div>
          </div>
        </div>
      ) : analysisComplete ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <div className="max-w-md space-y-3 text-center">
            <h3 className="text-sm font-medium">{t('No figures or tables detected')}</h3>
            {analysisOptions}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <div className="max-w-md space-y-5 text-center">
            <ScanSearch className="mx-auto size-9 text-primary" aria-hidden="true" />
            <h3 className="text-[17px] font-medium">
              {analysisIncomplete ? t('Analysis incomplete') : t('Figures & Tables')}
            </h3>
            <p className="text-sm leading-6 text-text-200">
              {analysisIncomplete
                ? t('Extracted {{completed}} / {{total}} pages', {
                    completed: results.length,
                    total: pageCount
                  })
                : t('Browse figures, captions and copyable tables.')}
            </p>
            {!busy ? (
              <div className="flex items-center justify-center gap-2">
                <Button disabled={!model} onClick={() => void extract()}>
                  {needsDownload
                    ? t('Download and continue')
                    : analysisIncomplete
                      ? t('Analyze again')
                      : t('Analyze PDF')}
                </Button>
                {concurrencySelect}
              </div>
            ) : null}
            {needsDownload ? (
              <p className="text-xs text-text-300">
                {t('Download size')}: {formatBytes(model.downloadBytes)}
              </p>
            ) : null}
            <p className="text-xs leading-5 text-text-300">
              {!analysisIncomplete ? t('Scanned and rotated pages are not supported yet.') : null}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
