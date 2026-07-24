import { Button } from '@/components/ui/button'
import { CardContent, CardFooter } from '@/components/ui/card'
import { useSettingsStore } from '@/stores/settings-store'
import { AgentPanel } from '../settings/AgentPanel'

type AgentStepProps = {
  onBack: () => void
  onContinue: () => void
}

// Continue only when the latest full check belongs to the currently-selected framework. A check
// still in flight, or a stale result from a previous selection, must keep the onboarding gate shut.
const useEnvironmentReady = (): boolean => {
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const isCheckingEnvironment = useSettingsStore((state) => state.isCheckingEnvironment)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)

  return (
    !isCheckingEnvironment &&
    environmentCheck?.ready === true &&
    environmentCheck.agentFrameworkId === agentFrameworkId
  )
}

// The first-run step reuses the same runtime cards and repair/install behavior as Settings. Only the
// surrounding Back/Continue gate is onboarding-specific.
const AgentStep = ({ onBack, onContinue }: AgentStepProps): React.JSX.Element => {
  const environmentReady = useEnvironmentReady()

  return (
    <>
      <CardContent className="flex-1 p-0">
        <AgentPanel
          variant="onboarding"
          title="Set up the agent runtime"
          description="Pick the agent Open Science drives, then install it. Only this agent needs to be installed to continue."
        />
      </CardContent>
      <CardFooter className="mt-auto items-center justify-between gap-4 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
        <p className="text-xs leading-5 text-text-100">
          {environmentReady
            ? 'All required environment checks passed.'
            : 'Complete every required item above to continue.'}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button type="button" onClick={onContinue} disabled={!environmentReady} className="px-4">
            Continue
          </Button>
        </div>
      </CardFooter>
    </>
  )
}

export { AgentStep }
