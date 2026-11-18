import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { citationDirections, type CitationGraphController } from './useCitationGraphController'
import type { CitationDirection } from './citation-graph'

export type CitationStatusModel = Pick<
  CitationGraphController,
  | 'busy'
  | 'states'
  | 'entries'
  | 'activeDirection'
  | 'directionMode'
  | 'interactionBusy'
  | 'invalidated'
  | 'blocked'
  | 'load'
>

export function LiteratureCitationStatus({
  model,
  sourceName,
  outsideView,
  onRestart
}: {
  model: CitationStatusModel
  sourceName: string
  outsideView: boolean
  onRestart(): void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const {
    busy,
    states,
    entries,
    activeDirection,
    directionMode,
    interactionBusy,
    invalidated,
    blocked,
    load
  } = model
  const showDirectionStatus = (direction: CitationDirection): boolean =>
    busy === direction ||
    states[direction].result?.state !== 'ready' ||
    states[direction].result?.nextOffset !== undefined ||
    Boolean(states[direction].omitted) ||
    !entries.some((entry) => entry.direction === direction)
  const shownDirections = directionMode === 'both' ? citationDirections : [activeDirection]
  const showStatus = shownDirections.some(showDirectionStatus) || outsideView
  return showStatus ? (
    <div
      data-citation-status
      className="min-h-0 max-h-[45%] shrink overflow-y-auto overscroll-contain border-t border-border-300 bg-background px-3 py-1"
    >
      {outsideView ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t('New papers are outside the current view. Fit the graph to see all loaded papers.')}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-x-4" aria-busy={busy !== undefined}>
        {shownDirections.map((direction) => {
          if (!showDirectionStatus(direction)) return null
          const state = states[direction]
          const result = state.result
          const pageLimitReached =
            state.pages >= 5 && result?.state === 'ready' && result.nextOffset !== undefined
          const title = direction === 'references' ? t('References') : t('Papers citing this paper')
          const compactDirection =
            result?.state === 'ready' &&
            !pageLimitReached &&
            !state.omitted &&
            entries.some((entry) => entry.direction === direction)
          return (
            <section
              key={direction}
              className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 py-2 ${compactDirection && shownDirections.length > 1 ? '' : 'col-span-2'}`}
              aria-label={title}
            >
              <h3 className="min-w-0 text-xs font-medium">
                {direction === 'references' ? t('References') : t('Cited by')}
              </h3>
              <div className="col-start-1 row-start-2 min-w-0 space-y-1">
                {busy === direction ? (
                  <p role="status" className="text-xs">
                    {t('Searching…')}
                  </p>
                ) : null}
                {result?.state === 'unavailable' ? (
                  <ErrorNotice
                    inline
                    role="alert"
                    description={
                      result.issue === 'reference-changed'
                        ? t('This reference changed. Reopen its details and try again.')
                        : result.issue === 'expired'
                          ? t('These results expired. Search again.')
                          : result.issue === 'rate-limited'
                            ? t('{{source}} is limiting requests. Try again later.', {
                                source: sourceName
                              })
                            : result.issue === 'authentication'
                              ? t('{{source}} rejected the request. Try again later.', {
                                  source: sourceName
                                })
                              : result.issue === 'no-match'
                                ? t('No matching paper was found in {{source}}.', {
                                    source: sourceName
                                  })
                                : t('Citation discovery is temporarily unavailable. Try again.')
                    }
                    primaryButton={
                      result.issue === 'reference-changed'
                        ? undefined
                        : {
                            label: t('Retry'),
                            disabled:
                              interactionBusy || (invalidated && result.issue !== 'expired'),
                            onClick: () =>
                              result.issue === 'expired'
                                ? onRestart()
                                : void load(direction, state.pages ? (state.nextOffset ?? 0) : 0)
                          }
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
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked || state.pages >= 5}
                  className="col-start-2 row-start-1 row-span-2 w-auto shrink-0 self-center text-xs"
                  onClick={() => void load(direction, result.nextOffset)}
                >
                  {t('Load more')}
                </Button>
              ) : !result && !busy ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  className="col-start-2 row-start-1 row-span-2 w-auto"
                  onClick={() => void load(direction)}
                >
                  {t('Search')}
                </Button>
              ) : null}
            </section>
          )
        })}
      </div>
    </div>
  ) : null
}
