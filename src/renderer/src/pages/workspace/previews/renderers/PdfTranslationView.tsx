/* Hallmark · component: translation reading · theme: existing Open-Science tokens */
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfTranslationLayoutFailure } from '../../../../../../shared/pdf-translation'
import { PdfTranslatedPage } from './PdfTranslatedPage'
import { Collapsible } from 'radix-ui'
import {
  Check,
  TriangleAlert,
  ListFilter,
  ChevronRight,
  Copy,
  LocateFixed,
  Search,
  RotateCw,
  Languages,
  LoaderCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  memo,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  isCurrentTranslation,
  type PdfTranslation,
  type PdfTranslationUnit
} from './pdf-translation'

const TranslationParagraph = memo(function TranslationParagraph({
  unit,
  fontScale,
  scrollable = false,
  showSelectAction = true
}: {
  unit: PdfTranslationUnit
  fontScale?: number
  scrollable?: boolean
  showSelectAction?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const paragraphRef = useRef<HTMLParagraphElement>(null)
  return (
    <>
      <p
        ref={paragraphRef}
        data-translation-text
        tabIndex={scrollable ? 0 : -1}
        dir="auto"
        style={
          fontScale === undefined
            ? undefined
            : { fontSize: `calc(var(--text-sm) * ${fontScale})`, lineHeight: 2 }
        }
        className={cn(
          'whitespace-pre-wrap break-words text-sm leading-7 outline-none focus-visible:ring-2 focus-visible:ring-ring',
          scrollable &&
            'max-h-60 overflow-y-auto overscroll-contain pr-2 leading-6 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border'
        )}
      >
        {unit.translation || (unit.translationFailed ? unit.source : t('Translation unavailable'))}
      </p>
      {showSelectAction ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto whitespace-nowrap px-1 py-1 text-xs"
          disabled={!isCurrentTranslation(unit)}
          onClick={() => {
            const paragraph = paragraphRef.current
            if (!paragraph) return
            paragraph.focus({ preventScroll: true })
            const selection = paragraph.ownerDocument.getSelection()
            const range = paragraph.ownerDocument.createRange()
            range.selectNodeContents(paragraph)
            selection?.removeAllRanges()
            selection?.addRange(range)
          }}
        >
          {t('Select full paragraph')}
        </Button>
      ) : null}
    </>
  )
})

function TranslationFailureDetails({
  unit
}: {
  unit: PdfTranslationUnit
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const failure = unit.failure
  if (!failure) return null
  const descriptions: Record<typeof failure.reasonCode, string> = {
    'missing-numeric-literals': t('The translation changed or omitted numeric values.'),
    'unexpected-numeric-literals': t('The translation changed or omitted numeric values.'),
    'changed-numeric-sign': t('The translation changed or omitted numeric values.'),
    'changed-numeric-unit': t(
      'The translation changed or omitted units associated with numeric values.'
    ),
    'missing-citation-identities': t('The translation changed or omitted citations.'),
    'missing-math-identifiers': t('The translation changed mathematical notation.'),
    'reordered-inline-math': t('The translation changed mathematical notation.'),
    'math-markup': t('The translation changed mathematical notation.'),
    'missing-proper-name': t('The translation changed a proper name.'),
    'changed-label-meaning': t('The translation changed the meaning of a label.'),
    'untranslated-output': t('The model returned untranslated text.'),
    'commentary-output': t('The model included commentary or text from another passage.'),
    'context-leakage': t('The model included commentary or text from another passage.'),
    'incomplete-output': t('The model returned an incomplete translation.'),
    timeout: t(
      'The model took too long to respond. Completed paragraphs are kept; retry the remaining text.'
    ),
    'provider-failed': t(
      'Completed paragraphs are kept. Check the model connection in Settings, then retry.'
    ),
    skipped: t('This paragraph was skipped.')
  }
  return (
    <div className="space-y-1 text-xs" data-translation-failure>
      <p>{descriptions[failure.reasonCode]}</p>
      <p>{t('Translation attempts: {{attempts}}', { attempts: failure.attempts })}</p>
    </div>
  )
}

function LayoutFailureDetails({
  failure
}: {
  failure: PdfTranslationLayoutFailure
}): React.JSX.Element {
  const { t } = useTranslation()
  const descriptions: Record<PdfTranslationLayoutFailure['code'], string> = {
    'unsupported-layout': t(
      'This layout could not be preserved safely. The text translation is still available.'
    ),
    annotations: t('This PDF contains links or annotations that cannot yet be preserved safely.'),
    'multi-region': t('A paragraph spans multiple regions. PDF placement is not yet supported.'),
    font: t('The translated text needs unsupported glyphs or text shaping.'),
    overflow: t('The translated text does not fit its original region.'),
    'source-mismatch': t('The source text could not be matched safely to PDF objects.'),
    timeout: t('PDF generation timed out. You can retry using the existing translations.'),
    'worker-failed': t(
      'PDF generation stopped unexpectedly. You can retry using the existing translations.'
    ),
    'validation-failed': t(
      'The generated PDF did not pass verification. The text translation is still available.'
    )
  }
  return (
    <p className="text-xs" data-layout-failure>
      {descriptions[failure.code]}
    </p>
  )
}

export const PdfTranslationSidebar = memo(function PdfTranslationSidebar({
  translation,
  retainedUnitIds,
  unfilledUnitIds,
  layoutFailures,
  unchangedLayoutUnitIds,
  onRetryUnit,
  onRetryLayout,
  layoutBusy = false,
  layoutPending = false,
  retryingUnitId,
  retryDisabled = false,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  onCollapse,
  collapsed = false,
  onReviewOpenChange,
  searchOpen: controlledSearchOpen,
  onSearchOpenChange
}: {
  translation: PdfTranslation
  retainedUnitIds?: readonly string[]
  unfilledUnitIds?: readonly string[]
  layoutFailures?: Readonly<Record<string, PdfTranslationLayoutFailure>>
  unchangedLayoutUnitIds?: readonly string[]
  onRetryUnit?: (unitId: string) => void
  onRetryLayout?: (unitId: string) => void
  layoutBusy?: boolean
  layoutPending?: boolean
  retryingUnitId?: string
  retryDisabled?: boolean
  query: string
  onQueryChange: (query: string) => void
  selectedId?: string
  onSelect: (unit: PdfTranslationUnit, fragmentIndex: number) => void
  onCollapse: () => void
  collapsed?: boolean
  onReviewOpenChange?: (open: boolean) => void
  searchOpen?: boolean
  onSearchOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const detailsId = useId()
  const selectedRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [copiedId, setCopiedId] = useState<string>()
  const [filter, setFilter] = useState<'all' | 'issues' | 'translated' | 'failed' | 'unfilled'>(
    'all'
  )
  const [localSearchOpen, setLocalSearchOpen] = useState(Boolean(query.trim()))
  const searchOpen = controlledSearchOpen ?? localSearchOpen
  const [reviewOpen, setReviewOpen] = useState(!collapsed || Boolean(query.trim() || selectedId))
  const [reviewContext, setReviewContext] = useState({ collapsed, selectedId, query })
  if (
    reviewContext.collapsed !== collapsed ||
    reviewContext.selectedId !== selectedId ||
    reviewContext.query !== query
  ) {
    setReviewContext({ collapsed, selectedId, query })
    if (!collapsed || query.trim() || (selectedId && selectedId !== reviewContext.selectedId))
      setReviewOpen(true)
    else if (collapsed && !reviewContext.collapsed && !selectedId) setReviewOpen(false)
  }
  useEffect(() => {
    onReviewOpenChange?.(reviewOpen)
  }, [onReviewOpenChange, reviewOpen])
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])
  useEffect(() => {
    if (query.trim()) onSearchOpenChange?.(true)
  }, [onSearchOpenChange, query])
  useLayoutEffect(() => {
    if (searchOpen) searchInputRef.current?.focus({ preventScroll: true })
  }, [searchOpen])
  const updateSearchOpen = (open: boolean): void => {
    onSearchOpenChange?.(open)
    if (!onSearchOpenChange) setLocalSearchOpen(open)
  }
  const toggleSearch = (): void => {
    if (searchOpen) {
      updateSearchOpen(false)
      if (query) onQueryChange('')
      return
    }
    updateSearchOpen(true)
    setReviewOpen(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }
  const copyTranslation = async (unit: PdfTranslationUnit): Promise<void> => {
    const value = isCurrentTranslation(unit) ? unit.translation : unit.source
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(unit.id)
      window.setTimeout(
        () => setCopiedId((current) => (current === unit.id ? undefined : current)),
        1500
      )
    } catch {
      // Clipboard access can be unavailable in restricted preview contexts.
    }
  }
  const paragraphNumbers = useMemo(
    () =>
      new Map(translation.units.map((unit, index) => [unit.id, unit.paragraphNumber ?? index + 1])),
    [translation.units]
  )
  const retainedIds = useMemo(() => new Set(retainedUnitIds ?? []), [retainedUnitIds])
  const unfilledIds = useMemo(
    () => new Set(layoutPending ? [] : (unfilledUnitIds ?? retainedUnitIds ?? [])),
    [layoutPending, unfilledUnitIds, retainedUnitIds]
  )
  const counts = {
    translated: translation.units.filter(isCurrentTranslation).length,
    failed: translation.units.filter((unit) => unit.translationFailed).length,
    unfilled: translation.units.filter(
      (unit) => isCurrentTranslation(unit) && unfilledIds.has(unit.id)
    ).length
  }
  const progressFilters = [
    {
      value: 'translated' as const,
      label: t('Translated'),
      count: counts.translated,
      tip: t('Paragraphs with a text translation.')
    },
    {
      value: 'failed' as const,
      label: t('Failed'),
      count: counts.failed,
      tip: t('Translation failed')
    },
    {
      value: 'unfilled' as const,
      label: t('Not in PDF'),
      count: layoutPending ? undefined : counts.unfilled,
      tip: layoutPending
        ? t('Checking translated PDF…')
        : t('Translated paragraphs not yet shown in the PDF.')
    }
  ]
  const unchangedLayoutIds = useMemo(
    () => new Set(unchangedLayoutUnitIds ?? []),
    [unchangedLayoutUnitIds]
  )
  const deferredQuery = useDeferredValue(query)
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase()
  const units = useMemo(
    () =>
      translation.units.filter(
        (unit) =>
          (filter === 'all' ||
            (filter === 'issues' && (unit.translationFailed || unfilledIds.has(unit.id))) ||
            (filter === 'translated' && isCurrentTranslation(unit)) ||
            (filter === 'failed' && unit.translationFailed) ||
            (filter === 'unfilled' && isCurrentTranslation(unit) && unfilledIds.has(unit.id))) &&
          (!normalizedQuery ||
            ((isCurrentTranslation(unit) || unit.translationFailed) &&
              (isCurrentTranslation(unit) ? unit.translation : unit.source)
                .toLocaleLowerCase()
                .includes(normalizedQuery)))
      ),
    [normalizedQuery, filter, unfilledIds, translation.units]
  )
  return (
    <TooltipProvider delayDuration={100} skipDelayDuration={300}>
      <div className="shrink-0 border-t border-border" data-state={reviewOpen ? 'open' : 'closed'}>
        <div
          className="sticky top-0 z-10 border-b border-border bg-background"
          data-translation-review-header
        >
          <div className="flex items-center gap-1 px-5">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={reviewOpen}
              className="group min-h-10 min-w-0 flex-1 justify-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/50 aria-expanded:bg-muted/50"
              onClick={() => setReviewOpen((open) => !open)}
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  'size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                  reviewOpen && 'rotate-90'
                )}
              />
              <span className="min-w-0 flex-1 truncate">{t('Translation')}</span>
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                {filter !== 'all'
                  ? `${units.length} / ${translation.units.length}`
                  : translation.units.length}
              </span>
            </Button>
            {translation.units.some((unit) => unit.translationFailed) ? (
              <span
                role="img"
                aria-label={t('Translation failed')}
                className="inline-flex items-center gap-1 text-xs text-status-warning-foreground"
              >
                <TriangleAlert aria-hidden="true" className="size-3.5" />
                {translation.units.filter((unit) => unit.translationFailed).length}
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={searchOpen ? t('Close search') : t('Search translation')}
                  aria-pressed={searchOpen}
                  className="size-8 shrink-0 hover:bg-muted/50 aria-pressed:bg-muted/50"
                  onClick={toggleSearch}
                >
                  <Search aria-hidden="true" className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="z-[120]">
                {searchOpen ? t('Close search') : t('Search translation')}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  asChild
                  onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Filter translations')}
                      aria-pressed={filter !== 'all'}
                      className="size-8 shrink-0 hover:bg-muted/50 aria-pressed:bg-primary/10 aria-pressed:text-primary"
                    >
                      <ListFilter aria-hidden="true" className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent className="z-[120]">{t('Filter translations')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                side="bottom"
                align="end"
                className="z-[120] w-max max-w-64"
                onEscapeKeyDown={(event) => event.stopPropagation()}
              >
                {[
                  { value: 'all' as const, label: t('All') },
                  { value: 'issues' as const, label: t('Translation issues') },
                  ...progressFilters
                ].map(({ value, label }) => (
                  <DropdownMenuCheckboxItem
                    key={value}
                    checked={filter === value}
                    aria-disabled={value === 'unfilled' && layoutPending}
                    title={
                      value === 'unfilled' && layoutPending
                        ? t('Checking translated PDF…')
                        : undefined
                    }
                    onCheckedChange={() => {
                      if (value === 'unfilled' && layoutPending) return
                      setFilter((current) => (current === value ? 'all' : value))
                      setReviewOpen(true)
                    }}
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div
            role="group"
            aria-label={t('Translation progress')}
            className="grid grid-cols-3 gap-1 px-5 pb-2"
          >
            {progressFilters.map(({ value, label, count, tip }) => (
              <Tooltip key={value}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={filter === value}
                    aria-label={count === undefined ? label : `${count} ${label}`}
                    aria-disabled={count === undefined}
                    className="h-auto min-w-0 flex-col justify-start gap-0.5 px-1 py-1 text-center text-xs font-normal aria-pressed:bg-primary/10 aria-pressed:text-primary"
                    onClick={() => {
                      if (count === undefined) return
                      setFilter((current) => (current === value ? 'all' : value))
                      setReviewOpen(true)
                    }}
                  >
                    <span className="tabular-nums text-sm font-medium">{count ?? '—'}</span>
                    <span className="max-w-full truncate">{label}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="z-[120]">{tip}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
        {reviewOpen ? (
          <div className="space-y-2 px-5 pb-3 pt-2">
            {searchOpen ? (
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t('Search translation')}
                <Input
                  ref={searchInputRef}
                  data-translation-search
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                  className="min-w-0 rounded-md border border-input bg-background px-2 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
            ) : null}
            <p className="text-xs leading-5 text-muted-foreground">{t('Click to locate')}</p>
            <div className="space-y-2">
              {units.length === 0 ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('No translation matches')}
                </p>
              ) : (
                units.map((unit) => (
                  <div
                    key={unit.id}
                    data-translation-row={unit.id}
                    ref={selectedId === unit.id ? selectedRef : undefined}
                    data-state={selectedId === unit.id ? 'open' : 'closed'}
                    className={cn(
                      'min-w-0 scroll-mt-24 rounded-lg border border-transparent',
                      selectedId !== unit.id &&
                        '[content-visibility:auto] [contain-intrinsic-size:auto_8rem]',
                      selectedId === unit.id && 'border-primary/40 bg-primary/5'
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-x-1 px-1">
                      <button
                        type="button"
                        aria-pressed={selectedId === unit.id}
                        aria-expanded={selectedId === unit.id}
                        aria-controls={
                          selectedId === unit.id
                            ? `${detailsId}-${encodeURIComponent(unit.id)}`
                            : undefined
                        }
                        data-state={selectedId === unit.id ? 'open' : 'closed'}
                        onClick={() => (selectedId === unit.id ? onCollapse() : onSelect(unit, 0))}
                        className="group min-w-0 flex-1 rounded-md px-1 py-2 text-start text-sm hover:bg-muted focus-visible:outline-ring"
                      >
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <ChevronRight
                            aria-hidden="true"
                            className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                          />
                          <span className="whitespace-nowrap">
                            {t('Page {{page}} · #{{number}}', {
                              page: unit.fragments[0].pageNumber,
                              number: paragraphNumbers.get(unit.id)
                            })}
                            {!isCurrentTranslation(unit) && !unit.translationFailed ? (
                              <span className="whitespace-normal">{` · ${t('Source changed')}`}</span>
                            ) : null}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'mt-1 line-clamp-2 break-words',
                            selectedId === unit.id && 'hidden'
                          )}
                          dir="auto"
                        >
                          {isCurrentTranslation(unit) ? unit.translation : unit.source}
                        </span>
                      </button>
                      {unit.translationFailed ||
                      unfilledIds.has(unit.id) ||
                      layoutFailures?.[unit.id] ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              role="img"
                              tabIndex={0}
                              aria-label={
                                unit.translationFailed
                                  ? t('Translation failed')
                                  : retainedIds.has(unit.id)
                                    ? t('Text kept in original layout')
                                    : t('Not in PDF')
                              }
                              className="inline-flex shrink-0 rounded-sm text-status-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <TriangleAlert aria-hidden="true" className="size-3.5" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="z-[120] max-w-64 space-y-1">
                            {unit.translationFailed ? (
                              <>
                                <p>
                                  {t(
                                    'This passage could not be translated and was skipped. Retry it individually.'
                                  )}
                                </p>
                                <TranslationFailureDetails unit={unit} />
                              </>
                            ) : (
                              <>
                                <p>
                                  {unchangedLayoutIds.has(unit.id)
                                    ? t(
                                        'Retrying did not change this passage. You can read its translation here.'
                                      )
                                    : retainedIds.has(unit.id)
                                      ? t(
                                          'This passage is translated, but its original layout was retained in the PDF.'
                                        )
                                      : t(
                                          'This translation is not yet placed in the PDF. You can read it here.'
                                        )}
                                </p>
                                {layoutFailures?.[unit.id] ? (
                                  <LayoutFailureDetails failure={layoutFailures[unit.id]} />
                                ) : null}
                              </>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      {selectedId === unit.id ? (
                        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-0.5 py-1">
                          {onRetryLayout && unfilledIds.has(unit.id) ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex">
                                  <Button
                                    type="button"
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={
                                      layoutBusy
                                        ? t('Preparing translated PDF…')
                                        : unchangedLayoutIds.has(unit.id)
                                          ? t('Layout unchanged')
                                          : t('Retry PDF layout')
                                    }
                                    disabled={
                                      layoutBusy || retryDisabled || unchangedLayoutIds.has(unit.id)
                                    }
                                    onClick={() => onRetryLayout(unit.id)}
                                  >
                                    {layoutBusy ? (
                                      <LoaderCircle
                                        aria-hidden="true"
                                        className="size-3.5 animate-spin"
                                      />
                                    ) : (
                                      <RotateCw aria-hidden="true" className="size-3.5" />
                                    )}
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="z-[120] max-w-64">
                                <p>
                                  {layoutBusy
                                    ? t('Preparing translated PDF…')
                                    : unchangedLayoutIds.has(unit.id)
                                      ? t('Layout unchanged')
                                      : t('Retry PDF layout')}
                                </p>
                                <p>
                                  {unchangedLayoutIds.has(unit.id)
                                    ? t(
                                        'Retrying did not change this passage. You can read its translation here.'
                                      )
                                    : t(
                                        'Rebuild the PDF using saved translations, without calling the model.'
                                      )}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                          {onRetryUnit && (isCurrentTranslation(unit) || unit.translationFailed) ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex">
                                  <Button
                                    type="button"
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={
                                      retryingUnitId === unit.id
                                        ? t('Translating paragraph…')
                                        : t('Retranslate this paragraph')
                                    }
                                    disabled={retryDisabled || layoutBusy}
                                    onClick={() => onRetryUnit(unit.id)}
                                  >
                                    {retryingUnitId === unit.id ? (
                                      <LoaderCircle
                                        aria-hidden="true"
                                        className="size-3.5 animate-spin"
                                      />
                                    ) : (
                                      <Languages aria-hidden="true" className="size-3.5" />
                                    )}
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="z-[120] max-w-64">
                                {retryingUnitId === unit.id
                                  ? t('Translating paragraph…')
                                  : t('Retranslate this paragraph')}
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={copiedId === unit.id ? t('Copied') : t('Copy')}
                                onClick={() => void copyTranslation(unit)}
                              >
                                {copiedId === unit.id ? (
                                  <Check aria-hidden="true" className="size-3.5" />
                                ) : (
                                  <Copy aria-hidden="true" className="size-3.5" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="z-[120]">
                              {copiedId === unit.id ? t('Copied') : t('Copy')}
                            </TooltipContent>
                          </Tooltip>
                          {Array.from(
                            new Map(
                              unit.fragments.map((fragment, index) => [
                                fragment.pageNumber,
                                { fragment, index }
                              ])
                            ).values()
                          ).map(({ fragment, index }) => {
                            const label = t('Locate paragraph on page {{page}}', {
                              page: fragment.pageNumber
                            })
                            return (
                              <Tooltip key={`${fragment.pageNumber}-${index}`}>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={label}
                                    onClick={() => onSelect(unit, index)}
                                  >
                                    <LocateFixed aria-hidden="true" className="size-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent className="z-[120]">{label}</TooltipContent>
                              </Tooltip>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                    {selectedId === unit.id ? (
                      <div
                        id={`${detailsId}-${encodeURIComponent(unit.id)}`}
                        className="overflow-hidden"
                      >
                        <div className="space-y-2 border-t border-primary/15 px-3 py-3">
                          {!isCurrentTranslation(unit) && !unit.translationFailed ? (
                            <p className="text-xs text-status-warning-foreground">
                              {t('Source changed. This translation is for review only.')}
                            </p>
                          ) : null}
                          <TranslationParagraph unit={unit} scrollable showSelectAction={false} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  )
})

export function PdfTranslationHighlight({
  unit,
  pageNumber
}: {
  unit?: PdfTranslationUnit
  pageNumber: number
}): React.JSX.Element | null {
  if (!unit) return null
  return (
    <>
      {unit.fragments.map((fragment, fragmentIndex) =>
        fragment.pageNumber === pageNumber ? (
          <span
            key={fragmentIndex}
            aria-hidden="true"
            data-translation-highlight
            data-translation-source={unit.id}
            data-translation-fragment={fragmentIndex}
            className="pointer-events-none absolute z-10 border-2 border-primary bg-primary/5"
            style={{
              left: fragment.rect.x * 100 + '%',
              top: fragment.rect.y * 100 + '%',
              width: fragment.rect.width * 100 + '%',
              height: fragment.rect.height * 100 + '%'
            }}
          />
        ) : null
      )}
    </>
  )
}

export const PdfTranslationMarkers = memo(function PdfTranslationMarkers({
  units,
  visibleUnitIds,
  firstFragmentPerPage = false,
  pageNumber,
  selectedId,
  onSelect
}: {
  units: readonly PdfTranslationUnit[]
  visibleUnitIds?: readonly string[]
  firstFragmentPerPage?: boolean
  pageNumber: number
  selectedId?: string
  onSelect: (unit: PdfTranslationUnit, fragmentIndex: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const markers = useMemo(
    () =>
      units.flatMap((unit, unitIndex) =>
        unit.fragments.flatMap((fragment, fragmentIndex) => {
          if (
            (visibleUnitIds && !visibleUnitIds.includes(unit.id)) ||
            fragment.pageNumber !== pageNumber ||
            (firstFragmentPerPage &&
              unit.fragments.findIndex((candidate) => candidate.pageNumber === pageNumber) !==
                fragmentIndex)
          )
            return []
          const { rect } = fragment
          return [
            <button
              key={`${unit.id}:${fragmentIndex}`}
              data-translation-source={unit.id}
              data-translation-fragment={fragmentIndex}
              type="button"
              aria-label={t('Read paragraph {{number}} translation', {
                number: unit.paragraphNumber ?? unitIndex + 1
              })}
              aria-pressed={selectedId === unit.id}
              className={cn(
                'pointer-events-auto absolute flex items-center justify-center rounded-sm focus-visible:outline-ring'
              )}
              style={{
                left: `max(0px, calc(${rect.x * 100}% - 26px))`,
                top: `${rect.y * 100}%`,
                width: '24px',
                height: '24px'
              }}
              onClick={() => onSelect(unit, fragmentIndex)}
            >
              <span
                className={cn(
                  'min-w-4 rounded border border-border bg-background px-1 text-center text-[10px] leading-4 text-foreground shadow-sm hover:bg-muted',
                  selectedId === unit.id &&
                    'border-primary bg-primary/10 text-primary ring-1 ring-primary'
                )}
              >
                {unit.paragraphNumber ?? unitIndex + 1}
              </span>
            </button>
          ]
        })
      ),
    [firstFragmentPerPage, onSelect, pageNumber, selectedId, t, units, visibleUnitIds]
  )
  return <div className="pointer-events-none absolute inset-0 z-20">{markers}</div>
})

export function PdfTranslationView({
  document,
  registerDisposer,
  page,
  textOnly = false,
  includeContinuations = textOnly,
  fontScale,
  pageNumber,
  translation,
  selectedId,
  onSelect
}: {
  document?: PDFDocumentProxy
  registerDisposer?: (dispose: () => void) => () => void
  page?: ReactNode
  textOnly?: boolean
  includeContinuations?: boolean
  fontScale?: number
  pageNumber: number
  translation: PdfTranslation
  selectedId?: string
  onSelect: (unit: PdfTranslationUnit, fragmentIndex: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const units = useMemo(
    () =>
      translation.units.filter((unit) =>
        includeContinuations
          ? unit.fragments.some((fragment) => fragment.pageNumber === pageNumber)
          : unit.fragments[0].pageNumber === pageNumber
      ),
    [includeContinuations, pageNumber, translation.units]
  )
  return (
    <section
      className="min-w-0"
      aria-label={textOnly ? undefined : t('Translation')}
      data-pdf-translation-pane
    >
      {!textOnly ? (
        <div className="relative">
          {document && registerDisposer ? (
            <PdfTranslatedPage
              document={document}
              pageNumber={pageNumber}
              translation={translation}
              fallback={page}
              registerDisposer={registerDisposer}
            />
          ) : (
            page
          )}
          <PdfTranslationMarkers
            units={translation.units}
            pageNumber={pageNumber}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </div>
      ) : null}
      <div className="space-y-3 border border-border bg-background p-4 text-foreground">
        <p className="text-xs text-muted-foreground">
          {t('Full paragraphs linked to the original page')}
        </p>
        {units.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('No translated paragraphs start on this page.')}
          </p>
        ) : (
          units.map((unit) => (
            <article
              key={unit.id}
              data-translation-unit={unit.id}
              tabIndex={-1}
              className={cn(
                'space-y-2 rounded-md border border-border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selectedId === unit.id && 'border-primary'
              )}
            >
              {!isCurrentTranslation(unit) ? (
                <p role="status" className="text-xs text-status-warning-foreground">
                  {unit.translationFailed
                    ? t(
                        'This passage could not be translated and was skipped. Retry it individually.'
                      )
                    : t('Source changed. This translation is for review only.')}
                </p>
              ) : null}
              {unit.translationFailed ? <TranslationFailureDetails unit={unit} /> : null}
              <TranslationParagraph unit={unit} fontScale={fontScale} />
              <Collapsible.Root className="text-xs text-muted-foreground">
                <Collapsible.Trigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="group h-auto gap-1 px-0 py-1 text-xs"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                    />
                    {t('Original text')}
                  </Button>
                </Collapsible.Trigger>
                <Collapsible.Content>
                  <p dir="auto" className="mt-2 whitespace-pre-wrap break-words leading-6">
                    {unit.source}
                  </p>
                  {!isCurrentTranslation(unit) &&
                  !unit.translationFailed &&
                  unit.translationSource ? (
                    <>
                      <p className="mt-2 font-medium">{t('Source used for translation')}</p>
                      <p dir="auto" className="whitespace-pre-wrap break-words leading-6">
                        {unit.translationSource}
                      </p>
                    </>
                  ) : null}
                </Collapsible.Content>
              </Collapsible.Root>
              <div className="flex flex-wrap gap-1">
                {unit.fragments.map((fragment, index) => (
                  <Button
                    key={index}
                    size="sm"
                    variant="ghost"
                    className="h-auto whitespace-nowrap px-2 py-1 text-xs"
                    onClick={() => onSelect(unit, index)}
                  >
                    {t('Source: page {{page}}, fragment {{number}}', {
                      page: fragment.pageNumber,
                      number: index + 1
                    })}
                  </Button>
                ))}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  )
}
