import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, X } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  dialogPanelClassName,
  dialogOverlayClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogDescriptionClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'
import type {
  LiteratureFullTextCandidate,
  LiteratureFullTextProgress,
  LiteratureItemView,
  LiteratureMetadataCompletionResult,
  LiteratureMetadataField
} from '../../../../shared/literature'
import { formatBytes } from '../../../../shared/update'

type BatchLookupMode = 'metadata' | 'full-text'
const progressClassName =
  'h-1.5 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary'
type Row = {
  id: string
  item?: LiteratureItemView
  status: 'pending' | 'searching' | 'ready' | 'skipped' | 'error' | 'saving' | 'done'
  message?: string
  checked: boolean
  metadata?: LiteratureMetadataCompletionResult
  candidates?: LiteratureFullTextCandidate[]
  candidateId?: string
}

export const LiteratureBatchLookupDialog = ({
  itemIds,
  initialItems,
  mode,
  fieldLabel,
  onClose,
  onChanged
}: {
  itemIds: string[]
  initialItems: LiteratureItemView[]
  mode: BatchLookupMode
  fieldLabel: (field: LiteratureMetadataField) => string
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[]>(() =>
    [...new Set(itemIds)].map((id) => ({
      id,
      item: initialItems.find((item) => item.id === id),
      status: 'pending',
      checked: true
    }))
  )
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const running = useRef(false)
  const stopped = useRef(false)
  const mounted = useRef(true)
  const cooldowns = useRef(new Map<string, number>())
  const [download, setDownload] = useState<{ itemId: string; candidateId: string }>()
  const [progress, setProgress] = useState<LiteratureFullTextProgress>()
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      stopped.current = true
    }
  }, [])
  useEffect(() => {
    if (!download) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const result = await window.api.literature.fullText({ mode: 'progress', ...download })
        if (active && result.mode === 'progress') setProgress(result.progress)
      } catch {
        /* Download telemetry must not interrupt attachment saving. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [download])

  const update = (id: string, patch: Partial<Row>): void => {
    if (mounted.current)
      setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }
  const run = async (apply: boolean): Promise<void> => {
    if (running.current) return
    running.current = true
    stopped.current = false
    setStopping(false)
    setBusy(true)
    let changed = false
    try {
      for (const row of rows) {
        if (stopped.current || !mounted.current) break
        if (row.status === 'done' || (apply && (row.status !== 'ready' || !row.checked))) continue
        update(row.id, { status: apply ? 'saving' : 'searching', message: undefined })
        try {
          if (!apply) {
            const item = await window.api.literature.get(row.id)
            if (!item || item.deletedAt) throw new Error('Reference unavailable')
            update(row.id, { item })
            if (mode === 'metadata') {
              if (
                !item.item.identifiers.some(
                  ({ scheme, value }) => ['doi', 'pmid'].includes(scheme) && value.trim()
                )
              ) {
                update(row.id, { status: 'skipped', message: t('Needs identifiers') })
                continue
              }
              const result = await window.api.literature.completeMetadata({
                mode: 'preview',
                itemId: row.id
              })
              update(row.id, {
                metadata: result,
                status: result.filled.length ? 'ready' : 'skipped',
                message: result.filled.length ? undefined : t('No missing metadata was found.')
              })
            } else {
              if (
                item.attachments.some((attachment) =>
                  attachment.versions.some((version) => version.contentType === 'application/pdf')
                )
              ) {
                update(row.id, { status: 'skipped', message: t('PDF already attached') })
                continue
              }
              const result = await window.api.literature.fullText({
                mode: 'search',
                itemId: row.id
              })
              if (result.mode !== 'search') throw new Error('Unexpected full-text response')
              const partial = result.notices.some((notice) => notice.endsWith('-unavailable'))
              const configuration = [
                result.notices.includes('openalex-not-configured')
                  ? `${t('OpenAlex')}: ${t('API key required')}`
                  : '',
                result.notices.includes('unpaywall-not-configured')
                  ? `${t('Unpaywall')}: ${t('Contact email required')}`
                  : ''
              ]
                .filter(Boolean)
                .join(' · ')
              update(row.id, {
                candidates: result.candidates,
                candidateId: result.candidates[0]?.id,
                status: result.candidates.length ? 'ready' : partial ? 'error' : 'skipped',
                message:
                  [
                    result.notices.includes('missing-identifiers')
                      ? t('Needs identifiers')
                      : partial
                        ? t('Some sources were unavailable. Results may be incomplete.')
                        : !result.candidates.length
                          ? t('No freely accessible full-text PDF was found.')
                          : '',
                    configuration
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined
              })
            }
          } else if (mode === 'metadata' && row.item) {
            await window.api.literature.completeMetadata({
              mode: 'commit',
              itemId: row.id,
              expectedMetadataRevision: row.item.metadataRevision,
              overwriteFields: []
            })
            changed = true
            update(row.id, { status: 'done' })
          } else {
            const candidate = row.candidates?.find(({ id }) => id === row.candidateId)
            if (!candidate) throw new Error('No candidate selected')
            const origin = new URL(candidate.url).origin
            const until = cooldowns.current.get(origin) ?? 0
            if (until > Date.now()) {
              update(row.id, {
                status: 'error',
                message: t('Source rate limit reached. Search again later.')
              })
              continue
            }
            // Search candidates are bounded and expire; a large batch can evict its first rows.
            // Refresh the token, but only attach the exact source the user reviewed.
            const current = await window.api.literature.get(row.id)
            if (!current || current.metadataRevision !== row.item?.metadataRevision)
              throw new Error('Reference changed')
            const refreshed = await window.api.literature.fullText({
              mode: 'search',
              itemId: row.id
            })
            if (refreshed.mode !== 'search') throw new Error('Unexpected full-text response')
            const confirmed = refreshed.candidates.find(
              (entry) => entry.url === candidate.url && entry.provider === candidate.provider
            )
            if (!confirmed) {
              update(row.id, {
                status: 'error',
                message: t('The selected source changed. Search again and review the results.')
              })
              continue
            }
            setProgress(undefined)
            setDownload({ itemId: row.id, candidateId: confirmed.id })
            const result = await window.api.literature.fullText({
              mode: 'attach',
              itemId: row.id,
              candidateId: confirmed.id
            })
            if (result.mode === 'attach-error') {
              cooldowns.current.set(origin, result.retryAt)
              update(row.id, {
                status: 'error',
                message: t('Source rate limit reached. Search again later.')
              })
            } else if (result.mode === 'attach') {
              changed = true
              update(row.id, { status: 'done' })
            } else throw new Error('Unexpected attachment response')
          }
        } catch {
          update(row.id, {
            status: 'error',
            message:
              mode === 'metadata'
                ? t('Metadata could not be completed.')
                : apply
                  ? t('PDF could not be added')
                  : t('Full-text search failed. Try again.')
          })
        } finally {
          if (mounted.current) setDownload(undefined)
        }
        // Space provider requests as well as limiting concurrency to one reference.
        if (!stopped.current) await new Promise((resolve) => setTimeout(resolve, 350))
      }
    } finally {
      running.current = false
      if (mounted.current) {
        setBusy(false)
        setStopping(false)
      }
      if (changed) onChanged()
    }
  }
  const ready = rows.filter((row) => row.status === 'ready' && row.checked).length
  const checked = rows.filter((row) => !['pending', 'searching'].includes(row.status)).length
  const done = rows.filter((row) => row.status === 'done').length
  const failed = rows.filter((row) => row.status === 'error').length
  const skipped = rows.filter((row) => row.status === 'skipped').length
  const title = mode === 'metadata' ? t('Complete metadata') : t('Find full-text PDF')
  const labels = {
    pending: t('Pending'),
    searching: t('Searching…'),
    ready: t('Ready'),
    skipped: t('Skipped'),
    error: t('Failed'),
    saving: t('Saving…'),
    done: t('Completed')
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !running.current) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[85vh] w-[min(52rem,calc(100vw-2rem))] flex-col p-0'
          )}
        >
          <header className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{title}</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {mode === 'metadata'
                  ? t('Review missing fields before applying. Existing values are kept.')
                  : t(
                      'Review a source for each reference before downloading. References with PDFs are skipped.'
                    )}
              </Dialog.Description>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              onClick={onClose}
              aria-label={t('Close')}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          <div
            className="space-y-2 border-b border-border-300/60 px-5 py-3 text-xs text-muted-foreground"
            role="status"
          >
            <div className="flex flex-wrap justify-between gap-2 tabular-nums">
              <span>{t('Checked {{checked}} of {{total}}', { checked, total: rows.length })}</span>
              <span>
                {t('Completed {{done}} · Skipped {{skipped}} · Failed {{failed}}', {
                  done,
                  skipped,
                  failed
                })}
              </span>
            </div>
            <progress
              className={progressClassName}
              max={rows.length || 1}
              value={checked}
              aria-label={t('Search progress')}
            />
          </div>
          <ol className="min-h-0 flex-1 divide-y divide-border-300/60 overflow-y-auto px-5">
            {rows.map((row, index) => {
              const candidate = row.candidates?.find(({ id }) => id === row.candidateId)
              return (
                <li key={row.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 py-3">
                  <div className="pt-0.5 text-xs text-muted-foreground">
                    {row.status === 'ready' ? (
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={row.checked}
                        disabled={busy}
                        aria-label={`${t('Select reference')}: ${row.item?.item.title ?? row.id}`}
                        onChange={(event) => update(row.id, { checked: event.target.checked })}
                      />
                    ) : (
                      index + 1
                    )}
                  </div>
                  <div className="min-w-0 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 text-sm font-medium leading-5">
                        {row.item?.item.title ?? t('Reference')}
                      </p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {labels[row.status]}
                      </span>
                    </div>
                    {row.message ? (
                      <p className="text-xs text-muted-foreground">{row.message}</p>
                    ) : null}
                    {row.metadata ? (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-primary">
                          {t('View details')} ·{' '}
                          {row.metadata.provider === 'crossref' ? 'Crossref' : 'PubMed'} ·{' '}
                          {t('{{count}} missing fields', {
                            count: row.metadata.filled.length,
                            defaultValue_one: '{{count}} missing field'
                          })}
                        </summary>
                        <dl className="mt-2 space-y-2">
                          {row.metadata.filled.map(({ field, value }) => (
                            <div key={field}>
                              <dt className="text-muted-foreground">{fieldLabel(field)}</dt>
                              <dd className="break-words">{value}</dd>
                            </div>
                          ))}
                          {row.metadata.conflicts.length ? (
                            <div>
                              <dt className="font-medium">{t('Existing values kept')}</dt>
                              <dd className="mt-1 space-y-1">
                                {row.metadata.conflicts.map(({ field, currentValue }) => (
                                  <p key={field}>
                                    {fieldLabel(field)}: {currentValue}
                                  </p>
                                ))}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </details>
                    ) : null}
                    {candidate ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={row.candidateId}
                          disabled={busy || row.status === 'done'}
                          onValueChange={(candidateId) => update(row.id, { candidateId })}
                        >
                          <SelectTrigger
                            className="h-8 min-w-0 flex-1 text-xs"
                            aria-label={`${t('Source')}: ${row.item?.item.title ?? row.id}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {row.candidates?.map((source) => (
                              <SelectItem key={source.id} value={source.id}>
                                {source.source} · {new URL(source.sourceUrl ?? source.url).hostname}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <ExternalTextLink
                          href={candidate.sourceUrl ?? new URL(candidate.url).origin}
                        >
                          {t('Open source')}
                        </ExternalTextLink>
                      </div>
                    ) : null}
                    {download?.itemId === row.id && progress ? (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        <progress
                          className={progressClassName}
                          max={progress.totalBytes}
                          value={progress.totalBytes ? progress.receivedBytes : undefined}
                          aria-label={t('Downloading…')}
                        />
                        <p>
                          {formatBytes(progress.receivedBytes)}
                          {progress.totalBytes
                            ? ` / ${formatBytes(progress.totalBytes)}`
                            : ''} · {formatBytes(progress.bytesPerSecond)}/s
                        </p>
                      </div>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
          <footer className={`${dialogFooterClassName} flex-wrap items-center`}>
            {busy ? (
              <>
                <LoaderCircle
                  className="size-4 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
                <Button
                  variant="outline"
                  disabled={stopping}
                  onClick={() => {
                    stopped.current = true
                    setStopping(true)
                  }}
                >
                  {stopping ? t('Stopping after the current reference…') : t('Stop')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={onClose}>
                  {t('Close')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void run(false)}
                  disabled={done === rows.length}
                >
                  {checked ? t('Search again') : t('Search')}
                </Button>
                <Button disabled={!ready} onClick={() => void run(true)}>
                  {mode === 'metadata' ? t('Apply metadata') : t('Add attachment')} ({ready})
                </Button>
              </>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export type { BatchLookupMode }
