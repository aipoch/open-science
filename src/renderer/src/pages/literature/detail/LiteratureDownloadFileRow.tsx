import type { ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LiteratureFullTextProgress } from '@aipoch/literature-discovery/contracts'
import { formatBytes } from '../../../../../shared/update'
import { useLiteratureHost } from '../renderer-host'

export function LiteratureDownloadFileRow({
  name,
  sizeBytes,
  adding = false,
  progress,
  saving = false,
  children
}: {
  name: string
  sizeBytes?: number
  adding?: boolean
  progress?: LiteratureFullTextProgress
  saving?: boolean
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const { FileTypeIcon } = useLiteratureHost()
  const percent = progress?.totalBytes
    ? Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100))
    : undefined
  const waiting = !progress?.receivedBytes && !progress?.totalBytes
  const transferText = `${formatBytes(progress?.receivedBytes ?? 0)}${progress?.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''} · ${waiting ? t('Waiting for server…') : `${formatBytes(Math.round(progress?.bytesPerSecond ?? 0))}/s`}`
  const isSaving = saving || progress?.phase === 'saving'
  return (
    <div className="relative overflow-hidden rounded bg-muted/40 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap">
        <FileTypeIcon name={name} />
        <span className="min-w-0 flex-1 truncate" title={name}>
          {name}
        </span>
        {adding ? (
          <span
            role="status"
            className="ml-auto flex h-7 shrink-0 items-center gap-2 whitespace-nowrap tabular-nums text-muted-foreground"
          >
            <LoaderCircle
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {isSaving ? t('Saving…') : transferText}
          </span>
        ) : (
          <>
            {sizeBytes !== undefined ? (
              <span className="shrink-0 text-muted-foreground">{formatBytes(sizeBytes)}</span>
            ) : null}
            {children}
          </>
        )}
      </div>
      {adding && !isSaving ? (
        <div
          role="progressbar"
          aria-label={t('Download progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted"
        >
          <span
            className={`block h-full bg-primary ${percent === undefined ? 'w-1/3 motion-safe:animate-pulse' : 'transition-[width] motion-reduce:transition-none'}`}
            style={percent !== undefined ? { width: `${percent}%` } : undefined}
          />
        </div>
      ) : null}
    </div>
  )
}
