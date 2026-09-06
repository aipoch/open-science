/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: citation style manager · genre: modern-minimal · theme: existing Open Science tokens · enrichment: none */
import { ArrowLeft, BookOpenText, FileText, LoaderCircle, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { cn } from '@/lib/utils'
import {
  LITERATURE_CSL_MAX_BYTES,
  type LiteratureCitationStyleView
} from '../../../../shared/literature'

type CitationStylesViewProps = Readonly<{
  styles?: LiteratureCitationStyleView[]
  onBack: () => void
  onStylesChange: (styles: LiteratureCitationStyleView[]) => void
}>

type CitationStylePreview = NonNullable<LiteratureCitationStyleView['preview']>
type CitationStylePreviewState =
  | Readonly<{ status: 'loading' | 'error' }>
  | Readonly<{ status: 'ready'; value: CitationStylePreview }>

const CitationStylesView = ({
  styles,
  onBack,
  onStylesChange
}: CitationStylesViewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(styles === undefined)
  const [importing, setImporting] = useState(false)
  const [deletingId, setDeletingId] = useState<string>()
  const [previewStates, setPreviewStates] = useState<Record<string, CitationStylePreviewState>>({})
  const [error, setError] = useState<string>()
  const previewRequestsRef = useRef(new Set<string>())

  useEffect(() => {
    if (styles !== undefined) return
    let active = true
    void window.api.literature.citationStyles({ kind: 'list' }).then(
      (result) => {
        if (!active) return
        onStylesChange(result.styles)
        setLoading(false)
      },
      (cause: unknown) => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoading(false)
      }
    )
    return () => {
      active = false
    }
  }, [onStylesChange, styles])

  const loadPreview = (style: LiteratureCitationStyleView): void => {
    if (
      style.preview ||
      previewRequestsRef.current.has(style.id) ||
      previewStates[style.id]?.status === 'ready'
    )
      return
    previewRequestsRef.current.add(style.id)
    setPreviewStates((current) => ({ ...current, [style.id]: { status: 'loading' } }))
    void window.api.literature.citationStyles({ kind: 'preview', styleId: style.id }).then(
      (result) => {
        const preview = result.preview
        if (preview?.styleId !== style.id) previewRequestsRef.current.delete(style.id)
        setPreviewStates((current) => ({
          ...current,
          [style.id]:
            preview?.styleId === style.id
              ? { status: 'ready', value: preview }
              : { status: 'error' }
        }))
      },
      () => {
        previewRequestsRef.current.delete(style.id)
        setPreviewStates((current) => ({ ...current, [style.id]: { status: 'error' } }))
      }
    )
  }

  const importStyle = async (file: File): Promise<void> => {
    setError(undefined)
    if (!file.name.toLowerCase().endsWith('.csl')) {
      setError(t('Choose a .csl file.'))
      return
    }
    if (file.size > LITERATURE_CSL_MAX_BYTES) {
      setError(t('The CSL file must be 1 MB or smaller.'))
      return
    }
    setImporting(true)
    try {
      const result = await window.api.literature.citationStyles({
        kind: 'import',
        content: await file.text()
      })
      onStylesChange(result.styles)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setImporting(false)
    }
  }

  const deleteStyle = async (styleId: string): Promise<void> => {
    setError(undefined)
    setDeletingId(styleId)
    try {
      const result = await window.api.literature.citationStyles({ kind: 'delete', styleId })
      onStylesChange(result.styles)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeletingId(undefined)
    }
  }

  const builtIn = styles?.filter(({ source }) => source === 'built-in') ?? []
  const imported = styles?.filter(({ source }) => source === 'custom') ?? []

  const renderStyle = (style: LiteratureCitationStyleView): React.JSX.Element => {
    const previewState = previewStates[style.id]
    const example =
      style.preview ?? (previewState?.status === 'ready' ? previewState.value : undefined)
    return (
      <li key={style.id} className="flex min-h-16 items-center gap-3 px-4 py-3 sm:px-5">
        <Tooltip onOpenChange={(open) => open && loadPreview(style)}>
          <TooltipTrigger asChild>
            <div
              tabIndex={0}
              aria-label={`${t('Preview')}: ${style.title}`}
              className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg',
                  style.source === 'built-in'
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {style.source === 'built-in' ? (
                  <BookOpenText className="size-4" aria-hidden="true" />
                ) : (
                  <FileText className="size-4" aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={style.title}>
                  {style.title}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {style.source === 'built-in'
                    ? t('Included with Open Science')
                    : t('Imported CSL')}
                  {style.rights ? ` · ${style.rights}` : ''}
                </p>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="min-h-32 w-80 space-y-2.5 p-3">
            {example ? (
              <>
                <div>
                  <p className="font-medium text-bg-000/70">{t('In-text citation')}</p>
                  <p className="mt-0.5 leading-5">{example.inText}</p>
                </div>
                <div>
                  <p className="font-medium text-bg-000/70">{t('Reference')}</p>
                  <p className="mt-0.5 leading-5">{example.reference}</p>
                </div>
              </>
            ) : (
              <p role="status" className="flex min-h-26 items-center justify-center gap-2">
                {previewState?.status === 'loading' ? (
                  <LoaderCircle
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {previewState?.status === 'loading'
                  ? t('Loading preview…')
                  : t('Preview unavailable')}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
        {style.source === 'custom' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={deletingId !== undefined}
            aria-label={t('Delete {{style}}', { style: style.title })}
            title={t('Delete')}
            onClick={() => void deleteStyle(style.id)}
          >
            {deletingId === style.id ? (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Trash2 className="size-4" aria-hidden="true" />
            )}
          </Button>
        ) : null}
      </li>
    )
  }

  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={0}>
      <div className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-y-auto px-4 py-6 [scrollbar-width:none] lg:px-6 lg:py-8 [&::-webkit-scrollbar]:hidden">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-3" onClick={onBack}>
              <ArrowLeft className="size-4" aria-hidden="true" />
              {t('Back to references')}
            </Button>
            <h2 className="text-2xl font-semibold tracking-tight">{t('Citation styles')}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t('Choose the styles available when formatting references and documents.')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <ExternalTextLink href="https://www.zotero.org/styles" className="text-sm">
              {t('Browse styles')}
            </ExternalTextLink>
            <input
              ref={inputRef}
              type="file"
              accept=".csl,application/xml,text/xml"
              className="sr-only"
              aria-label={t('Import CSL')}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void importStyle(file)
              }}
            />
            <Button type="button" disabled={importing} onClick={() => inputRef.current?.click()}>
              {importing ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Upload className="size-4" aria-hidden="true" />
              )}
              {importing ? t('Importing…') : t('Import CSL')}
            </Button>
          </div>
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-5 rounded-lg bg-danger-900 px-3 py-2 text-sm text-danger-000"
          >
            {error}
          </p>
        ) : null}

        {loading ? (
          <div role="status" className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t('Loading citation styles…')}
          </div>
        ) : (
          <div className="mt-8 space-y-8">
            <section aria-labelledby="built-in-citation-styles">
              <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
                <h3 id="built-in-citation-styles" className="text-sm font-semibold">
                  {t('Built-in styles')}
                </h3>
                <span className="text-xs tabular-nums text-muted-foreground">{builtIn.length}</span>
              </div>
              <ul className="divide-y divide-border-300/80 overflow-hidden rounded-xl border border-border-300/80 bg-bg-000">
                {builtIn.map(renderStyle)}
              </ul>
            </section>

            <section aria-labelledby="imported-citation-styles">
              <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
                <h3 id="imported-citation-styles" className="text-sm font-semibold">
                  {t('Imported styles')}
                </h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {imported.length}
                </span>
              </div>
              {imported.length > 0 ? (
                <ul className="divide-y divide-border-300/80 overflow-hidden rounded-xl border border-border-300/80 bg-bg-000">
                  {imported.map(renderStyle)}
                </ul>
              ) : (
                <div className="flex min-h-28 items-center gap-3 rounded-xl border border-dashed border-border-300/80 px-5 py-4">
                  <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium">{t('No imported styles')}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('Import an independent .csl file to make it available on this device.')}
                    </p>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}

export { CitationStylesView }
