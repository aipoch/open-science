import { Check } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
import { onboardingErrorMessage } from './onboarding-error'
import { ProviderStep } from './ProviderStep'

// Location is last: it doubles as the wizard's Finish step, so the confirm-restart dialog can
// show only once the provider is already validated.
type WizardStep = 'environment' | 'agent' | 'provider' | 'notebook' | 'location'
type OnboardingWizardProps = {
  loadStorageInfo?: () => Promise<StorageInfo>
}

const STEP_ORDER: WizardStep[] = ['environment', 'agent', 'provider', 'notebook', 'location']

// The step id is a runtime value, so it can't be interpolated into a natural-language key.
const STEP_LABELS = {
  environment: 'Environment',
  agent: 'Agent runtime',
  provider: 'Model provider',
  notebook: 'Notebook runtime',
  location: 'Data location'
}
const loadStorageInfoFromBridge = (): Promise<StorageInfo> => window.api.storage.getInfo()

const windowsDriveLetter = (path: string): string | undefined => {
  const match = /^([a-z]):[\\/]/i.exec(path)
  return match?.[1].toUpperCase()
}

// On a fresh Windows setup, prefer the first usable data drive (D:, E:, F:, ...). Existing
// OpenScience folders are deliberately skipped: adopting historical data remains an explicit user
// choice through Browse rather than a silent onboarding default.
const findWindowsStorageDefault = async (
  storageInfo: StorageInfo
): Promise<LocationDraft | null> => {
  if (
    window.api.platform !== 'win32' ||
    !storageInfo.isDefault ||
    !storageInfo.canAutoSelectDataDrive
  ) {
    return null
  }

  const defaultDrive = windowsDriveLetter(storageInfo.defaultDataRoot)
  if (!defaultDrive) return null

  let drives: Awaited<ReturnType<typeof window.api.localFs.listDrives>>
  try {
    drives = await window.api.localFs.listDrives()
  } catch {
    return null
  }

  const candidates = drives
    .map((drive) => ({ drive, letter: windowsDriveLetter(drive.path) }))
    .filter(
      (candidate): candidate is { drive: (typeof drives)[number]; letter: string } =>
        candidate.letter !== undefined &&
        candidate.letter >= 'D' &&
        candidate.letter !== defaultDrive
    )
    .sort((left, right) => left.letter.localeCompare(right.letter))

  for (const { drive } of candidates) {
    try {
      const inspection = await window.api.storage.inspectDataRoot(drive.path)
      if (inspection.kind === 'move') {
        return {
          chosenParent: drive.path,
          chosenDataRoot: inspection.dataRoot,
          chosenKind: 'move'
        }
      }
    } catch {
      // This is an opportunistic default. A failed probe must not block onboarding or surface an
      // error for a location the user never chose.
    }
  }

  return null
}

// Keeps the five-step sequence visible without turning the lightweight setup flow into navigation.
const OnboardingProgress = ({ step }: { step: WizardStep }): React.JSX.Element => {
  const { t } = useTranslation()
  const currentIndex = STEP_ORDER.indexOf(step)

  return (
    <ol aria-label={t('Setup progress')} className="mt-7 space-y-3">
      {STEP_ORDER.map((wizardStep, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'upcoming'

        return (
          <li
            key={wizardStep}
            aria-current={state === 'active' ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 text-sm',
              state === 'active' ? 'font-medium text-text-000' : 'text-muted-foreground'
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
            <span>{t(STEP_LABELS[wizardStep])}</span>
          </li>
        )
      })}
    </ol>
  )
}

// First-run gate: inspect the host, install the agent runtime, configure and validate a model
// provider, optionally set up the notebook runtime, then choose where data lives — one focused
// step each. Completed users repair later environment regressions from the relevant Settings panel.
const OnboardingWizard = ({
  loadStorageInfo = loadStorageInfoFromBridge
}: OnboardingWizardProps): React.JSX.Element => {
  const { t } = useTranslation()
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const environmentCheckError = useSettingsStore((state) => state.environmentCheckError)
  const isCheckingEnvironment = useSettingsStore((state) => state.isCheckingEnvironment)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)

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
  const [dataRootError, setDataRootError] = useState<string | undefined>(undefined)
  // Like the provider draft, the data-location choice belongs to the stable shell so Back/Continue
  // does not discard it when LocationStep unmounts.
  const [locationDraft, setLocationDraft] = useState<LocationDraft>({
    chosenParent: '',
    chosenDataRoot: '',
    chosenKind: null
  })
  // A slow automatic drive probe must never overwrite a location the user explicitly browsed to
  // (or their explicit reset back to the system default).
  const locationDraftTouched = useRef(false)
  const handleLocationDraftChange = useCallback((draft: LocationDraft): void => {
    locationDraftTouched.current = true
    setLocationDraft(draft)
  }, [])
  const [relaunchError, setRelaunchError] = useState<string | undefined>(undefined)
  // Relaunching replaces the whole wizard with a bare screen — owned here because LocationStep
  // unmounts (and the layout disappears) while it is in flight.
  const [isRelaunching, setIsRelaunching] = useState(false)

  const didRequestCheck = useRef(false)
  const didKickEnv = useRef(false)

  // Fetch the default data location once, up front, so the Location step has something to show
  // and the provider step can later tell whether the user's choice actually differs from it.
  const handleDataRootInfoSuccess = useCallback((info: StorageInfo): void => {
    setDataRootInfo(info)
    setDataRootError(undefined)
  }, [])
  const handleDataRootInfoFailure = useCallback((error: unknown): void => {
    setDataRootError(
      onboardingErrorMessage(error, 'Could not load the default data location. Please try again.')
    )
  }, [])
  const retryDataRootInfo = useCallback((): void => {
    void loadStorageInfo().then(handleDataRootInfoSuccess, handleDataRootInfoFailure)
  }, [handleDataRootInfoFailure, handleDataRootInfoSuccess, loadStorageInfo])

  useEffect(() => {
    void loadStorageInfo().then(handleDataRootInfoSuccess, handleDataRootInfoFailure)
  }, [handleDataRootInfoFailure, handleDataRootInfoSuccess, loadStorageInfo])

  useEffect(() => {
    if (!dataRootInfo || locationDraftTouched.current) return

    let cancelled = false
    void findWindowsStorageDefault(dataRootInfo).then((recommendedDraft) => {
      if (cancelled || !recommendedDraft || locationDraftTouched.current) {
        return
      }
      setLocationDraft((current) => (current.chosenParent ? current : recommendedDraft))
    })

    return () => {
      cancelled = true
    }
  }, [dataRootInfo])

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
        <p className="text-sm text-text-100">{t('Setting up your workspace…')}</p>
      </main>
    )
  }

  return (
    <main className="h-svh overflow-y-auto bg-bg-10 text-text-000">
      <div className="mx-auto min-h-full w-full max-w-[1040px] px-4 py-5 sm:px-8 sm:py-7">
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
          className="mt-8 grid grid-cols-1 gap-6 md:mt-12 md:grid-cols-[240px_minmax(0,1fr)] md:gap-10"
        >
          <section aria-labelledby="onboarding-introduction-title" className="md:pt-2">
            <p className="text-[11px] font-medium text-muted-foreground">{t('FIRST-TIME SETUP')}</p>
            <h1
              id="onboarding-introduction-title"
              className="mt-2 font-serif text-[28px] leading-[1.15] font-medium text-text-000"
            >
              {t('Set up your research workspace.')}
            </h1>
            <p className="mt-3 max-w-60 text-sm leading-5 text-muted-foreground">
              {t(
                'A quick host check confirms this computer is ready, you connect the model you want to use, then you choose where your data lives.'
              )}
            </p>
            <OnboardingProgress step={step} />
          </section>

          {/* One stable work surface keeps the setup steps aligned as their content changes. */}
          <Card className="min-h-[420px] gap-0 rounded-lg bg-bg-000 py-0 shadow-card ring-1 ring-border-200">
            {/* Each step owns its validation gate and advances only through its callback. The shell
                owns cross-step drafts so Back/Continue never discards provider or location input. */}
            {step === 'environment' ? (
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
                dataRootError={dataRootError}
                locationDraft={locationDraft}
                onLocationDraftChange={handleLocationDraftChange}
                relaunchError={relaunchError}
                onRelaunchErrorChange={setRelaunchError}
                onRetryDataRootInfo={retryDataRootInfo}
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
