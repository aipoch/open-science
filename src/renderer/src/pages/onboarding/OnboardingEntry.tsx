import { ArrowRight, Check, KeyRound, Settings2 } from 'lucide-react'
import type { AnimationItem } from 'lottie-web'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import logoUrl from '@/assets/logo-symbol.svg'
import codexUrl from '@/assets/onboarding/icons/openai-codex.svg?url&no-inline'
import claudeCodeUrl from '@/assets/onboarding/icons/claude-code.svg?url&no-inline'
import openCodeUrl from '@/assets/onboarding/icons/opencode.svg?url&no-inline'
import piUrl from '@/assets/onboarding/icons/pi.svg?url&no-inline'
import openAiUrl from '@/assets/onboarding/icons/openai.svg?url&no-inline'
import anthropicUrl from '@/assets/onboarding/icons/anthropic.svg?url&no-inline'
import grokUrl from '@/assets/onboarding/icons/xai-grok.svg?url&no-inline'
import deepSeekUrl from '@/assets/onboarding/icons/deepseek.svg?url&no-inline'
import kimiUrl from '@/assets/onboarding/icons/kimi.svg?url&no-inline'
import codeBuddyUrl from '@/assets/onboarding/icons/codebuddy.svg?url&no-inline'
import bailianUrl from '@/assets/provider-icons/bailian.svg?url&no-inline'
import zhipuUrl from '@/assets/provider-icons/zhipu.svg?url&no-inline'
import minimaxUrl from '@/assets/provider-icons/minimax.svg?url&no-inline'
import stepfunUrl from '@/assets/provider-icons/stepfun.svg?url&no-inline'
import openrouterUrl from '@/assets/provider-icons/openrouter.svg?url&no-inline'
import volcengineUrl from '@/assets/provider-icons/volcengine.svg?url&no-inline'
import { OnboardingErrorNotice, type OnboardingFailure } from './OnboardingErrorNotice'
import { onboardingErrorMessage } from './onboarding-error'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings-store'
import {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isXaiSubscriptionProvider
} from '../../../../shared/settings-runtime'
import { KILO_FREE_MODEL_ID } from '../../../../shared/provider-model-catalog'
import { providerAllowsAnonymousAccess } from '../../../../shared/provider-url-policy'
import { cn } from '@/lib/utils'
import guideExampleCasesGif from '@/assets/onboarding/guide-example-cases.gif'
import guideNewProjectGif from '@/assets/onboarding/guide-new-project.gif'
import welcomeAnimation from '@/assets/onboarding/welcome-optimized.json'

const welcomeAnimationAssetUrls: Record<string, string> = {
  'providers-openai': openAiUrl,
  'providers-anthropic': anthropicUrl,
  'providers-xai-grok': grokUrl,
  'providers-deepseek': deepSeekUrl,
  'providers-kimi': kimiUrl,
  'providers-codebuddy': codeBuddyUrl,
  'providers-bailian': bailianUrl,
  'providers-zhipu': zhipuUrl,
  'providers-minimax': minimaxUrl,
  'providers-stepfun': stepfunUrl,
  'providers-openrouter': openrouterUrl,
  'providers-volcengine': volcengineUrl,
  'agents-openai-codex': codexUrl,
  'agents-claude-code': claudeCodeUrl,
  'agents-opencode': openCodeUrl,
  'agents-pi': piUrl,
  'agents-codebuddy': codeBuddyUrl
}

const FALLBACK_ANIMATION_TIMEOUT_MS = 3_600

type WelcomeAnimationProps = {
  onComplete: () => void
}

const completeAnimation = (
  onComplete: () => void,
  sentRef: React.MutableRefObject<boolean>
): void => {
  if (sentRef.current) return
  sentRef.current = true
  onComplete()
}

const WelcomeAnimation = ({ onComplete }: WelcomeAnimationProps): React.JSX.Element => {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const completionSentRef = useRef(false)
  const [useFallback, setUseFallback] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  const [isFinished, setIsFinished] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    let animation: AnimationItem | undefined
    let cancelled = false
    let fallbackTimer: number | undefined
    const complete = (): void => {
      if (cancelled || completionSentRef.current) return
      completionSentRef.current = true
      setIsFinished(true)
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
      onComplete()
    }
    const fallback = (): void => {
      if (cancelled || completionSentRef.current || fallbackTimer !== undefined) return
      animation?.destroy()
      animation = undefined
      setUseFallback(true)
      // CSS animationend is the normal fallback completion signal. The bounded timer is only a
      // safety net for embedded webviews that do not dispatch CSS animation events.
      fallbackTimer = window.setTimeout(complete, FALLBACK_ANIMATION_TIMEOUT_MS)
    }

    const start = async (): Promise<void> => {
      // jsdom and older embedded webviews expose a canvas element without a drawing context. Treat
      // that as an explicit capability miss so the CSS fallback owns completion.
      const canvas = document.createElement('canvas')
      let canvasSupported = false
      try {
        canvasSupported = Boolean(canvas.getContext?.('2d'))
      } catch {
        canvasSupported = false
      }
      if (!canvasSupported) {
        fallback()
        return
      }
      try {
        const { default: lottie } = await import('lottie-web')
        if (cancelled) return
        const animationData = structuredClone(welcomeAnimation)
        animationData.assets = animationData.assets.map((asset) => {
          const assetUrl =
            asset.id === 'center' || asset.id === 'agents-open-science'
              ? logoUrl
              : welcomeAnimationAssetUrls[asset.id]
          return assetUrl ? { ...asset, p: assetUrl, u: '', e: 0 } : asset
        })
        for (const layer of animationData.layers) {
          if (layer.refId !== 'agents-open-science' && layer.refId !== 'center') continue
          layer.cl = 'onboarding-lottie-logo'
          if (layer.refId !== 'center') continue
          // Enlarge the symbol throughout convergence, so completion never swaps its size.
          for (const frame of layer.ks.s.k) {
            frame.s = frame.s.map((value, index) => (index < 2 ? value * 1.36 : value))
            frame.e = frame.e.map((value, index) => (index < 2 ? value * 1.36 : value))
          }
        }
        animation = lottie.loadAnimation({
          container,
          renderer: 'svg',
          loop: false,
          autoplay: true,
          animationData,
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet' }
        })
        animation.addEventListener('complete', complete)
        animation.addEventListener('data_failed', fallback)
      } catch {
        fallback()
      }
    }
    void start()

    return () => {
      cancelled = true
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
      animation?.removeEventListener('complete', complete)
      animation?.removeEventListener('data_failed', fallback)
      animation?.destroy()
    }
  }, [onComplete])

  return (
    <div
      className="onboarding-welcome-animation relative size-full"
      data-animation-fallback={useFallback || undefined}
    >
      <div
        ref={containerRef}
        className={cn('onboarding-welcome-lottie', useFallback && 'is-hidden')}
        role="img"
        aria-label={t('Providers converge into Agent frameworks, then into the Open-Science logo')}
      />
      {useFallback && isFinished ? (
        <div className="onboarding-welcome-fallback absolute inset-0 grid place-items-center">
          <div className="onboarding-welcome-logo relative z-2 grid place-items-center text-primary">
            <img src={logoUrl} alt="" />
          </div>
        </div>
      ) : useFallback ? (
        <div
          className="onboarding-welcome-fallback absolute inset-0 grid place-items-center"
          role="img"
          aria-label={t(
            'Providers converge into Agent frameworks, then into the Open-Science logo'
          )}
          onAnimationEnd={(event) => {
            if (!(event.target instanceof HTMLElement)) return
            if (!event.target.classList.contains('onboarding-ring-convergence')) return
            setIsFinished(true)
            completeAnimation(onComplete, completionSentRef)
          }}
        >
          <div className="onboarding-ring onboarding-ring-outer" aria-hidden="true">
            <span>{t('OpenAI')}</span>
            <span>{t('Anthropic')}</span>
            <span>{t('xAI')}</span>
            <span>{t('DeepSeek')}</span>
          </div>
          <div className="onboarding-ring onboarding-ring-inner" aria-hidden="true">
            <span>{t('Codex')}</span>
            <span>{t('Claude Agent')}</span>
            <span>{t('OpenCode')}</span>
          </div>
          <div className="onboarding-ring onboarding-ring-convergence" aria-hidden="true" />
          <div className="onboarding-welcome-logo relative z-2 grid place-items-center text-primary">
            <img src={logoUrl} alt="" />
          </div>
        </div>
      ) : null}
    </div>
  )
}

type OnboardingWelcomeProps = {
  onNext: () => void
}

const OnboardingWelcome = ({ onNext }: OnboardingWelcomeProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [isComplete, setIsComplete] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )

  const finishWelcome = useCallback(() => setIsComplete(true), [])

  return (
    <section
      aria-labelledby="onboarding-welcome-title"
      data-onboarding-entry="welcome"
      className={cn('onboarding-welcome', isComplete && 'is-complete')}
    >
      <div className="onboarding-entry-brand inline-flex items-center gap-[0.6rem] text-text-000 font-onboarding-serif text-[1.35rem] tracking-[-0.035em]">
        <img className="onboarding-entry-brand-mark" src={logoUrl} alt="" />
        <span>Open-Science</span>
      </div>

      <div className="onboarding-welcome-art">
        <WelcomeAnimation onComplete={finishWelcome} />
      </div>

      <div className="onboarding-welcome-copy" aria-live="polite">
        <h1 id="onboarding-welcome-title">{t('Welcome to Open-Science.')}</h1>
        <p>{t('An open-source, local-first AI research workbench.')}</p>
      </div>

      {isComplete ? (
        <Button
          type="button"
          data-onboarding-action="next"
          size="lg"
          onClick={onNext}
          className="mt-auto min-w-44"
        >
          {t('Next')}
          <ArrowRight aria-hidden="true" />
        </Button>
      ) : null}
    </section>
  )
}

type OnboardingReadyStepProps = {
  onBack: () => void
  onStart: () => Promise<void>
}

const GuideArtwork = ({
  slide,
  onAnimationComplete
}: {
  slide: number
  onAnimationComplete: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [gifFailed, setGifFailed] = useState(false)

  return (
    <div
      className="onboarding-guide-art relative h-68 overflow-hidden border border-border rounded-[0.8rem] bg-bg-10 py-[1.2rem] px-[1.4rem]"
      aria-hidden="true"
    >
      <div
        key={slide}
        className="onboarding-guide-cycle-signal absolute z-4 inset-0 pointer-events-none animate-onboarding-guide"
        onAnimationEnd={onAnimationComplete}
      />
      {!gifFailed ? (
        <img
          className="onboarding-guide-gif absolute z-3 inset-0 size-full object-cover rounded-[inherit]"
          src={slide === 0 ? guideNewProjectGif : guideExampleCasesGif}
          alt=""
          onError={() => setGifFailed(true)}
        />
      ) : null}
      <div className="onboarding-guide-browser-bar flex items-center gap-[0.35rem] text-muted-foreground text-[0.65rem]">
        <img className="onboarding-guide-brand-mark" src={logoUrl} alt="" />
        <span>Open-Science</span>
        <span className="onboarding-guide-window-action ml-auto border border-border rounded-[0.35rem] py-1 px-[0.45rem]">
          ＋ {t('New project')}
        </span>
      </div>
      <div className="onboarding-guide-heading mt-5 font-onboarding-serif text-[1.2rem] tracking-[-0.03em]">
        {t('Your next discovery starts here.')}
      </div>
      <div className="onboarding-guide-tabs flex gap-4 mt-[0.8rem] border-b border-b-border pb-[0.45rem] text-muted-foreground text-[0.57rem]">
        <span>{t('Projects')}</span>
        <span>{t('Recent conversations')}</span>
      </div>
      <div className="onboarding-guide-cases grid grid-cols-[repeat(3,1fr)] gap-[0.6rem] mt-4">
        <div className="onboarding-guide-case">
          <div className="onboarding-guide-paper" />
          <span>{t('From papers to a literature review')}</span>
        </div>
        <div className={cn('onboarding-guide-case', slide === 1 && 'is-focused')}>
          <div className="onboarding-guide-bars" />
          <span>{t('Explore a single-cell dataset')}</span>
        </div>
        <div className="onboarding-guide-case">
          <div className="onboarding-guide-scatter" />
          <span>{t('Create publication-ready figures')}</span>
        </div>
      </div>
      <div className={cn('onboarding-guide-new-project', slide === 0 && 'is-focused')}>
        <span>＋ {t('New project')}</span>
        <span className="onboarding-guide-cursor absolute -right-[0.6rem] -bottom-[1.2rem] w-[1.2rem] h-[1.6rem] transform-[rotate(-18deg)] border-2 border-foreground bg-bg-000 [clip-path:polygon(0_0,_100%_67%,_62%_69%,_78%_100%,_56%_100%,_42%_73%,_14%_92%)]" />
      </div>
    </div>
  )
}

function ReadyConnectionSummary(): React.JSX.Element | null {
  const { t } = useTranslation()
  const provider = useSettingsStore((state) =>
    state.providers.find(({ id }) => id === state.activeProviderId)
  )
  const activeModel = useSettingsStore((state) => state.activeModel)
  if (!provider) return null
  const model = activeModel ?? provider.model
  const freeKilo =
    provider.type === 'official' &&
    provider.vendorId === 'kilo' &&
    (model === KILO_FREE_MODEL_ID ||
      (!provider.hasKey && providerAllowsAnonymousAccess({ ...provider, model })))
  const account =
    isClaudeSubscriptionProvider(provider.type) ||
    isCodexSubscriptionProvider(provider.type) ||
    isXaiSubscriptionProvider(provider.type) ||
    provider.type === 'codebuddy-subscription'
  let label = t('Connected')
  let Icon = Settings2
  if (freeKilo) label = t('Using free Kilo models')
  else if (account) label = t('Connected with your account')
  else if (provider.hasKey) {
    label = t('Connected with API key')
    Icon = KeyRound
  }
  return (
    <div className="onboarding-connection-summary bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface dark:text-status-success-dark-foreground inline-flex items-center gap-[0.45rem] mt-4 border border-transparent rounded-full py-2 px-[0.8rem] text-[0.75rem]">
      <Check aria-hidden="true" />
      <span>{provider.name}</span>
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

const OnboardingReadyStep = ({ onBack, onStart }: OnboardingReadyStepProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [slide, setSlide] = useState(0)
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<OnboardingFailure>()

  const handleStart = async (): Promise<void> => {
    if (isStarting) return
    setError(undefined)
    setIsStarting(true)
    try {
      await onStart()
    } catch (cause) {
      setError({
        summary: t('Could not finish setup.'),
        details: onboardingErrorMessage(cause, 'completeOnboarding')
      })
      setIsStarting(false)
    }
  }

  return (
    <section
      aria-labelledby="onboarding-ready-title"
      data-onboarding-entry="ready"
      className="onboarding-ready"
    >
      <div className="onboarding-entry-brand inline-flex items-center gap-[0.6rem] text-text-000 font-onboarding-serif text-[1.35rem] tracking-[-0.035em]">
        <img className="onboarding-entry-brand-mark" src={logoUrl} alt="" />
        <span>Open-Science</span>
      </div>
      <h1 id="onboarding-ready-title">{t('You’re ready to explore.')}</h1>
      <p className="onboarding-ready-subtitle">
        {t('Start with a question. See where it takes you.')}
      </p>
      <ReadyConnectionSummary />

      <div className="onboarding-guide w-full mt-6 text-left" aria-live="polite">
        <GuideArtwork
          slide={slide}
          onAnimationComplete={() => setSlide((current) => (current + 1) % 2)}
        />
        <div className="onboarding-guide-caption flex items-start justify-between gap-4 mt-[0.8rem]">
          <div>
            <h2>
              {slide === 0
                ? t('Create a home for your next idea')
                : t('Start with a working example')}
            </h2>
            <p>
              {slide === 0
                ? t('Start a project to keep your files and conversations together.')
                : t('Open an example and explore a complete research workflow.')}
            </p>
          </div>
          <div
            className="onboarding-guide-indicators flex gap-[0.35rem] pt-[0.2rem]"
            role="img"
            aria-label={t(slide === 0 ? 'Guide 1 of 2' : 'Guide 2 of 2')}
          >
            <span className={cn(slide === 0 && 'is-active')} />
            <span className={cn(slide === 1 && 'is-active')} />
          </div>
        </div>
      </div>

      {error ? (
        <OnboardingErrorNotice failure={error} onDismiss={() => setError(undefined)} />
      ) : null}

      <div className="onboarding-ready-actions">
        <Button type="button" variant="ghost" onClick={onBack} disabled={isStarting}>
          {t('Back', { context: 'step' })}
        </Button>
        <Button
          type="button"
          size="lg"
          data-onboarding-action="finish"
          onClick={() => void handleStart()}
          disabled={isStarting}
        >
          {isStarting ? t('Finishing setup…') : t('Start exploring')}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
      <p className="onboarding-ready-footnote mt-[0.55rem] text-muted-foreground text-[0.68rem]">
        {t('You can adjust your setup at any time in Settings.')}
      </p>
    </section>
  )
}

export { OnboardingReadyStep, OnboardingWelcome }
