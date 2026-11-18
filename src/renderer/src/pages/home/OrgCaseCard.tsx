import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Download, FolderArchive, X } from 'lucide-react'
import type {
  OrgCaseDownloadSnapshot,
  OrgCaseErrorCode,
  OrgCaseItem
} from '../../../../shared/org-cases'
import { formatPackageBytes } from '../../../../shared/session-package'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  describeOrgCaseError,
  formatOrgCaseDownloadLabel,
  orgCaseErrorNoticeActions
} from './org-case-errors'
import type { UseCaseSourceKind } from '@/stores/org-cases-store'

export const UseCaseSourceToggle = ({
  source,
  onChange,
  compact = false
}: {
  source: UseCaseSourceKind
  onChange: (source: UseCaseSourceKind) => void
  compact?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div
      role="tablist"
      aria-label={t('Case source')}
      className={cn(
        'inline-flex items-center rounded-lg border border-border bg-muted/50 p-0.5',
        compact && 'h-7'
      )}
    >
      {(
        [
          { id: 'official', label: t('Official') },
          { id: 'organization', label: t('Organization') }
        ] as const
      ).map((option) => {
        const selected = source === option.id
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={selected}
            data-testid={`use-case-source-${option.id}`}
            onClick={() => onChange(option.id)}
            className={cn(
              'rounded-md font-medium transition-colors',
              compact ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-xs',
              selected
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export const OrgCaseCard = ({
  item,
  layout = 'carousel',
  download,
  downloadError,
  importBusy,
  importDisabled = false,
  onExplore,
  onImport,
  onCancelImport,
  onDismissError,
  onOpenLabSettings
}: {
  item: OrgCaseItem
  layout?: 'carousel' | 'grid'
  download: OrgCaseDownloadSnapshot | null
  downloadError: OrgCaseErrorCode | null
  importBusy: boolean
  importDisabled?: boolean
  onExplore: (caseId: string, opener?: HTMLElement | null) => void
  onImport: (caseId: string) => void
  onCancelImport: (caseId: string) => void
  onDismissError: () => void
  onOpenLabSettings?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const isDownloading = download?.caseId === item.id
  const progressPercent =
    isDownloading && download.totalBytes && download.totalBytes > 0
      ? Math.min(
          100,
          Math.max(0, Math.round((download.completedBytes / download.totalBytes) * 100))
        )
      : 0

  const errorPresentation = downloadError ? describeOrgCaseError(downloadError, t) : null

  const handleCopyCode = (event: React.MouseEvent): void => {
    event.stopPropagation()
    const writeText = navigator.clipboard?.writeText
    if (!writeText) return
    void writeText
      .call(navigator.clipboard, item.code)
      .then(() => {
        setCopied(true)
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current)
        }
        copyTimerRef.current = window.setTimeout(() => {
          copyTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
      .catch(() => undefined)
  }

  return (
    <article
      aria-label={item.name}
      data-testid={`org-case-card-${item.id}`}
      className={cn(
        'group flex flex-col justify-between rounded-xl border border-border/80 bg-card p-3.5 text-left transition-colors hover:border-border',
        layout === 'carousel' ? 'w-[280px] shrink-0' : 'w-full'
      )}
    >
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground">
            <FolderArchive className="h-4 w-4" />
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5">
            <code className="font-mono text-[11px] font-medium tracking-wider text-foreground">
              {item.code}
            </code>
            <button
              type="button"
              onClick={handleCopyCode}
              aria-label={t('Copy share code')}
              title={copied ? t('Copied') : t('Copy share code')}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={(event) => onExplore(item.id, event.currentTarget)}
          className="block w-full space-y-1 text-left focus-visible:outline-none"
        >
          <h4 className="line-clamp-1 text-sm font-medium text-foreground group-hover:underline">
            {item.name}
          </h4>
          <p className="line-clamp-2 min-h-[2.25rem] text-xs leading-relaxed text-muted-foreground">
            {item.description || t('No description provided.')}
          </p>
        </button>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="truncate max-w-[110px]">
            {item.owner.display_name || t('Unknown author')}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatPackageBytes(item.size_bytes)}</span>
          <span aria-hidden="true">·</span>
          <span>
            {t('{{count}} files', {
              count: item.summary.file_count,
              defaultValue_one: '{{count}} file'
            })}
          </span>
        </div>

        {errorPresentation ? (
          <ErrorNotice
            inline
            level={errorPresentation.level}
            title={errorPresentation.title}
            description={errorPresentation.description}
            dismissButton={{ label: t('Dismiss'), onClick: onDismissError }}
            {...orgCaseErrorNoticeActions(errorPresentation, t, {
              onOpenLabSettings,
              onRetry: !importDisabled && !importBusy ? () => onImport(item.id) : undefined
            })}
          />
        ) : null}
      </div>

      <div className="mt-3 pt-2.5 border-t border-border/60">
        {isDownloading ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate font-medium text-foreground">
                {formatOrgCaseDownloadLabel(download, t)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => onCancelImport(item.id)}
              >
                <X className="mr-1 h-3 w-3" />
                {t('Cancel')}
              </Button>
            </div>
            <div
              role="progressbar"
              aria-label={formatOrgCaseDownloadLabel(download, t)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={download.state === 'verifying' ? 100 : progressPercent}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${download.state === 'verifying' ? 100 : progressPercent}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={(event) => onExplore(item.id, event.currentTarget)}
            >
              {t('Details')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={importBusy || importDisabled}
              onClick={() => onImport(item.id)}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t('Import')}
            </Button>
          </div>
        )}
      </div>
    </article>
  )
}
