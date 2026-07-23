import { Button } from '@/components/ui/button'
import { CardContent, CardFooter } from '@/components/ui/card'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { RuntimesPanel } from '../settings/RuntimesPanel'

type NotebookStepProps = {
  onBack: () => void
  onContinue: () => void
}

// Optional step: how notebooks run (app-managed Python by default, or a detected interpreter of the
// user's own). Nothing here blocks the wizard — a fresh env is built lazily on first notebook use —
// except a runtime setup the user explicitly started: it must finish (or be cancelled) before
// leaving, otherwise a half-built env would be stranded.
const NotebookStep = ({ onBack, onContinue }: NotebookStepProps): React.JSX.Element => {
  // The per-language flag flips synchronously on click, before the main-process status/progress event
  // arrives. Combining both signals closes the window where Continue could leave a fresh setup behind.
  const envProvisioning = useNotebookEnvStore(
    (s) => s.status.provisioning || Object.values(s.byLang).some((state) => state?.preparing)
  )

  return (
    <>
      <CardContent className="flex-1 p-0">
        {/* Reuse the complete Settings surface so discovery, interpreter controls, language logos,
            managed setup, progress, recovery, and cancellation stay identical in both places. */}
        <RuntimesPanel
          title="Notebook runtime (optional)"
          description="Notebooks run in an app-managed Python environment by default. You can change any of this later in Settings → Runtimes."
        />
      </CardContent>
      <CardFooter className="mt-auto items-center justify-between gap-4 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
        <p className="text-xs leading-5 text-text-100">
          {envProvisioning
            ? 'Setting up the notebook runtime — wait for it to finish, or cancel it, to continue.'
            : 'Optional — nothing here is required to finish setup.'}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onBack} disabled={envProvisioning}>
            Back
          </Button>
          <Button
            type="button"
            onClick={onContinue}
            // Leaving mid-create would strand a half-built env (the user can cancel it from the
            // card to proceed).
            disabled={envProvisioning}
            className="px-4"
          >
            Continue
          </Button>
        </div>
      </CardFooter>
    </>
  )
}

export { NotebookStep }
