import { useCallback, useEffect, useId, useRef, useState, type Ref } from 'react'
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
  sectionRef?: Ref<HTMLElement>
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
  const visibleKey = visible.map((item) => item.slug).join(',')
  // Observe the shared homepage viewport so reaching the list end appends one batch.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || slugs.length >= (items?.length ?? 0)) return
    let active = true
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return
        active = false
        observer.disconnect()
        loadMore()
      },
      { root: sentinel.closest('[data-home-scroll]'), rootMargin: '0px 0px 80px 0px' }
    )
    observer.observe(sentinel)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [visibleKey, slugs.length, items?.length, loadMore])

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
          <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-2 bg-background/95 pr-3 text-xs sm:pr-4">
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
          {/* List covers stay compact when a narrow panel can only fit one column. */}
          <div
            className={`relative aspect-[16/9] w-full overflow-hidden bg-bg-100 ${variant === 'marketplace' ? 'max-h-50' : ''}`}
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
          ref={sectionRef}
          aria-labelledby={headingId}
          className="mt-auto -mx-3 overflow-clip px-3 pt-10 [&_button:enabled]:cursor-pointer"
        >
          <div className="sticky top-0 z-20 -mx-3 mb-3 flex items-center justify-between gap-4 bg-bg-10 px-3 py-2">
            <h2 id={headingId} className="text-base font-medium text-text-000">
              <button
                type="button"
                onClick={openMarketplace}
                className="inline-flex cursor-pointer items-center gap-1 rounded-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GalleryHorizontalEnd className="size-4 text-text-100" aria-hidden="true" />
                {t('Case library')}
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
            {renderCards(visible)}
          </div>
          {slugs.length < (items?.length ?? 0) && (
            <div ref={sentinelRef} className="h-px" aria-hidden="true" />
          )}
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
