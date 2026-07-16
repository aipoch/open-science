import { Check } from 'lucide-react'
import { AlertDialog } from 'radix-ui'
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
import type { StorageInfo } from '../../../../shared/storage'
import type {
  ClaudeInstallResult,
  ClaudeInstallSource,
  UpsertProviderRequest
} from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { DataRootWarning } from '@/components/DataRootWarning'
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

// Location is last: it doubles as the wizard's Finish step, so the confirm-restart dialog can
// show only once the provider is already validated.
type WizardStep = 'claude' | 'provider' | 'location'
type EnvironmentMode = 'automatic' | 'manual'

const STEP_ORDER: WizardStep[] = ['claude', 'provider', 'location']
const STEP_LABELS: Record<WizardStep, string> = {
  claude: 'Environment',
  provider: 'Model provider',
  location: 'Data location'
}

// Keeps the three-step sequence visible without turning the lightweight setup flow into navigation.
const OnboardingProgress = ({ step }: { step: WizardStep }): React.JSX.Element => {
  const currentIndex = STEP_ORDER.indexOf(step)

  return (
    <ol aria-label="Setup progress" className="mt-7 space-y-3">
      {STEP_ORDER.map((wizardStep, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'upcoming'

        return (
          <li
            key={wizardStep}
            aria-current={state === 'active' ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 text-sm',
              state === 'active'
                ? 'font-medium text-text-000'
                : state === 'done'
                  ? 'text-text-100'
                  : 'text-text-300'
            )}
          >
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]',
                state === 'active'
                  ? 'bg-primary font-medium text-primary-foreground'
                  : state === 'done'
                    ? 'border border-primary/40 text-primary'
                    : 'border border-border-300 bg-bg-000'
              )}
              aria-hidden="true"
            >
              {state === 'done' ? <Check className="size-3" strokeWidth={2.4} /> : index + 1}
            </span>
            <span>{STEP_LABELS[wizardStep]}</span>
          </li>
        )
      })}
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
// tab), configure and validate a model provider, then choose where data lives. Reuses the same
// cards/form as the settings page so both surfaces stay in sync. For completed users App can
// re-open only the environment portion when a required dependency later disappears (recovery mode).
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

  // Data-root location step. Only `dataRoot` is ever touched here — the config root (settings,
  // sessions, db, claude, skills) always stays at its fixed default.
  const [dataRootInfo, setDataRootInfo] = useState<StorageInfo | null>(null)
  // The picked PARENT directory (what the browse dialog returns and what setDataRootAndRelaunch
  // takes); empty means "keep the default". The actual data root is always
  // `<chosenParent>/OpenScience`, derived server-side and shown via chosenDataRoot below.
  const [chosenParent, setChosenParent] = useState('')
  // Display-only: the derived `<parent>/OpenScience` path returned by inspectDataRoot, shown in
  // place of the raw parent so the user sees the real final location.
  const [chosenDataRoot, setChosenDataRoot] = useState('')
  // 'adopt' shows the "used as-is" note; 'move' is the ordinary empty-folder case. Irrelevant once
  // chosenParent is cleared back to the default.
  const [chosenKind, setChosenKind] = useState<'move' | 'adopt' | null>(null)
  // Non-blocking caution for the chosen location (e.g. a spaced path on macOS/Linux).
  const [chosenWarning, setChosenWarning] = useState<string | undefined>(undefined)
  const [locationError, setLocationError] = useState<string | undefined>(undefined)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [isRelaunching, setIsRelaunching] = useState(false)
  const [relaunchError, setRelaunchError] = useState<string | undefined>(undefined)

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
  // Guards against handleKeepDefault's completeOnboarding firing spuriously after Restart:
  // AlertDialog.Action fires onOpenChange(false) on click (same as Cancel), and closures inside
  // that handler can't see isRelaunching's update from the same synchronous batch, so a ref is
  // used instead of state for this check.
  const isRestartingRef = useRef(false)

  // Fetch the default data location once, up front, so the Location step has something to show
  // and the provider step can later tell whether the user's choice actually differs from it.
  useEffect(() => {
    void window.api.storage.getInfo().then(setDataRootInfo)
  }, [])

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

  const handleBrowseLocation = async (): Promise<void> => {
    const picked = await window.api.storage.pickDirectory()
    if (!picked) return

    const result = await window.api.storage.inspectDataRoot(picked)
    if (result.kind === 'invalid') {
      setLocationError(result.error)
      return
    }

    setChosenParent(picked)
    setChosenDataRoot(result.dataRoot)
    setChosenKind(result.kind)
    setChosenWarning(result.warning)
    setLocationError(undefined)
  }

  const handleResetLocation = (): void => {
    setChosenParent('')
    setChosenDataRoot('')
    setChosenKind(null)
    setChosenWarning(undefined)
    setLocationError(undefined)
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

      if (validation.ok) {
        // Location is the last step now: it decides completeOnboarding vs. the relaunch, once the
        // user confirms (or keeps) a location there.
        setStep('location')
      }
    } catch (error) {
      setValidationOk(false)
      setValidationMessage(error instanceof Error ? error.message : 'Could not save provider.')
    } finally {
      setIsSaving(false)
    }
  }

  const handleFinishLocation = async (): Promise<void> => {
    if (chosenParent) {
      // A custom location was chosen: gate completeOnboarding behind the user's confirmation.
      // Calling completeOnboarding immediately would flip the App-level startup gate to 'app'
      // and unmount this wizard (and this confirm dialog) before it could ever be shown.
      setConfirmRestart(true)
    } else {
      // Default kept: nothing more to do, the App gate takes it from here — no relaunch.
      await completeOnboarding()
    }
  }

  const handleKeepDefault = async (): Promise<void> => {
    // AlertDialog.Action also fires onOpenChange(false) on click (it closes the dialog like Cancel
    // does), which would otherwise call this a second time right after handleRestart. A ref (not
    // isRelaunching state) is required here: both handlers run synchronously in the same click
    // event, so a state-based check would still read the pre-update closure value.
    if (isRestartingRef.current) return

    setConfirmRestart(false)
    await completeOnboarding()
  }

  const handleRestart = async (): Promise<void> => {
    isRestartingRef.current = true
    setConfirmRestart(false)
    setIsRelaunching(true)

    // Deliberately NOT calling the renderer completeOnboarding() here: it flips
    // onboardingCompletedAt immediately, which would make App.tsx's startup gate swap this
    // wizard for Home (showing the OLD data root) before setDataRootAndRelaunch even runs, and
    // would turn the failure branch below into dead code. Instead the main-process handler marks
    // onboarding complete itself, in the same step as setDataRoot, right before it relaunches -
    // so the gate only flips once the new location is actually persisted.
    const result = await window.api.storage.setDataRootAndRelaunch(chosenParent, true)
    if (!result.ok) {
      // The app is not relaunching; the gate was never flipped, so we're still on the wizard -
      // surface the error here and let the user retry or fall back to Keep default.
      isRestartingRef.current = false
      setIsRelaunching(false)
      setRelaunchError(result.error ?? 'Could not restart to apply the new location.')
    }
  }

  const environmentReady = environmentCheck?.ready ?? false

  if (isRelaunching) {
    return (
      <main className="flex h-svh items-center justify-center bg-bg-10 text-text-000">
        <p className="text-sm text-text-100">Setting up your workspace…</p>
      </main>
    )
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
                : 'A quick host check confirms this computer is ready, you connect the model you want to use, then you choose where your data lives.'}
            </p>
            {/* Recovery only reopens the environment portion, so the step tracker does not apply. */}
            {!isRecovery ? <OnboardingProgress step={step} /> : null}
          </section>

          {/* One stable work surface keeps the setup steps aligned as their content changes. */}
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
            ) : step === 'provider' ? (
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
            ) : (
              <>
                <CardHeader className="gap-1 rounded-t-lg px-6 py-5">
                  <CardTitle className="text-[15px] font-semibold">
                    Where should Open Science store your data?
                  </CardTitle>
                  <CardDescription className="text-xs leading-5">
                    Large files (artifacts, notebooks, environments) go here. Your settings and
                    history always stay in the default location. You can change this later in
                    Settings.
                  </CardDescription>
                </CardHeader>
                <Separator className="bg-border-200" />

                <CardContent className="flex-1 px-6 py-5">
                  <section aria-label="Choose data location" className="space-y-5">
                    {relaunchError ? (
                      <p
                        className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                        role="alert"
                      >
                        Could not switch to the new location: {relaunchError} You can retry or keep
                        the default location.
                      </p>
                    ) : null}

                    <div className="rounded-xl border border-border-200 p-4">
                      <span className="text-xs font-medium text-text-100">Location</span>
                      <div className="mt-1 flex items-center gap-2">
                        <p
                          aria-label="Data location path"
                          className="flex-1 truncate rounded-lg border border-border-200 bg-bg-000 px-2.5 py-1.5 font-mono text-xs"
                        >
                          {chosenDataRoot || dataRootInfo?.dataRoot || ''}
                        </p>
                        <button
                          type="button"
                          onClick={() => void handleBrowseLocation()}
                          className="inline-flex shrink-0 items-center rounded-lg border border-border-200 px-3 py-1.5 text-sm font-medium text-text-000 transition-colors hover:bg-bg-10"
                        >
                          Browse…
                        </button>
                      </div>

                      {chosenDataRoot ? (
                        <p className="mt-2 text-xs text-text-100">
                          Your data will be stored in{' '}
                          <span className="font-mono">{chosenDataRoot}</span>. Open Science will
                          restart to set this up.{' '}
                          <button
                            type="button"
                            onClick={handleResetLocation}
                            className="underline underline-offset-2 hover:text-text-000"
                          >
                            Use default location instead
                          </button>
                        </p>
                      ) : null}

                      {chosenKind === 'adopt' ? (
                        <p className="mt-2 text-xs text-text-100">
                          This folder already contains Open Science data — it will be used as-is
                          (nothing is moved).
                        </p>
                      ) : null}

                      {chosenWarning ? (
                        <p
                          className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400"
                          role="alert"
                        >
                          {chosenWarning}
                        </p>
                      ) : null}

                      {locationError ? (
                        <p className="mt-2 text-xs text-destructive" role="alert">
                          {locationError}
                        </p>
                      ) : null}
                    </div>

                    <DataRootWarning />
                  </section>
                </CardContent>
                <CardFooter className="mt-auto justify-end gap-2 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
                  <Button type="button" variant="outline" onClick={() => setStep('provider')}>
                    Back
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleFinishLocation()}
                    className="px-4"
                  >
                    Finish
                  </Button>
                </CardFooter>
              </>
            )}
          </Card>
        </div>
      </div>

      <AlertDialog.Root
        open={confirmRestart}
        onOpenChange={(open) => {
          if (!open) void handleKeepDefault()
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
            <AlertDialog.Title className="text-base font-semibold text-text-000">
              Restart to set up your data?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
              Open Science will restart to set up your data at{' '}
              <span className="font-mono">{chosenDataRoot}</span>.
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="rounded-lg border border-input px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
                >
                  Keep default
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  onClick={() => void handleRestart()}
                  className="rounded-lg border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Restart
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </main>
  )
}

export { OnboardingWizard }
