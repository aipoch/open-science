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
        <span>Claude runtime</span>
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
  const installProgress = useSettingsStore((state) => state.installProgress)
  const installError = useSettingsStore((state) => state.installError)
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
            <p className="text-[11px] font-medium text-text-100">FIRST-TIME SETUP</p>
            <h1
              id="onboarding-introduction-title"
              className="mt-2 font-serif text-[28px] leading-[1.15] font-medium text-text-000"
            >
              Set up your research workspace.
            </h1>
            <p className="mt-3 max-w-60 text-sm leading-5 text-text-100">
              Two quick checks connect the local runtime and the model you want to use.
            </p>
            <OnboardingProgress step={step} />
          </section>

          {/* One stable work surface keeps the two setup steps aligned as their content changes. */}
          <Card className="min-h-[420px] gap-0 rounded-lg bg-bg-000 py-0 shadow-card ring-1 ring-border-200">
            <CardHeader className="gap-1 rounded-t-lg px-6 py-5">
              <CardTitle className="text-[15px] font-semibold">
                {step === 'claude' ? 'Connect Claude' : 'Connect a model'}
              </CardTitle>
              <CardDescription className="text-xs leading-5">
                {step === 'claude'
                  ? 'Open Science uses Claude Code as its local agent runtime.'
                  : 'Choose the provider Open Science should use for new research sessions.'}
              </CardDescription>
            </CardHeader>
            <Separator className="bg-border-200" />

            {step === 'claude' ? (
              <>
                <CardContent className="flex-1 px-6 py-5">
                  <section aria-label="Confirm Claude" className="space-y-5">
                    <ClaudeStatusCard
                      claude={claude}
                      claudeReady={preflight.claudeReady}
                      isDetecting={isDetectingClaude}
                      onDetect={() => void detectClaude()}
                      embedded
                    />
                    {/* Once Claude is ready, installation controls no longer add useful choices. */}
                    {!preflight.claudeReady ? (
                      <>
                        <Separator className="bg-border-200" />
                        <ClaudeInstallCard
                          isInstalling={isInstalling}
                          installLogs={installLogs}
                          installProgress={installProgress}
                          installError={installError}
                          npmAvailable={npmAvailable}
                          onInstall={(source) => void installClaude(source)}
                          embedded
                        />
                      </>
                    ) : null}
                  </section>
                </CardContent>
                <CardFooter className="mt-auto justify-end rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
                  <Button
                    type="button"
                    onClick={() => setStep('provider')}
                    disabled={!preflight.claudeReady}
                    className="px-4"
                  >
                    Continue
                  </Button>
                </CardFooter>
              </>
            ) : (
              <>
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
                    {isSaving ? 'Testing connection…' : 'Test connection & finish'}
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
