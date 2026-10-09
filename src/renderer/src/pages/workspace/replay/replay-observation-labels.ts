import { useTranslation } from 'react-i18next'
import type { RunObservationPhase } from '../../../../../shared/run-observation'

export const useObservationPhaseLabel = (): ((phase: RunObservationPhase) => string) => {
  const { t } = useTranslation()
  return (phase) =>
    ({
      preparing: t('Preparing environment'),
      queued: t('Queued'),
      running: t('Running'),
      collecting: t('Saving results'),
      completed: t('Completed'),
      failed: t('Failed'),
      cancelled: t('Cancelled'),
      interrupted: t('Interrupted'),
      timeout: t('Timed out')
    })[phase]
}
