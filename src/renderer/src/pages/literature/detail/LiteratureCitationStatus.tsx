import { CitationLookupLoading, CitationPageActionLabel } from './CitationLookupLoading'
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
  selecting = false,
  renderRecords,
  onRestart
}: {
  model: CitationStatusModel
  direction: 'references' | 'citations'
  sourceName: string
  selecting?: boolean
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
  const nextOffset = result?.state === 'ready' ? result.nextOffset : undefined
  const pageLimitReached = state.pages >= 5 && nextOffset !== undefined
  const canPage = nextOffset !== undefined && !pageLimitReached
  const loadedLabel = t('Loaded: {{loaded}}', { loaded })
  const footerClass =
    'sticky bottom-0 flex shrink-0 items-center justify-between gap-2 border-t border-border-300 bg-card px-3 py-2 text-xs text-muted-foreground sm:px-4'
  const title = direction === 'references' ? t('References') : t('Papers citing this paper')
  if (!result && busy) {
    return (
      <section aria-label={title} data-citation-status className="px-3 pt-3 sm:px-4">
        <CitationLookupLoading direction={direction} queued={busy !== direction} />
      </section>
    )
  }
  return (
    <section
      key={direction}
      className="flex min-w-0 flex-1 flex-col"
      data-citation-status
      aria-busy={busy === direction}
      aria-label={title}
    >
      <div className="sr-only">
        <h3 className="font-medium">
          {direction === 'references' ? t('References') : t('Cited by')}
        </h3>
        {pageLimitReached ? (
          <span className="tabular-nums text-muted-foreground">{loadedLabel}</span>
        ) : null}
      </div>
      <div
        className={
          state.pages || result?.state !== 'unavailable' ? 'flex-1 px-3 pt-3 sm:px-4' : 'hidden'
        }
      >
        {renderRecords(direction)}
        <div className="mt-2 min-w-0 space-y-2">
          {result?.state === 'ready' &&
          state.pages > 0 &&
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
        <p className="py-3 text-xs text-muted-foreground">
          {t('Loaded results only; source coverage may be incomplete.')}
        </p>
      </div>
      {result?.state === 'unavailable' ? (
        <CitationLookupError
          className="mx-3 my-2 sm:mx-4"
          result={result}
          loading={busy === direction}
          sourceName={sourceName}
          disabled={interactionBusy || (invalidated && result.issue !== 'expired')}
          onRetry={() =>
            result.issue === 'expired' ? onRestart() : void load(direction, state.nextOffset)
          }
          renderRetry={
            state.pages && !selecting
              ? (button) => (
                  <div className={footerClass}>
                    <span className="tabular-nums">{loadedLabel}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={button.onClick}
                      disabled={button.disabled || button.loading}
                      aria-busy={button.loading || undefined}
                    >
                      <CitationPageActionLabel
                        loading={Boolean(button.loading)}
                        retryLabel={button.label}
                      />
                    </Button>
                  </div>
                )
              : undefined
          }
        />
      ) : result?.state === 'ready' && !pageLimitReached && !selecting ? (
        <div className={footerClass}>
          <span className="tabular-nums">{loadedLabel}</span>
          {canPage ? (
            <Button
              size="sm"
              variant="outline"
              disabled={blocked}
              aria-busy={busy === direction || undefined}
              onClick={() => void load(direction, nextOffset)}
            >
              <CitationPageActionLabel loading={busy === direction} />
            </Button>
          ) : (
            <span role="status">{t('No more results')}</span>
          )}
        </div>
      ) : !result && !busy ? (
        <Button
          size="sm"
          variant="outline"
          disabled={blocked}
          className="m-3 self-start"
          onClick={() => void load(direction)}
        >
          {t('Search')}
        </Button>
      ) : null}
    </section>
  )
}
