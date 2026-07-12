import { Star } from 'lucide-react'
import { useEffect, useState } from 'react'

import { formatStarCount } from '@/lib/format-star-count'
import { cn } from '@/lib/utils'
import { APP } from '../../../shared/app-config'

// GitHub's octocat is a brand asset that lucide-react dropped in v1, so we inline the official mark
// here. currentColor lets it inherit the link's text color like the other icons.
const GitHubMark = ({ className }: { className?: string }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.725-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.73.083-.73 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.42-1.305.762-1.605-2.665-.303-5.467-1.332-5.467-5.93 0-1.31.468-2.38 1.236-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23.957-.266 1.983-.4 3.003-.404 1.02.004 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.652.242 2.873.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.807 5.624-5.48 5.92.43.372.815 1.103.815 2.222 0 1.606-.014 2.9-.014 3.293 0 .32.216.694.825.576C20.565 22.296 24 17.797 24 12.5 24 5.87 18.63.5 12 .5z" />
  </svg>
)

type GitHubStarBadgeProps = {
  className?: string
}

// GitHub entry point reused on the home header, chat sidebar, and settings. Fetches the repo star
// count once (cached in the main process) and shows it beside the GitHub mark; when the count is
// unavailable it degrades to an icon-only link. Clicking opens the repo in the system browser via
// the window-open handler in src/main/windows.ts.
const GitHubStarBadge = ({ className }: GitHubStarBadgeProps): React.JSX.Element => {
  const [stars, setStars] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    // Decorative badge: if the preload API is unavailable, stay icon-only instead of throwing.
    // In production window.api.github is always present.
    const getStars = window.api?.github?.getStars

    if (!getStars) return

    void getStars().then((count) => {
      if (!cancelled) setStars(count)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const label =
    stars === null ? `Open ${APP.name} on GitHub` : `Star ${APP.name} on GitHub, ${stars} stars`

  return (
    <a
      href={APP.links.githubRepo}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-text-300 transition-colors duration-150 ease-out hover:bg-bg-300 hover:text-text-000',
        className
      )}
    >
      <GitHubMark className="size-4" />
      {stars !== null ? (
        <span className="inline-flex items-center gap-0.5 text-xs font-medium tabular-nums">
          <Star className="size-3" strokeWidth={2} aria-hidden="true" />
          {formatStarCount(stars)}
        </span>
      ) : null}
    </a>
  )
}

export { GitHubStarBadge }
