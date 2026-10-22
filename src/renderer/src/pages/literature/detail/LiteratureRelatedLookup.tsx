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
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { useLiteratureHost } from '../renderer-host'

export function LiteratureRelatedLookup({
  item,
  initialDirection,
  onSaved,
  onOpenInbox
}: {
  item: LiteratureItemView
  initialDirection: LiteratureRelatedRequest['direction']
  onSaved(): void
  onOpenInbox?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const [direction, setDirection] = useState(initialDirection)
  const [result, setResult] = useState<LiteratureRelatedResult>()
  const [offset, setOffset] = useState(0)
  const [pages, setPages] = useState<number[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [receipts, setReceipts] = useState<Record<string, LiteratureCatalogReceipt | 'failed'>>({})
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const savingRef = useRef(false)
  const lookup = useCallback(
    async (
      nextDirection: LiteratureRelatedRequest['direction'],
      nextOffset = 0,
      token?: string
    ): Promise<void> => {
      if (inFlight.current || savingRef.current) return
      const current = ++generation.current
      inFlight.current = true
      setBusy(true)
      setSelected(new Set())
      setDirection(nextDirection)
      setOffset(nextOffset)
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
        if (current === generation.current) setResult(response)
      } catch {
        if (current === generation.current)
          setResult({
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
      if (current === generation.current) setSaving(false)
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
  const issue = result?.issue
  const errorMessage =
    issue === 'rate-limited'
      ? t(
          'Semantic Scholar is rate limiting requests. Try again later or add an API key in Settings / Credentials.'
        )
      : issue === 'authentication'
        ? t('Semantic Scholar rejected the API key. Update it in Settings / Credentials.')
        : issue === 'no-match'
          ? t('No matching paper was found in Semantic Scholar.')
          : issue === 'reference-changed'
            ? t('This reference changed. Reopen its details and try again.')
            : issue === 'expired'
              ? t('These results expired. Search again.')
              : t('Citation discovery is temporarily unavailable. Try again.')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-border-300 px-5 py-3">
        <div className="flex flex-wrap gap-2" aria-label={t('Citation discovery')}>
          <Button
            size="sm"
            variant={direction === 'references' ? 'default' : 'outline'}
            aria-pressed={direction === 'references'}
            disabled={busy || saving}
            onClick={() => {
              setPages([])
              void lookup(
                'references',
                0,
                result?.state === 'ready' ? result.resolutionToken : undefined
              )
            }}
          >
            {t('References')}
          </Button>
          <Button
            size="sm"
            variant={direction === 'citations' ? 'default' : 'outline'}
            aria-pressed={direction === 'citations'}
            disabled={busy || saving}
            onClick={() => {
              setPages([])
              void lookup(
                'citations',
                0,
                result?.state === 'ready' ? result.resolutionToken : undefined
              )
            }}
          >
            {t('Cited by')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {direction === 'references'
            ? t('Papers referenced by this paper.')
            : t('Papers that cite this paper.')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            'Source: Semantic Scholar. Coverage may be incomplete. Selected references go to Inbox for review.'
          )}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" aria-busy={busy}>
        {busy ? (
          <p role="status">{t('Searching…')}</p>
        ) : result?.state === 'unavailable' ? (
          <ErrorNotice
            role="alert"
            description={errorMessage}
            primaryButton={{ label: t('Retry'), onClick: () => void lookup(direction, 0) }}
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
          <ul className="space-y-3">
            {result.records.map((entry) => {
              const receipt = receipts[entry.paperId]
              return (
                <li key={entry.paperId} className="rounded-lg border border-border-300 p-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-primary"
                      aria-label={t('Select {{title}}', { title: entry.item.title })}
                      checked={selected.has(entry.paperId)}
                      disabled={saving || (receipt !== undefined && receipt !== 'failed')}
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
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-300 px-5 py-3">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || saving || !pages.length}
            onClick={() => {
              const previous = pages.at(-1)!
              setPages(pages.slice(0, -1))
              void lookup(direction, previous, result?.resolutionToken)
            }}
          >
            {t('Previous')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || saving || result?.nextOffset === undefined}
            onClick={() => {
              setPages([...pages, offset])
              void lookup(direction, result!.nextOffset!, result?.resolutionToken)
            }}
          >
            {t('Next')}
          </Button>
        </div>
        {onOpenInbox &&
        Object.values(receipts).some(
          (receipt) => receipt !== 'failed' && receipt.kind === 'candidate'
        ) ? (
          <Button size="sm" variant="outline" disabled={saving} onClick={onOpenInbox}>
            {t('Open Inbox')}
          </Button>
        ) : null}
        <Button size="sm" disabled={busy || saving || !selected.size} onClick={() => void save()}>
          {saving ? t('Saving…') : t('Add selected to Inbox')}
        </Button>
      </div>
    </div>
  )
}
