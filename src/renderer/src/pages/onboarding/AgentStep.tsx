import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { CardContent, CardFooter } from '@/components/ui/card'
import { useSettingsStore } from '@/stores/settings-store'
import { selectAgentEnvironmentReady } from './onboarding-readiness'
import { AgentPanel } from '../settings/AgentPanel'

type AgentStepProps = {
  inDialog?: boolean
  onBack: () => void
  onContinue: () => void
}

// Continue only when the latest full check belongs to the currently-selected framework. A check
// still in flight, or a stale result from a previous selection, must keep the onboarding gate shut.
const useEnvironmentReady = (): boolean => {
  useEffect(() => {
    // Quick sign-in can select a different runtime before this step opens. Later card clicks
    // run their own checks, and checkEnvironment already deduplicates in-flight checks.
    const settings = useSettingsStore.getState()
    if (settings.environmentCheck?.agentFrameworkId !== settings.agentFrameworkId) {
      void settings.checkEnvironment()
    }
  }, [])

  return useSettingsStore(selectAgentEnvironmentReady)
}

// The first-run step reuses the same runtime cards and repair/install behavior as Settings. Only the
// surrounding Back/Continue gate is onboarding-specific.
const AgentStep = ({ onBack, onContinue, inDialog }: AgentStepProps): React.JSX.Element => {
  const { t } = useTranslation()
  const environmentReady = useEnvironmentReady()

  return (
    <>
      <CardContent className={inDialog ? 'flex-1 px-6 py-5' : 'flex-1 p-0'}>
        <AgentPanel
          variant="onboarding"
          title={t('Set up the agent runtime')}
          description={t(
            'Use the selected runtime if it is ready. Choose another only if you need its provider support. You will connect a model in the next step.'
          )}
        />
      </CardContent>
      <CardFooter className="sticky bottom-0 z-10 mt-auto items-center justify-between gap-4 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
        <p className="text-xs leading-5 text-text-100">
          {environmentReady
            ? t('All required environment checks passed.')
            : t('Complete every required item above to continue.')}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onBack}>
            {t('Back', { context: 'step' })}
          </Button>
          <Button type="button" onClick={onContinue} disabled={!environmentReady} className="px-4">
            {t('Continue')}
          </Button>
        </div>
      </CardFooter>
    </>
  )
}

export { AgentStep }
