import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  GalleryHorizontalEnd,
  ArrowUpRight,
  Check,
  LoaderCircle,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { ORG_CASE_MAX_QUERY_LENGTH } from '../../../../shared/org-cases'
import { UseCaseSourceToggle } from '../home/OrgCaseCard'
import { OrgCaseSectionContent } from '../home/OrgCaseSectionContent'
import {
  useOrgCaseSearchActions,
  useOrgCaseStore,
  type UseCaseSourceKind
} from '@/stores/org-cases-store'
import { ResourceCatalogHeader, ResourceCatalogToolbar } from './ResourceCenterModeTabs'
import { useNoticeCountdown } from '@/components/use-notice-countdown'
import { cn } from '@/lib/utils'
import { sessionPackageImportAvailable } from '@/lib/session-package-capabilities'
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
  source,
  onChangeSource,
  onOpenOrgCase,
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
  source: UseCaseSourceKind
  onChangeSource?: (source: UseCaseSourceKind) => void
  onOpenOrgCase?: (caseId: string, opener?: HTMLElement | null) => void
  onOpenMarketplace?: (snapshot: MarketplaceListSnapshot) => void
  onFiltersChange?: (snapshot: MarketplaceListSnapshot) => void
  initialState?: MarketplaceListSnapshot
}): React.JSX.Element => {
  const { t } = useTranslation()
  const orgLoading = useOrgCaseStore((state) => state.loading)
  const {
    query: orgQuery,
    setQuery: setOrgQuery,
    submitSearch: submitOrgSearch,
    refresh: refreshOrg
  } = useOrgCaseSearchActions(source === 'organization')
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

  const openMarketplaceAction = onOpenMarketplace ? (
    <Button
      variant="outline"
      size="sm"
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
      <ArrowUpRight aria-hidden="true" />
      {t('View in case library')}
    </Button>
  ) : undefined

  return (
    <div
      className="@container flex min-h-0 flex-1 flex-col"
      role="region"
      aria-label={t('Use Cases')}
      aria-description={t(
        'Discover shared research examples and import them to start your own work.'
      )}
    >
      <div className="shrink-0">
        <ResourceCatalogHeader
          className="static m-0"
          icon={GalleryHorizontalEnd}
          title={t('Use Cases')}
          actions={
            onChangeSource ? (
              <div className="flex flex-wrap items-center gap-2">
                <UseCaseSourceToggle source={source} onChange={onChangeSource} />
                {openMarketplaceAction}
              </div>
            ) : (
              openMarketplaceAction
            )
          }
          toolbar={
            source === 'organization' ? (
              <ResourceCatalogToolbar
                search={
                  <div className="relative min-w-0">
                    <Search
                      className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      className="h-8 pl-8 pr-8"
                      maxLength={ORG_CASE_MAX_QUERY_LENGTH}
                      aria-label={t('Search organization cases')}
                      placeholder={t('Search by name or share code')}
                      value={orgQuery}
                      onChange={(event) => setOrgQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          submitOrgSearch()
                        }
                      }}
                    />
                    {orgQuery ? (
                      <button
                        type="button"
                        aria-label={t('Clear search')}
                        onClick={() => submitOrgSearch('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                }
                trailing={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={t('Refresh organization cases')}
                    title={t('Refresh organization cases')}
                    aria-busy={orgLoading}
                    disabled={orgLoading}
                    onClick={refreshOrg}
                  >
                    <RefreshCw
                      className={cn(
                        'size-4',
                        orgLoading &&
                          'animate-spin [animation-duration:600ms] motion-reduce:animate-none'
                      )}
                      aria-hidden="true"
                    />
                  </Button>
                }
              />
            ) : (
              <ResourceCatalogToolbar
                search={
                  <div className="relative min-w-0">
                    <Search
                      className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      className="h-8 pl-8"
                      aria-label={t('Search examples')}
                      placeholder={t('Search examples')}
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value)
                        resetList()
                      }}
                    />
                  </div>
                }
                trailing={
                  <Button
                    variant="outline"
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
                }
              />
            )
          }
        />
        {source === 'official' ? (
          /* Keep categories discoverable without taking vertical space from the case list. */
          <div
            role="group"
            aria-label={t('Category')}
            className="flex gap-2 overflow-x-auto px-5 pt-4"
          >
            {[['', t('All categories')], ...categories].map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={activeCategory === key}
                className={cn(
                  'shrink-0 cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  activeCategory === key
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
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
        ) : null}
      </div>
      <div
        ref={viewportRef}
        className={cn('min-h-0 flex-1 overflow-y-auto p-4', !compact && 'p-5')}
        data-use-case-browser-scroll
      >
        {source === 'organization' ? (
          <OrgCaseSectionContent
            variant="marketplace"
            showInlineToolbar={false}
            importDisabled={!sessionPackageImportAvailable()}
            onOpenDetails={(caseId, opener) => onOpenOrgCase?.(caseId, opener)}
          />
        ) : (
          <>
            {/* Keep sparse search results at the same card width as a full row, including narrow panels. */}
            <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
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
                <p className="py-16 text-center text-sm text-text-200">
                  {t('No matching examples')}
                </p>
              )
            )}
            {count < filtered.length && (
              <div ref={setSentinel} aria-hidden="true" className="h-px" />
            )}
          </>
        )}
      </div>
    </div>
  )
}
