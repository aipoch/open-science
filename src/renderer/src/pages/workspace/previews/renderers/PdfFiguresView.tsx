import { useEffect, useMemo, useRef, useState } from 'react'
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
import { ErrorNotice } from '@/components/error-notice'
import {
  ImageIcon,
  Table2,
  ListOrdered,
  ArrowUpRight,
  ScanSearch,
  RefreshCw,
  LoaderCircle,
  CircleCheck,
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
  type LocalModelSnapshot
} from '../../../../../../shared/local-models'
import type { PdfStructureResult } from '../../../../../../shared/pdf-structure'
import { copyPdfTable, pdfTableLayout } from '../../../../../../shared/pdf-table-copy'

const formatBytes = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MiB`
import { groupPdfFigureSelections, type Selection } from './pdf-figure-selections'

type TableData = NonNullable<PdfStructureResult['elements'][number]['table']>

const TableDetails = ({
  table,
  title,
  sharedNotes
}: {
  table: TableData
  title?: string
  sharedNotes?: TableData['notes']
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [reviewed, setReviewed] = useState(false)
  const [copyStatus, setCopyStatus] = useState<string>()
  const missing = t('[Missing]')
  const grid = useMemo(
    () =>
      table && table.rowCount <= 256 && table.columnCount <= 128
        ? pdfTableLayout(table)
        : undefined,
    [table]
  )
  const copy = async (format: 'tsv' | 'markdown' | 'html'): Promise<void> => {
    if (!table || !reviewed) return
    const copyTable = { ...table, notes: [...(table.notes ?? []), ...(sharedNotes ?? [])] }
    try {
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
      setCopyStatus(t('Could not copy the table. Try again.'))
    }
  }
  return (
    <section className="space-y-3" aria-label={title}>
      {title ? <h3 className="font-medium">{title}</h3> : null}
      {grid ? (
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
      ) : (
        <p>{t('Structured cells are unavailable for this candidate.')}</p>
      )}
    </section>
  )
}

const CandidateDetails = ({
  selected,
  attachmentVersionId,
  imageCache,
  onNavigate,
  hideCaption = false,
  showPage = false,
  imageOnly = false
}: {
  selected: Selection
  attachmentVersionId: string
  imageCache: PdfPreviewImageCache
  onNavigate: (page: number) => void
  hideCaption?: boolean
  showPage?: boolean
  imageOnly?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { result, element } = selected
  const table = selected.combinedTable ?? element.table
  const imageRequest = {
    attachmentVersionId,
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
  }, [attachmentVersionId, element, result.extractionId, imageAttempt, imageCache, needsImage])
  return (
    <article className="space-y-3 text-sm">
      <div
        className={cn(
          'flex-wrap items-center gap-3 border-b border-border-200 pb-2 @min-[640px]:flex',
          hasTable || showPage ? 'flex' : 'hidden'
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
                    >
                      {imageAction === 'download' ? (
                        <LoaderCircle
                          className="size-4 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <Download className="size-4" aria-hidden="true" />
                      )}
                      <span className="hidden sm:inline">{t('Download image')}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      aria-label={t('Copy image')}
                      title={t('Copy image')}
                      disabled={imageAction !== null}
                      onClick={() => void exportImage('copy')}
                    >
                      {imageAction === 'copy' ? (
                        <LoaderCircle
                          className="size-4 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <Copy className="size-4" aria-hidden="true" />
                      )}
                      <span className="hidden sm:inline">{t('Copy image')}</span>
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
              />
            ))
          ) : table ? (
            <TableDetails key={selected.continuations?.length ?? 0} table={table} />
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
  attachmentVersionId,
  pageCount,
  active: visible = true,
  onNavigate
}: {
  attachmentVersionId: string
  pageCount: number
  active?: boolean
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
  const [imageCache] = useState(() => new PdfPreviewImageCache())
  const [restoring, setRestoring] = useState(true)
  const [cacheChecked, setCacheChecked] = useState(false)
  const generation = useRef(0)
  const requestId = useRef<string | undefined>(undefined)
  const installation = useRef<Promise<void> | undefined>(undefined)
  const mounted = useRef(true)
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
              window.api.pdfStructure.readCached({ attachmentVersionId, page: page + offset })
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
      } catch {
        if (live && own === generation.current) setError(true)
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
  }, [visible, cacheChecked, attachmentVersionId, pageCount])
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
    return () => {
      mounted.current = false
      imageCache.clear()
      taskGeneration.current++
      if (requestId.current)
        void window.api.pdfStructure.cancel(requestId.current).catch(() => undefined)
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
          if (live) setError(true)
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
  const entries = useMemo(() => groupPdfFigureSelections(results), [results])
  const analysisComplete =
    !restoring && !busy && !error && !limited && failed.length === 0 && results.length === pageCount
  const analysisIncomplete = !busy && (completed > 0 || error || limited)
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
  const progressValue = downloading ? model.transferredBytes : completed
  const progressTotal = downloading ? model.downloadBytes : pageCount
  const percent =
    progressTotal > 0 ? Math.min(100, Math.round((progressValue / progressTotal) * 100)) : 0
  const busyLabel = downloading ? t('Downloading and verifying…') : t('Analyzing PDF…')
  const progressTrack = (
    <div
      role="progressbar"
      aria-label={downloading ? t('Model download progress') : t('PDF extraction progress')}
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
  const progress = (
    <div className="w-full space-y-2 text-left">
      {progressTrack}
      <div className="flex items-start justify-between gap-4 text-xs text-text-200 tabular-nums">
        <span>
          {downloading
            ? `${formatBytes(model.transferredBytes)} / ${formatBytes(model.downloadBytes)}`
            : t('Processed {{completed}} / {{total}} pages', { completed, total: pageCount })}
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
      {completed > 0 && (analysisComplete || entries.length > 0) ? (
        <header
          className={cn(
            'shrink-0 space-y-2 border-b border-border-200 px-3 @min-[640px]:px-4',
            busy ? 'py-3' : 'py-1.5'
          )}
        >
          <div className="flex items-center justify-between gap-4">
            <p
              role="status"
              aria-atomic="true"
              className="min-w-0 text-xs text-text-200 @min-[640px]:text-sm"
              title={t('Processed {{completed}} / {{total}} pages', {
                completed,
                total: pageCount
              })}
            >
              <span className="inline-flex items-center gap-2 font-medium text-text-000">
                {busy || restoring ? (
                  <LoaderCircle
                    className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : analysisComplete ? (
                  <CircleCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
                ) : null}
                {restoring
                  ? t('Loading…')
                  : busy
                    ? busyLabel
                    : analysisComplete
                      ? t('Analysis complete')
                      : t('Processed {{completed}} / {{total}} pages', {
                          completed,
                          total: pageCount
                        })}
              </span>
            </p>
            {busy ? (
              <Button size="sm" variant="outline" onClick={cancel}>
                {model?.availability === 'installing' ? t('Cancel download') : t('Cancel')}
              </Button>
            ) : completed > 0 ? (
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
          </div>
          {busy && !restoring ? progress : null}
        </header>
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
                    attachmentVersionId={attachmentVersionId}
                    onNavigate={onNavigate}
                    showPage={parts.length > 1}
                    hideCaption={active.combinedTable ? index > 0 : index < parts.length - 1}
                    imageOnly={!!active.combinedTable && index > 0}
                  />
                ))
              : null}
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
