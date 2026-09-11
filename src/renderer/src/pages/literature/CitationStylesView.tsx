import { ErrorNotice } from '@/components/error-notice'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: citation style manager · genre: modern-minimal · theme: existing Open Science tokens · enrichment: none */
import { ArrowLeft, BookOpenText, FileText, LoaderCircle, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  ApplicationCommandError,
  parseApplicationCommandError
} from '../../../../shared/application-command-contract'

import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
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
  const mutating = importing || deletingId !== undefined
  const [previewStates, setPreviewStates] = useState<Record<string, CitationStylePreviewState>>({})
  const [error, setError] = useState<
    | ApplicationCommandError
    | 'file-extension'
    | 'file-too-large'
    | 'load-failed'
    | 'import-failed'
    | 'delete-failed'
  >()
  const previewRequestsRef = useRef(new Set<string>())
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null)
  const activePreviewRef = useRef<string | null>(null)
  const pinnedRef = useRef(false)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const warmRef = useRef(false)
  const warmTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previewContentRef = useRef<HTMLDivElement>(null)
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const restoreFocusRef = useRef(false)
  const suppressFocusRef = useRef(false)

  const cancelPreviewTimer = (): void => clearTimeout(previewTimerRef.current)
  const closePreview = useCallback((): void => {
    clearTimeout(previewTimerRef.current)
    if (activePreviewRef.current) {
      warmRef.current = true
      clearTimeout(warmTimerRef.current)
      warmTimerRef.current = setTimeout(() => {
        warmRef.current = false
      }, 300)
    }
    activePreviewRef.current = null
    pinnedRef.current = false
    setActivePreviewId(null)
  }, [])
  const scheduleClosePreview = (): void => {
    cancelPreviewTimer()
    if (pinnedRef.current) return
    previewTimerRef.current = setTimeout(() => {
      if (
        previewContentRef.current?.contains(document.activeElement) ||
        previewTriggerRef.current === document.activeElement
      )
        return
      closePreview()
    }, 150)
  }

  useEffect(
    () => () => {
      clearTimeout(previewTimerRef.current)
      clearTimeout(warmTimerRef.current)
    },
    []
  )

  useEffect(() => {
    if (!activePreviewId) return
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && previewContentRef.current?.contains(event.target)) return
      closePreview()
    }
    document.addEventListener('scroll', onScroll, true)
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [activePreviewId, closePreview])

  useEffect(() => {
    if (!activePreviewId || styles?.some((style) => style.id === activePreviewId)) return
    let current = true
    queueMicrotask(() => {
      if (current) closePreview()
    })
    return () => {
      current = false
    }
  }, [activePreviewId, styles, closePreview])

  useEffect(() => {
    if (styles !== undefined) return
    let active = true
    void window.api.literature.citationStyles({ kind: 'list' }).then(
      (result) => {
        if (!active) return
        onStylesChange(result.styles)
        setLoading(false)
      },
      () => {
        if (!active) return
        setError('load-failed')
        setLoading(false)
      }
    )
    return () => {
      active = false
    }
  }, [onStylesChange, styles])

  const loadPreview = useCallback(
    (style: LiteratureCitationStyleView): void => {
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
    },
    [previewStates]
  )

  const showPreview = useCallback(
    (style: LiteratureCitationStyleView, trigger: HTMLButtonElement, immediate = false): void => {
      cancelPreviewTimer()
      if (pinnedRef.current && activePreviewRef.current !== style.id) return
      const show = (): void => {
        previewTriggerRef.current = trigger
        activePreviewRef.current = style.id
        setActivePreviewId(style.id)
        loadPreview(style)
      }
      if (immediate || activePreviewRef.current || warmRef.current) show()
      else previewTimerRef.current = setTimeout(show, 200)
    },
    [loadPreview]
  )

  const importStyle = async (file: File): Promise<void> => {
    if (mutating) return
    setError(undefined)
    if (!file.name.toLowerCase().endsWith('.csl')) {
      setError('file-extension')
      return
    }
    if (file.size > LITERATURE_CSL_MAX_BYTES) {
      setError('file-too-large')
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
      setError(parseApplicationCommandError(cause) ?? 'import-failed')
    } finally {
      setImporting(false)
    }
  }

  const deleteStyle = async (styleId: string): Promise<void> => {
    if (mutating) return
    setError(undefined)
    setDeletingId(styleId)
    try {
      const result = await window.api.literature.citationStyles({ kind: 'delete', styleId })
      onStylesChange(result.styles)
    } catch {
      setError('delete-failed')
    } finally {
      setDeletingId(undefined)
    }
  }

  const errorMessage = (): string => {
    const code = error instanceof ApplicationCommandError ? error.code : error
    switch (code) {
      case 'file-extension':
        return t('Choose a .csl file.')
      case 'file-too-large':
      case 'csl-file-too-large':
        return t('The CSL file must be 1 MB or smaller.')
      case 'csl-invalid-xml':
        return t('The selected file is not valid CSL XML.')
      case 'csl-unsupported-doctype':
        return t('CSL files with a document type declaration are not supported.')
      case 'csl-unsupported-style':
        return t('The selected file must be an independent CSL 1.0 style.')
      case 'csl-missing-metadata':
        return t('The CSL style must include a title and an id.')
      case 'csl-dependent-style':
        return t('Dependent CSL styles are not supported yet. Import an independent style.')
      case 'csl-missing-sections':
        return t('Open Science requires CSL styles with both citation and bibliography sections.')
      case 'csl-undefined-macro':
        if (error instanceof ApplicationCommandError && error.parameters) {
          return t('The CSL style references an undefined macro: {{macro}}', {
            macro: error.parameters.macro
          })
        }
        return t('The CSL style could not be imported. Please try again.')
      case 'load-failed':
        return t('Citation styles could not be loaded. Please try again.')
      case 'delete-failed':
        return t('The CSL style could not be deleted. Please try again.')
      default:
        return t('The CSL style could not be imported. Please try again.')
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
        <Popover
          open={activePreviewId === style.id}
          onOpenChange={(open) => {
            if (!open) closePreview()
          }}
        >
          <PopoverAnchor asChild>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={activePreviewId === style.id}
              onPointerEnter={(event) => {
                if (event.pointerType !== 'touch') showPreview(style, event.currentTarget)
              }}
              onPointerLeave={scheduleClosePreview}
              onFocus={(event) => {
                if (suppressFocusRef.current) {
                  suppressFocusRef.current = false
                  return
                }
                if (event.currentTarget.matches(':focus-visible'))
                  showPreview(style, event.currentTarget, true)
              }}
              onBlur={(event) => {
                if (
                  event.relatedTarget instanceof Node &&
                  previewContentRef.current?.contains(event.relatedTarget)
                )
                  return
                scheduleClosePreview()
              }}
              onClick={(event) => {
                pinnedRef.current = false
                showPreview(style, event.currentTarget, true)
                pinnedRef.current = true
                previewContentRef.current?.focus()
              }}
              aria-label={`${t('Preview')}: ${style.title}`}
              className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
                <p className="truncate text-sm font-medium">{style.title}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {style.source === 'built-in'
                    ? t('Included with Open Science')
                    : t('Imported CSL')}
                  {style.rights ? ` · ${style.rights}` : ''}
                </p>
              </div>
            </button>
          </PopoverAnchor>
          <PopoverContent
            ref={previewContentRef}
            aria-label={`${t('Preview')}: ${style.title}`}
            tabIndex={-1}
            side="top"
            align="end"
            collisionPadding={8}
            className="max-h-[min(24rem,var(--radix-popover-content-available-height))] min-h-0 w-80 max-w-[calc(100vw-1rem)] space-y-2.5 overflow-y-auto overscroll-contain break-words p-3 select-text"
            onPointerEnter={cancelPreviewTimer}
            onPointerLeave={scheduleClosePreview}
            onFocusCapture={() => {
              cancelPreviewTimer()
              pinnedRef.current = true
            }}
            onBlurCapture={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                previewContentRef.current?.contains(event.relatedTarget)
              )
                return
              pinnedRef.current = false
              scheduleClosePreview()
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              if (pinnedRef.current) previewContentRef.current?.focus()
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (!restoreFocusRef.current) return
              restoreFocusRef.current = false
              suppressFocusRef.current = true
              previewTriggerRef.current?.focus()
            }}
            onEscapeKeyDown={() => {
              restoreFocusRef.current =
                previewContentRef.current?.contains(document.activeElement) ?? false
            }}
          >
            <p className="font-semibold">{style.title}</p>
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
            {previewState?.status === 'error' ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => loadPreview(style)}
              >
                {t('Retry')}
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>
        {style.source === 'custom' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={mutating}
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
    <>
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
              disabled={mutating}
              accept=".csl,application/xml,text/xml"
              className="sr-only"
              aria-label={t('Import CSL')}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void importStyle(file)
              }}
            />
            <Button type="button" disabled={mutating} onClick={() => inputRef.current?.click()}>
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
          <ErrorNotice role="alert" tone="amber" className="mt-5" description={errorMessage()} />
        ) : null}

        {loading && styles === undefined ? (
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
    </>
  )
}

export { CitationStylesView }
