import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { EnvironmentSetupCard } from './EnvironmentSetupCard'

type EnvironmentStepProps = {
  onContinue: () => void
}

// First step: confirm the host meets the core requirements (system, storage, secure storage,
// network). The agent runtime is set up on the next step.
const EnvironmentStep = ({ onContinue }: EnvironmentStepProps): React.JSX.Element => {
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const environmentCheckError = useSettingsStore((state) => state.environmentCheckError)
  const isCheckingEnvironment = useSettingsStore((state) => state.isCheckingEnvironment)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)

  // environmentCheck.ready covers the agent runtime too, so it can't gate this host-only step.
  // When the agent is the only gap the main process reports canAutoInstall — which by definition
  // means every host check passed.
  const hostReady =
    !isCheckingEnvironment &&
    environmentCheck !== undefined &&
    (environmentCheck.ready === true || environmentCheck.canAutoInstall === true)

  return (
    <>
      <CardHeader className="gap-1 rounded-t-lg px-6 py-5">
        <CardTitle className="text-[15px] font-semibold">Prepare environment</CardTitle>
        {/* Re-check lives on the title row (the setup card's own intro row is hidden via hideIntro),
            so the step header and the checklist read as one surface. */}
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void checkEnvironment()}
            disabled={isCheckingEnvironment}
          >
            <RefreshCw className={cn(isCheckingEnvironment && 'animate-spin')} aria-hidden="true" />
            {isCheckingEnvironment ? 'Checking…' : 'Check again'}
          </Button>
        </CardAction>
        <CardDescription className="text-xs leading-5">
          Open Science confirms its core requirements before your first research session.
        </CardDescription>
      </CardHeader>
      <Separator className="bg-border-200" />

      <CardContent className="flex-1 px-6 py-5">
        <section aria-label="Prepare environment" className="space-y-5">
          <EnvironmentSetupCard environment={environmentCheck} error={environmentCheckError} />
        </section>
      </CardContent>
      <CardFooter className="mt-auto items-center justify-between gap-4 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
        <p className="text-xs leading-5 text-text-100">
          {hostReady
            ? 'All required environment checks passed.'
            : 'Complete every required item above to continue.'}
        </p>
        <Button type="button" onClick={onContinue} disabled={!hostReady} className="px-4">
          Continue
        </Button>
      </CardFooter>
    </>
  )
}

export { EnvironmentStep }
