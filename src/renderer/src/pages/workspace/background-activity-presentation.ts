import type { ProjectBackgroundActivityItem } from '../../../../shared/background-result-delivery'

type BackgroundActivityStatus = ProjectBackgroundActivityItem['status']
type BackgroundActivityOutcome = ProjectBackgroundActivityItem['outcomeStatus']
type Translate = (key: string) => string

const isActiveBackgroundStatus = (status: BackgroundActivityStatus): boolean =>
  status === 'queued' || status === 'submitted' || status === 'running' || status === 'cancelling'

const terminalOutcomeLabel = (
  outcome: BackgroundActivityOutcome,
  t: Translate
): string | undefined => {
  if (!outcome) return undefined
  if (outcome === 'completed' || outcome === 'success') return t('Completed')
  if (outcome === 'timeout') return t('Timed out')
  if (outcome === 'interrupted') return t('Interrupted')
  if (outcome === 'cancelled') return t('Cancelled')
  return t('Failed')
}

const backgroundActivityStatusLabel = (
  status: BackgroundActivityStatus,
  outcome: BackgroundActivityOutcome,
  t: Translate
): string => {
  if (!status) return t('Result unavailable')
  const outcomeLabel = terminalOutcomeLabel(outcome, t)
  if (status === 'needs-attention') return outcomeLabel ?? t('Result unavailable')
  if (status === 'result-unavailable') return t('Result unavailable')
  if (status === 'pending-delivery') return outcomeLabel ?? t('Result unavailable')
  if (status === 'queued' || status === 'submitted') return t('Queued')
  if (status === 'running') return t('Running')
  if (status === 'cancelling') return t('Cancelling')
  if (status === 'completed' || status === 'success') return t('Completed')
  if (status === 'timeout') return t('Timed out')
  if (status === 'interrupted') return t('Interrupted')
  if (status === 'cancelled') return t('Cancelled')
  return t('Failed')
}

export { backgroundActivityStatusLabel, isActiveBackgroundStatus }
