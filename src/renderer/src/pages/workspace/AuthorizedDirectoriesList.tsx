import { useId, useMemo, useRef, useState } from 'react'
import { Folder } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AuthorizedDirectorySnapshot } from './authorized-directories-presentation'
import { grantedRootAccessBadgeClassName } from './granted-root-access-badge'

export const AuthorizedDirectoriesList = ({
  directories
}: {
  directories: AuthorizedDirectorySnapshot['directories']
}): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.resolvedLanguage]
  )

  if (!directories.length)
    return <p className="py-1 text-xs text-text-200">{t('No folders granted yet.')}</p>

  const visibleDirectories = expanded ? directories : directories.slice(0, 5)
  return (
    <TooltipProvider>
      <div className="min-w-0">
        <ul
          ref={listRef}
          id={listId}
          aria-label={t('List authorized directories')}
          className={cn('min-w-0', expanded && 'max-h-80 overflow-y-auto overscroll-contain')}
        >
          {visibleDirectories.map((directory) => (
            <li key={directory.path}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    tabIndex={0}
                    className="flex min-h-9 min-w-0 items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-bg-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <span
                      role="img"
                      aria-label={directory.access === 'rw' ? t('Read & write') : t('Read-only')}
                      className="relative size-7 shrink-0 text-text-200"
                    >
                      <Folder className="size-6.5" strokeWidth={1.5} aria-hidden="true" />
                      <span
                        aria-hidden="true"
                        className={cn(
                          grantedRootAccessBadgeClassName(directory.access),
                          'absolute -right-0.5 bottom-0 border-2 border-bg-000 px-0.5 text-[8px] leading-3'
                        )}
                      >
                        {directory.access}
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs leading-4 text-text-000">
                        {directory.name || directory.path}
                      </span>
                      <span className="block text-[10px] leading-[14px] break-all text-text-200 select-text">
                        {directory.path}
                      </span>
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {t('Granted at {{time}}', {
                    time: dateFormat.format(new Date(directory.grantedAt))
                  })}
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
        {directories.length > 5 ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            className="mt-0.5 block rounded-sm px-1 py-0.5 text-[11px] leading-4 text-text-100 hover:bg-bg-200 hover:text-text-000 focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              setExpanded(!expanded)
              if (listRef.current) listRef.current.scrollTop = 0
            }}
          >
            {expanded
              ? t('Show less')
              : t('Show remaining {{count}} directories', {
                  count: directories.length - 5,
                  defaultValue_one: 'Show remaining {{count}} directory'
                })}
          </button>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
