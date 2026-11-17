import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useNavigationStore } from '@/stores/navigation-store'
import { createLiteratureAttachmentVersionReference } from '../../../../shared/literature-attachment-reference'
import type { LiteratureSourceCitation } from '../../../../shared/literature-source-citation'
import { requestPdfSourceReveal } from './annotations/annotation-reveal'
import { ArtifactLiteratureDetailDialog } from './ArtifactLiteratureDetailDialog'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { createUploadVersionReference } from '../../../../shared/uploads'

function highlightQuote(text: string, quote: string | undefined): ReactNode {
  const index = quote ? text.indexOf(quote) : -1
  if (index < 0 || !quote) return text
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-primary/10 font-medium text-foreground">{quote}</mark>
      {text.slice(index + quote.length)}
    </>
  )
}

function CitationExcerpt({
  quote,
  context
}: Pick<LiteratureSourceCitation, 'quote' | 'context'>): React.JSX.Element | null {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const surroundingText = context?.trim() && context.trim() !== quote?.trim() ? context : undefined
  const text = surroundingText ?? quote
  if (!text) return null

  // Keep the issued quote intact and center the bounded preview around it when possible.
  const quoteIndex = quote ? text.indexOf(quote) : -1
  const previewLength = Math.max(800, quote?.length ?? 0)
  const previewStart = Math.max(
    0,
    Math.min(
      quoteIndex - Math.floor((previewLength - (quote?.length ?? 0)) / 2),
      text.length - previewLength
    )
  )
  const previewEnd = Math.min(text.length, previewStart + previewLength)
  const truncated = previewStart > 0 || previewEnd < text.length
  const preview = text.slice(previewStart, previewEnd)
  const excerptClassName =
    'max-h-60 overflow-y-auto overscroll-contain border-s-2 border-border ps-3 text-sm whitespace-pre-wrap break-words'

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('Source excerpt')}</p>
      {!truncated || !expanded ? (
        <blockquote className={excerptClassName}>
          {previewStart > 0 ? '…' : null}
          {highlightQuote(preview, quote)}
          {previewEnd < text.length ? '…' : null}
        </blockquote>
      ) : null}
      {truncated ? (
        <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t('View surrounding text')}
          </summary>
          <blockquote className={`mt-2 ${excerptClassName}`}>
            {highlightQuote(text, quote)}
          </blockquote>
        </details>
      ) : null}
      {surroundingText && quote && quoteIndex < 0 ? (
        <blockquote className={excerptClassName}>{highlightQuote(quote, quote)}</blockquote>
      ) : null}
    </div>
  )
}

export function LibrarySourceCitationLink({
  citation,
  children,
  className,
  snapshotOnly = false,
  packageLiterature,
  packageSessionId
}: {
  citation: LiteratureSourceCitation
  children: ReactNode
  className?: string
  snapshotOnly?: boolean
  packageLiterature?: Readonly<{
    items: readonly Readonly<{ itemId: string; metadataRevision: number; item: unknown }>[]
  }>
  packageSessionId?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState(false)
  const [packageSourceResult, setPackageSourceResult] = useState<{
    key: string
    state: 'available' | 'unavailable' | 'unknown'
  }>()
  const [showSnapshot, setShowSnapshot] = useState(false)
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [])
  const projectId = useNavigationStore.getState().activeProjectId
  const packageSourceKey = JSON.stringify([
    projectId,
    packageSessionId,
    citation.source?.attachmentId,
    citation.source?.versionId,
    citation.source?.checksum
  ])
  const packageSource =
    packageSourceResult?.key === packageSourceKey ? packageSourceResult.state : 'checking'

  useEffect(() => {
    const source = citation.source
    if (!open || !snapshotOnly || !packageSessionId || !source || !projectId) return
    let active = true
    // Receipt membership, not historical citation metadata, determines whether the
    // imported package actually includes these PDF bytes.
    void window.api.pdfAnnotations
      .list({
        projectId,
        sessionId: packageSessionId,
        sourceFileId: source.attachmentId,
        versionId: source.versionId
      })
      .then(
        (result) => {
          if (active)
            setPackageSourceResult({
              key: packageSourceKey,
              state: result.source?.checksum === source.checksum ? 'available' : 'unavailable'
            })
        },
        () => {
          if (active)
            setPackageSourceResult((previous) =>
              previous?.key === packageSourceKey
                ? previous
                : { key: packageSourceKey, state: 'unknown' }
            )
        }
      )
    return () => {
      active = false
    }
  }, [open, snapshotOnly, packageSessionId, citation.source, projectId, packageSourceKey])

  const sourceUnavailable = Boolean(
    snapshotOnly && packageSessionId && packageSource === 'unavailable'
  )

  const viewSource = async (): Promise<void> => {
    if (sourceUnavailable || (snapshotOnly && packageSessionId && packageSource === 'checking'))
      return
    const source = citation.source
    const projectId = useNavigationStore.getState().activeProjectId
    if (!source || !citation.pageStart || !projectId) {
      setError(true)
      return
    }
    controller.current?.abort()
    const pending = new AbortController()
    controller.current = pending
    setOpening(true)
    setError(false)
    try {
      const request = requestPdfSourceReveal(
        {
          id: `library-citation:${source.versionId}:${citation.pageStart}`,
          kind: 'pdf',
          source: {
            kind: packageSessionId ? 'upload-version' : 'literature-attachment-version',
            sourceFileId: source.attachmentId,
            versionId: source.versionId,
            checksum: source.checksum,
            name: source.name,
            path: packageSessionId
              ? createUploadVersionReference(source.versionId, {
                  projectId,
                  sessionId: packageSessionId,
                  fileId: source.attachmentId
                })
              : createLiteratureAttachmentVersionReference(source.versionId),
            ...(packageSessionId ? { projectId, sessionId: packageSessionId } : {})
          },
          selector: {
            kind: 'page-note',
            pageNumber: citation.pageStart,
            pageRotation: 0,
            coordinateVersion: 1
          }
        },
        { projectId, signal: pending.signal }
      )
      if (!request.admitted) setOpening(false)
      const outcome = await request.result
      if (pending.signal.aborted) return
      if (outcome === 'cancelled') return
      if (outcome === 'revealed') setOpen(false)
      else setError(true)
    } catch {
      if (!pending.signal.aborted) setError(true)
    } finally {
      if (!pending.signal.aborted) setOpening(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={className}
          data-streamdown="link"
          data-library-source-citation=""
          aria-label={t('Source excerpt')}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] space-y-3" align="start">
        <div>
          <p className="text-sm font-medium">{citation.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {citation.kind === 'metadata'
              ? t('Metadata only')
              : citation.kind === 'abstract'
                ? t('Abstract only')
                : t('PDF evidence')}
            {citation.pageStart ? ` · ${t('Page {{page}}', { page: citation.pageStart })}` : ''}
          </p>
        </div>
        <CitationExcerpt quote={citation.quote} context={citation.context} />
        {error ? <ErrorNotice inline description={t('The source could not be opened.')} /> : null}
        {sourceUnavailable ? (
          <p className="text-xs text-muted-foreground">
            {t('The original PDF is unavailable in this Session package.')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {citation.kind === 'pdf' ? (
            <Button
              size="sm"
              disabled={
                opening ||
                sourceUnavailable ||
                Boolean(snapshotOnly && packageSessionId && packageSource === 'checking')
              }
              onClick={() => void viewSource()}
            >
              {t('View source page')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (snapshotOnly) setShowSnapshot(true)
              else useNavigationStore.getState().openLiteratureItem(citation.itemId, 'user')
            }}
          >
            {t('View reference')}
          </Button>
        </div>
      </PopoverContent>
      {snapshotOnly && showSnapshot ? (
        <ArtifactLiteratureDetailDialog
          snapshotOnly
          reference={{
            itemId: citation.itemId,
            metadataRevision:
              packageLiterature?.items.find((entry) => entry.itemId === citation.itemId)
                ?.metadataRevision ?? 1,
            item: literatureItemInputSchema.parse(
              packageLiterature?.items.find((entry) => entry.itemId === citation.itemId)?.item ?? {
                itemType: 'document',
                title: citation.title
              }
            )
          }}
          onOpenChange={setShowSnapshot}
        />
      ) : null}
    </Popover>
  )
}
