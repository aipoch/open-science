import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CitationLookupError } from './CitationLookupError'
import { type CitationGraphController } from './useCitationGraphController'

export type CitationStatusModel = Pick<
  CitationGraphController,
  | 'busy'
  | 'states'
  | 'entries'
  | 'unfilteredGraph'
  | 'interactionBusy'
  | 'invalidated'
  | 'blocked'
  | 'load'
>

export function LiteratureCitationStatus({
  model,
  direction,
  sourceName,
  renderRecords,
  onRestart
}: {
  model: CitationStatusModel
  direction: 'references' | 'citations'
  sourceName: string
  renderRecords(direction: 'references' | 'citations'): React.ReactNode
  onRestart(): void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { busy, states, entries, unfilteredGraph, interactionBusy, invalidated, blocked, load } =
    model
  const centerId = unfilteredGraph?.nodes.find((node) => node.center)?.id
  const loaded =
    unfilteredGraph?.edges.filter((edge) =>
      direction === 'references' ? edge.source === centerId : edge.target === centerId
    ).length ?? 0
  const state = states[direction]
  const result = state.result
  const pageLimitReached =
    state.pages >= 5 && result?.state === 'ready' && result.nextOffset !== undefined
  const title = direction === 'references' ? t('References') : t('Papers citing this paper')
  return (
    <div data-citation-status aria-busy={busy === direction}>
      <section key={direction} className="min-w-0" aria-label={title}>
        <div className="sr-only">
          <h3 className="font-medium">
            {direction === 'references' ? t('References') : t('Cited by')}
          </h3>
          {state.pages > 0 ? (
            <span className="tabular-nums text-muted-foreground">
              {t('Loaded: {{loaded}}', { loaded })}
            </span>
          ) : null}
        </div>
        {renderRecords(direction)}
        <div className="mt-2 min-w-0 space-y-2">
          {busy === direction ? (
            <p role="status" className="text-xs">
              {t('Searching…')}
            </p>
          ) : null}
          {result?.state === 'unavailable' ? (
            <CitationLookupError
              result={result}
              sourceName={sourceName}
              disabled={interactionBusy || (invalidated && result.issue !== 'expired')}
              onRetry={() =>
                result.issue === 'expired'
                  ? onRestart()
                  : void load(direction, state.pages ? (state.nextOffset ?? 0) : 0)
              }
            />
          ) : result?.state === 'ready' && !state.pages ? null : result?.state === 'ready' &&
            !entries.some((entry) => entry.direction === direction) ? (
            <p className="text-xs text-muted-foreground">
              {t(
                '{{source}} did not provide relationships for this page; the paper may still have references or citations.',
                { source: sourceName }
              )}
            </p>
          ) : null}
          {state.omitted ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'Some relationships could not be matched to a record in {{source}} and are not shown.',
                { source: sourceName }
              )}
            </p>
          ) : null}
          {pageLimitReached ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t(
                'Loaded 5 pages for this direction (up to 100 relationships). Explore the other direction or another paper.'
              )}
            </p>
          ) : null}
        </div>
        {result?.state === 'ready' && result.nextOffset !== undefined ? (
          <div className="mt-2 flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              disabled={blocked || state.pages >= 5}
              onClick={() => void load(direction, result.nextOffset)}
            >
              {t('Load more')}
            </Button>
          </div>
        ) : !result && !busy ? (
          <Button
            size="sm"
            variant="outline"
            disabled={blocked}
            className="mt-2"
            onClick={() => void load(direction)}
          >
            {t('Search')}
          </Button>
        ) : null}
      </section>
      <p className="py-3 text-xs text-muted-foreground">
        {t('Loaded results only; source coverage may be incomplete.')}
      </p>
    </div>
  )
}
