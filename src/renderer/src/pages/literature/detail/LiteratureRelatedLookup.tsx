import { fullCreatorLabel, publicationSummary } from '../literature-item-display'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LiteratureItemView,
  LiteratureCatalogReceipt
} from '@aipoch/literature-library/contracts'
import {
  literatureRelatedResultSchema,
  type LiteratureRelatedResult,
  type LiteratureRelatedRequest
} from '@aipoch/literature-discovery/contracts'
import { Tabs } from 'radix-ui'
import { BookOpen, Quote, Info, LoaderCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { useLiteratureHost } from '../renderer-host'
import { MaskedPasswordField } from '../../settings/MaskedPasswordField'

export function LiteratureRelatedLookup({
  item,
  initialDirection,
  onSaved,
  onSavingChange,
  onOpenInbox,
  credentialsOpen = false,
  credentialFormId,
  onOpenCredentials,
  onCloseCredentials
}: {
  item: LiteratureItemView
  initialDirection: LiteratureRelatedRequest['direction']
  onSaved(): void
  onSavingChange?: (saving: boolean) => void
  onOpenInbox?: () => void
  credentialsOpen?: boolean
  credentialFormId?: string
  onOpenCredentials?: () => void
  onCloseCredentials?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api, useSettingsStore } = useLiteratureHost()
  const hasApiKey = useSettingsStore((state) => state.semanticScholar?.hasApiKey)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  useEffect(() => {
    // Unknown credential status must not be presented as a missing key.
    void loadConnectors().catch(() => undefined)
  }, [loadConnectors])
  const showCredentialHint = hasApiKey === false && !credentialsOpen && onOpenCredentials
  const [direction, setDirection] = useState(initialDirection)
  const [result, setResult] = useState<LiteratureRelatedResult>()
  const [loadError, setLoadError] = useState<LiteratureRelatedResult>()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [receipts, setReceipts] = useState<Record<string, LiteratureCatalogReceipt | 'failed'>>({})
  const [busy, setBusy] = useState(false)
  const [busyVisible, setBusyVisible] = useState(false)
  useEffect(() => {
    if (!busy) return
    // Cached responses and local cooldowns should not flash a loading screen.
    const timer = setTimeout(() => setBusyVisible(true), 200)
    return () => clearTimeout(timer)
  }, [busy])
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const savingRef = useRef(false)
  useEffect(() => () => onSavingChange?.(false), [onSavingChange])
  const lookup = useCallback(
    async (
      nextDirection: LiteratureRelatedRequest['direction'],
      nextOffset = 0,
      token?: string
    ): Promise<void> => {
      if (inFlight.current || savingRef.current) return
      const current = ++generation.current
      inFlight.current = true
      setBusyVisible(false)
      setBusy(true)
      setLoadError(undefined)
      if (!nextOffset) {
        setSelected(new Set())
        setResult((previous) => (previous?.state === 'unavailable' ? previous : undefined))
        if (scrollRef.current) scrollRef.current.scrollTop = 0
      }
      setDirection(nextDirection)
      try {
        const response = literatureRelatedResultSchema.parse(
          await api.literature.related({
            itemId: item.id,
            expectedMetadataRevision: item.metadataRevision,
            direction: nextDirection,
            offset: nextOffset,
            resolutionToken: token
          })
        )
        if (
          response.itemId !== item.id ||
          response.metadataRevision !== item.metadataRevision ||
          response.direction !== nextDirection
        )
          throw new Error('Citation discovery identity mismatch.')
        if (current === generation.current) {
          if (nextOffset && response.state === 'unavailable') setLoadError(response)
          else
            setResult((previous) =>
              nextOffset && previous && response.state === 'ready'
                ? {
                    ...response,
                    records: [
                      ...previous.records,
                      ...response.records.filter(
                        (entry) => !previous.records.some((old) => old.paperId === entry.paperId)
                      )
                    ],
                    omitted: (previous.omitted ?? 0) + (response.omitted ?? 0)
                  }
                : response
            )
        }
      } catch {
        if (current === generation.current)
          (nextOffset ? setLoadError : setResult)({
            itemId: item.id,
            metadataRevision: item.metadataRevision,
            direction: nextDirection,
            state: 'unavailable',
            records: [],
            issue: 'unavailable'
          })
      } finally {
        if (current === generation.current) {
          inFlight.current = false
          setBusy(false)
        }
      }
    },
    [api, item.id, item.metadataRevision]
  )
  useEffect(() => {
    let active = true
    const counter = generation
    const pending = inFlight
    queueMicrotask(() => {
      if (active) void lookup(initialDirection)
    })
    return () => {
      active = false
      counter.current++
      pending.current = false
    }
  }, [lookup, initialDirection])
  const save = async (): Promise<void> => {
    if (savingRef.current || inFlight.current || !result) return
    savingRef.current = true
    setSaving(true)
    onSavingChange?.(true)
    const current = generation.current
    try {
      for (const entry of result.records.filter((entry) => selected.has(entry.paperId))) {
        if (current !== generation.current) break
        let receipt: LiteratureCatalogReceipt | 'failed'
        try {
          receipt = await api.literature.transact({
            kind: 'stage-candidate',
            candidate: {
              item: entry.item,
              source: {
                provider: 'semantic-scholar',
                externalId: entry.paperId,
                sourceUrl: entry.item.url,
                rawMetadata: { seedItemId: item.id, seedPaperId: result.seed?.paperId, direction }
              },
              origin: { kind: 'manual-discovery' }
            }
          })
        } catch {
          receipt = 'failed'
        }
        if (current === generation.current) {
          setReceipts((previous) => ({ ...previous, [entry.paperId]: receipt }))
          if (receipt !== 'failed')
            setSelected((previous) => {
              const next = new Set(previous)
              next.delete(entry.paperId)
              return next
            })
        }
      }
      onSaved()
    } finally {
      savingRef.current = false
      if (current === generation.current) {
        setSaving(false)
        onSavingChange?.(false)
      }
    }
  }
  const receiptLabel = (receipt: LiteratureCatalogReceipt | 'failed'): string =>
    receipt === 'failed'
      ? t('Could not add this reference. Try again.')
      : receipt.kind === 'item' || receipt.state === 'accepted'
        ? t('Already in Library')
        : receipt.state === 'dismissed'
          ? t('Previously dismissed; review it in Inbox.')
          : t('In Inbox')
  const issue = loadError?.issue ?? result?.issue
  const invalidated = issue === 'expired' || issue === 'reference-changed'
  const credentialAction =
    !showCredentialHint &&
    !credentialsOpen &&
    onOpenCredentials &&
    (issue === 'rate-limited' || issue === 'authentication')
      ? { label: t('Configure API key'), onClick: onOpenCredentials }
      : undefined
  const errorMessage =
    issue === 'rate-limited'
      ? t('Semantic Scholar is rate limiting requests. Try again later or add an API key above.')
      : issue === 'authentication'
        ? t('Semantic Scholar rejected the API key. Update it above.')
        : issue === 'no-match'
          ? t('No matching paper was found in Semantic Scholar.')
          : issue === 'reference-changed'
            ? t('This reference changed. Reopen its details and try again.')
            : issue === 'expired'
              ? t('These results expired. Search again.')
              : t('Citation discovery is temporarily unavailable. Try again.')
  return (
    <Tabs.Root
      value={direction}
      activationMode="manual"
      onValueChange={(value) => {
        if (value !== direction)
          void lookup(
            value as typeof direction,
            0,
            result?.state === 'ready' ? result.resolutionToken : undefined
          )
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border-300 px-5">
        <Tabs.List className="flex gap-5" aria-label={t('Citation discovery')}>
          {(['references', 'citations'] as const).map((value) => {
            const Icon = value === 'references' ? BookOpen : Quote
            return (
              <Tabs.Trigger
                key={value}
                value={value}
                disabled={busy || saving || credentialsOpen}
                className="flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent py-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none data-[state=active]:border-primary data-[state=active]:text-primary"
              >
                <Icon className="size-4" aria-hidden="true" />
                {value === 'references' ? t('References') : t('Cited by')}
              </Tabs.Trigger>
            )
          })}
        </Tabs.List>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t(
                  'Source: Semantic Scholar. Coverage may be incomplete. Selected references go to Inbox for review.'
                )}
                className="flex shrink-0 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="hidden sm:inline">{t('Semantic Scholar')}</span>
                <Info className="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {t(
                'Source: Semantic Scholar. Coverage may be incomplete. Selected references go to Inbox for review.'
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {showCredentialHint ? (
        <div
          data-slot="citation-key-hint"
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border-300 bg-muted/30 px-5 py-2"
        >
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" aria-hidden="true" />
            {t('An API key is optional but recommended.')}
          </p>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            disabled={saving}
            onClick={onOpenCredentials}
          >
            {t('Configure API key')}
          </Button>
        </div>
      ) : null}
      {credentialsOpen && onCloseCredentials ? (
        <SemanticScholarCredentialForm
          id={credentialFormId}
          disabled={busy || saving}
          onCancel={onCloseCredentials}
          onSaved={() => {
            onCloseCredentials()
            if (loadError)
              void lookup(
                direction,
                invalidated ? 0 : result?.nextOffset,
                invalidated ? undefined : result?.resolutionToken
              )
            else if (result?.state === 'unavailable') void lookup(direction)
          }}
        />
      ) : null}
      <Tabs.Content
        forceMount
        value={direction}
        ref={scrollRef}
        className="m-0 min-h-0 flex-1 overflow-y-auto px-5 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-busy={busy}
      >
        <p className="sr-only">
          {direction === 'references'
            ? t('Papers referenced by this paper.')
            : t('Papers that cite this paper.')}
        </p>
        {busy && busyVisible && !result ? (
          <div data-slot="citation-loading" role="status" className="space-y-5">
            <div className="flex items-start gap-3 py-2">
              <LoaderCircle
                className="mt-0.5 size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('Searching…')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {direction === 'references'
                    ? t('Papers referenced by this paper.')
                    : t('Papers that cite this paper.')}
                </p>
              </div>
            </div>
            <div aria-hidden="true" className="divide-y divide-border-300">
              {['w-4/5', 'w-3/5', 'w-5/6', 'w-2/3'].map((width) => (
                <div key={width} className="flex gap-3 py-5 first:pt-0">
                  <div className="mt-0.5 size-4 shrink-0 rounded bg-muted" />
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className={`h-3.5 rounded bg-muted ${width}`} />
                    <div className="h-3 w-1/2 rounded bg-muted" />
                    <div className="h-2.5 w-20 rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : result?.state === 'unavailable' ? (
          <ErrorNotice
            role="alert"
            description={errorMessage}
            secondaryButton={credentialAction}
            primaryButton={{
              label: t('Retry'),
              disabled: busy || saving,
              loading: busy && busyVisible,
              onClick: () => void lookup(direction, 0)
            }}
          />
        ) : result?.state === 'match-required' && result.seed ? (
          <div className="space-y-4">
            <h3 className="font-medium">{t('Is this the same paper?')}</h3>
            <p className="text-sm text-muted-foreground">
              {t(
                'Confirm this title match before looking up citation relationships. Your saved metadata will not change.'
              )}
            </p>
            <p className="text-sm">{item.item.title}</p>
            <div className="rounded-lg border border-border-300 p-4">
              <p className="font-medium">{result.seed.item.title}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {[fullCreatorLabel(result.seed.item), publicationSummary(result.seed.item)]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <ExternalTextLink href={result.seed.item.url}>{t('View source')}</ExternalTextLink>
            </div>
            <Button onClick={() => void lookup(direction, 0, result.resolutionToken)}>
              {t('Same paper, show relationships')}
            </Button>
          </div>
        ) : result?.records.length ? (
          <ul className="divide-y divide-border-300">
            {result.records.map((entry) => {
              const receipt = receipts[entry.paperId]
              return (
                <li key={entry.paperId} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-primary"
                      aria-label={t('Select {{title}}', { title: entry.item.title })}
                      checked={selected.has(entry.paperId)}
                      disabled={
                        saving || invalidated || (receipt !== undefined && receipt !== 'failed')
                      }
                      onChange={(event) =>
                        setSelected((previous) => {
                          const next = new Set(previous)
                          if (event.target.checked) next.add(entry.paperId)
                          else next.delete(entry.paperId)
                          return next
                        })
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{entry.item.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {[fullCreatorLabel(entry.item), publicationSummary(entry.item)]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      <ExternalTextLink href={entry.item.url} className="text-xs">
                        {t('View source')}
                      </ExternalTextLink>
                      {entry.item.abstract ? (
                        <details className="mt-2 text-sm">
                          <summary className="cursor-pointer">{t('Abstract')}</summary>
                          <p className="mt-2 whitespace-pre-wrap">{entry.item.abstract}</p>
                        </details>
                      ) : null}
                      {receipt ? (
                        <p role="status" className="mt-2 text-xs">
                          {receiptLabel(receipt)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : result?.state === 'ready' ? (
          <p className="text-sm text-muted-foreground">
            {t('No citation relationships were returned for this page.')}
          </p>
        ) : null}
        {!busy && result?.omitted ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t('Some relationships have no identifiable paper and cannot be added.')}
          </p>
        ) : null}
        {loadError ? (
          <div className="mt-4">
            <ErrorNotice
              inline
              role="alert"
              description={errorMessage}
              secondaryButton={credentialAction}
              primaryButton={{
                label: t('Retry'),
                disabled: busy || saving,
                loading: busy,
                onClick: () =>
                  void lookup(
                    direction,
                    invalidated ? 0 : result?.nextOffset,
                    invalidated ? undefined : result?.resolutionToken
                  )
              }}
            />
          </div>
        ) : result?.nextOffset !== undefined ? (
          <div className="mt-5 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || saving}
              onClick={() => void lookup(direction, result.nextOffset, result.resolutionToken)}
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
              {busy ? t('Loading…') : t('Load more')}
            </Button>
          </div>
        ) : null}
      </Tabs.Content>
      {result?.records.length ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-300 px-5 py-3">
          {onOpenInbox &&
          Object.values(receipts).some(
            (receipt) => receipt !== 'failed' && receipt.kind === 'candidate'
          ) ? (
            <Button size="sm" variant="outline" disabled={saving} onClick={onOpenInbox}>
              {t('Open Inbox')}
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={busy || saving || invalidated || !selected.size}
            onClick={() => void save()}
          >
            {saving ? t('Saving…') : t('Add selected to Inbox')}
          </Button>
        </div>
      ) : null}
    </Tabs.Root>
  )
}

function SemanticScholarCredentialForm({
  id,
  disabled,
  onCancel,
  onSaved
}: {
  id?: string
  disabled: boolean
  onCancel(): void
  onSaved(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { useSettingsStore } = useLiteratureHost()
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const saveCredential = useSettingsStore((state) => state.setSemanticScholarCredential)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const active = useRef(true)
  const submitting = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const submit = async (): Promise<void> => {
    if (submitting.current || disabled || !key.trim() || !encryptionAvailable) return
    submitting.current = true
    setBusy(true)
    setError(false)
    try {
      await saveCredential({ apiKey: key.trim() })
      if (active.current) {
        setKey('')
        onSaved()
      }
    } catch {
      if (active.current) setError(true)
    } finally {
      submitting.current = false
      if (active.current) setBusy(false)
    }
  }
  return (
    <form
      id={id}
      aria-label={t('Semantic Scholar settings')}
      className="shrink-0 space-y-2 border-b border-border-300 bg-muted/30 px-5 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{t('API key')}</span>
        <ExternalTextLink href="https://www.semanticscholar.org/product/api">
          {t('Get an API key')}
        </ExternalTextLink>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <MaskedPasswordField
          aria-label={t('API key')}
          autoFocus
          value={key}
          onChange={setKey}
          placeholder={t('Paste an API key')}
          disabled={busy}
          className="min-w-40 flex-1"
        />
        <Button
          type="submit"
          size="sm"
          disabled={busy || disabled || !key.trim() || !encryptionAvailable}
        >
          {busy ? t('Saving…') : t('Save key')}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </div>
      {!encryptionAvailable || error ? (
        <ErrorNotice
          inline
          role="alert"
          description={
            !encryptionAvailable
              ? t('Secure key storage is unavailable. Unlock the system keychain and try again.')
              : t('Could not save the Semantic Scholar API key.')
          }
        />
      ) : null}
    </form>
  )
}
