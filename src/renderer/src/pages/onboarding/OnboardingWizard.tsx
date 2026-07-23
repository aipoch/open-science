import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { APP } from '../../../../shared/app-config'
import type { StorageInfo } from '../../../../shared/storage'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
  createEmptyProviderFormValue,
  type ProviderFormValue
} from '../settings/provider-form-value'
import { AgentStep } from './AgentStep'
import { EnvironmentStep } from './EnvironmentStep'
import { LocationStep, type LocationDraft } from './LocationStep'
import { NotebookStep } from './NotebookStep'
import { ProviderStep } from './ProviderStep'
import { RecoveryStep } from './RecoveryStep'

// Location is last: it doubles as the wizard's Finish step, so the confirm-restart dialog can
// show only once the provider is already validated.
type WizardStep = 'environment' | 'agent' | 'provider' | 'notebook' | 'location'

const STEP_ORDER: WizardStep[] = ['environment', 'agent', 'provider', 'notebook', 'location']
const STEP_LABELS: Record<WizardStep, string> = {
  environment: 'Environment',
  agent: 'Agent runtime',
  provider: 'Model provider',
  notebook: 'Notebook runtime',
  location: 'Data location'
}

// Keeps the five-step sequence visible without turning the lightweight setup flow into navigation.
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

// First-run gate: inspect the host, install the agent runtime, configure and validate a model
// provider, optionally set up the notebook runtime, then choose where data lives — one focused
// step each. For completed users App can re-open only the repair surface (RecoveryStep) when a
// required dependency later disappears.
const OnboardingWizard = (): React.JSX.Element => {
  const onboardingCompletedAt = useSettingsStore((state) => state.onboardingCompletedAt)
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const environmentCheckError = useSettingsStore((state) => state.environmentCheckError)
  const isCheckingEnvironment = useSettingsStore((state) => state.isCheckingEnvironment)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)

  // A completed user re-opened only for a regressed required check: environment repair, no steps.
  const isRecovery = onboardingCompletedAt !== undefined
  // First-time setup always starts on the visible environment summary, even when every check has
  // already passed. The user explicitly continues to agent setup after reviewing it.

  const envInit = useNotebookEnvStore((s) => s.init)

  const [step, setStep] = useState<WizardStep>('environment')
  // The provider draft lives here (not in ProviderStep) so going Back and returning keeps it.
  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
  // Fetched once, up front, so the Location step has the default to show and the provider step can
  // later tell whether the user's choice actually differs from it.
  const [dataRootInfo, setDataRootInfo] = useState<StorageInfo | null>(null)
  // Like the provider draft, the data-location choice belongs to the stable shell so Back/Continue
  // does not discard it when LocationStep unmounts.
  const [locationDraft, setLocationDraft] = useState<LocationDraft>({
    chosenParent: '',
    chosenDataRoot: '',
    chosenKind: null
  })
  const [relaunchError, setRelaunchError] = useState<string | undefined>(undefined)
  // Relaunching replaces the whole wizard with a bare screen — owned here because LocationStep
  // unmounts (and the layout disappears) while it is in flight.
  const [isRelaunching, setIsRelaunching] = useState(false)

  const didRequestCheck = useRef(false)
  const didKickEnv = useRef(false)

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

  // Detect-only: hydrate the env store so the Notebook step's status/progress row reflects the real
  // managed-python state, but do NOT auto-provision here. A fresh env is built lazily on first
  // notebook use. Guarded so re-renders don't refire it.
  useEffect(() => {
    if (didKickEnv.current) return
    didKickEnv.current = true
    void envInit()
  }, [envInit])

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
            {/* Recovery only reopens the repair surface, so the step tracker does not apply. */}
            {!isRecovery ? <OnboardingProgress step={step} /> : null}
          </section>

          {/* One stable work surface keeps the setup steps aligned as their content changes. */}
          <Card className="min-h-[420px] gap-0 rounded-lg bg-bg-000 py-0 shadow-card ring-1 ring-border-200">
            {/* Each step owns its validation gate and advances only through its callback. The shell
                owns cross-step drafts so Back/Continue never discards provider or location input. */}
            {isRecovery ? (
              <RecoveryStep />
            ) : step === 'environment' ? (
              <EnvironmentStep onContinue={() => setStep('agent')} />
            ) : step === 'agent' ? (
              <AgentStep
                onBack={() => setStep('environment')}
                onContinue={() => setStep('provider')}
              />
            ) : step === 'provider' ? (
              <ProviderStep
                formValue={formValue}
                setFormValue={setFormValue}
                onBack={() => setStep('agent')}
                onAdvance={() => setStep('notebook')}
              />
            ) : step === 'notebook' ? (
              <NotebookStep
                onBack={() => setStep('provider')}
                onContinue={() => setStep('location')}
              />
            ) : (
              <LocationStep
                dataRootInfo={dataRootInfo}
                locationDraft={locationDraft}
                onLocationDraftChange={setLocationDraft}
                relaunchError={relaunchError}
                onRelaunchErrorChange={setRelaunchError}
                onBack={() => setStep('notebook')}
                setIsRelaunching={setIsRelaunching}
              />
            )}
          </Card>
        </div>
      </div>
    </main>
  )
}

export { OnboardingWizard }
