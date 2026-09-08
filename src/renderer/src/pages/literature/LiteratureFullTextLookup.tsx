import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  Download,
  ExternalLink,
  FileUp,
  LoaderCircle,
  Search,
  Settings2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type {
  LiteratureFullTextCandidate,
  LiteratureFullTextProgress,
  LiteratureFullTextResult,
  LiteratureItemView
} from '../../../../shared/literature'
import { createLiteratureIdentifierUrl } from '../../../../shared/literature'
import { formatBytes } from '../../../../shared/update'
import { LiteratureOpenAlexCredential } from './LiteratureOpenAlexCredential'
import { UnpaywallCredentialForm } from '../settings/UnpaywallCredentialForm'
import { useSettingsStore } from '@/stores/settings-store'

export const LiteratureFullTextLookup = ({
  item,
  onAdded,
  onCompleteMetadata,
  onUpload
}: {
  item: LiteratureItemView
  onAdded: (item: LiteratureItemView) => void
  onCompleteMetadata: () => void
  onUpload: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<Extract<LiteratureFullTextResult, { mode: 'search' }>>()
  const [searching, setSearching] = useState(true)
  const [adding, setAdding] = useState<string>()
  const [savingCredential, setSavingCredential] = useState(false)
  const [editingUnpaywall, setEditingUnpaywall] = useState(false)
  const contactEmail = useSettingsStore((state) => state.ncbi.contactEmail)
  const [refreshingItem, setRefreshingItem] = useState(false)
  const [progress, setProgress] = useState<LiteratureFullTextProgress>()
  const [retryAfter, setRetryAfter] = useState<Record<string, number>>({})
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<'search' | 'runtime' | 'attach' | 'rate-limited'>()
  const lifecycle = useRef(0)
  const notifiedCandidate = useRef<string | undefined>(undefined)
  useEffect(() => {
    lifecycle.current += 1
    notifiedCandidate.current = undefined
    return () => {
      lifecycle.current += 1
    }
  }, [item.id])
  const notifyAdded = useCallback(
    (updated: LiteratureItemView, candidateId: string, transferId?: string): void => {
      if (updated.id !== item.id || notifiedCandidate.current === candidateId) return
      notifiedCandidate.current = candidateId
      onAdded(updated)
      if (transferId)
        void window.api.literature
          .fullText({ mode: 'transfer', itemId: item.id, acknowledgeId: transferId })
          .catch(() => undefined)
    },
    [item.id, onAdded]
  )
  const restoreFailure = useCallback(
    (candidate: LiteratureFullTextCandidate, retryAt?: number): void => {
      if (retryAt && retryAt > Date.now()) {
        setNow(Date.now())
        setRetryAfter((current) => ({ ...current, [new URL(candidate.url).origin]: retryAt }))
        setError('rate-limited')
      } else setError('attach')
    },
    []
  )
  const coolingDown = Object.values(retryAfter).some((until) => until > now)
  useEffect(() => {
    if (!coolingDown) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [coolingDown])
  useEffect(() => {
    if (!adding) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await window.api.literature.fullText({ mode: 'transfer', itemId: item.id })
        if (!active || response.mode !== 'transfer' || !response.transfer) return
        const task = response.transfer
        if (task.candidate.id !== adding) return
        setProgress(task.progress)
        setRefreshingItem(task.status === 'succeeded' && !response.item)
        if (task.status === 'succeeded' && response.item) {
          setAdding(undefined)
          notifyAdded(response.item, task.candidate.id, task.id)
        } else if (task.status === 'failed') {
          setAdding(undefined)
          restoreFailure(task.candidate, task.retryAt)
        }
      } catch {
        // The attach request owns errors. Missing telemetry must not interrupt the download.
      } finally {
        if (active) timer = setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [adding, item.id, notifyAdded, restoreFailure])
  useEffect(() => {
    let active = true
    void (async () => {
      if (typeof window.api.literature.fullText !== 'function') {
        throw new Error("No handler registered for 'literature:full-text'")
      }
      const response = await window.api.literature.fullText({ mode: 'transfer', itemId: item.id })
      if (!active) return
      if (response.mode === 'transfer' && response.transfer) {
        const task = response.transfer
        if (task.status === 'running' || (task.status === 'succeeded' && !response.item)) {
          setResult({ mode: 'search', candidates: [task.candidate], notices: [] })
          setProgress(task.progress)
          setRefreshingItem(task.status === 'succeeded')
          setAdding(task.candidate.id)
          return
        }
        if (task.status === 'succeeded' && response.item) {
          notifyAdded(response.item, task.candidate.id, task.id)
          return
        }
        if (task.status === 'failed') restoreFailure(task.candidate, task.retryAt)
      }
      const found = await window.api.literature.fullText({ mode: 'search', itemId: item.id })
      if (active && found.mode === 'search') setResult(found)
    })()
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error &&
              failure.message.includes("No handler registered for 'literature:full-text'")
              ? 'runtime'
              : 'search'
          )
      })
      .finally(() => {
        if (active) setSearching(false)
      })
    return () => {
      active = false
    }
  }, [item.id, item.metadataRevision, attempt, t, notifyAdded, restoreFailure])

  const retry = (): void => {
    setSearching(true)
    setResult(undefined)
    setError(undefined)
    setAttempt((value) => value + 1)
  }
  const attach = async (candidate: LiteratureFullTextCandidate): Promise<void> => {
    if (adding || savingCredential || (retryAfter[new URL(candidate.url).origin] ?? 0) > now) return
    const generation = lifecycle.current
    setAdding(candidate.id)
    setProgress(undefined)
    setRefreshingItem(false)
    setError(undefined)
    let awaitingItem = false
    try {
      const response = await window.api.literature.fullText({
        mode: 'attach',
        itemId: item.id,
        candidateId: candidate.id
      })
      if (generation !== lifecycle.current) return
      if (response.mode === 'transfer' && response.transfer?.status === 'succeeded') {
        awaitingItem = true
        setRefreshingItem(true)
        setProgress(response.transfer.progress)
      }
      if (response.mode === 'attach') notifyAdded(response.item, candidate.id, response.transferId)
      if (response.mode === 'attach-error') {
        setNow(Date.now)
        setRetryAfter((current) => ({
          ...current,
          [new URL(candidate.url).origin]: response.retryAt
        }))
        setError('rate-limited')
      }
    } catch {
      if (generation === lifecycle.current) setError('attach')
    } finally {
      if (generation === lifecycle.current && !awaitingItem) setAdding(undefined)
    }
  }

  const hasArxiv = item.item.identifiers.some(
    ({ scheme, value }) => scheme === 'arxiv' && createLiteratureIdentifierUrl('arxiv', value)
  )
  const hasBiomedicalIdentifier = item.item.identifiers.some(
    ({ scheme, value }) => ['doi', 'pmid', 'pmcid'].includes(scheme) && value.trim()
  )
  const missingIdentifiers =
    result?.notices.includes('missing-identifiers') ?? !(hasArxiv || hasBiomedicalIdentifier)
  const hasDoi = item.item.identifiers.some(({ scheme, value }) => scheme === 'doi' && value.trim())
  const europeUnavailable = result?.notices.includes('europe-pmc-unavailable')
  const openAlexUnavailable = result?.notices.includes('openalex-unavailable')
  const unpaywallUnavailable = result?.notices.includes('unpaywall-unavailable')
  const pmcUnavailable = result?.notices.includes('pmc-unavailable')
  const incomplete =
    result &&
    !result.candidates.length &&
    (europeUnavailable || openAlexUnavailable || unpaywallUnavailable || pmcUnavailable)
  const failed = error || incomplete
  const sourceStatus = (provider: LiteratureFullTextCandidate['provider']): string => {
    if (provider === 'arxiv')
      return hasArxiv ? t('Direct PDF link') : t('arXiv identifier required')
    if (missingIdentifiers || !hasBiomedicalIdentifier) return t('Needs identifiers')
    if ((provider === 'openalex' || provider === 'unpaywall') && !hasDoi) return t('DOI required')
    if (searching) return t('Searching…')
    if (!result) return t('Not checked')
    if (provider === 'openalex' && result.notices.includes('openalex-not-configured'))
      return t('API key required')
    if (provider === 'unpaywall' && result.notices.includes('unpaywall-not-configured'))
      return t('Contact email required')
    if (provider === 'pmc' && result.notices.includes('pmc-no-record')) return t('No PMC record')
    if (result.notices.includes(`${provider}-unavailable`)) return t('Unavailable')
    return t('Search completed')
  }
  const providerLabels = {
    'europe-pmc': t('Europe PMC'),
    openalex: t('OpenAlex'),
    unpaywall: t('Unpaywall'),
    pmc: t('PubMed Central'),
    arxiv: t('arXiv')
  }
  const versions = {
    published: t('Published version'),
    accepted: t('Accepted manuscript'),
    submitted: t('Submitted manuscript')
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="min-h-0 overflow-y-auto px-5 py-4 sm:px-6">
        <section aria-label={t('Search sources')}>
          <details className="group">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                className="size-3.5 transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              {t('Search sources')}
            </summary>
            <div className="mt-2 divide-y divide-border rounded-lg border border-border bg-muted/30 px-4">
              <div className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium">{t('Europe PMC')}</h4>
                  <span className="text-xs text-muted-foreground">
                    {sourceStatus('europe-pmc')}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t('Biomedical full text via DOI, PMID or PMCID. No API key required.')}
                </p>
                {europeUnavailable ? (
                  <p className="mt-1 text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground">
                    {t('Europe PMC is unavailable. Results may be incomplete.')}
                  </p>
                ) : null}
              </div>
              <div className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium">{t('OpenAlex')}</h4>
                  <span className="text-xs text-muted-foreground">{sourceStatus('openalex')}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t(
                    'Open-access PDFs from publishers and repositories. Requires a DOI and an API key.'
                  )}
                </p>
                {openAlexUnavailable ? (
                  <p className="mt-1 text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground">
                    {t('OpenAlex is unavailable. Results may be incomplete.')}
                  </p>
                ) : null}
                <LiteratureOpenAlexCredential
                  disabled={Boolean(adding) || savingCredential}
                  onSaved={retry}
                  onBusyChange={setSavingCredential}
                />
              </div>
              <div className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium">{t('Unpaywall')}</h4>
                  <span className="text-xs text-muted-foreground">{sourceStatus('unpaywall')}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t('Open-access PDFs via DOI. Requires a contact email; no API key needed.')}
                </p>
                {unpaywallUnavailable ? (
                  <p className="mt-1 text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground">
                    {t('Unpaywall is unavailable. Results may be incomplete.')}
                  </p>
                ) : null}
                {editingUnpaywall ? (
                  <div className="mt-3 border-t border-border pt-3">
                    <UnpaywallCredentialForm
                      disabled={Boolean(adding) || savingCredential}
                      onBusyChange={setSavingCredential}
                      onSaved={() => {
                        setEditingUnpaywall(false)
                        retry()
                      }}
                      onCancel={() => setEditingUnpaywall(false)}
                    />
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-3">
                    {contactEmail ? (
                      <span className="text-xs text-muted-foreground">{t('Configured')}</span>
                    ) : null}
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0 py-1 text-xs"
                      disabled={Boolean(adding) || savingCredential}
                      onClick={() => setEditingUnpaywall(true)}
                    >
                      <Settings2 className="size-3.5" aria-hidden="true" />
                      {contactEmail ? t('Edit') : t('Configure Unpaywall')}
                    </Button>
                  </div>
                )}
              </div>
              <div className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium">{t('PubMed Central')}</h4>
                  <span className="text-xs text-muted-foreground">{sourceStatus('pmc')}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t(
                    'Official NLM article PDFs, when available under the article license. No account or API key needed.'
                  )}
                </p>
                {pmcUnavailable ? (
                  <p className="mt-1 text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground">
                    {t('PubMed Central is unavailable. Results may be incomplete.')}
                  </p>
                ) : null}
              </div>
              <div className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium">{t('arXiv')}</h4>
                  <span className="text-xs text-muted-foreground">{sourceStatus('arxiv')}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t(
                    'Latest PDF via arXiv identifier. No API key required. The file is checked when downloaded.'
                  )}
                </p>
              </div>
            </div>
          </details>
        </section>
        <section
          className="py-5"
          aria-label={t('Search results')}
          aria-busy={searching || Boolean(adding)}
        >
          {searching ? (
            <div role="status" className="flex items-center gap-3 py-4 text-muted-foreground">
              <LoaderCircle
                className="size-5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              <p>{t('Searching for a matching full-text PDF…')}</p>
            </div>
          ) : failed ? (
            <div role="alert" className="mb-3">
              <ErrorNotice
                icon={AlertCircle}
                tone={error === 'runtime' ? 'teal' : 'amber'}
                title={
                  error === 'runtime'
                    ? t('Full-text search is not ready')
                    : error === 'attach' || error === 'rate-limited'
                      ? t('PDF could not be added')
                      : t('Full-text search failed. Try again.')
                }
                description={
                  error === 'runtime'
                    ? t('Restart Open Science to enable full-text search.')
                    : error === 'rate-limited'
                      ? t(
                          'This source is limiting downloads (HTTP 429). Wait before trying again, choose another source, or upload a PDF.'
                        )
                      : error === 'attach'
                        ? t(
                            'PDF could not be added. The link may have expired, require sign-in, or exceed 50 MB. Search again or upload a PDF.'
                          )
                        : t(
                            'Check the source status above and your connection, then try again. You can also add a PDF from your device.'
                          )
                }
                primaryButton={
                  error === 'runtime' || error === 'attach' || error === 'rate-limited'
                    ? undefined
                    : { label: t('Retry'), onClick: retry }
                }
              />
            </div>
          ) : missingIdentifiers ? (
            <div className="space-y-3 py-2">
              <p>
                {t('Add a DOI, PMID, PMCID or arXiv identifier to find a matching full-text PDF.')}
              </p>
              <Button variant="outline" onClick={onCompleteMetadata}>
                {t('Complete metadata')}
              </Button>
            </div>
          ) : result && result.candidates.length === 0 ? (
            <div role="status" className="space-y-2 py-2">
              <p className="font-medium">{t('No freely accessible full-text PDF was found.')}</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('Try another source or add a PDF from your device.')}
              </p>
            </div>
          ) : null}
          {adding && !refreshingItem ? (
            <p role="status" className="mb-3 text-xs text-muted-foreground">
              {t(
                'You can close this dialog. The download continues in the background; reopen it to see progress.'
              )}
            </p>
          ) : null}
          <div className="space-y-3">
            {result?.candidates.map((candidate) => (
              <section
                key={candidate.id}
                className="flex flex-col gap-4 rounded-lg border border-border p-4 sm:flex-row sm:items-start"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h3 className="font-medium break-words">{candidate.source}</h3>
                    <span className="break-all text-xs text-muted-foreground">
                      {new URL(candidate.sourceUrl ?? candidate.url).hostname}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground break-words">
                    {[
                      candidate.source === providerLabels[candidate.provider]
                        ? undefined
                        : providerLabels[candidate.provider],
                      candidate.version ? versions[candidate.version] : undefined,
                      candidate.license
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {adding === candidate.id ? (
                    <div role="status" className="mt-4 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {refreshingItem
                          ? t('PDF added. Refreshing attachment details…')
                          : progress?.phase === 'saving'
                            ? t('Checking and saving PDF…')
                            : t('Downloading PDF…')}
                      </p>
                      <progress
                        className="block h-1.5 w-full overflow-hidden rounded-full appearance-none bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
                        aria-label={t('Downloading PDF…')}
                        max={100}
                        value={
                          progress?.totalBytes
                            ? Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)
                            : undefined
                        }
                      />
                      {progress?.phase !== 'saving' ? (
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {progress?.totalBytes
                            ? t('{{downloaded}} of {{total}} · {{speed}}/s', {
                                downloaded: formatBytes(progress.receivedBytes),
                                total: formatBytes(progress.totalBytes),
                                speed: formatBytes(Math.round(progress.bytesPerSecond))
                              })
                            : t('{{downloaded}} downloaded · {{speed}}/s', {
                                downloaded: formatBytes(progress?.receivedBytes ?? 0),
                                speed: formatBytes(Math.round(progress?.bytesPerSecond ?? 0))
                              })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-2 sm:min-w-36">
                  <Button
                    size="sm"
                    disabled={
                      Boolean(adding) ||
                      savingCredential ||
                      (retryAfter[new URL(candidate.url).origin] ?? 0) > now
                    }
                    onClick={() => void attach(candidate)}
                  >
                    {adding === candidate.id ? (
                      <LoaderCircle
                        className="size-4 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <Download className="size-4" aria-hidden="true" />
                    )}
                    {adding === candidate.id
                      ? t('Adding PDF…')
                      : (retryAfter[new URL(candidate.url).origin] ?? 0) > now
                        ? t('Retry in {{seconds}}s', {
                            seconds: Math.ceil(
                              (retryAfter[new URL(candidate.url).origin]! - now) / 1000
                            )
                          })
                        : t('Add attachment')}
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={candidate.sourceUrl ?? new URL(candidate.url).origin}
                      target="_blank"
                      rel="noreferrer"
                      title={candidate.sourceUrl ?? new URL(candidate.url).origin}
                    >
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                      {t('Open source')}
                    </a>
                  </Button>
                </div>
              </section>
            ))}
          </div>
        </section>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 sm:px-6">
        <p className="max-w-sm text-xs leading-5 text-muted-foreground">
          {t('Existing attachments are kept. PDFs are added only after you confirm a source.')}
        </p>
        <div className="flex flex-wrap gap-2">
          {!failed && !missingIdentifiers ? (
            <Button
              variant="ghost"
              disabled={searching || Boolean(adding) || savingCredential}
              onClick={retry}
            >
              <Search className="size-4" aria-hidden="true" />
              {t('Search again')}
            </Button>
          ) : null}
          {error === 'attach' || error === 'rate-limited' ? (
            <Button variant="ghost" disabled={Boolean(adding) || savingCredential} onClick={retry}>
              {t('Search again')}
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={Boolean(adding) || savingCredential}
            onClick={onUpload}
          >
            <FileUp className="size-4" aria-hidden="true" />
            {t('Add PDF')}
          </Button>
        </div>
      </div>
    </div>
  )
}
