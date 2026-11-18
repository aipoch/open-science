import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ChevronDown } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CitationLookupError } from './CitationLookupError'
import { citationDirections, type CitationGraphController } from './useCitationGraphController'

export type CitationStatusModel = Pick<
  CitationGraphController,
  | 'busy'
  | 'states'
  | 'entries'
  | 'unfilteredGraph'
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
    unfilteredGraph,
    activeDirection,
    directionMode,
    interactionBusy,
    invalidated,
    blocked,
    load
  } = model
  const shownDirections = directionMode === 'both' ? citationDirections : [activeDirection]
  const centerId = unfilteredGraph?.nodes.find((node) => node.center)?.id
  const compactStatuses = shownDirections.every(
    (direction) =>
      states[direction].result?.state === 'ready' &&
      states[direction].pages < 5 &&
      !states[direction].omitted &&
      entries.some((entry) => entry.direction === direction)
  )
  return (
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
            <section
              key={direction}
              className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 py-2 ${compactStatuses && shownDirections.length > 1 ? '' : 'col-span-2'}`}
              aria-label={title}
            >
              <div className="flex min-h-7 min-w-0 flex-col justify-center text-xs leading-[14px] sm:min-h-0 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-start sm:gap-x-2 sm:gap-y-1 sm:leading-4">
                <h3 className="font-medium">
                  {direction === 'references' ? t('References') : t('Cited by')}
                </h3>
                {state.pages > 0 ? (
                  <span className="tabular-nums text-muted-foreground">
                    {t('Loaded: {{loaded}}', { loaded })}
                  </span>
                ) : null}
              </div>
              <div className="col-start-1 row-start-2 min-w-0 space-y-1">
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
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        aria-label={t('Load more')}
                        variant="outline"
                        disabled={blocked || state.pages >= 5}
                        className="col-start-2 row-start-1 row-span-2 w-auto shrink-0 self-center text-xs"
                        onClick={() => void load(direction, result.nextOffset)}
                      >
                        {compactStatuses && shownDirections.length > 1 ? (
                          <>
                            <ChevronDown className="size-3.5 sm:hidden" aria-hidden="true" />
                            <span className="hidden sm:inline">{t('Load more')}</span>
                          </>
                        ) : (
                          t('Load more')
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('Load more')}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
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
      <p className="pb-2 text-xs text-muted-foreground">
        {t('Loaded results only; source coverage may be incomplete.')}
      </p>
    </div>
  )
}
