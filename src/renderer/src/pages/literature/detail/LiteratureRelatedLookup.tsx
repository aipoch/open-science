import { CitationLookupError } from './CitationLookupError'
import { CitationAbstract } from './LiteratureDetailText'
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
import { createPortal } from 'react-dom'
import { BookOpen, Quote, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { ErrorNotice } from '@/components/error-notice'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { useLiteratureHost } from '../renderer-host'
import { LiteratureCitationGraph } from './LiteratureCitationGraph'
import {
  useCitationSource,
  type CitationProviderChoice,
  type CitationSourceState
} from './useCitationSource'
import { citationRecordProvider } from './citation-graph'
import type { ScheduleRequest } from './useCitationGraphController'

const firstPageReuseMs = 60_000

export function LiteratureRelatedLookup(
  props: React.ComponentProps<typeof LiteratureRelatedList> & { toolbarHost?: HTMLElement | null }
): React.JSX.Element {
  const [provider, setProvider] = useState<CitationProviderChoice>('europe-pmc')
  const [view, setView] = useState<'list' | 'graph'>('list')
  return (
    <LiteratureRelatedSession
      key={`${props.item.id}:${props.item.metadataRevision}:${provider}`}
      {...props}
      provider={provider}
      onProviderChange={setProvider}
      view={view}
      onViewChange={setView}
    />
  )
}

function LiteratureRelatedSession(
  props: React.ComponentProps<typeof LiteratureRelatedList> & {
    toolbarHost?: HTMLElement | null
    provider: CitationProviderChoice
    onProviderChange(provider: CitationProviderChoice): void
    view: 'list' | 'graph'
    onViewChange(view: 'list' | 'graph'): void
  }
): React.JSX.Element {
  const { t } = useTranslation()
  const { view, onViewChange: setView } = props
  const { source, requestRelated } = useCitationSource(props.provider)
  const [graphOpened, setGraphOpened] = useState(view === 'graph')
  const [listOpened, setListOpened] = useState(view === 'list')
  const graphStarted = useRef(false)
  const firstPage = useRef<{ response: LiteratureRelatedResult; receivedAt: number } | undefined>(
    undefined
  )
  const scheduleList = useCallback<ScheduleRequest>(
    async (request, shouldRun) => {
      const response = await requestRelated(request, shouldRun)
      if (response.issue === 'expired' || response.issue === 'reference-changed')
        firstPage.current = undefined
      if (
        !graphStarted.current &&
        !request.offset &&
        request.direction === 'references' &&
        !request.resolutionToken
      ) {
        firstPage.current =
          response.state === 'ready' && response.seed && response.resolutionToken
            ? { response, receivedAt: Date.now() }
            : undefined
      }
      return response
    },
    [requestRelated]
  )
  const scheduleGraph = useCallback<ScheduleRequest>(
    (request, shouldRun) => {
      graphStarted.current = true
      const page = firstPage.current
      firstPage.current = undefined
      if (
        page &&
        Date.now() - page.receivedAt < firstPageReuseMs &&
        shouldRun() &&
        !request.seedPaperId &&
        !request.resolutionToken &&
        !request.offset &&
        page.response.direction === request.direction
      )
        return Promise.resolve(page.response)
      return requestRelated(request, shouldRun)
    },
    [requestRelated]
  )
  const [referenceInvalidated, setReferenceInvalidated] = useState(false)
  const invalidatedReference = useRef(false)
  const isReferenceInvalidated = useCallback(() => invalidatedReference.current, [])
  const invalidateReference = useCallback(() => {
    invalidatedReference.current = true
    setReferenceInvalidated(true)
  }, [])
  const [saving, setSaving] = useState(false)
  const { onSavingChange } = props
  const handleSavingChange = useCallback(
    (value: boolean) => {
      setSaving(value)
      onSavingChange?.(value)
    },
    [onSavingChange]
  )
  const toolbar = (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2"
      role="group"
      aria-label={t('Citation discovery view')}
    >
      <div className="inline-flex shrink-0 rounded-lg border border-border-300 bg-muted/50 p-0.5">
        <Button
          size="sm"
          variant={view === 'list' ? 'secondary' : 'ghost'}
          aria-pressed={view === 'list'}
          disabled={saving}
          onClick={() => {
            setListOpened(true)
            setView('list')
          }}
        >
          {t('List')}
        </Button>
        <Button
          size="sm"
          variant={view === 'graph' ? 'secondary' : 'ghost'}
          aria-pressed={view === 'graph'}
          disabled={saving}
          onClick={() => {
            setGraphOpened(true)
            setView('graph')
          }}
        >
          {t('Citation graph')}
        </Button>
      </div>
      <Select
        value={props.provider}
        disabled={saving || referenceInvalidated}
        onValueChange={(value) => {
          if (!saving && !invalidatedReference.current)
            props.onProviderChange(value as CitationProviderChoice)
        }}
      >
        <SelectTrigger aria-label={t('Citation source')} className="w-auto max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="europe-pmc">{t('Europe PMC')}</SelectItem>
          <SelectItem value="opencitations">{t('OpenCitations · SKG-IF')}</SelectItem>
          <SelectItem value="opencitations-index">{t('OpenCitations · Index v2')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
  return (
    <div
      data-citation-graph-active={view === 'graph' ? '' : undefined}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {props.toolbarHost ? (
        createPortal(toolbar, props.toolbarHost)
      ) : (
        <div className="border-b border-border-300 px-3 py-2">{toolbar}</div>
      )}
      {source.opencitationsMode === 'index' ? (
        <p
          role="status"
          className="shrink-0 border-b border-border-300 px-5 py-2 text-xs text-muted-foreground"
        >
          {t(
            'OpenCitations Index merges records that share an identifier. Relationships and counts may differ from SKG-IF.'
          )}
        </p>
      ) : null}
      {referenceInvalidated ? (
        <ErrorNotice
          inline
          role="alert"
          className="mx-5 mt-3"
          description={t('This reference changed. Reopen its details and try again.')}
        />
      ) : null}
      <div
        hidden={view !== 'list'}
        style={{ display: view === 'list' ? undefined : 'none' }}
        className="flex min-h-0 flex-1 flex-col"
      >
        {listOpened && (
          <LiteratureRelatedList
            {...props}
            source={source}
            requestRelated={scheduleList}
            referenceInvalidated={referenceInvalidated}
            isReferenceInvalidated={isReferenceInvalidated}
            onReferenceChanged={invalidateReference}
            onSavingChange={handleSavingChange}
          />
        )}
      </div>
      {graphOpened ? (
        <div
          hidden={view !== 'graph'}
          style={{ display: view === 'graph' ? undefined : 'none' }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <LiteratureCitationGraph
            key={`${props.item.id}:${props.item.metadataRevision}`}
            item={props.item}
            provider={props.provider}
            source={source}
            requestRelated={scheduleGraph}
            onSaved={props.onSaved}
            onOpenInbox={props.onOpenInbox}
            onSavingChange={handleSavingChange}
            disabled={referenceInvalidated}
            onReferenceChanged={invalidateReference}
            referenceInvalidated={referenceInvalidated}
            isReferenceInvalidated={isReferenceInvalidated}
            visible={view === 'graph'}
          />
        </div>
      ) : null}
    </div>
  )
}

function LiteratureRelatedList({
  item,
  initialDirection,
  onSaved,
  onSavingChange,
  onOpenInbox,
  referenceInvalidated = false,
  isReferenceInvalidated,
  onReferenceChanged,
  source,
  requestRelated
}: {
  item: LiteratureItemView
  initialDirection: LiteratureRelatedRequest['direction']
  onSaved(): void
  onSavingChange?: (saving: boolean) => void
  onOpenInbox?: () => void
  referenceInvalidated?: boolean
  isReferenceInvalidated?: () => boolean
  onReferenceChanged?: () => void
  source?: CitationSourceState
  requestRelated?: ScheduleRequest
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const actualProvider = source?.provider
  const sourceName =
    actualProvider === 'europe-pmc'
      ? t('Europe PMC')
      : actualProvider === 'opencitations'
        ? source?.opencitationsMode === 'index'
          ? t('OpenCitations · Index v2')
          : t('OpenCitations · SKG-IF')
        : t('Europe PMC')
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
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onSavingChange?.(false)
    }
  }, [onSavingChange])
  const lookup = useCallback(
    async (
      nextDirection: LiteratureRelatedRequest['direction'],
      nextOffset = 0,
      token?: string
    ): Promise<void> => {
      if (
        inFlight.current ||
        savingRef.current ||
        referenceInvalidated ||
        isReferenceInvalidated?.()
      )
        return
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
          await (requestRelated ?? ((request) => api.literature.related(request)))(
            {
              itemId: item.id,
              expectedMetadataRevision: item.metadataRevision,
              direction: nextDirection,
              offset: nextOffset,
              resolutionToken: token
            },
            () => mounted.current && current === generation.current && !isReferenceInvalidated?.()
          )
        )
        if (
          response.itemId !== item.id ||
          response.metadataRevision !== item.metadataRevision ||
          response.direction !== nextDirection
        )
          throw new Error('Citation discovery identity mismatch.')
        if (current === generation.current) {
          if (response.issue === 'reference-changed') onReferenceChanged?.()
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
    [
      api,
      requestRelated,
      item.id,
      item.metadataRevision,
      onReferenceChanged,
      referenceInvalidated,
      isReferenceInvalidated
    ]
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
    if (
      savingRef.current ||
      inFlight.current ||
      !result ||
      referenceInvalidated ||
      isReferenceInvalidated?.()
    )
      return
    savingRef.current = true
    setSaving(true)
    onSavingChange?.(true)
    const current = generation.current
    try {
      for (const entry of result.records.filter((entry) => selected.has(entry.paperId))) {
        if (current !== generation.current || isReferenceInvalidated?.()) break
        let receipt: LiteratureCatalogReceipt | 'failed'
        try {
          receipt = await api.literature.transact({
            kind: 'stage-candidate',
            candidate: {
              item: entry.item,
              source: {
                provider: citationRecordProvider(entry.paperId),
                externalId: entry.paperId,
                sourceUrl: entry.item.url,
                rawMetadata: {
                  rootItemId: item.id,
                  rootMetadataRevision: item.metadataRevision,
                  seedItemId: item.id,
                  seedPaperId: result.seed?.paperId,
                  ...(citationRecordProvider(entry.paperId) === 'opencitations'
                    ? { lookupMode: result.opencitationsMode ?? 'skg-if' }
                    : {}),
                  direction
                }
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
      if (mounted.current) {
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
  const invalidated = referenceInvalidated || issue === 'expired' || issue === 'reference-changed'
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-300 px-5">
        <Tabs.List className="flex gap-5" aria-label={t('Citation discovery')}>
          {(['references', 'citations'] as const).map((value) => {
            const Icon = value === 'references' ? BookOpen : Quote
            return (
              <Tabs.Trigger
                key={value}
                value={value}
                disabled={busy || saving || referenceInvalidated}
                className="flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent py-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none data-[state=active]:border-primary data-[state=active]:text-primary"
              >
                <Icon className="size-4" aria-hidden="true" />
                {value === 'references' ? t('References') : t('Cited by')}
              </Tabs.Trigger>
            )
          })}
        </Tabs.List>
        <span className="sr-only">{t('Source: {{source}}', { source: sourceName })}</span>
        {result?.state === 'ready' ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('Loaded: {{loaded}}', { loaded: result.records.length })}
          </span>
        ) : null}
      </div>
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
          <CitationLookupError
            result={result}
            sourceName={sourceName}
            inline={false}
            disabled={busy || saving || referenceInvalidated}
            loading={busy && busyVisible}
            onRetry={() => void lookup(direction, 0)}
          />
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
                        {t('Open in {{source}}', { source: sourceName })}
                      </ExternalTextLink>
                      <CitationAbstract text={entry.item.abstract} className="mt-2" />
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
            {t(
              '{{source}} did not provide relationships for this page; the paper may still have references or citations.',
              { source: sourceName }
            )}
          </p>
        ) : null}
        {result?.state === 'ready' ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t('Loaded results only; source coverage may be incomplete.')}
          </p>
        ) : null}
        {!busy && result?.omitted ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t(
              'Some relationships could not be matched to a record in {{source}} and are not shown.',
              { source: sourceName }
            )}
          </p>
        ) : null}
        {loadError ? (
          <div className="mt-4">
            <CitationLookupError
              result={loadError}
              sourceName={sourceName}
              disabled={busy || saving || referenceInvalidated}
              loading={busy}
              onRetry={() =>
                void lookup(
                  direction,
                  invalidated ? 0 : result?.nextOffset,
                  invalidated ? undefined : result?.resolutionToken
                )
              }
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
