import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUpRight,
  Check,
  LoaderCircle,
  RefreshCw,
  Search,
  GalleryHorizontalEnd
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useNoticeCountdown } from '@/components/use-notice-countdown'
import { cn } from '@/lib/utils'
import type { MarketplaceListSnapshot } from '@/stores/navigation-store'
import type { UseCase } from '../../../../shared/use-cases'
import { USE_CASE_BATCH_SIZE } from '../home/use-case-gallery-store'

// Anchor to a case instead of copying pixels between grids with different column counts.
const capturePosition = (
  viewport: HTMLDivElement | null
): Pick<MarketplaceListSnapshot, 'scrollTop' | 'anchor'> => {
  if (!viewport) return { scrollTop: 0 }
  const top = viewport.getBoundingClientRect().top
  const card = Array.from(viewport.querySelectorAll<HTMLElement>('[data-case-slug]')).find(
    (item) => item.getBoundingClientRect().bottom > top
  )
  return {
    scrollTop: viewport.scrollTop,
    anchor: card
      ? { slug: card.dataset.caseSlug!, offset: top - card.getBoundingClientRect().top }
      : undefined
  }
}

const restorePosition = (viewport: HTMLDivElement, snapshot: MarketplaceListSnapshot): void => {
  const card = Array.from(viewport.querySelectorAll<HTMLElement>('[data-case-slug]')).find(
    (item) => item.dataset.caseSlug === snapshot.anchor?.slug
  )
  viewport.scrollTop =
    card && snapshot.anchor
      ? viewport.scrollTop +
        card.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        Math.min(snapshot.anchor.offset, card.getBoundingClientRect().height - 1)
      : snapshot.scrollTop
}

export const UseCaseGalleryList = ({
  items,
  catalogStatus,
  renderCards,
  refreshing,
  refreshCompletion,
  onResetRefreshCompletion,
  onRefresh,
  onOpenMarketplace,
  onFiltersChange,
  initialState
}: {
  items: UseCase[]
  catalogStatus: 'loading' | 'ready' | 'error'
  renderCards: (items: UseCase[]) => ReactNode
  refreshing: boolean
  refreshCompletion: number | null
  onResetRefreshCompletion: () => void
  onRefresh: () => void
  onOpenMarketplace?: (snapshot: MarketplaceListSnapshot) => void
  onFiltersChange?: (snapshot: MarketplaceListSnapshot) => void
  initialState?: MarketplaceListSnapshot
}): React.JSX.Element => {
  const { t } = useTranslation()
  const compact = Boolean(onOpenMarketplace)
  useNoticeCountdown(
    refreshCompletion === null ? undefined : 2000,
    false,
    onResetRefreshCompletion,
    refreshCompletion
  )
  const [search, setSearch] = useState(initialState?.search ?? '')
  const [category, setCategory] = useState(initialState?.category ?? '')
  const [count, setCount] = useState(initialState?.count ?? USE_CASE_BATCH_SIZE)
  const pendingRestore = useRef(initialState)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const categories = useMemo(
    () =>
      Array.from(
        new Map(
          items
            .filter((item) => item.categoryKey)
            .map((item) => [item.categoryKey!, item.category ?? item.categoryKey!])
        ).entries()
      ),
    [items]
  )
  // A retired category must not keep filtering invisibly or become selected again later.
  const activeCategory =
    (!items.length && catalogStatus === 'loading') || categories.some(([key]) => key === category)
      ? category
      : ''
  if (category !== activeCategory) {
    setCategory(activeCategory)
    setCount(USE_CASE_BATCH_SIZE)
  }
  // Persist changed filters in both layouts, including a category retired by a refresh.
  // Unchanged filters retain the original loaded count and anchor for the return trip.
  useEffect(() => {
    if (
      !initialState ||
      (search === initialState.search && activeCategory === initialState.category)
    )
      return
    onFiltersChange?.({
      search,
      category: activeCategory,
      count: USE_CASE_BATCH_SIZE,
      scrollTop: 0
    })
  }, [search, activeCategory, initialState, onFiltersChange])
  const previousCategory = useRef(activeCategory)
  useEffect(() => {
    if (previousCategory.current !== activeCategory && viewportRef.current)
      viewportRef.current.scrollTop = 0
    previousCategory.current = activeCategory
  }, [activeCategory])
  // Restore once after cards exist; later refreshes and user scrolling remain locally owned.
  useLayoutEffect(() => {
    if (!pendingRestore.current || (!items.length && catalogStatus === 'loading')) return
    const snapshot = pendingRestore.current
    pendingRestore.current = undefined
    if (viewportRef.current && snapshot.category === activeCategory)
      restorePosition(viewportRef.current, snapshot)
  }, [items, catalogStatus, activeCategory])
  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (!activeCategory || item.categoryKey === activeCategory) &&
          `${item.title} ${item.category ?? ''}`
            .toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase())
      ),
    [items, search, activeCategory]
  )

  // Observe the committed boundary and append a single batch per intersection.
  useEffect(() => {
    if (!sentinel || count >= filtered.length) return
    let active = true
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return
        active = false
        observer.disconnect()
        setCount((value) => Math.min(value + USE_CASE_BATCH_SIZE, filtered.length))
      },
      { root: viewportRef.current, rootMargin: '0px 0px 24px 0px' }
    )
    observer.observe(sentinel)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [sentinel, count, filtered])
  const resetList = (): void => {
    pendingRestore.current = undefined
    setCount(USE_CASE_BATCH_SIZE)
    if (viewportRef.current) viewportRef.current.scrollTop = 0
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <header
        className={cn('shrink-0', compact ? 'border-b border-border' : 'px-4 pb-3 pt-6 sm:px-6')}
      >
        <div
          className={cn(
            compact ? 'flex flex-col' : 'flex flex-wrap items-center justify-between gap-4'
          )}
        >
          <div
            className={cn(
              'min-w-0',
              compact ? 'flex h-12 items-center justify-between gap-2 px-4' : 'flex-1'
            )}
          >
            <h2
              className={cn(
                'flex min-w-0 items-center gap-2 font-semibold text-text-000',
                compact ? 'text-sm' : 'text-xl tracking-tight @min-[640px]:text-2xl'
              )}
            >
              <GalleryHorizontalEnd
                className={cn('shrink-0', compact ? 'size-4 text-muted-foreground' : 'size-5')}
                aria-hidden="true"
              />
              {compact ? (
                <Select defaultValue="use-cases">
                  <SelectTrigger
                    aria-label={t('Resource type')}
                    className="-ml-1 h-8 w-auto min-w-0 gap-1 border-transparent bg-transparent px-1 font-semibold"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem value="use-cases">{t('Case library')}</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                t('Case library')
              )}
            </h2>
            {onOpenMarketplace ? (
              <Button
                size="xs"
                onClick={() =>
                  onOpenMarketplace({
                    search,
                    category: activeCategory,
                    count,
                    ...capturePosition(viewportRef.current)
                  })
                }
                aria-label={t('View in case library')}
                title={t('View in case library')}
              >
                {t('View in case library')}
                <ArrowUpRight aria-hidden="true" />
              </Button>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Discover shared research examples and import them to start your own work.')}
              </p>
            )}
          </div>
          <div
            className={cn(
              'flex items-center gap-2',
              compact ? 'mx-4 mb-2' : 'w-full @min-[640px]:w-auto'
            )}
          >
            <div className={cn('relative min-w-0 flex-1', !compact && '@min-[640px]:w-64')}>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-200"
                aria-hidden="true"
              />
              <Input
                className={cn('pl-9', compact ? 'h-8 text-xs' : 'bg-bg-200')}
                aria-label={t('Search examples')}
                placeholder={t('Search examples')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  resetList()
                }}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={t('Refresh examples')}
              title={t('Refresh examples')}
              aria-busy={refreshing}
              disabled={refreshing}
              onClick={onRefresh}
            >
              {refreshCompletion !== null && !refreshing ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <RefreshCw
                  className={cn(
                    'size-4',
                    refreshing &&
                      'animate-spin [animation-duration:600ms] motion-reduce:animate-none'
                  )}
                  aria-hidden="true"
                />
              )}
            </Button>
          </div>
        </div>
        {/* Keep categories discoverable without taking vertical space from the case list. */}
        <div
          role="group"
          aria-label={t('Category')}
          className={cn('flex overflow-x-auto', compact ? 'gap-x-5 px-4' : 'mt-6 gap-2 pb-1')}
        >
          {[['', t('All categories')], ...categories].map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={activeCategory === key}
              className={cn(
                'shrink-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                compact
                  ? 'h-9 border-b-2 border-transparent text-xs hover:text-foreground'
                  : 'rounded-md px-3 py-1.5 text-sm',
                activeCategory === key
                  ? compact
                    ? 'border-primary font-medium text-foreground'
                    : 'bg-bg-300 font-medium text-text-000'
                  : compact
                    ? 'text-muted-foreground'
                    : 'text-text-200 hover:bg-bg-200 hover:text-text-000'
              )}
              onClick={() => {
                setCategory(key)
                resetList()
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div
        ref={viewportRef}
        className={cn('min-h-0 flex-1 overflow-y-auto p-4', !compact && 'sm:p-6')}
        data-use-case-browser-scroll
      >
        {/* Keep sparse search results at the same card width as a full row, including narrow panels. */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-5">
          {renderCards(filtered.slice(0, count))}
        </div>
        {!items.length && catalogStatus === 'loading' ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 py-16 text-sm text-text-200"
          >
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t('Loading examples…')}
          </div>
        ) : !items.length && catalogStatus === 'error' ? (
          <div className="py-12">
            <ErrorNotice
              inline
              role="alert"
              tone="amber"
              description={t('Could not load examples. Try again.')}
              primaryButton={{ label: t('Try again'), onClick: onRefresh, loading: refreshing }}
            />
          </div>
        ) : !items.length ? (
          <p className="py-16 text-center text-sm text-text-200">
            {t('No examples available yet.')}
          </p>
        ) : (
          !filtered.length && (
            <p className="py-16 text-center text-sm text-text-200">{t('No matching examples')}</p>
          )
        )}
        {count < filtered.length && <div ref={setSentinel} aria-hidden="true" className="h-px" />}
      </div>
    </div>
  )
}
