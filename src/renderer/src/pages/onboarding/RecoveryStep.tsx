import { Button } from '@/components/ui/button'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useSettingsStore } from '@/stores/settings-store'
import { AgentEnvironmentPanel } from './AgentStep'
import { useEnvironmentReady } from './use-agent-environment'

// Recovery view: a completed user re-opened the wizard because a required check regressed. It
// deliberately keeps the pre-split single-surface layout (all check rows, automatic + manual
// install, framework switcher, no step tracker) so the repair flow behaves exactly as before.
const RecoveryStep = (): React.JSX.Element => {
  const closeEnvironmentRepair = useSettingsStore((state) => state.closeEnvironmentRepair)
  const environmentReady = useEnvironmentReady()
  // A runtime setup started before entering recovery must finish (or be cancelled) first —
  // leaving mid-create would strand a half-built env.
  const envProvisioning = useNotebookEnvStore((s) => s.status.provisioning)

  return (
    <>
      <CardHeader className="gap-1 rounded-t-lg px-6 py-5">
        <CardTitle className="text-[15px] font-semibold">Repair environment</CardTitle>
        <CardDescription className="text-xs leading-5">
          Resolve the required item below to return to Open Science.
        </CardDescription>
      </CardHeader>
      <Separator className="bg-border-200" />

      <CardContent className="flex-1 px-6 py-5">
        <section aria-label="Prepare environment" className="space-y-5">
          <AgentEnvironmentPanel />
        </section>
      </CardContent>
      <CardFooter className="mt-auto items-center justify-between gap-4 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
        <p className="text-xs leading-5 text-text-100">
          {envProvisioning
            ? 'Setting up the notebook runtime — wait for it to finish, or cancel it, to continue.'
            : environmentReady
              ? 'All required environment checks passed.'
              : 'Complete every required item above to continue.'}
        </p>
        <Button
          type="button"
          onClick={closeEnvironmentRepair}
          disabled={!environmentReady || envProvisioning}
          className="px-4"
        >
          Return to Open Science
        </Button>
      </CardFooter>
    </>
  )
}

export { RecoveryStep }
