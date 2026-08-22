import { Check } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { APP } from '../../../../shared/app-config'
import { useSettingsStore } from '@/stores/settings-store'
import {
  createEmptyProviderFormValue,
  type ProviderFormValue
} from '../settings/provider-form-value'
import { AgentStep } from './AgentStep'
import { ProviderStep } from './ProviderStep'

type WizardStep = 'agent' | 'provider'

const STEP_ORDER: WizardStep[] = ['agent', 'provider']

// The step id is a runtime value, so it can't be interpolated into a natural-language key.
const STEP_LABELS = {
  agent: 'Agent runtime',
  provider: 'Model provider'
}

// Keeps the two decisions visible without turning the lightweight setup flow into navigation.
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

// First-run gate: install a usable agent runtime, then configure and validate a model provider.
// Storage is resolved before owners start, and Python preparation runs in the background from App.
const OnboardingWizard = ({
  backgroundStatus
}: {
  backgroundStatus?: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const environmentCheckError = useSettingsStore((state) => state.environmentCheckError)
  const isCheckingEnvironment = useSettingsStore((state) => state.isCheckingEnvironment)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)
  const completeOnboarding = useSettingsStore((state) => state.completeOnboarding)

  const [step, setStep] = useState<WizardStep>('agent')
  // The provider draft lives here (not in ProviderStep) so going Back and returning keeps it.
  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
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
                'Choose an agent framework and connect a model. Research tools are prepared automatically in the background.'
              )}
            </p>
            {backgroundStatus}
            <OnboardingProgress step={step} />
          </section>

          {/* One stable work surface keeps the setup steps aligned as their content changes. */}
          <Card className="min-h-[420px] gap-0 rounded-lg bg-bg-000 py-0 shadow-card ring-1 ring-border-200">
            {/* Each step owns its validation gate and advances only through its callback. */}
            {step === 'agent' ? (
              <AgentStep onContinue={() => setStep('provider')} />
            ) : (
              <ProviderStep
                formValue={formValue}
                setFormValue={setFormValue}
                onBack={() => setStep('agent')}
                onAdvance={completeOnboarding}
              />
            )}
          </Card>
        </div>
      </div>
    </main>
  )
}

export { OnboardingWizard }
