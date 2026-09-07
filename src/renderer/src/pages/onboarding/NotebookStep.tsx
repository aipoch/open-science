import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { CardContent, CardFooter } from '@/components/ui/card'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useSettingsStore } from '@/stores/settings-store'
import { RuntimesPanel } from '../settings/RuntimesPanel'
import { onboardingErrorMessage } from './onboarding-error'

type NotebookStepProps = {
  onBack: () => void
}

// Optional step: how notebooks run (app-managed Python by default, or a detected interpreter of the
// user's own). Nothing here blocks the wizard — a fresh env is built lazily on first notebook use —
// except a runtime setup the user explicitly started: it must finish (or be cancelled) before
// leaving, otherwise a half-built env would be stranded.
const NotebookStep = ({ onBack }: NotebookStepProps): React.JSX.Element => {
  const { t } = useTranslation()
  const completeOnboarding = useSettingsStore((state) => state.completeOnboarding)
  const completionInFlight = useRef(false)
  const [isCompleting, setIsCompleting] = useState(false)
  const [completionError, setCompletionError] = useState<string | undefined>(undefined)
  // The per-language flag flips synchronously on click, before the main-process status/progress event
  // arrives. Combining both signals closes the window where Finish could leave a fresh setup behind.
  const envProvisioning = useNotebookEnvStore(
    (s) => s.status.provisioning || Object.values(s.byLang).some((state) => state?.preparing)
  )
  const handleFinish = async (): Promise<void> => {
    if (completionInFlight.current || envProvisioning) return
    completionInFlight.current = true
    setIsCompleting(true)
    setCompletionError(undefined)
    try {
      await completeOnboarding()
    } catch (error) {
      setCompletionError(onboardingErrorMessage(error, t('Could not finish setup.')))
      completionInFlight.current = false
      setIsCompleting(false)
    }
  }

  return (
    <>
      <CardContent className="flex-1 p-0">
        {/* Reuse the complete Settings surface so discovery, interpreter controls, language logos,
            managed setup, progress, recovery, and cancellation stay identical in both places. */}
        <RuntimesPanel
          headingAs="h2"
          title={t('Notebook runtime (optional)')}
          description={t(
            'Notebooks run in an app-managed Python environment by default. You can change any of this later in Settings → Runtimes.'
          )}
        />
      </CardContent>
      <CardFooter className="mt-auto items-center justify-between gap-4 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
        <p className="text-xs leading-5 text-text-100">
          {completionError ? (
            <span className="text-destructive" role="alert">
              {completionError}
            </span>
          ) : envProvisioning ? (
            t('Setting up the notebook runtime — wait for it to finish, or cancel it, to continue.')
          ) : (
            t('Optional — nothing here is required to finish setup.')
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            disabled={envProvisioning || isCompleting}
          >
            {t('Back', { context: 'step' })}
          </Button>
          <Button
            type="button"
            onClick={() => void handleFinish()}
            // Leaving mid-create would strand a half-built env (the user can cancel it from the
            // card to finish).
            disabled={envProvisioning || isCompleting}
            className="px-4"
          >
            {t('Finish')}
          </Button>
        </div>
      </CardFooter>
    </>
  )
}

export { NotebookStep }
