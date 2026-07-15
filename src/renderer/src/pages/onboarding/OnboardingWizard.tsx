import { useEffect, useRef, useState } from 'react'

import type {
  ClaudeInstallResult,
  ClaudeInstallSource,
  UpsertProviderRequest
} from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { ClaudeInstallCard } from '../settings/ClaudeInstallCard'
import { ClaudeStatusCard } from '../settings/ClaudeStatusCard'
import { EnvironmentSetupCard } from './EnvironmentSetupCard'
import { ProviderForm } from '../settings/ProviderForm'
import {
  createEmptyProviderFormValue,
  getProviderFormErrors,
  hasProviderFormErrors,
  type ProviderFormValue
} from '../settings/provider-form-value'
import { describeValidation } from '../settings/validation-message'

type WizardStep = 'claude' | 'provider'
type EnvironmentMode = 'automatic' | 'manual'

// Converts a form value into the upsert request the main process expects.
const toUpsertRequest = (value: ProviderFormValue): UpsertProviderRequest => ({
  type: value.type,
  name: value.name,
  baseUrl: value.baseUrl,
  model: value.model,
  vendorId: value.vendorId,
  region: value.region,
  key: value.key || undefined
})

// Startup preparation surface: automatic host inspection (with the original manual installer kept as
// a tab), then first-run model-provider validation. For completed users App can re-open only the
// environment portion when a required dependency later disappears.
const OnboardingWizard = (): React.JSX.Element => {
  const claude = useSettingsStore((state) => state.claude)
  const preflight = useSettingsStore((state) => state.preflight)
  const isDetectingClaude = useSettingsStore((state) => state.isDetectingClaude)
  const isInstalling = useSettingsStore((state) => state.isInstalling)
  const installLogs = useSettingsStore((state) => state.installLogs)
  const installProgress = useSettingsStore((state) => state.installProgress)
  const storeInstallError = useSettingsStore((state) => state.installError)
  const npmAvailable = useSettingsStore((state) => state.npmAvailable)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const onboardingCompletedAt = useSettingsStore((state) => state.onboardingCompletedAt)
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const environmentCheckError = useSettingsStore((state) => state.environmentCheckError)
  const isCheckingEnvironment = useSettingsStore((state) => state.isCheckingEnvironment)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)
  const closeEnvironmentRepair = useSettingsStore((state) => state.closeEnvironmentRepair)
  const installClaude = useSettingsStore((state) => state.installClaude)
  const saveAndActivateProvider = useSettingsStore((state) => state.saveAndActivateProvider)
  const completeOnboarding = useSettingsStore((state) => state.completeOnboarding)

  const isRecovery = onboardingCompletedAt !== undefined
  // First-time setup always starts on the visible environment summary, even when every check has
  // already passed. The user explicitly continues to model configuration after reviewing it.
  const [step, setStep] = useState<WizardStep>('claude')
  const [environmentMode, setEnvironmentMode] = useState<EnvironmentMode>('automatic')
  const [automaticInstallError, setAutomaticInstallError] = useState<string | undefined>(undefined)
  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
  const [isSaving, setIsSaving] = useState(false)
  // Required-field errors stay hidden until the user first tries to submit, so an untouched form is
  // not littered with "required" messages. A `*` on each label signals the requirement up front.
  const [showProviderErrors, setShowProviderErrors] = useState(false)
  const [validationMessage, setValidationMessage] = useState<string | undefined>(undefined)
  const [validationOk, setValidationOk] = useState(false)
  const didRequestCheck = useRef(false)

  // App starts this check on every launch. This local fallback also keeps the wizard self-contained in
  // tests or alternate entry surfaces where it may be mounted without App as its parent.
  useEffect(() => {
    if (
      !environmentCheck &&
      !environmentCheckError &&
      !isCheckingEnvironment &&
      !didRequestCheck.current
    ) {
      didRequestCheck.current = true
      void checkEnvironment()
    }
  }, [environmentCheck, environmentCheckError, isCheckingEnvironment, checkEnvironment])

  // Onboarding always creates a provider, so required fields must be filled before it can continue.
  const formErrors = getProviderFormErrors(formValue)

  const describeInstallFailure = (result: ClaudeInstallResult): string => {
    if (result.error) return result.error
    if (result.timedOut) return 'The installer timed out before Claude was ready.'
    if (result.exitCode !== undefined) return `The installer exited with code ${result.exitCode}.`

    return 'Claude was not detected after the installer finished.'
  }

  const handleEnvironmentCheck = async (): Promise<void> => {
    setAutomaticInstallError(undefined)
    await checkEnvironment()
  }

  const handleInstall = async (source: ClaudeInstallSource): Promise<void> => {
    setAutomaticInstallError(undefined)

    try {
      const result = await installClaude(
        source,
        source === 'managed' ? environmentCheck?.recommendedRegistry : undefined
      )

      if (!result.ok) {
        setAutomaticInstallError(describeInstallFailure(result))
        return
      }

      await checkEnvironment()
    } catch (error) {
      setAutomaticInstallError(
        error instanceof Error ? error.message : 'The installer could not be started.'
      )
    }
  }

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
    <main className="h-svh overflow-y-auto overscroll-contain bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="font-serif text-2xl font-medium">
          {isRecovery ? 'Open Science needs attention' : 'Welcome to Open Science'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isRecovery
            ? 'A required environment check changed since your last launch. Repair it to continue.'
            : 'We will prepare this computer automatically, then connect your model.'}
        </p>

        {!isRecovery ? (
          <ol className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
            <li className={step === 'claude' ? 'font-medium text-foreground' : ''}>
              1. Environment
            </li>
            <li aria-hidden="true">→</li>
            <li className={step === 'provider' ? 'font-medium text-foreground' : ''}>2. Model</li>
          </ol>
        ) : null}

        {step === 'claude' ? (
          <section aria-label="Prepare environment" className="mt-6 space-y-4">
            <div
              className="grid grid-cols-2 rounded-xl border border-border bg-muted/40 p-1"
              role="tablist"
              aria-label="Environment setup mode"
            >
              <button
                type="button"
                role="tab"
                aria-selected={environmentMode === 'automatic'}
                aria-controls="automatic-environment-panel"
                id="automatic-environment-tab"
                onClick={() => setEnvironmentMode('automatic')}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  environmentMode === 'automatic'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Automatic detection
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={environmentMode === 'manual'}
                aria-controls="manual-environment-panel"
                id="manual-environment-tab"
                onClick={() => setEnvironmentMode('manual')}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  environmentMode === 'manual'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Manual setup
              </button>
            </div>

            {environmentMode === 'automatic' ? (
              <div
                id="automatic-environment-panel"
                role="tabpanel"
                aria-labelledby="automatic-environment-tab"
              >
                <EnvironmentSetupCard
                  environment={environmentCheck}
                  isChecking={isCheckingEnvironment}
                  isInstalling={isInstalling}
                  installLogs={installLogs}
                  installProgress={installProgress}
                  error={automaticInstallError ?? storeInstallError ?? environmentCheckError}
                  onCheck={() => void handleEnvironmentCheck()}
                  onInstall={() => void handleInstall('managed')}
                />
              </div>
            ) : (
              <div
                id="manual-environment-panel"
                role="tabpanel"
                aria-labelledby="manual-environment-tab"
                className="space-y-4"
              >
                <p className="rounded-lg border border-border bg-muted/35 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  Advanced fallback: choose the original installer source and copyable scripts. Use
                  Check again after completing any external permission or installation step.
                </p>
                <ClaudeStatusCard
                  claude={claude}
                  claudeReady={preflight.claudeReady}
                  isDetecting={isDetectingClaude || isCheckingEnvironment}
                  onDetect={() => void handleEnvironmentCheck()}
                />
                {!preflight.claudeReady ? (
                  <ClaudeInstallCard
                    isInstalling={isInstalling}
                    installLogs={installLogs}
                    installProgress={installProgress}
                    installError={storeInstallError}
                    npmAvailable={npmAvailable}
                    onInstall={(source) => void handleInstall(source)}
                  />
                ) : null}
              </div>
            )}

            <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                {environmentCheck?.ready
                  ? 'All required environment checks passed.'
                  : 'Complete every required item above to continue.'}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (isRecovery) {
                    closeEnvironmentRepair()
                  } else {
                    setStep('provider')
                  }
                }}
                disabled={!environmentCheck?.ready}
                className="shrink-0 rounded-lg border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {isRecovery ? 'Return to Open Science' : 'Continue'}
              </button>
            </div>
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
              encryptionAvailable={encryptionAvailable}
            />
            {validationMessage ? (
              <p
                className={`text-sm ${validationOk ? 'text-primary' : 'text-destructive'}`}
                role="alert"
              >
                {validationMessage}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-3">
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
