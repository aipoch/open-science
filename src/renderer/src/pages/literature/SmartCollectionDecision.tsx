import { SmartEvaluationHistory } from './SmartEvaluationHistory'
import { SmartDecisionPendingContext } from './smart-collection-state'
import { memo, useContext, useEffect, useRef, useState } from 'react'
import {
  Check,
  X,
  RotateCcw,
  RefreshCw,
  ChevronRight,
  Info,
  Brain,
  ClipboardList
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { classificationFailureText } from './smart-collection-decisions'
import { useTranslation } from 'react-i18next'
import type { SmartCollectionRow } from '../../../../shared/literature-smart-collections'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type Decision = 'include' | 'exclude' | 'automatic'
export type SmartCollectionCellActions = {
  update: () => void
  reevaluate: (id: string) => void
  decide: (id: string, decision: Decision) => void
}

// Keep unrelated page updates out of the per-row Radix trees. Read the latest
// owner callbacks only on interaction, so memoization never retains stale guards.
export const SmartCollectionCells = memo(function SmartCollectionCells({
  itemId,
  row,
  actions,
  disabled,
  updateDisabled,
  evaluating,
  completed
}: {
  itemId: string
  row?: SmartCollectionRow
  actions: React.RefObject<SmartCollectionCellActions>
  disabled: boolean
  updateDisabled: boolean
  evaluating: boolean
  completed?: boolean
}): React.JSX.Element {
  return (
    <>
      <td className="px-1 py-2 align-middle">
        <SmartCollectionAssessment
          row={row}
          onUpdate={() => actions.current.update()}
          updateDisabled={updateDisabled}
        />
      </td>
      <td className="px-2 py-2 align-middle">
        <SmartCollectionDecisionActions
          compact
          withTooltipProvider={false}
          row={row}
          disabled={disabled}
          evaluating={evaluating}
          completed={completed}
          onReevaluate={() => actions.current.reevaluate(itemId)}
          onDecision={(decision) => actions.current.decide(itemId, decision)}
        />
      </td>
    </>
  )
})

export function SmartCollectionAssessment({
  row,
  onUpdate,
  updateDisabled,
  inline = false
}: {
  inline?: boolean
  onUpdate?: () => void
  updateDisabled?: boolean
  row?: SmartCollectionRow
}): React.JSX.Element {
  const { t } = useTranslation()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [boundary, setBoundary] = useState<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clearHoverTimer = (): void => {
    clearTimeout(hoverTimer.current)
  }
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  useEffect(() => {
    if (!open || !boundary || !triggerRef.current || !globalThis.IntersectionObserver) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          clearTimeout(hoverTimer.current)
          pinned.current = false
          setOpen(false)
        }
      },
      { root: boundary }
    )
    observer.observe(triggerRef.current)
    return () => observer.disconnect()
  }, [open, boundary])
  const resolveBoundary = (): void => {
    setBoundary(
      triggerRef.current?.closest<HTMLElement>('[data-slot="literature-table-scroll"]') ?? null
    )
  }
  const openOnHover = (event: React.PointerEvent): void => {
    if (event.pointerType === 'touch') return
    resolveBoundary()
    clearHoverTimer()
    if (open) return
    pinned.current = false
    hoverTimer.current = setTimeout(() => setOpen(true), 250)
  }
  const closeOnLeave = (): void => {
    clearHoverTimer()
    if (!pinned.current) hoverTimer.current = setTimeout(() => setOpen(false), 180)
  }
  const reasons = {
    'rule-changed': t('Collection rule changed'),
    'input-changed': t('Evaluation evidence changed'),
    'model-changed': t('Classification configuration changed'),
    'missing-evidence': t('Not enough readable evidence'),
    'input-too-long': t('Evidence exceeds the evaluation limit'),
    uncertain: t('The model could not determine a match')
  }
  const reason = row?.override
    ? row.override === 'include'
      ? t('Manually included')
      : t('Manually excluded')
    : row?.failure
      ? classificationFailureText(t, row.failure)
      : row?.reason
        ? reasons[row.reason]
        : row?.verdict === 'match'
          ? t('Matches the collection rule')
          : row?.verdict === 'no-match'
            ? t('Does not match the collection rule')
            : t('Not evaluated')
  const status = row?.override
    ? row.override === 'include'
      ? t('Manually included')
      : t('Manually excluded')
    : row?.verdict === 'match'
      ? t('AI included')
      : row?.verdict === 'no-match'
        ? t('AI excluded')
        : row?.assessment?.model === 'insufficient-evidence'
          ? t('Not evaluated')
          : row?.verdict === 'uncertain'
            ? t('Needs review')
            : row?.verdict === 'stale'
              ? t('Outdated')
              : row?.failure
                ? t('Failed')
                : t('Not evaluated')
  const assessment = row?.assessment
  const evaluatedByModel = Boolean(assessment && assessment.model !== 'insufficient-evidence')
  const scores = evaluatedByModel ? assessment?.probabilities : undefined
  const score = (value?: number): string =>
    value === undefined ? '—' : `${Math.round(value * 100)}%`
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clearHoverTimer()
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={`w-full rounded-md px-2 py-1 text-left text-xs hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring${inline ? ' -ml-2' : ''}`}
          aria-label={t('Evaluation details')}
          onPointerEnter={openOnHover}
          onPointerLeave={closeOnLeave}
          onClick={(event) => {
            event.preventDefault()
            resolveBoundary()
            clearHoverTimer()
            pinned.current = true
            setOpen(true)
            contentRef.current?.focus()
          }}
        >
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span
              className={
                inline
                  ? 'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'
                  : 'min-w-0 space-y-0.5'
              }
            >
              <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                {inline && (
                  <ClipboardList
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span className="truncate">{status}</span>
              </span>
              {scores && (
                <span
                  className="block tabular-nums text-muted-foreground"
                  aria-label={t('Match score')}
                >
                  {t('Match')}: {score(scores.match)}
                </span>
              )}
            </span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </span>
        </button>
      </PopoverTrigger>
      {open && (
        <PopoverContent
          ref={contentRef}
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            if (pinned.current) contentRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            if (!pinned.current) event.preventDefault()
          }}
          onPointerEnter={clearHoverTimer}
          onPointerLeave={closeOnLeave}
          align="start"
          collisionBoundary={boundary ?? undefined}
          collisionPadding={8}
          sticky="always"
          hideWhenDetached
          className="w-80 max-w-[var(--radix-popover-content-available-width)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto space-y-3 rounded-xl border border-border bg-bg-000 p-4 text-sm text-foreground shadow-lg"
        >
          <h3 className="flex items-center gap-2 font-medium">
            <ClipboardList className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {assessment?.model === 'insufficient-evidence'
              ? t('Not evaluated by a model')
              : t('Evaluation details')}
          </h3>
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <p>{status}</p>
              {assessment && !assessment.current && (
                <TooltipProvider disableHoverableContent>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('Outdated')}
                        className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Info className="size-3.5" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64 space-y-1">
                      {reason !== status && <p>{reason}</p>}
                      <p>
                        {t(
                          'This result is outdated. Update the collection to evaluate the current rule and evidence.'
                        )}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            {reason !== status && (!assessment || assessment.current) && (
              <p className="text-xs text-muted-foreground">{reason}</p>
            )}
          </div>
          {assessment?.ruleRevision !== undefined &&
            assessment.currentRuleRevision !== undefined &&
            assessment.ruleRevision !== assessment.currentRuleRevision && (
              <p className="text-xs text-muted-foreground">
                {t('Evaluated with rule {{evaluated}}; current rule {{current}}', {
                  evaluated: `#${assessment.ruleRevision}`,
                  current: `#${assessment.currentRuleRevision}`
                })}
              </p>
            )}
          {scores && (
            <section className="space-y-3 border-t border-border pt-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t('Match score')}</span>
                <TooltipProvider disableHoverableContent>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('Match score')}
                        className="rounded-sm p-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Info className="size-3.5" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                      {t(
                        'Model scores for this rule, not paper quality or calibrated probabilities.'
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <dl className="space-y-2">
                {[
                  [t('Match'), score(scores?.match)],
                  [t('No match'), score(scores?.['no-match'])],
                  [t('Uncertain'), score(scores?.uncertain)]
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt>{label}</dt>
                    <dd className="tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {evaluatedByModel && assessment && (
            <div className="space-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <p>
                {assessment.evidence?.coverage === 'full-text'
                  ? t('Evidence: full text')
                  : assessment.evidence?.coverage === 'passages'
                    ? t('Evidence: selected passages')
                    : assessment.evidence?.coverage === 'unavailable'
                      ? t('Evidence: available title and abstract; no PDF text used')
                      : t('Evidence: title and abstract')}
              </p>
              {assessment.evidence?.filename && (
                <p className="break-words">{assessment.evidence.filename}</p>
              )}
              {assessment.evidence?.passage ? (
                <>
                  <p>
                    {t('Pages {{start}}–{{end}}', {
                      start: assessment.evidence.passage.pageStart,
                      end: assessment.evidence.passage.pageEnd
                    })}
                  </p>
                  <blockquote className="max-h-48 overflow-y-auto whitespace-pre-wrap border-l-2 border-primary pl-3 text-foreground">
                    {assessment.evidence.passage.content}
                  </blockquote>
                </>
              ) : ['full-text', 'passages'].includes(assessment.evidence?.coverage ?? '') ? (
                <p>{t('No supporting passage was selected by the model.')}</p>
              ) : null}
            </div>
          )}
          {evaluatedByModel && !scores && (
            <p className="text-xs text-muted-foreground">
              {t('No model scores are available for this evaluation.')}
            </p>
          )}
          {row?.collectionId && (
            <SmartEvaluationHistory
              key={`${row.collectionId}:${row.id}`}
              collectionId={row.collectionId}
              itemId={row.id}
            />
          )}
          {evaluatedByModel && assessment && (
            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              <span className="flex min-w-0 items-center gap-1.5">
                <Brain className="size-3 shrink-0" aria-hidden="true" />
                <span className="break-all">
                  {t('Model: {{model}}', { model: assessment.model })}
                </span>
              </span>
              {new Date(assessment.evaluatedAt).toLocaleString()}
            </p>
          )}
          {assessment && !assessment.current && onUpdate && (
            <Button variant="outline" size="sm" disabled={updateDisabled} onClick={onUpdate}>
              {t('Update collection')}
            </Button>
          )}
        </PopoverContent>
      )}
    </Popover>
  )
}

export function SmartCollectionDecisionActions({
  row,
  compact = false,
  withTooltipProvider = true,
  evaluating = false,
  completed = false,
  disabled,
  onDecision,
  onReevaluate
}: {
  row?: SmartCollectionRow
  disabled: boolean
  compact?: boolean
  withTooltipProvider?: boolean
  completed?: boolean
  evaluating?: boolean
  onReevaluate?: () => void
  onDecision: (decision: 'include' | 'exclude' | 'automatic') => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const decisionPending = useContext(SmartDecisionPendingContext)
  const actions = [
    {
      label: t('Include'),
      icon: Check,
      disabled: disabled || row?.override === 'include',
      run: () => onDecision('include')
    },
    {
      label: t('Exclude'),
      icon: X,
      disabled: disabled || row?.override === 'exclude',
      run: () => onDecision('exclude')
    },
    ...(row?.override
      ? [
          {
            label: t('Use model decision'),
            icon: RotateCcw,
            disabled,
            run: () => onDecision('automatic')
          }
        ]
      : onReevaluate
        ? [{ label: t('Re-evaluate'), icon: RefreshCw, disabled, run: onReevaluate }]
        : [])
  ]
  const buttons = (
    <div className={compact ? 'flex items-center gap-1' : 'flex flex-wrap items-center gap-1.5'}>
      {actions.map(({ label, icon: Icon, disabled: actionDisabled, run }) => {
        const isReevaluation = label === t('Re-evaluate')
        const ActionIcon = completed && isReevaluation ? Check : Icon
        const button = (
          <Button
            key={label}
            size="sm"
            variant="outline"
            className={
              compact
                ? 'size-7 shrink-0 border-border bg-bg-000 p-0 hover:border-primary/40 hover:bg-primary/10 hover:text-primary'
                : undefined
            }
            aria-label={completed && isReevaluation ? t('Completed') : label}
            disabled={
              actionDisabled || evaluating || ((completed || decisionPending) && isReevaluation)
            }
            aria-busy={evaluating || undefined}
            onClick={run}
          >
            <ActionIcon
              className={
                evaluating && isReevaluation
                  ? 'size-4 animate-spin motion-reduce:animate-none'
                  : completed && isReevaluation
                    ? 'size-4 text-primary animate-in zoom-in-75 motion-reduce:animate-none'
                    : 'size-4'
              }
              aria-hidden="true"
            />
            {!compact && label}
          </Button>
        )
        return compact ? (
          <Tooltip key={label}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ) : (
          button
        )
      })}
    </div>
  )
  return compact && withTooltipProvider ? (
    <TooltipProvider disableHoverableContent delayDuration={150} skipDelayDuration={300}>
      {buttons}
    </TooltipProvider>
  ) : (
    buttons
  )
}
