import { useEffect, useMemo, useRef, useState } from 'react'

import type { UpsertProviderRequest } from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { ClaudeInstallCard } from '../settings/ClaudeInstallCard'
import { ClaudeStatusCard } from '../settings/ClaudeStatusCard'
import { ProviderForm } from '../settings/ProviderForm'
import {
  createEmptyProviderFormValue,
  getProviderFormErrors,
  hasProviderFormErrors,
  type ProviderFormValue
} from '../settings/provider-form-value'
import { describeValidation } from '../settings/validation-message'

type OnboardingWizardProps = {
  // Called once both startup gates are satisfied so the app can enter the main UI.
  onComplete: () => void
}

// Converts a form value into the upsert request the main process expects.
const toUpsertRequest = (value: ProviderFormValue): UpsertProviderRequest => ({
  type: value.type,
  name: value.name,
  baseUrl: value.baseUrl,
  model: value.model,
  key: value.key || undefined
})

// First-run gate: install/detect claude, then configure and validate a model provider. Reuses the
// same cards/form as the settings page so both surfaces stay in sync.
const OnboardingWizard = ({ onComplete }: OnboardingWizardProps): React.JSX.Element => {
  const claude = useSettingsStore((state) => state.claude)
  const preflight = useSettingsStore((state) => state.preflight)
  const isDetectingClaude = useSettingsStore((state) => state.isDetectingClaude)
  const isInstalling = useSettingsStore((state) => state.isInstalling)
  const installLogs = useSettingsStore((state) => state.installLogs)
  const npmAvailable = useSettingsStore((state) => state.npmAvailable)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const load = useSettingsStore((state) => state.load)
  const detectClaude = useSettingsStore((state) => state.detectClaude)
  const installClaude = useSettingsStore((state) => state.installClaude)
  const saveAndActivateProvider = useSettingsStore((state) => state.saveAndActivateProvider)

  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
  const [isSaving, setIsSaving] = useState(false)
  const [validationMessage, setValidationMessage] = useState<string | undefined>(undefined)
  const [validationOk, setValidationOk] = useState(false)
  const didAutoDetect = useRef(false)

  // Load settings once, then auto-detect claude so a machine that already has it skips straight ahead.
  useEffect(() => {
    void (async () => {
      await load()

      if (!didAutoDetect.current) {
        didAutoDetect.current = true
        await detectClaude()
      }
    })()
  }, [load, detectClaude])

  // Enter the app as soon as both gates are satisfied.
  useEffect(() => {
    if (preflight.claudeReady && preflight.activeProviderReady) {
      onComplete()
    }
  }, [preflight.claudeReady, preflight.activeProviderReady, onComplete])

  const step = useMemo<'claude' | 'provider'>(
    () => (preflight.claudeReady ? 'provider' : 'claude'),
    [preflight.claudeReady]
  )

  // Onboarding always creates a provider, so required fields must be filled before it can continue.
  const formErrors = getProviderFormErrors(formValue)
  const canContinue = !isSaving && !hasProviderFormErrors(formErrors)

  const handleSaveProvider = async (): Promise<void> => {
    setIsSaving(true)
    setValidationMessage(undefined)

    try {
      const { validation } = await saveAndActivateProvider(toUpsertRequest(formValue))

      setValidationOk(validation.ok)
      setValidationMessage(describeValidation(validation))
    } catch (error) {
      setValidationOk(false)
      setValidationMessage(error instanceof Error ? error.message : 'Could not save provider.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto max-w-xl px-6 py-12">
        <h1 className="font-serif text-2xl font-medium">Welcome to Open Science</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Two quick steps and you are ready: install Claude, then connect a model.
        </p>

        <ol className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
          <li className={step === 'claude' ? 'font-medium text-foreground' : ''}>1. Claude</li>
          <li aria-hidden="true">→</li>
          <li className={step === 'provider' ? 'font-medium text-foreground' : ''}>2. Model</li>
        </ol>

        {step === 'claude' ? (
          <section aria-label="Install Claude" className="mt-6 space-y-4">
            <ClaudeStatusCard
              claude={claude}
              claudeReady={preflight.claudeReady}
              isDetecting={isDetectingClaude}
              onDetect={() => void detectClaude()}
            />
            <ClaudeInstallCard
              isInstalling={isInstalling}
              installLogs={installLogs}
              npmAvailable={npmAvailable}
              onInstall={(source) => void installClaude(source)}
            />
          </section>
        ) : (
          <section aria-label="Configure model" className="mt-6 space-y-4">
            {!encryptionAvailable ? (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                Secure key storage is unavailable on this machine. Your key will be stored with
                reduced protection.
              </p>
            ) : null}
            <ProviderForm
              value={formValue}
              onChange={(patch) => setFormValue((current) => ({ ...current, ...patch }))}
              errors={formErrors}
              disabled={isSaving}
            />
            {validationMessage ? (
              <p
                className={`text-sm ${validationOk ? 'text-primary' : 'text-destructive'}`}
                role="alert"
              >
                {validationMessage}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void handleSaveProvider()}
              disabled={!canContinue}
              className="rounded-lg border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {isSaving ? 'Testing connection…' : 'Test connection & continue'}
            </button>
          </section>
        )}
      </div>
    </main>
  )
}

export { OnboardingWizard }
