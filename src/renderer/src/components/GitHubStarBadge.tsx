/* Hallmark · component: GitHub Star CTA · genre: modern-minimal · theme: existing Open Science
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (40–41)
 */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { Star, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatStarCount } from '@/lib/format-star-count'
import { cn } from '@/lib/utils'
import { APP } from '../../../shared/app-config'

const STAR_NUDGE_DELAY_MS = 5_000
const STAR_NUDGE_VISIBILITY_POLL_MS = 500
const STAR_NUDGE_VISIBLE_MS = 30_000
const STAR_NUDGE_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1_000
const STAR_NUDGE_LAST_SHOWN_STORAGE_KEY = 'open-science:github-star-nudge-last-shown-at'

const isVisibleStarNudgeAnchor = (anchor: HTMLElement | null): anchor is HTMLElement =>
  Boolean(anchor && !anchor.closest('[inert]') && anchor.getClientRects().length > 0)

const wasStarNudgeRecentlyShown = (): boolean => {
  try {
    const lastShownAt = Number(window.localStorage.getItem(STAR_NUDGE_LAST_SHOWN_STORAGE_KEY))
    const elapsed = Date.now() - lastShownAt
    return lastShownAt > 0 && elapsed >= 0 && elapsed < STAR_NUDGE_COOLDOWN_MS
  } catch {
    return false
  }
}

const recordStarNudgeShown = (): void => {
  try {
    window.localStorage.setItem(STAR_NUDGE_LAST_SHOWN_STORAGE_KEY, String(Date.now()))
  } catch {
    // The nudge remains best-effort when renderer storage is unavailable.
  }
}

// GitHub's octocat is a brand asset that lucide-react dropped in v1, so we inline the official mark
// here. currentColor lets it inherit the link's text color like the other icons.
const GitHubMark = ({ className }: { className?: string }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.725-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.73.083-.73 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.42-1.305.762-1.605-2.665-.303-5.467-1.332-5.467-5.93 0-1.31.468-2.38 1.236-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23.957-.266 1.983-.4 3.003-.404 1.02.004 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.652.242 2.873.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.807 5.624-5.48 5.92.43.372.815 1.103.815 2.222 0 1.606-.014 2.9-.014 3.293 0 .32.216.694.825.576C20.565 22.296 24 17.797 24 12.5 24 5.87 18.63.5 12 .5z" />
  </svg>
)

type GitHubStarBadgeProps = {
  className?: string
  nudgeKey?: string
  variant?: 'compact' | 'home' | 'workspace'
}

// GitHub entry point reused on the home header, chat sidebar, and settings. Fetches the repo star
// count once (cached in the main process) and shows it beside the GitHub mark; when the count is
// unavailable it keeps the variant's static label or icon. Clicking opens the repo in the system
// browser via the window-open handler in src/main/windows.ts.
const GitHubStarBadge = ({
  className,
  nudgeKey,
  variant = 'compact'
}: GitHubStarBadgeProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [stars, setStars] = useState<number | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'success' | 'error'>(() =>
    typeof window.api?.github?.getStars === 'function' ? 'loading' : 'error'
  )
  const [starNudgeOpen, setStarNudgeOpen] = useState(false)
  const [starNudgePaused, setStarNudgePaused] = useState(false)
  const starNudgeAnchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let cancelled = false

    // Decorative badge: if the preload API is unavailable, stay icon-only instead of throwing.
    // In production window.api.github is always present.
    const getStars = window.api?.github?.getStars

    if (!getStars) return

    void getStars()
      .then((count) => {
        if (cancelled) return
        setStars(count)
        setLoadState(count === null ? 'error' : 'success')
      })
      .catch(() => {
        if (!cancelled) setLoadState('error')
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (variant !== 'workspace' || !nudgeKey || wasStarNudgeRecentlyShown()) return

    let timeoutId: number
    const scheduleWhenVisible = (): void => {
      const anchor = starNudgeAnchorRef.current
      if (!isVisibleStarNudgeAnchor(anchor)) {
        timeoutId = window.setTimeout(scheduleWhenVisible, STAR_NUDGE_VISIBILITY_POLL_MS)
        return
      }

      timeoutId = window.setTimeout(() => {
        const currentAnchor = starNudgeAnchorRef.current
        if (!isVisibleStarNudgeAnchor(currentAnchor)) {
          scheduleWhenVisible()
          return
        }
        recordStarNudgeShown()
        setStarNudgeOpen(true)
      }, STAR_NUDGE_DELAY_MS)
    }

    scheduleWhenVisible()

    return () => window.clearTimeout(timeoutId)
  }, [nudgeKey, variant])

  useEffect(() => {
    if (!starNudgeOpen) return

    let timeoutId: number
    const closeWhenHidden = (): void => {
      if (!isVisibleStarNudgeAnchor(starNudgeAnchorRef.current)) {
        setStarNudgeOpen(false)
        return
      }
      timeoutId = window.setTimeout(closeWhenHidden, STAR_NUDGE_VISIBILITY_POLL_MS)
    }
    timeoutId = window.setTimeout(closeWhenHidden, STAR_NUDGE_VISIBILITY_POLL_MS)

    return () => window.clearTimeout(timeoutId)
  }, [starNudgeOpen])

  useEffect(() => {
    if (!starNudgeOpen || starNudgePaused) return

    const timeoutId = window.setTimeout(() => setStarNudgeOpen(false), STAR_NUDGE_VISIBLE_MS)
    return () => window.clearTimeout(timeoutId)
  }, [starNudgeOpen, starNudgePaused])

  const accessibleLabel =
    stars === null
      ? t('Star {{app}} on GitHub', { app: APP.name })
      : t('Star {{app}} on GitHub, {{count}} stars', { app: APP.name, count: stars })

  const badge = (
    <Button
      asChild
      variant={variant === 'compact' ? 'ghost' : 'outline'}
      size="default"
      className={cn(
        variant === 'compact' && 'px-2 text-muted-foreground hover:bg-bg-300 hover:text-text-000',
        variant === 'home' && 'rounded-md px-2.5 [@media(pointer:coarse)]:h-11',
        variant === 'workspace' &&
          'rounded-md border-border-200 bg-bg-000 px-2 text-text-100 hover:bg-bg-300 hover:text-text-000 [@media(pointer:coarse)]:h-11',
        className
      )}
    >
      <a
        href={APP.links.githubRepo}
        target="_blank"
        rel="noreferrer"
        aria-label={accessibleLabel}
        title={variant === 'compact' ? accessibleLabel : undefined}
        data-variant={variant}
        data-state={loadState}
        aria-busy={loadState === 'loading'}
        onClick={() => setStarNudgeOpen(false)}
        className="github-star-cta"
      >
        <GitHubMark className="size-4" />
        {variant === 'home' ? (
          <span className="text-xs font-semibold">{t('Star on GitHub')}</span>
        ) : null}
        <span
          className={cn(
            'inline-flex items-center gap-1 text-xs font-medium tabular-nums text-muted-foreground',
            variant === 'home' && 'border-l border-border pl-2'
          )}
        >
          <Star
            className={cn('size-3 fill-transparent', loadState === 'loading' && 'opacity-70')}
            strokeWidth={2}
            aria-hidden="true"
          />
          {stars !== null ? formatStarCount(stars) : null}
        </span>
      </a>
    </Button>
  )

  const badgeWithTooltip = (
    <TooltipProvider delayDuration={800}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent
          side={variant === 'home' ? 'bottom' : 'top'}
          align={variant === 'home' ? 'end' : 'center'}
          sideOffset={6}
          className={cn(
            'max-w-[260px] whitespace-normal px-3 py-2 text-left text-xs leading-5',
            variant === 'workspace' && starNudgeOpen && 'hidden'
          )}
        >
          {t('Enjoying {{appName}}?', { appName: APP.name })}{' '}
          {t('A star helps more researchers find it.')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )

  if (variant === 'compact') return badge
  if (variant === 'home') return badgeWithTooltip

  return (
    <Popover
      open={starNudgeOpen}
      onOpenChange={(open) => {
        setStarNudgeOpen(open)
        if (!open) setStarNudgePaused(false)
      }}
    >
      <PopoverAnchor asChild>
        <span ref={starNudgeAnchorRef} className="inline-flex">
          {badgeWithTooltip}
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={10}
        aria-label={t('Star on GitHub')}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={() => setStarNudgePaused(true)}
        onPointerLeave={() => setStarNudgePaused(false)}
        onFocusCapture={() => setStarNudgePaused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setStarNudgePaused(false)
          }
        }}
        className="z-[80] origin-bottom w-max max-w-[calc(100vw-1rem)] px-3 py-2 text-left data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none after:absolute after:-bottom-1 after:left-1/2 after:size-2 after:-translate-x-1/2 after:rotate-45 after:bg-text-000"
      >
        <div className="flex items-center justify-between gap-3">
          <strong className="text-sm font-semibold leading-5">
            {t('Enjoying {{appName}}?', { appName: APP.name })}
          </strong>
          <TooltipProvider delayDuration={800}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t('Close')}
                  onClick={() => setStarNudgeOpen(false)}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-bg-000/70 transition-colors duration-150 hover:bg-bg-000/10 hover:text-bg-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/70 active:translate-y-px motion-reduce:transform-none motion-reduce:transition-none [@media(pointer:coarse)]:size-11"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('Close')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="mt-0.5 whitespace-nowrap text-[11px] leading-4 text-bg-000/60">
          {t('A star helps more researchers find it.')}
        </div>
        <a
          href={APP.links.githubRepo}
          target="_blank"
          rel="noreferrer"
          onClick={() => setStarNudgeOpen(false)}
          className="mt-2 inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md text-xs font-semibold text-bg-000 underline decoration-bg-000/40 underline-offset-4 transition-colors duration-150 hover:decoration-bg-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/70 motion-reduce:transition-none [@media(pointer:coarse)]:h-11"
        >
          <Star
            className="size-3 fill-transparent animate-[pulse_1400ms_cubic-bezier(0.16,1,0.3,1)_infinite] motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t('Star on GitHub')}
        </a>
      </PopoverContent>
    </Popover>
  )
}

export { GitHubStarBadge }
