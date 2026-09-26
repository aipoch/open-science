import { Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatStarCount } from '@/lib/format-star-count'
import { cn } from '@/lib/utils'
import { APP } from '../../../shared/app-config'

// GitHub's octocat is a brand asset that lucide-react dropped in v1, so we inline the official mark
// here. currentColor lets it inherit the link's text color like the other icons.
export const GitHubMark = ({ className }: { className?: string }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.725-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.73.083-.73 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.42-1.305.762-1.605-2.665-.303-5.467-1.332-5.467-5.93 0-1.31.468-2.38 1.236-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23.957-.266 1.983-.4 3.003-.404 1.02.004 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.652.242 2.873.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.807 5.624-5.48 5.92.43.372.815 1.103.815 2.222 0 1.606-.014 2.9-.014 3.293 0 .32.216.694.825.576C20.565 22.296 24 17.797 24 12.5 24 5.87 18.63.5 12 .5z" />
  </svg>
)

type GitHubStarBadgeProps = {
  withTooltipProvider?: boolean
  className?: string
  variant?: 'compact' | 'home' | 'workspace'
}

// GitHub entry point reused on the home header, chat sidebar, and settings. Fetches the repo star
// count once (cached in the main process) and shows it beside the GitHub mark; when the count is
// unavailable it keeps the variant's static label or icon. Clicking opens the repo in the system
// browser via the window-open handler in src/main/windows.ts.
const GitHubStarBadge = ({
  className,
  variant = 'compact',
  withTooltipProvider = true
}: GitHubStarBadgeProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [stars, setStars] = useState<number | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'success' | 'error'>(() =>
    typeof window.api?.github?.getStars === 'function' ? 'loading' : 'error'
  )
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

  const tooltip = (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent
        side={variant === 'home' ? 'bottom' : 'top'}
        align={variant === 'home' ? 'end' : 'center'}
        sideOffset={6}
        className={cn('max-w-[260px] whitespace-normal px-3 py-2 text-left text-xs leading-5')}
      >
        {t('Enjoying {{appName}}?', { appName: APP.name })}{' '}
        {t('A star helps more researchers find it.')}
      </TooltipContent>
    </Tooltip>
  )

  const badgeWithTooltip = withTooltipProvider ? (
    <TooltipProvider>{tooltip}</TooltipProvider>
  ) : (
    tooltip
  )

  return variant === 'compact' ? badge : badgeWithTooltip
}

export { GitHubStarBadge }
