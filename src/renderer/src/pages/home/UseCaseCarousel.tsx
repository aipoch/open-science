import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  ChevronRight,
  Download,
  GalleryHorizontalEnd,
  LoaderCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { importSessionPackage } from '@/lib/session-package-import'
import { sessionPackageImportAvailable } from '@/lib/session-package-capabilities'
import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import { UseCaseIntroductionLoader } from './use-case-introduction-loader'
import { UseCaseCover } from './UseCaseCover'
import { UseCaseDetailsDialog } from './UseCaseDetailsDialog'
import { UseCaseGalleryList } from '../marketplace/UseCaseGalleryList'
import { UseCaseDetailsPage } from '../marketplace/UseCaseDetailsPage'
import { useNavigationStore, type MarketplaceListSnapshot } from '@/stores/navigation-store'
import { useUseCaseGalleryStore } from './use-case-gallery-store'
import type { UseCase } from '../../../../shared/use-cases'

export const UseCaseCarousel = ({
  sectionRef,
  variant = 'home',
  compact = false
}: {
  sectionRef?: (element: HTMLElement | null) => void
  variant?: 'home' | 'marketplace'
  compact?: boolean
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const headingId = useId()
  const projectId = useNavigationStore((state) => state.activeProjectId)
  const initialListState = useNavigationStore((state) =>
    state.marketplaceListContext?.projectId === state.activeProjectId
      ? state.marketplaceListContext?.list
      : undefined
  )
  // Capture the owning Project so a late list update cannot overwrite a different Project.
  const updateListFilters = useCallback(
    (snapshot: MarketplaceListSnapshot): void => {
      if (projectId) useNavigationStore.getState().updateMarketplaceList(projectId, snapshot)
    },
    [projectId]
  )
  const [introductions] = useState(() => new UseCaseIntroductionLoader())
  useEffect(() => () => introductions.cancelPrefetch(), [introductions])
  const openMarketplace = (): void => {
    setBrowser(null)
    useNavigationStore.getState().openMarketplace('user')
  }
  const [browser, setBrowser] = useState<{ slug: string; opener: HTMLElement } | null>(null)
  const { items, slugs, receive, loadMore, refreshRevision } = useUseCaseGalleryStore()
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  // Every mounted gallery rechecks its warm renderer cache after the native refresh completes.
  useEffect(() => {
    if (refreshRevision)
      void introductions.refreshCached(useUseCaseGalleryStore.getState().items ?? [])
  }, [introductions, refreshRevision])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshCompletion, setRefreshCompletion] = useState<number | null>(null)
  const refreshInFlight = useRef(false)
  const catalogRevision = useRef(0)
  const refreshCatalog = async (): Promise<void> => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    catalogRevision.current++
    setRefreshing(true)
    setRefreshCompletion(null)
    useUseCaseGalleryStore.getState().retryFailedCovers()
    if (!useUseCaseGalleryStore.getState().items?.length) setCatalogStatus('loading')
    try {
      receive(await window.api.sessions.useCaseCatalog('reload'), true)
      setCatalogStatus('ready')
    } catch {
      // A failed request leaves the current catalog intact.
      setCatalogStatus('error')
    } finally {
      setRefreshCompletion(catalogRevision.current)
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState<string>()
  const operation = usePackageOperationStore((state) => state.operation)
  const useCaseFailure = usePackageOperationStore((state) => state.useCaseFailure)
  const useCaseSlug = usePackageOperationStore((state) => state.useCaseSlug)
  const operationActive = packageOperationActive(operation)
  const [cancelFailed, setCancelFailed] = useState(false)
  const cancelDownload = async (): Promise<void> => {
    if (!operation?.useCaseDownload) return
    setCancelFailed(false)
    try {
      await window.api.sessions.packageOperation({ action: 'cancel', operationId: operation.id })
    } catch {
      setCancelFailed(true)
    }
  }

  useEffect(() => {
    let active = true
    const revision = catalogRevision.current
    const load = async (): Promise<void> => {
      try {
        const cached = await window.api.sessions.useCaseCatalog('cached').catch(() => undefined)
        if (
          cached &&
          active &&
          revision === catalogRevision.current &&
          !useUseCaseGalleryStore.getState().items
        )
          receive(cached)
        const refreshed = await window.api.sessions.useCaseCatalog('refreshed')
        if (active && revision === catalogRevision.current) {
          receive(refreshed)
          setCatalogStatus('ready')
        }
      } catch {
        // Keep the cached list when the application transport is temporarily unavailable.
        if (active && revision === catalogRevision.current) setCatalogStatus('error')
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [receive])

  const importExample = async (item: UseCase): Promise<void> => {
    if (pending || operationActive) return
    setCancelFailed(false)
    setPending(item.slug)
    try {
      await importSessionPackage(undefined, { useCase: item.slug })
    } finally {
      setPending(undefined)
    }
  }
  const visible = slugs.flatMap((slug) => {
    const item = items?.find((item) => item.slug === slug)
    return item ? [item] : []
  })
  const homeGridRef = useRef<HTMLDivElement>(null)
  const homeSectionRef = useRef<HTMLElement>(null)
  const homeLastLoadScrollTop = useRef<number | null>(null)
  const homeGalleryOffsetRef = useRef(0)
  const [homeGalleryOffset, setHomeGalleryOffset] = useState(0)
  // Render the complete loaded batch immediately. The one-row viewport below controls what is
  // initially visible without delaying cards or making the first scroll trigger a render.
  const homeVisible = visible
  const visibleKey = visible.map((item) => item.slug).join(',')
  const homeHasMore = variant === 'home' && slugs.length < (items?.length ?? 0)
  const setHomeSectionRef = useCallback(
    (element: HTMLElement | null): void => {
      homeSectionRef.current = element
      sectionRef?.(element)
    },
    [sectionRef]
  )
  const loadHomeMore = useCallback((): void => {
    const scroll = homeGridRef.current?.closest('[data-home-scroll]') as HTMLElement | null
    const scrollTop = scroll?.scrollTop ?? 0
    if (homeLastLoadScrollTop.current === scrollTop) return
    homeLastLoadScrollTop.current = scrollTop
    loadMore()
  }, [loadMore])

  // Keep the first row fully visible and let about half of the next row peek in, so the fold
  // shows that more cases are already loaded below. mt-auto absorbs part of the padding, and the
  // first startup layout can report a short card, so correct the visible error until it settles.
  useLayoutEffect(() => {
    if (variant !== 'home') return
    const grid = homeGridRef.current
    const section = homeSectionRef.current
    const scroll = section?.closest('[data-home-scroll]') as HTMLElement | null
    if (!grid || !section) return
    const applyOffset = (offset: number): void => {
      homeGalleryOffsetRef.current = offset
      section.style.paddingTop = offset ? `${offset}px` : ''
      setHomeGalleryOffset((previousOffset) =>
        previousOffset === offset ? previousOffset : offset
      )
    }
    const alignFirstRow = (): void => {
      if (!scroll || scroll.scrollTop > 0 || scroll.clientHeight <= 0) return
      const cards = [...grid.children].filter(
        (child): child is HTMLElement => child instanceof HTMLElement
      )
      const firstCard = cards[0]
      if (!firstCard) return
      for (let attempt = 0; attempt < 8; attempt++) {
        const firstBounds = firstCard.getBoundingClientRect()
        const secondCard = cards.find(
          (card) => card.getBoundingClientRect().top > firstBounds.top + 1
        )
        const secondBounds = secondCard?.getBoundingClientRect()
        const peek = secondBounds ? Math.round(secondBounds.height / 2) : 0
        const rowGap = secondBounds ? Math.max(0, secondBounds.top - firstBounds.bottom) : 0
        const delta = Math.ceil(
          scroll.getBoundingClientRect().bottom - peek - rowGap - firstBounds.bottom
        )
        if (Math.abs(delta) <= 1) return
        const next = Math.max(0, homeGalleryOffsetRef.current + delta)
        if (next === homeGalleryOffsetRef.current) return
        applyOffset(next)
      }
    }
    let frame = 0
    let framesLeft = 4
    const scheduleAlign = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        alignFirstRow()
        // Startup layout (fonts, flex height, covers) settles over the first few frames.
        if (framesLeft > 0) {
          framesLeft -= 1
          scheduleAlign()
        }
      })
    }
    const realign = (): void => {
      framesLeft = 1
      scheduleAlign()
    }
    const onScroll = (): void => {
      if (!scroll || scroll.scrollTop > 0) return
      realign()
    }
    const observer = new ResizeObserver(realign)
    observer.observe(grid)
    if (scroll) observer.observe(scroll)
    window.addEventListener('resize', realign)
    if (scroll) scroll.addEventListener('scroll', onScroll, { passive: true })
    alignFirstRow()
    scheduleAlign()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', realign)
      if (scroll) scroll.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [variant, visibleKey])

  // Observe the shared homepage viewport so reaching the list end appends one batch. The first
  // batch is already rendered behind the one-row viewport, so this only fetches later batches.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || slugs.length >= (items?.length ?? 0)) return
    let active = true
    const root = sentinel.closest('[data-home-scroll]') as HTMLElement | null
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return
        // The initial one-row viewport can place the sentinel inside a tall, otherwise empty
        // homepage. Wait for an actual page scroll before requesting the next batch.
        if (variant === 'home' && root && root.scrollTop <= 0) return
        active = false
        observer.disconnect()
        if (variant === 'home') loadHomeMore()
        else loadMore()
      },
      { root, rootMargin: '0px 0px 80px 0px' }
    )
    observer.observe(sentinel)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [variant, visibleKey, slugs.length, items?.length, loadMore, loadHomeMore])

  // The overflow-visible gallery keeps its sentinel outside the one-row section box. A scroll
  // boundary check complements IntersectionObserver so a fast wheel or programmatic scroll still
  // appends the next batch reliably.
  useEffect(() => {
    if (variant !== 'home') return
    const scroll = homeGridRef.current?.closest('[data-home-scroll]') as HTMLElement | null
    if (!scroll) return
    const onScroll = (): void => {
      if (
        scroll.scrollTop <= 0 ||
        scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 80
      )
        return
      loadHomeMore()
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    return () => scroll.removeEventListener('scroll', onScroll)
  }, [variant, visibleKey, loadHomeMore])

  const renderImport = (item: UseCase): React.JSX.Element => {
    const download =
      operation?.useCaseDownload?.slug === item.slug ? operation.useCaseDownload : undefined
    const downloading = Boolean(download && operationActive)
    const ownsOperation =
      operation?.kind === 'import' &&
      operationActive &&
      (useCaseSlug === item.slug || pending === item.slug)
    const waiting = ownsOperation && !download && operation?.state === 'awaiting-selection'
    const importing = ownsOperation || downloading || pending === item.slug
    const busy = importing && !waiting
    const percent = download?.totalBytes
      ? Math.min(100, Math.floor((download.completedBytes / download.totalBytes) * 100))
      : undefined
    // Detail imports keep the primary action in place as its label becomes live progress.
    const label = waiting
      ? t('Continue')
      : busy
        ? operation?.state === 'cancelling'
          ? t('Cancelling…')
          : downloading
            ? percent === undefined
              ? t('Preparing download…')
              : percent === 100
                ? t('Verifying download…')
                : t('Downloading {{percent}}%', { percent })
            : t('Importing…')
        : t('Import')
    return (
      <>
        <Button
          variant="default"
          size="lg"
          className="min-w-32 rounded-lg px-4 text-sm hover:bg-[color-mix(in_oklch,var(--primary),black_10%)] aria-busy:disabled:opacity-100"
          aria-busy={busy}
          disabled={
            !waiting && (Boolean(pending) || operationActive || !sessionPackageImportAvailable())
          }
          onClick={() =>
            waiting ? usePackageOperationStore.getState().setOpen(true) : void importExample(item)
          }
        >
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          ) : waiting ? (
            <ChevronRight className="size-3.5" aria-hidden="true" />
          ) : (
            <Download className="size-3.5" aria-hidden="true" />
          )}
          <span aria-live="polite">{label}</span>
        </Button>
        {downloading && (
          <Button
            variant="ghost"
            size="lg"
            className="px-3 text-muted-foreground"
            disabled={operation?.state === 'cancelling'}
            onClick={() => void cancelDownload()}
          >
            {t('Cancel')}
          </Button>
        )}
      </>
    )
  }

  // Share download progress and recovery between the card and its open detail dialog.
  const renderDownloadStatus = (item: UseCase, inline = false): React.JSX.Element => {
    const download =
      operation?.useCaseDownload?.slug === item.slug ? operation.useCaseDownload : undefined
    const downloading = Boolean(download && operationActive)
    const downloadFailed =
      (download && operation?.state === 'failed') || useCaseFailure === item.slug
    const percent = download?.totalBytes
      ? Math.min(100, Math.floor((download.completedBytes / download.totalBytes) * 100))
      : 0
    const progressLabel = download?.totalBytes
      ? percent === 100
        ? t('Verifying download…')
        : t('Downloading {{percent}}%', { percent })
      : t('Preparing download…')
    return (
      <>
        {downloading && !inline && (
          <div
            data-case-download-status="true"
            className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-2 border-t border-border bg-background/95 pr-3 text-xs shadow-sm sm:pr-4"
          >
            <div className="relative flex h-[35px] min-w-0 flex-1 items-center overflow-hidden px-3 sm:px-4">
              <div
                role="progressbar"
                aria-label={t('Example download progress')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={download?.totalBytes ? percent : undefined}
                aria-valuetext={progressLabel}
                className="pointer-events-none absolute inset-0"
              >
                <span
                  style={{ transform: `scaleX(${percent / 100})` }}
                  className="block h-full w-full origin-left bg-primary/25 transition-transform duration-150 ease-linear motion-reduce:transition-none"
                />
              </div>
              <span role="status" className="relative tabular-nums text-text-100">
                {operation?.state === 'cancelling' ? t('Cancelling…') : progressLabel}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-status-warning-foreground hover:bg-status-warning-surface hover:text-status-warning-foreground dark:text-status-warning-dark-foreground dark:hover:bg-status-warning-dark-surface dark:hover:text-status-warning-dark-foreground"
              disabled={operation?.state === 'cancelling'}
              onClick={() => void cancelDownload()}
            >
              {t('Cancel')}
            </Button>
          </div>
        )}
        {(downloadFailed || (downloading && cancelFailed)) && (
          <div
            className={
              inline
                ? 'mt-2'
                : `absolute inset-0 z-10 overflow-auto bg-background/95 p-3 sm:p-4 ${downloading ? 'pb-14' : ''}`
            }
          >
            <ErrorNotice
              inline
              role="alert"
              tone="amber"
              description={
                cancelFailed && downloading
                  ? t('Could not cancel download. Try again.')
                  : t('Could not download this example. Try again.')
              }
              primaryButton={
                downloadFailed
                  ? {
                      label: t('Try again'),
                      disabled: Boolean(pending) || operationActive,
                      onClick: () => void importExample(item)
                    }
                  : undefined
              }
            />
          </div>
        )}
      </>
    )
  }

  const renderCards = (cases: UseCase[]): React.JSX.Element[] =>
    cases.map((item) => {
      return (
        <article
          key={item.slug}
          data-case-slug={item.slug}
          aria-label={item.title}
          onMouseEnter={() => introductions.schedulePrefetch(item)}
          onMouseLeave={() => introductions.cancelPrefetch()}
          onFocusCapture={() => introductions.schedulePrefetch(item)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) introductions.cancelPrefetch()
          }}
          className="group relative min-w-0 overflow-hidden rounded-xl border border-border bg-bg-000 transition-[box-shadow,border-color] duration-300 ease-out hover:border-primary/25 hover:shadow-card-opaque focus-within:border-primary/40 focus-within:shadow-card-opaque motion-reduce:transition-none"
        >
          <button
            type="button"
            aria-label={item.title}
            onClick={(event) => setBrowser({ slug: item.slug, opener: event.currentTarget })}
            className="absolute inset-0 z-10 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
          {/* Home covers stay shorter so the one-row viewport does not dominate the page. */}
          <div
            className={`relative aspect-[16/9] w-full overflow-hidden bg-bg-100 ${variant === 'marketplace' ? 'max-h-50' : 'max-h-40'}`}
          >
            <div className="absolute inset-0 transition-transform duration-300 ease-out group-hover:scale-[1.025] group-focus-within:scale-[1.025] motion-reduce:transform-none motion-reduce:transition-none">
              <UseCaseCover key={item.imageUrl} src={item.imageUrl} />
            </div>
            {renderDownloadStatus(item)}
          </div>
          {/* Keep padding outside the clamped text so a third line cannot bleed into it. */}
          <div className="h-16 px-3 py-3 sm:px-4">
            <h3
              title={item.title}
              className="line-clamp-2 font-medium text-sm leading-5 text-text-000 [overflow-wrap:anywhere] sm:text-base sm:leading-5"
            >
              {item.title}
            </h3>
          </div>
        </article>
      )
    })

  const selected = items?.find((item) => item.slug === browser?.slug)
  const inlineDetails = variant === 'marketplace' && compact
  if (!items?.length && variant === 'home') return null

  return (
    <>
      {variant === 'marketplace' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={
              inlineDetails && browser && selected ? 'hidden' : 'flex min-h-0 flex-1 flex-col'
            }
          >
            <UseCaseGalleryList
              items={items ?? []}
              catalogStatus={catalogStatus}
              renderCards={renderCards}
              refreshing={refreshing}
              refreshCompletion={refreshCompletion}
              onResetRefreshCompletion={() => setRefreshCompletion(null)}
              onRefresh={() => void refreshCatalog()}
              initialState={initialListState}
              onFiltersChange={updateListFilters}
              onOpenMarketplace={
                compact
                  ? (snapshot) => useNavigationStore.getState().openMarketplace('user', snapshot)
                  : undefined
              }
            />
          </div>
          {inlineDetails && browser && selected && (
            <UseCaseDetailsPage
              item={selected}
              introductions={introductions}
              onBack={() => {
                const opener = browser.opener
                setBrowser(null)
                requestAnimationFrame(() => {
                  if (opener.isConnected) opener.focus({ preventScroll: true })
                })
              }}
              renderImport={renderImport}
              renderDownloadStatus={(item) => renderDownloadStatus(item, true)}
            />
          )}
        </div>
      ) : (
        <section
          ref={setHomeSectionRef}
          aria-labelledby={headingId}
          data-home-gallery-has-more={
            homeHasMore || slugs.length < (items?.length ?? 0) ? 'true' : 'false'
          }
          // The heading background sits immediately under the project card when the page is full.
          // This gap keeps that card's 1px ring visible; a positive pin replaces it inline.
          className="mt-auto -mx-3 overflow-visible px-3 pt-2 [&_button:enabled]:cursor-pointer"
          style={homeGalleryOffset ? { paddingTop: homeGalleryOffset } : undefined}
        >
          <div className="sticky top-0 z-20 -mx-3 mb-3 flex items-center justify-between gap-4 bg-bg-10 px-3 py-2">
            <h2 id={headingId} className="text-base font-medium text-text-000">
              <button
                type="button"
                onClick={openMarketplace}
                className="inline-flex cursor-pointer items-center gap-1 rounded-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GalleryHorizontalEnd className="size-4 text-text-100" aria-hidden="true" />
                {t('Use Cases')}
              </button>
            </h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('Browse all examples')}
              title={t('Browse all examples')}
              onClick={openMarketplace}
            >
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div
            ref={homeGridRef}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3"
          >
            {renderCards(homeVisible)}
          </div>
          {homeHasMore || slugs.length < (items?.length ?? 0) ? (
            <div ref={sentinelRef} className="h-px" aria-hidden="true" />
          ) : null}
        </section>
      )}
      {!inlineDetails && browser && selected && (
        <UseCaseDetailsDialog
          item={selected}
          introductions={introductions}
          opener={browser.opener}
          onClose={() => setBrowser(null)}
          onOpenMarketplace={variant === 'home' ? openMarketplace : undefined}
          renderImport={renderImport}
          renderDownloadStatus={(item) => renderDownloadStatus(item, true)}
        />
      )}
    </>
  )
}
