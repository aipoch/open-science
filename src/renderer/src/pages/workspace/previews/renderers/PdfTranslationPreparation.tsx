/* Hallmark · component: PDF preparation · theme: existing Open-Science tokens
 * pre-emit critique: P5 H4 E4 S5 R5 V4 */
import { Collapsible } from 'radix-ui'
import { Check, ChevronRight, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PdfPreparationState } from './use-pdf-translation-preparation'
import type { PdfTranslationExclusionReason } from './pdf-translation-extraction'

export function PdfTranslationPreparation({
  state,
  showReadyStatus = true,
  pageCount,
  onStart,
  onCancel,
  onNavigate,
  compact = false
}: {
  state: PdfPreparationState
  showReadyStatus?: boolean
  pageCount: number
  onStart: () => void
  onCancel: () => void
  onNavigate: (page: number) => void
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  if (compact && state.status !== 'error' && state.status !== 'cancelled') {
    return (
      <section
        className="min-w-0 shrink-0 border-b border-border px-5 py-1.5 text-xs"
        aria-label={t('Full-text preparation')}
        data-pdf-preparation
      >
        <p role="status" className="text-muted-foreground">
          {t('Loading saved translation…')}
        </p>
      </section>
    )
  }
  const coverage = state.status === 'ready' ? state.extraction.coverage : undefined
  const independent =
    state.status === 'ready' ? state.extraction.source.units.filter((unit) => unit.sourceOnly) : []
  const independentItemCount = independent.reduce(
    (count, unit) => count + unit.fragments.reduce((n, fragment) => n + fragment.items.length, 0),
    0
  )
  const independentPages = [
    ...new Set(independent.flatMap((unit) => unit.fragments.map((fragment) => fragment.pageNumber)))
  ].sort((a, b) => a - b)
  const excludedPages = new Map<number, Map<PdfTranslationExclusionReason, number>>()
  for (const entry of coverage?.exclusions ?? [])
    for (const item of entry.items) {
      if (!excludedPages.has(item.pageNumber)) excludedPages.set(item.pageNumber, new Map())
      const reasons = excludedPages.get(item.pageNumber)!
      reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1)
    }
  return (
    <section
      className="min-w-0 shrink-0 space-y-2 px-5 pb-0 pt-2 text-sm"
      aria-label={t('Full-text preparation')}
      data-pdf-preparation
    >
      {!coverage && state.status === 'idle' ? (
        <Collapsible.Root
          defaultOpen
          className="overflow-hidden rounded-lg border border-border/70 bg-muted/20"
        >
          <TooltipProvider delayDuration={100} skipDelayDuration={300}>
            <div className="flex items-center">
              <Collapsible.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="group grid min-h-9 min-w-0 flex-1 grid-cols-[16px_24px_minmax(0,1fr)] items-center gap-2 rounded-none px-3 text-left hover:bg-muted/60 aria-expanded:bg-muted/50"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                  />
                  <span
                    aria-hidden="true"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
                  >
                    1
                  </span>
                  <span className="min-w-0 truncate">{t('Full-text preparation')}</span>
                </Button>
              </Collapsible.Trigger>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-pdf-preparation-info
                    aria-label={t('More information')}
                    className="mr-2 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Info aria-hidden="true" className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="z-[120] max-w-64 space-y-1.5">
                  <p>{t('Check document text and page locations before translation.')}</p>
                  <p>{t('Preparation runs locally without calling a model.')}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
          <Collapsible.Content className="w-full space-y-3 border-t border-border/70 bg-background/60 px-3 pb-3 pt-3 data-[state=closed]:hidden">
            <Button className="w-full" size="sm" onClick={onStart} disabled={pageCount < 1}>
              {t('Prepare full text')}
            </Button>
          </Collapsible.Content>
        </Collapsible.Root>
      ) : null}
      {state.status === 'error' ? (
        <ErrorNotice
          inline
          role="alert"
          title={t('Could not prepare full text')}
          description={t(
            'The document could not be fully read. You can retry while continuing to read the original.'
          )}
          primaryButton={{ label: t('Retry'), onClick: onStart }}
        />
      ) : state.status === 'running' ? (
        <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
          <div className="grid min-h-9 grid-cols-[16px_24px_minmax(0,1fr)] items-center gap-2 bg-muted/20 px-3 py-1.5">
            <span aria-hidden="true" />
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary"
            >
              1
            </span>
            <p className="font-medium leading-6" role="status">
              {t('Preparing full text…')}
            </p>
          </div>
          <div className="w-full space-y-3 border-t border-border/70 bg-background/60 px-3 pb-3 pt-3">
            <div
              role="progressbar"
              aria-label={t('Full-text preparation')}
              aria-valuemin={0}
              aria-valuemax={pageCount}
              aria-valuenow={state.pagesRead}
              className="h-1 w-full overflow-hidden rounded-full bg-bg-300"
            >
              <div
                className="h-full origin-left rounded-full bg-primary transition-transform duration-150 ease-out motion-reduce:transition-none"
                style={{
                  transform: `scaleX(${pageCount > 0 ? Math.min(1, state.pagesRead / pageCount) : 0})`
                }}
              />
            </div>
            <p className="text-xs tabular-nums text-muted-foreground">
              {t('Pages checked: {{done}} / {{total}}', {
                done: state.pagesRead,
                total: pageCount
              })}
            </p>
            <Button className="w-full" size="sm" variant="outline" onClick={onCancel}>
              {t('Cancel')}
            </Button>
          </div>
        </div>
      ) : coverage ? (
        <>
          <Collapsible.Root className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
            <div className="flex items-center bg-muted/20">
              <Collapsible.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="group grid min-h-9 min-w-0 flex-1 grid-cols-[16px_24px_minmax(0,1fr)_auto_16px] items-center gap-2 rounded-none px-3 text-left hover:bg-muted/60 aria-expanded:bg-muted/50"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                  />
                  <span
                    aria-hidden="true"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
                  >
                    1
                  </span>
                  <span className="min-w-0 truncate">{t('Full-text preparation')}</span>
                  {showReadyStatus ? (
                    <span
                      role="status"
                      className="shrink-0 text-xs font-normal text-status-success-foreground"
                    >
                      {t('Full text prepared')}
                    </span>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  <Check aria-hidden="true" className="size-4 text-status-success-foreground" />
                </Button>
              </Collapsible.Trigger>
            </div>
            <Collapsible.Content className="w-full space-y-3 border-t border-border/70 bg-background/60 px-3 pb-3 pt-3 data-[state=closed]:hidden">
              <TooltipProvider delayDuration={100} skipDelayDuration={300}>
                <dl className="space-y-2 text-xs">
                  {[
                    [t('Pages checked'), coverage.pageCount],
                    [t('Text segments found'), coverage.textItemCount],
                    [t('Text segments located'), coverage.includedItemCount],
                    [t('Text segments excluded'), coverage.excludedItemCount],
                    ...(independent.length ? [[t('Located separately'), independentItemCount]] : [])
                  ].map(([label, value], index) => (
                    <div key={label} className="flex items-start justify-between gap-3">
                      <dt className="flex min-w-0 items-center gap-1">
                        {label}
                        {index === 0 ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                data-pdf-preparation-info
                                aria-label={t('More information')}
                                className="inline-flex size-4 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <Info aria-hidden="true" className="size-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent className="z-[120] max-w-64 space-y-1.5">
                              <p>
                                {t(
                                  'This report checks source coverage, not translation completeness or accuracy.'
                                )}
                              </p>
                              <p>{t('Text segments may be words, lines, or labels.')}</p>
                              {coverage.warnings.length > 0 ? (
                                <p>
                                  {t('Some paragraph boundaries or hyphenated words need review.')}
                                </p>
                              ) : null}
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                      </dt>
                      <dd className="shrink-0 tabular-nums font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
              </TooltipProvider>
              {independent.length > 0 ? (
                <TooltipProvider delayDuration={100} skipDelayDuration={300}>
                  <div className="flex items-center gap-1 rounded-md border border-border/60 bg-background/70">
                    <Select value="" onValueChange={(page) => onNavigate(Number(page))}>
                      <SelectTrigger
                        aria-label={t('Original-layout pages')}
                        className="min-w-0 flex-1 border-0 bg-transparent text-xs shadow-none"
                      >
                        <span className="min-w-0 flex-1 truncate text-left">
                          {t('Original-layout pages')}
                        </span>
                        <span className="shrink-0 tabular-nums">{independentPages.length}</span>
                      </SelectTrigger>
                      <SelectContent className="z-[120] max-h-56">
                        {independentPages.map((page) => (
                          <SelectItem key={page} value={String(page)}>
                            {t('Page {{page}}', { page })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          data-pdf-independent-info
                          aria-label={t('More information')}
                          className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Info aria-hidden="true" className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="z-[120] max-w-64">
                        {t(
                          'These text fragments are included in the located total. They remain in the original and are not translated as paragraphs.'
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TooltipProvider>
              ) : null}
              {coverage.pagesWithoutText.length > 0 ? (
                <Collapsible.Root className="overflow-hidden rounded-md border border-border/60 bg-background/70 text-xs">
                  <Collapsible.Trigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="group min-h-8 w-full justify-start gap-2 rounded-none px-2 text-left hover:bg-muted/60 aria-expanded:bg-muted/50"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                      />
                      {t('Pages without extractable text')}
                    </Button>
                  </Collapsible.Trigger>
                  <Collapsible.Content className="space-y-3 border-t border-border/60 px-3 pb-2 pt-2 data-[state=closed]:hidden">
                    <p className="leading-5 text-muted-foreground">
                      {t(
                        'These pages may need OCR. Their content is not included in the extracted text.'
                      )}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {coverage.pagesWithoutText.map((page) => (
                        <Button
                          key={page}
                          size="sm"
                          variant="ghost"
                          onClick={() => onNavigate(page)}
                        >
                          {t('Page {{page}}', { page })}
                        </Button>
                      ))}
                    </div>
                  </Collapsible.Content>
                </Collapsible.Root>
              ) : null}
              {excludedPages.size > 0 ? (
                <Collapsible.Root className="overflow-hidden rounded-md border border-border/60 bg-background/70 text-xs">
                  <Collapsible.Trigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="group min-h-8 w-full justify-start gap-2 rounded-none px-2 text-left hover:bg-muted/60 aria-expanded:bg-muted/50"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                      />
                      {t('Excluded text')}
                    </Button>
                  </Collapsible.Trigger>
                  <Collapsible.Content className="space-y-3 border-t border-border/60 px-3 pb-2 pt-2 data-[state=closed]:hidden">
                    <p className="leading-5 text-muted-foreground">
                      {t(
                        'These text segments could not be safely located. Read them in the original.'
                      )}
                    </p>
                    {[...excludedPages]
                      .sort(([a], [b]) => a - b)
                      .map(([page, reasons]) => (
                        <div key={page} className="space-y-1 border-t border-border pt-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="px-0"
                            onClick={() => onNavigate(page)}
                          >
                            {t('Page {{page}}', { page })}
                          </Button>
                          {[...reasons].map(([reason, count]) => (
                            <div key={reason} className="flex justify-between gap-3">
                              <span>
                                {reason === 'unsupported-orientation'
                                  ? t('Unsupported text direction')
                                  : reason === 'outside-page'
                                    ? t('Text outside page bounds')
                                    : t('Invalid text geometry')}
                              </span>
                              <span className="shrink-0 tabular-nums">{count}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                  </Collapsible.Content>
                </Collapsible.Root>
              ) : null}
            </Collapsible.Content>
          </Collapsible.Root>
        </>
      ) : state.status === 'cancelled' ? (
        <div className="space-y-3">
          <p role="status">{t('Full-text preparation cancelled.')}</p>
          <Button size="sm" onClick={onStart} disabled={pageCount < 1}>
            {t('Prepare full text')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
