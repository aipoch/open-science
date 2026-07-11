import { useEffect, useRef, useState } from 'react'

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

type WizardStep = 'claude' | 'provider'

// Converts a form value into the upsert request the main process expects.
const toUpsertRequest = (value: ProviderFormValue): UpsertProviderRequest => ({
  type: value.type,
  name: value.name,
  baseUrl: value.baseUrl,
  model: value.model,
  key: value.key || undefined
})

// First-run gate: confirm/install claude, then configure and validate a model provider. Reuses the
// same cards/form as the settings page so both surfaces stay in sync. Shown only on a genuine first
// run (see startup-gate); once onboarding completes it never reappears — later issues are fixed in
// Settings — so there is no recovery mode and no props.
const OnboardingWizard = (): React.JSX.Element => {
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
  const completeOnboarding = useSettingsStore((state) => state.completeOnboarding)

  // Always confirm Claude first, even when already detected (the explicit first-run confirmation).
  const [step, setStep] = useState<WizardStep>('claude')
  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
  const [isSaving, setIsSaving] = useState(false)
  // Required-field errors stay hidden until the user first tries to submit, so an untouched form is
  // not littered with "required" messages. A `*` on each label signals the requirement up front.
  const [showProviderErrors, setShowProviderErrors] = useState(false)
  const [validationMessage, setValidationMessage] = useState<string | undefined>(undefined)
  const [validationOk, setValidationOk] = useState(false)
  const didAutoDetect = useRef(false)

  // Load settings once, then auto-detect claude so the Claude step shows a fresh status. Detection no
  // longer auto-advances: the user must explicitly confirm with Continue.
  useEffect(() => {
    void (async () => {
      await load()

      if (!didAutoDetect.current) {
        didAutoDetect.current = true
        await detectClaude()
      }
    })()
  }, [load, detectClaude])

  // Onboarding always creates a provider, so required fields must be filled before it can continue.
  const formErrors = getProviderFormErrors(formValue)

  const handleSaveProvider = async (): Promise<void> => {
    // First submit attempt surfaces any missing required fields instead of testing an incomplete draft.
    if (hasProviderFormErrors(formErrors)) {
      setShowProviderErrors(true)
      return
    }

    setIsSaving(true)
    setValidationMessage(undefined)

    try {
      const { validation } = await saveAndActivateProvider(toUpsertRequest(formValue))

      setValidationOk(validation.ok)
      setValidationMessage(describeValidation(validation))

      // A passing validation means both gates are satisfied: finish onboarding. The App gate then
      // re-renders into Home once the marker lands.
      if (validation.ok) {
        await completeOnboarding()
      }
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
          Two quick steps and you are ready: confirm Claude, then connect a model.
        </p>

        <ol className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
          <li className={step === 'claude' ? 'font-medium text-foreground' : ''}>1. Claude</li>
          <li aria-hidden="true">→</li>
          <li className={step === 'provider' ? 'font-medium text-foreground' : ''}>2. Model</li>
        </ol>

        {step === 'claude' ? (
          <section aria-label="Confirm Claude" className="mt-6 space-y-4">
            <ClaudeStatusCard
              claude={claude}
              claudeReady={preflight.claudeReady}
              isDetecting={isDetectingClaude}
              onDetect={() => void detectClaude()}
            />
            {/* Once a runnable claude is detected there's nothing to install — just confirm & continue. */}
            {!preflight.claudeReady ? (
              <ClaudeInstallCard
                isInstalling={isInstalling}
                installLogs={installLogs}
                npmAvailable={npmAvailable}
                onInstall={(source) => void installClaude(source)}
              />
            ) : null}
            <button
              type="button"
              onClick={() => setStep('provider')}
              disabled={!preflight.claudeReady}
              className="rounded-lg border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              Continue
            </button>
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
              errors={showProviderErrors ? formErrors : undefined}
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
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setStep('claude')}
                className="rounded-lg border border-input px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void handleSaveProvider()}
                disabled={isSaving}
                className="rounded-lg border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {isSaving ? 'Testing connection…' : 'Test connection & continue'}
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  )
}

export { OnboardingWizard }
