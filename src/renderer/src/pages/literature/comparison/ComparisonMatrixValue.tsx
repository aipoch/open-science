import { memo, useCallback, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, CircleCheck, CircleDashed, Clock, Pencil } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import type { ComparisonCell, ComparisonField } from '../../../../../shared/literature-comparison'
import { comparisonCellView } from './comparison-display'

export const ComparisonMatrixValue = memo(function ComparisonMatrixValue({
  cell,
  field,
  sourceKey,
  selected,
  expanded,
  cellTriggers,
  onTooltipEscape
}: {
  cell: ComparisonCell
  field: ComparisonField
  sourceKey: string
  selected: boolean
  expanded: boolean
  cellTriggers: RefObject<Map<string, HTMLButtonElement>>
  onTooltipEscape?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const formatDateTime = useDateTimeFormat()
  const setTrigger = useCallback(
    (node: HTMLButtonElement | null) => {
      if (node) cellTriggers.current.set(cell.id, node)
      else cellTriggers.current.delete(cell.id)
    },
    [cell.id, cellTriggers]
  )
  const view = comparisonCellView(cell, field, sourceKey)
  const needsReview = view.needsReview || view.stale
  const statusLabel = needsReview
    ? t('Needs review')
    : view.confirmed
      ? t('Confirmed')
      : cell.manual
        ? t('Manual draft')
        : t('Machine result')
  const outdatedRule =
    view.attempt && view.attempt.fieldVersion !== field.version
      ? t('Outdated rule v{{previous}} (current: v{{current}})', {
          previous: view.attempt.fieldVersion,
          current: field.version
        })
      : undefined
  const machineResult = cell.status === 'succeeded' && view.attempt?.status === 'succeeded'
  const showStatus = needsReview || Boolean(cell.manual) || machineResult
  const detail =
    outdatedRule ??
    (cell.manual && cell.manual.fieldVersion !== field.version
      ? t('Rule changed. Review the saved manual value again.')
      : (view.attempt && view.attempt.sourceKey !== sourceKey) ||
          (cell.manual && cell.manual.sourceKey !== sourceKey)
        ? t('Source changed')
        : view.confirmed && cell.manual
          ? formatDateTime(cell.manual.updatedAt, 'dateTime')
          : cell.manual?.attemptId && cell.manual.attemptId !== view.attempt?.id
            ? t('New extraction result')
            : cell.manual && !cell.manual.confirmed
              ? t('Revision awaiting confirmation')
              : undefined)

  const button = (
    <button
      type="button"
      ref={setTrigger}
      aria-current={selected ? 'true' : undefined}
      aria-expanded={expanded}
      className="w-full min-h-9 px-3 py-1.5 text-left hover:bg-muted/30 focus-visible:keyboard-focus focus-visible:-outline-offset-2"
    >
      <span className="flex items-center gap-1.5">
        <span className="inline-flex w-3.5 shrink-0 items-center">
          {needsReview ? (
            <CircleAlert
              aria-hidden="true"
              className="size-3.5 shrink-0 text-status-warning-foreground dark:text-status-warning-dark-foreground"
            />
          ) : view.confirmed ? (
            <CircleCheck
              aria-hidden="true"
              className="size-3.5 shrink-0 text-status-success-foreground dark:text-status-success-dark-foreground"
            />
          ) : cell.manual ? (
            <Pencil aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          ) : machineResult ? (
            <CircleDashed aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          ) : cell.status === 'pending' ? (
            <Clock aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" />
          ) : null}
        </span>
        <span className="min-w-0 line-clamp-2 whitespace-pre-wrap break-words">
          {cell.manual !== undefined && !view.insufficient
            ? view.value
            : view.value ||
              (cell.status === 'running'
                ? t('Running')
                : cell.status === 'failed'
                  ? t('Extraction failed')
                  : cell.status === 'unavailable'
                    ? t('Waiting for source')
                    : view.insufficient
                      ? t('Insufficient evidence')
                      : t('Pending'))}
        </span>
        {showStatus && <span className="sr-only">{statusLabel}</span>}
        {outdatedRule && <span className="sr-only">{outdatedRule}</span>}
      </span>
      {view.attempt?.coverage && (
        <span className="sr-only">
          {view.attempt.coverage === 'abstract'
            ? t('Abstract')
            : view.attempt.coverage === 'passages'
              ? t('Selected passages')
              : t('Full text')}
        </span>
      )}
    </button>
  )
  if (!showStatus) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" onEscapeKeyDown={onTooltipEscape}>
        {statusLabel}
        {detail && <> · {detail}</>}
      </TooltipContent>
    </Tooltip>
  )
})
