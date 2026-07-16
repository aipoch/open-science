import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { APP } from '../../../../shared/app-config'
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

// Keeps the two-step sequence visible without turning the lightweight setup flow into navigation.
const OnboardingProgress = ({ step }: { step: WizardStep }): React.JSX.Element => {
  const providerActive = step === 'provider'

  return (
    <ol aria-label="Setup progress" className="mt-7 space-y-3">
      <li
        aria-current={!providerActive ? 'step' : undefined}
        className={cn(
          'flex items-center gap-2 text-sm',
          providerActive ? 'text-text-100' : 'font-medium text-text-000'
        )}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]',
            providerActive
              ? 'border border-primary/40 text-primary'
              : 'bg-primary font-medium text-primary-foreground'
          )}
          aria-hidden="true"
        >
          {providerActive ? <Check className="size-3" strokeWidth={2.4} /> : '1'}
        </span>
        <span>Environment</span>
      </li>
      <li
        aria-current={providerActive ? 'step' : undefined}
        className={cn(
          'flex items-center gap-2 text-sm',
          providerActive ? 'font-medium text-text-000' : 'text-text-300'
        )}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]',
            providerActive
              ? 'bg-primary font-medium text-primary-foreground'
              : 'border border-border-300 bg-bg-000'
          )}
          aria-hidden="true"
        >
          2
        </span>
        <span>Model provider</span>
      </li>
    </ol>
  )
}

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

// First-run gate: inspect the host (automatic checks, with the original manual installer kept as a
// tab), then configure and validate a model provider. Reuses the same cards/form as the settings
// page so both surfaces stay in sync. For completed users App can re-open only the environment
// portion when a required dependency later disappears (recovery mode).
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

  // A completed user re-opened only for a regressed required check: environment repair, no model step.
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

  const environmentReady = environmentCheck?.ready ?? false

  return (
    <main className="h-svh overflow-y-auto bg-bg-10 text-text-000">
      <div className="mx-auto min-h-full w-full max-w-[1040px] px-8 py-7">
        <a
          href={APP.links.website}
          target="_blank"
          rel="noreferrer"
          className="font-serif text-[26px] font-medium leading-none tracking-[-0.02em] text-text-000 transition-colors duration-150 ease-out hover:text-text-100"
        >
          Open Science
        </a>

        <div
          data-onboarding-layout="split"
          className="mt-12 grid grid-cols-[240px_minmax(0,1fr)] gap-10"
        >
          <section aria-labelledby="onboarding-introduction-title" className="pt-2">
            <p className="text-[11px] font-medium text-text-100">
              {isRecovery ? 'NEEDS ATTENTION' : 'FIRST-TIME SETUP'}
            </p>
            <h1
              id="onboarding-introduction-title"
              className="mt-2 font-serif text-[28px] leading-[1.15] font-medium text-text-000"
            >
              {isRecovery ? 'Open Science needs attention' : 'Set up your research workspace.'}
            </h1>
            <p className="mt-3 max-w-60 text-sm leading-5 text-text-100">
              {isRecovery
                ? 'A required environment check changed since your last launch. Repair it to continue.'
                : 'A quick host check confirms this computer is ready, then you connect the model you want to use.'}
            </p>
            {/* Recovery only reopens the environment portion, so the two-step tracker does not apply. */}
            {!isRecovery ? <OnboardingProgress step={step} /> : null}
          </section>

          {/* One stable work surface keeps the two setup steps aligned as their content changes. */}
          <Card className="min-h-[420px] gap-0 rounded-lg bg-bg-000 py-0 shadow-card ring-1 ring-border-200">
            {step === 'claude' ? (
              <>
                <CardHeader className="gap-1 rounded-t-lg px-6 py-5">
                  <CardTitle className="text-[15px] font-semibold">
                    {isRecovery ? 'Repair environment' : 'Prepare environment'}
                  </CardTitle>
                  <CardDescription className="text-xs leading-5">
                    {isRecovery
                      ? 'Resolve the required item below to return to Open Science.'
                      : 'Open Science confirms its core requirements before your first research session.'}
                  </CardDescription>
                </CardHeader>
                <Separator className="bg-border-200" />

                <CardContent className="flex-1 px-6 py-5">
                  <section aria-label="Prepare environment" className="space-y-5">
                    <div
                      className="grid grid-cols-2 gap-1 rounded-lg bg-bg-10 p-1 ring-1 ring-border-200"
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
                        className={cn(
                          'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                          environmentMode === 'automatic'
                            ? 'bg-bg-000 text-text-000 shadow-sm ring-1 ring-border-200'
                            : 'text-text-100 hover:text-text-000'
                        )}
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
                        className={cn(
                          'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                          environmentMode === 'manual'
                            ? 'bg-bg-000 text-text-000 shadow-sm ring-1 ring-border-200'
                            : 'text-text-100 hover:text-text-000'
                        )}
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
                          error={
                            automaticInstallError ?? storeInstallError ?? environmentCheckError
                          }
                          onCheck={() => void handleEnvironmentCheck()}
                          onInstall={() => void handleInstall('managed')}
                        />
                      </div>
                    ) : (
                      <div
                        id="manual-environment-panel"
                        role="tabpanel"
                        aria-labelledby="manual-environment-tab"
                        className="space-y-5"
                      >
                        <p className="rounded-lg bg-bg-10 px-3 py-2 text-xs leading-relaxed text-text-100 ring-1 ring-border-200">
                          Advanced fallback: pick the original installer source and copyable
                          scripts. Use Re-detect after completing any external permission or
                          installation step.
                        </p>
                        <ClaudeStatusCard
                          claude={claude}
                          claudeReady={preflight.claudeReady}
                          isDetecting={isDetectingClaude || isCheckingEnvironment}
                          onDetect={() => void handleEnvironmentCheck()}
                          embedded
                        />
                        {!preflight.claudeReady ? (
                          <>
                            <Separator className="bg-border-200" />
                            <ClaudeInstallCard
                              isInstalling={isInstalling}
                              installLogs={installLogs}
                              installProgress={installProgress}
                              installError={storeInstallError}
                              npmAvailable={npmAvailable}
                              onInstall={(source) => void handleInstall(source)}
                              embedded
                            />
                          </>
                        ) : null}
                      </div>
                    )}
                  </section>
                </CardContent>
                <CardFooter className="mt-auto items-center justify-between gap-4 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
                  <p className="text-xs leading-5 text-text-100">
                    {environmentReady
                      ? 'All required environment checks passed.'
                      : 'Complete every required item above to continue.'}
                  </p>
                  <Button
                    type="button"
                    onClick={() => {
                      if (isRecovery) {
                        closeEnvironmentRepair()
                      } else {
                        setStep('provider')
                      }
                    }}
                    disabled={!environmentReady}
                    className="px-4"
                  >
                    {isRecovery ? 'Return to Open Science' : 'Continue'}
                  </Button>
                </CardFooter>
              </>
            ) : (
              <>
                <CardHeader className="gap-1 rounded-t-lg px-6 py-5">
                  <CardTitle className="text-[15px] font-semibold">Connect a model</CardTitle>
                  <CardDescription className="text-xs leading-5">
                    Choose the provider Open Science should use for new research sessions.
                  </CardDescription>
                </CardHeader>
                <Separator className="bg-border-200" />

                <CardContent className="flex-1 px-6 py-5">
                  <section aria-label="Configure model">
                    {!encryptionAvailable ? (
                      <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        Secure key storage is unavailable on this machine. Your key will be stored
                        with reduced protection.
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
                        className={`mt-4 text-sm ${validationOk ? 'text-primary' : 'text-destructive'}`}
                        role="alert"
                      >
                        {validationMessage}
                      </p>
                    ) : null}
                  </section>
                </CardContent>
                <CardFooter className="mt-auto justify-end gap-2 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
                  <Button type="button" variant="outline" onClick={() => setStep('claude')}>
                    Back
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleSaveProvider()}
                    disabled={isSaving}
                    className="px-4"
                  >
                    {isSaving ? 'Testing connection…' : 'Test & continue'}
                  </Button>
                </CardFooter>
              </>
            )}
          </Card>
        </div>
      </div>
    </main>
  )
}

export { OnboardingWizard }
