import { ArrowRight, Check, KeyRound, Settings2 } from 'lucide-react'
import type { AnimationItem } from 'lottie-web'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { OpenScienceLogoLoader } from '@/components/OpenScienceLogoLoader'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import welcomeAnimation from '@/assets/onboarding/welcome.json'
import guideExampleCasesGif from '@/assets/onboarding/guide-example-cases.gif'
import guideNewProjectGif from '@/assets/onboarding/guide-new-project.gif'

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
  const [useFallback, setUseFallback] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    let animation: AnimationItem | undefined
    let cancelled = false
    let fallbackTimer: number | undefined
    const complete = (): void => {
      if (completionSentRef.current) return
      completionSentRef.current = true
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
      onComplete()
    }
    const fallback = (): void => {
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
        animation = lottie.loadAnimation({
          container,
          renderer: 'svg',
          loop: false,
          autoplay: true,
          animationData: welcomeAnimation,
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
      className="onboarding-welcome-animation"
      data-animation-fallback={useFallback || undefined}
    >
      <div
        ref={containerRef}
        className={cn('onboarding-welcome-lottie', useFallback && 'is-hidden')}
        role="img"
        aria-label={t('Providers converge into Agent frameworks, then into the Open-Science logo')}
      />
      {useFallback ? (
        <div
          className="onboarding-welcome-fallback"
          role="img"
          aria-label={t(
            'Providers converge into Agent frameworks, then into the Open-Science logo'
          )}
          onAnimationEnd={(event) => {
            if (!(event.target instanceof HTMLElement)) return
            if (!event.target.classList.contains('onboarding-ring-convergence')) return
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
          <div className="onboarding-welcome-logo">
            <OpenScienceLogoLoader />
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

  return (
    <section
      aria-labelledby="onboarding-welcome-title"
      data-onboarding-entry="welcome"
      className={cn('onboarding-welcome', isComplete && 'is-complete')}
    >
      <div className="onboarding-entry-brand">
        <span className="onboarding-entry-brand-mark" aria-hidden="true" />
        <span>Open-Science</span>
      </div>

      <div className="onboarding-welcome-art">
        <WelcomeAnimation onComplete={() => setIsComplete(true)} />
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
  method: 'account' | 'api-key'
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
    <div className="onboarding-guide-art" aria-hidden="true">
      <div
        key={slide}
        className="onboarding-guide-cycle-signal"
        onAnimationEnd={onAnimationComplete}
      />
      {!gifFailed ? (
        <img
          className="onboarding-guide-gif"
          src={slide === 0 ? guideNewProjectGif : guideExampleCasesGif}
          alt=""
          onError={() => setGifFailed(true)}
        />
      ) : null}
      <div className="onboarding-guide-browser-bar">
        <span className="onboarding-guide-brand-mark" />
        <span>Open-Science</span>
        <span className="onboarding-guide-window-action">＋ {t('New project')}</span>
      </div>
      <div className="onboarding-guide-heading">{t('Your next discovery starts here.')}</div>
      <div className="onboarding-guide-tabs">
        <span>{t('Projects')}</span>
        <span>{t('Recent conversations')}</span>
      </div>
      <div className="onboarding-guide-cases">
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
        <span className="onboarding-guide-cursor" />
      </div>
    </div>
  )
}

const OnboardingReadyStep = ({
  method,
  onBack,
  onStart
}: OnboardingReadyStepProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [slide, setSlide] = useState(0)
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<string>()

  const handleStart = async (): Promise<void> => {
    if (isStarting) return
    setError(undefined)
    setIsStarting(true)
    try {
      await onStart()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not finish setup.'))
      setIsStarting(false)
    }
  }

  return (
    <section
      aria-labelledby="onboarding-ready-title"
      data-onboarding-entry="ready"
      className="onboarding-ready"
    >
      <div className="onboarding-entry-brand">
        <span className="onboarding-entry-brand-mark" aria-hidden="true" />
        <span>Open-Science</span>
      </div>
      <h1 id="onboarding-ready-title">{t('You’re ready to explore.')}</h1>
      <p className="onboarding-ready-subtitle">
        {t('Start with a question. See where it takes you.')}
      </p>
      <div className="onboarding-connection-summary">
        <Check aria-hidden="true" />
        {method === 'api-key' ? <KeyRound aria-hidden="true" /> : <Settings2 aria-hidden="true" />}
        <span>
          {method === 'api-key' ? t('Connected with API key') : t('Connected with your account')}
        </span>
      </div>

      <div className="onboarding-guide" aria-live="polite">
        <GuideArtwork
          slide={slide}
          onAnimationComplete={() => setSlide((current) => (current + 1) % 2)}
        />
        <div className="onboarding-guide-caption">
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
            className="onboarding-guide-indicators"
            role="img"
            aria-label={t(slide === 0 ? 'Guide 1 of 2' : 'Guide 2 of 2')}
          >
            <span className={cn(slide === 0 && 'is-active')} />
            <span className={cn(slide === 1 && 'is-active')} />
          </div>
        </div>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="onboarding-ready-actions">
        <Button type="button" variant="ghost" onClick={onBack} disabled={isStarting}>
          {t('Back', { context: 'step' })}
        </Button>
        <Button type="button" size="lg" onClick={() => void handleStart()} disabled={isStarting}>
          {isStarting ? t('Finishing setup…') : t('Start exploring')}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
      <p className="onboarding-ready-footnote">
        {t('You can adjust your setup at any time in Settings.')}
      </p>
    </section>
  )
}

export { OnboardingReadyStep, OnboardingWelcome }
