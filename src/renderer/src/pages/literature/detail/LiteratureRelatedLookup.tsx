import { CitationLookupLoading, CitationPageActionLabel } from './CitationLookupLoading'
import { CitationLookupError } from './CitationLookupError'
import { CitationAbstract } from './LiteratureDetailText'
import { fullCreatorLabel, publicationSummary } from '../literature-item-display'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { BookOpen, LibraryBig, List, Quote, Share2 } from 'lucide-react'
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
import {
  buildCitationGraph,
  citationRecordProvider,
  supplementedCitation,
  type CitationMetadata
} from './citation-graph'
import type { ScheduleRequest } from './useCitationGraphController'

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
  const [paperMetadata] = useState<CitationMetadata>(() => new Map())
  const [graphOpened, setGraphOpened] = useState(view === 'graph')
  const [listOpened, setListOpened] = useState(view === 'list')
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
  const sources = [
    { value: 'europe-pmc', label: t('Europe PMC') },
    { value: 'opencitations', label: t('OpenCitations · SKG-IF') },
    { value: 'opencitations-index', label: t('OpenCitations · Index v2') }
  ]
  const toolbar = (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <div
        role="group"
        aria-label={t('Citation discovery view')}
        className="inline-flex shrink-0 rounded-lg border border-border-300 bg-muted/50 p-0.5"
      >
        <Button
          size="sm"
          className="px-2"
          variant={view === 'list' ? 'default' : 'ghost'}
          aria-pressed={view === 'list'}
          disabled={saving}
          onClick={() => {
            setListOpened(true)
            setView('list')
          }}
        >
          <List data-icon="inline-start" aria-hidden="true" />
          {t('List')}
        </Button>
        <Button
          size="sm"
          className="px-2"
          variant={view === 'graph' ? 'default' : 'ghost'}
          aria-pressed={view === 'graph'}
          disabled={saving}
          onClick={() => {
            setGraphOpened(true)
            setView('graph')
          }}
        >
          <Share2 data-icon="inline-start" aria-hidden="true" />
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
        <SelectTrigger aria-label={t('Citation source')} className="w-auto max-w-full px-2">
          <LibraryBig className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sources.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
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
            paperMetadata={paperMetadata}
            source={source}
            requestRelated={requestRelated}
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
            item={props.item}
            provider={props.provider}
            paperMetadata={paperMetadata}
            source={source}
            requestRelated={requestRelated}
            onSaved={props.onSaved}
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
  paperMetadata,
  onSaved,
  onSavingChange,
  onOpenInbox,
  referenceInvalidated = false,
  isReferenceInvalidated,
  onReferenceChanged,
  source,
  disabled = false,
  requestRelated
}: {
  item: LiteratureItemView
  paperMetadata?: CitationMetadata
  initialDirection: LiteratureRelatedRequest['direction']
  onSaved(): void
  onSavingChange?: (saving: boolean) => void
  onOpenInbox?: () => void
  referenceInvalidated?: boolean
  isReferenceInvalidated?: () => boolean
  onReferenceChanged?: () => void
  source?: CitationSourceState
  disabled?: boolean
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
  const [pageCount, setPageCount] = useState(0)
  const [directions, setDirections] = useState<
    Partial<
      Record<
        LiteratureRelatedRequest['direction'],
        {
          result?: LiteratureRelatedResult
          loadError?: LiteratureRelatedResult
          selected: Set<string>
          scroll: number
          pages: number
        }
      >
    >
  >({})
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = directions[direction]?.scroll ?? 0
  }, [direction, directions])
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
      if (!nextOffset) {
        setLoadError(undefined)
        setPageCount(0)
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
          if (response.state === 'ready') {
            setPageCount((count) => count + 1)
            setLoadError(undefined)
          }
          if (response.issue === 'reference-changed') onReferenceChanged?.()
          if (nextOffset && response.state === 'unavailable') setLoadError(response)
          else
            setResult((previous) => {
              const merged =
                nextOffset && previous && response.state === 'ready'
                  ? {
                      ...response,
                      records: [...previous.records, ...response.records],
                      omitted: (previous.omitted ?? 0) + (response.omitted ?? 0)
                    }
                  : response
              return {
                ...merged,
                records: [
                  ...new Map(merged.records.map((record) => [record.paperId, record])).values()
                ]
              }
            })
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
  const otherDirection = direction === 'references' ? 'citations' : 'references'
  const other = directions[otherDirection]?.result
  const listNodes = useMemo(() => {
    if (!result?.seed || result.state !== 'ready')
      return (result?.records ?? []).map((record) => ({
        record,
        paperIds: [record.paperId],
        conflicting: false
      }))
    const entries = result.records.map((record) => ({ direction, record }))
    if (other?.resolutionToken && other.resolutionToken === result.resolutionToken)
      entries.push(
        ...other.records.map((record) => ({ direction: otherDirection, record }) as const)
      )
    return buildCitationGraph(result.seed, entries).nodes.filter(
      (node) => node.relation === direction || node.relation === 'both'
    )
  }, [result, direction, other, otherDirection])
  const selectedNodes = listNodes.filter(
    (node) => !node.conflicting && node.paperIds.some((id) => selected.has(id))
  )
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
      for (const node of selectedNodes) {
        const entry = node.record
        if (current !== generation.current || isReferenceInvalidated?.()) break
        let receipt: LiteratureCatalogReceipt | 'failed'
        try {
          const supplemented = supplementedCitation(entry.item, paperMetadata)
          receipt = await api.literature.transact({
            kind: 'stage-candidate',
            candidate: {
              item: supplemented.item,
              source: {
                provider: citationRecordProvider(entry.paperId),
                externalId: entry.paperId,
                sourceUrl: entry.item.url,
                rawMetadata: {
                  ...(supplemented.reference && { metadataLookup: supplemented.reference }),
                  ...(entry.retrievedAt !== undefined ? { retrievedAt: entry.retrievedAt } : {}),
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
              node.paperIds.forEach((id) => next.delete(id))
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
        if (value === direction || disabled) return
        setDirections({
          ...directions,
          [direction]: {
            result,
            loadError,
            selected,
            scroll: scrollRef.current?.scrollTop ?? 0,
            pages: pageCount
          }
        })
        const next = value as typeof direction
        const cached = directions[next]
        if (cached) {
          setDirection(next)
          setResult(cached.result)
          setLoadError(cached.loadError)
          setSelected(cached.selected)
          setPageCount(cached.pages)
        } else void lookup(next, 0, result?.state === 'ready' ? result.resolutionToken : undefined)
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
                disabled={disabled || busy || saving || referenceInvalidated}
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
            {t('Loaded: {{loaded}}', { loaded: listNodes.length })}
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
          <CitationLookupLoading direction={direction} />
        ) : result?.state === 'unavailable' ? (
          <CitationLookupError
            result={result}
            sourceName={sourceName}
            inline={false}
            disabled={disabled || busy || saving || referenceInvalidated}
            loading={busy && busyVisible}
            onRetry={() => void lookup(direction, 0)}
          />
        ) : listNodes.length ? (
          <ul className="divide-y divide-border-300">
            {listNodes.map((node) => {
              const entry = node.record
              const receipt =
                node.paperIds
                  .map((id) => receipts[id])
                  .find((value) => value && value !== 'failed') ?? receipts[entry.paperId]
              return (
                <li key={entry.paperId} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-primary"
                      aria-label={t('Select {{title}}', { title: entry.item.title })}
                      checked={!node.conflicting && node.paperIds.some((id) => selected.has(id))}
                      disabled={
                        disabled ||
                        saving ||
                        invalidated ||
                        node.conflicting ||
                        (receipt !== undefined && receipt !== 'failed')
                      }
                      onChange={(event) =>
                        setSelected((previous) => {
                          const next = new Set(previous)
                          if (event.target.checked) next.add(entry.paperId)
                          else node.paperIds.forEach((id) => next.delete(id))
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
                      {node.conflicting && (
                        <p className="text-xs">{t('Conflicting identifiers')}</p>
                      )}
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
              disabled={disabled || busy || saving || referenceInvalidated}
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
        ) : result?.nextOffset !== undefined && pageCount >= 5 ? (
          <p role="status" className="mt-3 text-xs text-muted-foreground">
            {t(
              'Loaded 5 pages for this direction (up to 100 relationships). Explore the other direction or another paper.'
            )}
          </p>
        ) : result?.nextOffset !== undefined ? (
          <div className="mt-5 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || busy || saving}
              onClick={() => void lookup(direction, result.nextOffset, result.resolutionToken)}
            >
              <CitationPageActionLabel loading={busy} />
            </Button>
          </div>
        ) : null}
      </Tabs.Content>
      {listNodes.length ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-300 px-5 py-3">
          {onOpenInbox &&
          Object.values(receipts).some(
            (receipt) => receipt !== 'failed' && receipt.kind === 'candidate'
          ) ? (
            <Button size="sm" variant="outline" disabled={disabled || saving} onClick={onOpenInbox}>
              {t('Open Inbox')}
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={disabled || busy || saving || invalidated || !selectedNodes.length}
            onClick={() => void save()}
          >
            {saving ? t('Saving…') : t('Add selected to Inbox')}
          </Button>
        </div>
      ) : null}
    </Tabs.Root>
  )
}
