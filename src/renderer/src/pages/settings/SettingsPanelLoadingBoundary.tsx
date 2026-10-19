import { Component, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'
import { SettingsPanelRetryContext } from './settings-panel-loader'

type ErrorBoundaryProps = {
  children: ReactNode
  fallback: ReactNode
  resetKey?: string
  retryKey?: number
}

type ErrorBoundaryState = { failed: boolean }

class SettingsPanelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Settings panel failed to load', error, info)
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps, previousState: ErrorBoundaryState): void {
    if (
      this.state.failed &&
      previousState.failed &&
      (previousProps.resetKey !== this.props.resetKey ||
        previousProps.retryKey !== this.props.retryKey)
    ) {
      this.setState({ failed: false })
    }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

const SKELETON_DELAY_MS = 200

// Suspense fallback: the skeleton only appears after a short delay so fast chunk loads never flash
// it; screen readers get the status text immediately.
const PanelLoadingSkeleton = (): React.JSX.Element => {
  const { t } = useTranslation()
  const [showSkeleton, setShowSkeleton] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div role="status" aria-live="polite" className="min-h-[360px] px-5 py-5">
      <span className="sr-only">{t('Loading…')}</span>
      {showSkeleton ? (
        <div aria-hidden="true" className="flex flex-col gap-6">
          <div className="space-y-2">
            <div className="h-5 w-40 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
            <div className="h-3.5 w-3/4 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <div className="size-9 shrink-0 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3.5 w-1/3 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
                <div className="h-3 w-2/3 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
              </div>
              <div className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

type SettingsPanelLoadingBoundaryProps = {
  panelKey: string
  resetKey?: string
  children: ReactNode
}

const SettingsPanelLoadingBoundary = ({
  panelKey,
  resetKey,
  children
}: SettingsPanelLoadingBoundaryProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [retryKey, setRetryKey] = useState(0)

  return (
    <SettingsPanelErrorBoundary
      key={panelKey}
      resetKey={resetKey}
      retryKey={retryKey}
      fallback={
        <div className="flex min-h-[360px] items-center justify-center px-5">
          <ErrorNotice
            role="alert"
            tone="amber"
            title={t("Settings panel couldn't be loaded.")}
            description={t(
              'This is usually a temporary file issue after an app update. Retry to load it in place — no need to reload the app.'
            )}
            primaryButton={{
              label: t('Retry'),
              onClick: () => setRetryKey((key) => key + 1)
            }}
          />
        </div>
      }
    >
      <SettingsPanelRetryContext.Provider value={retryKey}>
        <Suspense fallback={<PanelLoadingSkeleton />}>{children}</Suspense>
      </SettingsPanelRetryContext.Provider>
    </SettingsPanelErrorBoundary>
  )
}

export { SettingsPanelLoadingBoundary }
