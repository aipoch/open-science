import { File, Folder } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { InlineNotice } from '@/components/ui/inline-notice'
import type { LocalDirEntry } from '../../../../shared/local-fs'

// Formats a byte count as a short human-readable string.
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(1)} GB`
}

// Human-readable relative time from a mtime; empty when unknown (mtimeMs 0).
const relativeTime = (mtimeMs: number): string => {
  if (!mtimeMs) return ''
  const sec = Math.round((Date.now() - mtimeMs) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

export const DirectoryBrowser = ({
  label,
  busy,
  testId,
  toolbar,
  children
}: {
  label?: string
  busy?: boolean
  testId?: string
  toolbar: ReactNode
  children: ReactNode
}): React.JSX.Element => (
  <div
    className="mx-4 mb-1.5 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-300/50 bg-bg-000"
    aria-label={label}
    aria-busy={busy}
    data-testid={testId}
  >
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border-300/40 px-3 py-1.5">
      {toolbar}
    </div>
    {children}
  </div>
)

export const DirectoryLoading = (): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="flex flex-1 items-center justify-center text-xs text-muted-foreground"
    >
      {t('Loading…')}
    </div>
  )
}

export const DirectoryListing = ({
  entries,
  onOpenEntry,
  truncated,
  footer
}: {
  entries: LocalDirEntry[]
  onOpenEntry: (entry: LocalDirEntry) => void
  truncated?: boolean
  footer?: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {truncated ? (
        <InlineNotice className="m-2">
          {t('Showing the first entries only — this directory is very large.')}
        </InlineNotice>
      ) : null}
      {entries.length === 0 ? (
        <div className="flex min-h-16 flex-1 items-center justify-center text-xs text-muted-foreground">
          {t('Empty folder')}
        </div>
      ) : (
        <ul className="shrink-0" aria-label={t('Directory contents')}>
          {entries.map((entry) => (
            <li key={entry.name} className="border-b border-border-300/40 last:border-b-0">
              <button
                type="button"
                aria-label={entry.name}
                onClick={() => onOpenEntry(entry)}
                className="grid w-full grid-cols-[minmax(0,1fr)_min(80px,20%)_min(64px,16%)] items-center gap-2 px-4 py-2 text-left text-[13px] hover:bg-bg-200 focus-visible:keyboard-focus focus-visible:outline-offset-[-2px]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {/* One neutral color for both: the glyph already says folder vs file, so tinting
                      the folder only added noise to a long list. */}
                  {entry.isDirectory ? (
                    <Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  ) : (
                    <File className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  )}
                  <span className="truncate" title={entry.name}>
                    {entry.name}
                  </span>
                </span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  {entry.isDirectory ? '—' : formatSize(entry.size)}
                </span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  {relativeTime(entry.mtimeMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {footer}
    </div>
  )
}
