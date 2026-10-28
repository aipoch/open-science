import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Shuffle,
  LoaderCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { importSessionPackage } from '@/lib/session-package-import'
import { sessionPackageImportAvailable } from '@/lib/session-package-capabilities'
import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import { UseCaseCover } from './UseCaseCover'
import { preloadUseCaseCovers } from './use-case-cover-cache'
import { useUseCaseGalleryStore } from './use-case-gallery-store'
import type { UseCase } from '../../../../shared/use-cases'

export const UseCaseCarousel = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const headingId = useId()
  const { items, slugs, page, receive, select } = useUseCaseGalleryStore()
  const [transition, setTransition] = useState<'random' | 'previous' | 'next'>('random')
  const [previous, setPrevious] = useState<UseCase[]>()
  const gridRef = useRef<HTMLDivElement>(null)
  const randomIconRef = useRef<SVGSVGElement>(null)
  const preparationRef = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => preparationRef.current?.abort(), [])
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
  const pages = Math.ceil((items?.length ?? 0) / 3)

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        const cached = await window.api.sessions.useCaseCatalog('cached')
        if (active && !useUseCaseGalleryStore.getState().items) receive(cached)
        const refreshed = await window.api.sessions.useCaseCatalog('refreshed')
        if (active) receive(refreshed)
      } catch {
        // Keep the cached list when the application transport is temporarily unavailable.
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
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!previous) return
    if (!grid?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPrevious(undefined)
      return
    }
    // Leave the old group opaque underneath until the new cards fully cover it.
    const offset = transition === 'random' ? 0 : transition === 'previous' ? -6 : 6
    const animation = grid.animate(
      [
        { opacity: 0, transform: `translateX(${offset}px)` },
        { opacity: 1, transform: 'translateX(0)' }
      ],
      { duration: 180, easing: 'ease-out' }
    )
    void animation.finished.then(
      () => setPrevious(undefined),
      () => {}
    )
    return () => animation.cancel()
  }, [visibleKey, transition, previous])

  const changePage = (direction: 'previous' | 'next'): void => {
    if (!items?.length) return
    preparationRef.current?.abort()
    const nextPage = (page + (direction === 'next' ? 1 : pages - 1)) % pages
    setTransition(direction)
    setPrevious(visible)
    select(
      Array.from(
        { length: Math.min(3, items.length) },
        (_, index) => items[(nextPage * 3 + index) % items.length].slug
      ),
      nextPage
    )
  }

  const randomize = async (): Promise<void> => {
    if (!items?.length) return
    const shuffled = [...items]
    for (let index = shuffled.length - 1; index > 0; index--) {
      const target = Math.floor(Math.random() * (index + 1))
      ;[shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]]
    }
    const next = shuffled.slice(0, 3)
    if (
      items.length > 3 &&
      next.every((item) => visible.some((current) => current.slug === item.slug))
    ) {
      next[2] = shuffled[3]
    } else if (next.length > 1 && next.every((item, index) => item.slug === visible[index]?.slug)) {
      next.push(next.shift()!)
    }
    preparationRef.current?.abort()
    const preparation = new AbortController()
    preparationRef.current = preparation
    const grid = gridRef.current
    if (grid?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const icon = randomIconRef.current
      icon?.getAnimations({ subtree: true }).forEach((animation) => animation.cancel())
      // Lucide draws each arrowhead separately; keep it in sync with its own shaft segments.
      const [downHead, upHead, upShaft, downStart, downEnd] = icon?.querySelectorAll('path') ?? []
      const arrows = [
        [downHead, downStart, downEnd],
        [upHead, upShaft]
      ]
      arrows.forEach((segments, index) =>
        segments.forEach((segment) =>
          segment?.animate(
            [
              { transform: 'scaleY(1)', transformOrigin: '12px 12px', opacity: 1 },
              { transform: 'scaleY(-1)', transformOrigin: '12px 12px', opacity: 0.65 },
              { transform: 'scaleY(1)', transformOrigin: '12px 12px', opacity: 1 }
            ],
            { duration: 220, delay: index * 30, easing: 'ease-in-out' }
          )
        )
      )
    }
    await preloadUseCaseCovers(
      next.map((item) => item.imageUrl),
      preparation.signal
    )
    if (preparation.signal.aborted) return
    // Reconcile again if a background refresh removed a candidate during image preparation.
    const latest = useUseCaseGalleryStore.getState().items ?? []
    const selected = next.filter((item) => latest.some((entry) => entry.slug === item.slug))
    for (const item of latest) {
      if (selected.length >= Math.min(3, latest.length)) break
      if (!selected.some((entry) => entry.slug === item.slug)) selected.push(item)
    }
    setPrevious(visible)
    setTransition('random')
    select(
      selected.map((item) => item.slug),
      page
    )
  }

  const renderCards = (cases: UseCase[]): React.JSX.Element[] =>
    cases.map((item) => {
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
        <article
          key={item.slug}
          aria-label={item.title}
          className="group relative min-w-0 overflow-hidden rounded-xl border border-border bg-bg-000"
        >
          <div className="relative aspect-[16/9] overflow-hidden bg-bg-100">
            <UseCaseCover key={item.imageUrl} src={item.imageUrl} />
            {/* Active imports retain their actions independently of hover or pointer focus. */}
            <div
              data-active={importing || undefined}
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/40 p-2 opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 data-[active=true]:opacity-100 [@media(hover:none)]:opacity-100 sm:flex-row"
            >
              <Button
                variant="outline"
                size="sm"
                className="h-8 cursor-pointer gap-1 rounded-md px-3 text-xs"
                asChild
              >
                <a
                  href={`https://aipoch.com/open-science/use-cases/${item.slug}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  {t('Details')}
                </a>
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-8 gap-1 rounded-md px-3 text-xs hover:bg-[color-mix(in_oklch,var(--primary),black_10%)] aria-busy:disabled:opacity-100"
                aria-busy={busy}
                disabled={
                  !waiting &&
                  (Boolean(pending) || operationActive || !sessionPackageImportAvailable())
                }
                onClick={() =>
                  waiting
                    ? usePackageOperationStore.getState().setOpen(true)
                    : void importExample(item)
                }
              >
                {busy ? (
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                ) : waiting ? (
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                ) : (
                  <Download className="size-3.5" aria-hidden="true" />
                )}
                {waiting ? t('Continue') : t('Import')}
              </Button>
            </div>
            {/* Transient status overlays the cover so every card keeps its original size. */}
            {downloading && (
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
                className={`absolute inset-0 z-10 overflow-auto bg-background/95 p-3 sm:p-4 ${downloading ? 'pb-14' : ''}`}
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
          </div>
          {/* Keep padding outside the clamped text so a third line cannot bleed into it. */}
          <div className="h-16 px-3 py-3 sm:px-4">
            <h3
              title={item.title}
              className="line-clamp-2 font-serif text-sm leading-5 text-text-000 [overflow-wrap:anywhere] sm:text-base sm:leading-5"
            >
              {item.title}
            </h3>
          </div>
        </article>
      )
    })

  if (!items?.length) return null

  return (
    <section
      aria-labelledby={headingId}
      className="mt-auto pt-10 [&_button:enabled]:cursor-pointer"
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 id={headingId} className="text-base font-medium text-text-000">
          <a
            href="https://aipoch.com/open-science/use-cases"
            target="_blank"
            rel="noreferrer"
            className="inline-flex cursor-pointer items-center gap-1 rounded-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('Use Case Gallery')}
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </a>
        </h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('Random examples')}
            title={t('Random examples')}
            disabled={items.length < 2}
            onClick={randomize}
          >
            <Shuffle ref={randomIconRef} className="size-4 origin-center" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('Previous examples')}
            disabled={pages < 2}
            onClick={() => changePage('previous')}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('Next examples')}
            disabled={pages < 2}
            onClick={() => changePage('next')}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="relative">
        {previous && (
          <div
            aria-hidden="true"
            inert
            className="pointer-events-none absolute inset-x-0 top-0 grid grid-cols-3 gap-3 sm:gap-5"
          >
            {renderCards(previous)}
          </div>
        )}
        <div ref={gridRef} className="relative grid grid-cols-3 gap-3 sm:gap-5">
          {renderCards(visible)}
        </div>
      </div>
    </section>
  )
}
