import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Circle,
  CircleCheck,
  ExternalLink,
  LoaderCircle,
  Search,
  Download,
  TriangleAlert
} from 'lucide-react'
import {
  LITERATURE_SUPPLEMENT_PROVIDERS,
  getSupplementDoi,
  mergeSupplementResults,
  literatureSupplementResultSchema,
  type LiteratureSupplementProvider,
  type LiteratureFullTextProgress,
  type LiteratureSupplementResult
} from '@aipoch/literature-discovery/contracts'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { noticeIconClassNames } from '@/components/ui/notice-chrome'
import { useLiteratureHost } from '../renderer-host'
import { LiteratureDownloadFileRow } from './LiteratureDownloadFileRow'

export function LiteratureSupplementLookup({
  item,
  onCompleteMetadata,
  onAdded
}: {
  item: LiteratureItemView
  onCompleteMetadata: () => void
  onAdded?: (item: LiteratureItemView) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const doi = getSupplementDoi(item.item.identifiers)
  const [results, setResults] = useState<
    Partial<Record<LiteratureSupplementProvider, LiteratureSupplementResult>>
  >({})
  const [pending, setPending] = useState<Set<LiteratureSupplementProvider>>(new Set())
  const [now, setNow] = useState(Date.now)
  const [selectedSources, setSelectedSources] = useState<Set<LiteratureSupplementProvider>>(
    new Set()
  )
  const sourceOrder = ['europe-pmc', 'datacite', 'figshare'] as const
  const [attachmentStates, setAttachmentStates] = useState<
    Record<string, 'adding' | 'added' | 'failed'>
  >({})
  const [attachmentProgress, setAttachmentProgress] = useState<
    Record<string, LiteratureFullTextProgress>
  >({})
  const attachmentsInFlight = useRef(new Set<string>())
  const generation = useRef(0)
  const inFlight = useRef(new Set<LiteratureSupplementProvider>())
  const lookup = useCallback(
    async (provider: LiteratureSupplementProvider): Promise<void> => {
      if (!doi || inFlight.current.has(provider)) return
      const current = generation.current
      inFlight.current.add(provider)
      setPending(new Set(inFlight.current))
      try {
        const result = literatureSupplementResultSchema.parse(
          await api.literature.supplements({
            itemId: item.id,
            expectedMetadataRevision: item.metadataRevision,
            provider
          })
        )
        if (
          result.itemId !== item.id ||
          result.metadataRevision !== item.metadataRevision ||
          result.provider !== provider ||
          (result.doi && result.doi !== doi)
        )
          throw new Error('Supplement query identity mismatch.')
        if (current === generation.current)
          setResults((previous) => ({ ...previous, [provider]: result }))
      } catch {
        if (current === generation.current)
          setResults((previous) => ({
            ...previous,
            [provider]: {
              itemId: item.id,
              metadataRevision: item.metadataRevision,
              provider,
              state: 'unavailable',
              records: previous[provider]?.records ?? [],
              issues: ['unavailable']
            }
          }))
      } finally {
        if (current === generation.current) {
          inFlight.current.delete(provider)
          setPending(new Set(inFlight.current))
          setNow(Date.now())
        }
      }
    },
    [api, item.id, item.metadataRevision, doi]
  )
  useEffect(() => {
    const current = ++generation.current
    // Defer admission so an immediately replaced or Strict Mode mount never starts requests.
    queueMicrotask(() => {
      if (generation.current !== current) return
      inFlight.current = new Set()
      setResults({})
      setSelectedSources(new Set())
      setAttachmentStates({})
      setAttachmentProgress({})
      attachmentsInFlight.current = new Set()
      setPending(new Set())
      if (doi) for (const provider of LITERATURE_SUPPLEMENT_PROVIDERS) void lookup(provider)
    })
    return () => {
      generation.current = current + 1
    }
  }, [doi, lookup])
  useEffect(() => {
    const ids = Object.keys(attachmentStates).filter((id) => attachmentStates[id] === 'adding')
    if (!ids.length) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      await Promise.all(
        ids.map(async (downloadId) => {
          try {
            const progress = await api.literature.supplementAttachmentProgress({
              itemId: item.id,
              expectedMetadataRevision: item.metadataRevision,
              downloadId
            })
            if (active && progress)
              setAttachmentProgress((previous) => ({ ...previous, [downloadId]: progress }))
          } catch {
            // A missed progress read must not turn a successful attachment into a failure.
          }
        })
      )
      if (active) timer = setTimeout(() => void poll(), 500)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, item.id, item.metadataRevision, attachmentStates])
  const addAttachment = async (downloadId: string): Promise<void> => {
    if (attachmentsInFlight.current.has(downloadId) || attachmentStates[downloadId] === 'added')
      return
    const current = generation.current
    attachmentsInFlight.current.add(downloadId)
    setAttachmentProgress((previous) => {
      const next = { ...previous }
      delete next[downloadId]
      return next
    })
    setAttachmentStates((previous) => ({ ...previous, [downloadId]: 'adding' }))
    try {
      await api.literature.supplementAttachment({
        itemId: item.id,
        expectedMetadataRevision: item.metadataRevision,
        downloadId
      })
      if (current !== generation.current) return
      setAttachmentStates((previous) => ({ ...previous, [downloadId]: 'added' }))
      const updated = await api.literature.get(item.id).catch(() => undefined)
      if (current === generation.current && updated?.id === item.id) onAdded?.(updated)
    } catch {
      if (current === generation.current)
        setAttachmentStates((previous) => ({ ...previous, [downloadId]: 'failed' }))
    } finally {
      if (current === generation.current) attachmentsInFlight.current.delete(downloadId)
    }
  }
  const cooldown = Object.values(results).some((result) => (result.retryAt ?? 0) > now)
  useEffect(() => {
    if (!cooldown) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [cooldown])
  const labels = { figshare: t('Figshare'), datacite: t('DataCite'), 'europe-pmc': t('Europe PMC') }
  const records = mergeSupplementResults(Object.values(results))
  const visibleRecords = records.filter(
    (record) =>
      !selectedSources.size || record.providers.some((provider) => selectedSources.has(provider))
  )
  const settled = LITERATURE_SUPPLEMENT_PROVIDERS.every(
    (provider) => results[provider] && !pending.has(provider)
  )
  const allFailed =
    settled && Object.values(results).every((result) => result.state === 'unavailable')
  const issueText = (issue: LiteratureSupplementResult['issues'][number]): string => {
    switch (issue) {
      case 'full-text-unavailable':
        return t('No readable article text is available from this source.')
      case 'search-incomplete':
        return t('The search limit was reached. Results may be incomplete.')
      case 'reference-changed':
        return t('This reference changed. Reopen it to search again.')
      case 'reference-unavailable':
        return t('This reference is no longer in your Library.')
      case 'doi-required':
        return t('Add one valid DOI to find supplementary materials.')
      case 'rate-limited':
        return t('This source is limiting requests. Wait before retrying.')
      default:
        return t('This source could not be checked. Other results remain available.')
    }
  }
  if (!doi)
    return (
      <div className="space-y-3 px-5 py-4 sm:px-6">
        <p>{t('Add one valid DOI to find supplementary materials.')}</p>
        <Button variant="outline" onClick={onCompleteMetadata}>
          {t('Complete metadata')}
        </Button>
      </div>
    )
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm sm:px-6">
      <p className="mb-4 break-all font-mono text-xs text-muted-foreground">{doi}</p>
      <section aria-label={t('Search sources')}>
        <h3 className="mb-2 font-medium">{t('Search sources')}</h3>
        <TooltipProvider>
          <div className="grid items-start gap-2 sm:grid-cols-3">
            {sourceOrder.map((provider) => {
              const result = results[provider]
              const loading = pending.has(provider)
              const retryAt = result?.retryAt ?? 0
              const status = loading
                ? t('Searching…')
                : !result
                  ? t('Not checked')
                  : result.state === 'complete'
                    ? t('Search completed')
                    : result.state === 'partial'
                      ? t('Partial results')
                      : t('Unavailable')
              const StatusIcon = loading
                ? LoaderCircle
                : !result
                  ? Circle
                  : result.state === 'complete'
                    ? CircleCheck
                    : result.state === 'partial'
                      ? TriangleAlert
                      : AlertCircle
              const issues = result?.issues.map(issueText).join(' ')
              return (
                <section
                  key={provider}
                  aria-label={labels[provider]}
                  className={`relative min-w-0 rounded-lg border px-3 py-2 transition-colors hover:bg-muted/50 ${selectedSources.has(provider) ? 'border-primary bg-primary/10' : 'border-border bg-muted/20'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={!result || loading}
                      aria-pressed={selectedSources.has(provider)}
                      className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left font-medium outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                      onClick={() =>
                        setSelectedSources((previous) => {
                          const next = new Set(previous)
                          if (next.has(provider)) next.delete(provider)
                          else next.add(provider)
                          return next
                        })
                      }
                    >
                      {labels[provider]}
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          role="status"
                          tabIndex={0}
                          className={`relative z-10 ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            !loading && result && result.state !== 'complete'
                              ? noticeIconClassNames[
                                  result.state === 'partial' ? 'warning' : 'error'
                                ]
                              : 'text-muted-foreground'
                          }`}
                        >
                          <StatusIcon
                            className={
                              loading
                                ? 'size-3.5 animate-spin motion-reduce:animate-none'
                                : 'size-3.5'
                            }
                            aria-hidden="true"
                          />
                          <span className="sr-only">{status}</span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[calc(100vw-2rem)]">
                        <p className="truncate">{issues || status}</p>
                      </TooltipContent>
                    </Tooltip>
                    {result && result.state !== 'complete' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="relative z-10 h-6 shrink-0 cursor-pointer px-1.5 text-xs"
                        disabled={loading || retryAt > now}
                        onClick={() => void lookup(provider)}
                        aria-label={t('Retry {{source}}', { source: labels[provider] })}
                      >
                        {retryAt > now
                          ? t('Retry in {{seconds}}s', {
                              seconds: Math.ceil((retryAt - now) / 1000)
                            })
                          : t('Retry')}
                      </Button>
                    ) : null}
                  </div>
                </section>
              )
            })}
          </div>
        </TooltipProvider>
      </section>
      <p className="my-4 text-xs leading-5 text-muted-foreground">
        {t('Click sources to filter results. Supplements may include figures, tables or datasets.')}
      </p>
      <section aria-label={t('Search results')} aria-busy={pending.size > 0} className="space-y-3">
        {allFailed ? (
          <ErrorNotice
            icon={AlertCircle}
            tone="amber"
            title={t('Supplementary material search failed.')}
            description={t('Check the source status above and retry an unavailable source.')}
          />
        ) : null}
        {settled && !allFailed && !records.length ? (
          <div
            role="status"
            className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-muted-foreground"
          >
            <Search className="size-8" aria-hidden="true" />
            <p>{t('No supplementary materials found in the searched sources.')}</p>
          </div>
        ) : null}
        {settled && Boolean(records.length) && !visibleRecords.length ? (
          <div
            role="status"
            className="flex min-h-48 flex-col items-center justify-center gap-3 text-muted-foreground"
          >
            <Search className="size-8" aria-hidden="true" />
            <p>{t('No results found')}</p>
          </div>
        ) : null}
        {visibleRecords.map((record) => (
          <article
            key={record.doi ?? `${record.providers[0]}:${record.id}`}
            className="space-y-3 rounded-lg border border-border p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h3 className="min-w-0 flex-1 break-words font-medium">{record.title}</h3>
              <Button asChild variant="ghost" size="sm">
                <a href={record.sourceUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  {t('Open source')}
                </a>
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {record.providers.map((provider) => (
                <span key={provider} className="rounded bg-muted px-2 py-1">
                  {labels[provider]}
                </span>
              ))}
              <span className="rounded bg-muted px-2 py-1">
                {record.evidence === 'article-section'
                  ? t('Article supplementary section')
                  : t('Source-declared supplement')}
              </span>
            </div>
            {record.doi ? (
              <p className="break-all font-mono text-xs text-muted-foreground">{record.doi}</p>
            ) : null}
            {record.files?.length ? (
              <ul className="space-y-1">
                {record.files.map((file, index) => {
                  const state = file.downloadId ? attachmentStates[file.downloadId] : undefined
                  const progress = file.downloadId ? attachmentProgress[file.downloadId] : undefined
                  return (
                    <li key={`${file.name}:${index}`}>
                      <LiteratureDownloadFileRow
                        name={file.name}
                        sizeBytes={file.sizeBytes}
                        adding={state === 'adding'}
                        progress={progress}
                      >
                        {file.downloadId ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="ml-auto h-7 shrink-0 text-xs"
                            disabled={state === 'added'}
                            onClick={() => void addAttachment(file.downloadId!)}
                          >
                            {state === 'added' ? (
                              <CircleCheck className="size-3.5" aria-hidden="true" />
                            ) : (
                              <Download className="size-3.5" aria-hidden="true" />
                            )}
                            {state === 'added' ? t('Attachment added') : t('Add attachment')}
                          </Button>
                        ) : null}
                      </LiteratureDownloadFileRow>
                      {state === 'failed' ? (
                        <ErrorNotice
                          inline
                          role="alert"
                          level="warning"
                          className="mt-2 text-xs"
                          description={t('Could not add attachment. Try again or open the source.')}
                        />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                {record.files
                  ? t('No files listed')
                  : t('File list not provided. Open the source to view files.')}
              </p>
            )}
          </article>
        ))}
      </section>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        {t('Matching DOIs are merged. Different version DOIs are shown separately.')}
      </p>
    </div>
  )
}
