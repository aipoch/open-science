import { LoaderCircle } from 'lucide-react'
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'

type ErrorBoundaryProps = {
  children: ReactNode
  fallback: ReactNode
  resetKey?: string
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
      previousProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ failed: false })
    }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

type SettingsPanelLoadingBoundaryProps = {
  panelKey: string
  resetKey?: string
  children: ReactNode
  onClose: () => void
  onReload?: () => void
}

const SettingsPanelLoadingBoundary = ({
  panelKey,
  resetKey,
  children,
  onClose,
  onReload = () => window.location.reload()
}: SettingsPanelLoadingBoundaryProps): React.JSX.Element => {
  const { t } = useTranslation()

  const centeredClassName =
    'flex min-h-[360px] flex-col items-center justify-center gap-3 px-5 text-center text-sm text-muted-foreground'

  return (
    <SettingsPanelErrorBoundary
      key={panelKey}
      resetKey={resetKey}
      fallback={
        <div className={centeredClassName}>
          <ErrorNotice
            role="alert"
            tone="amber"
            title={t("Settings panel couldn't be loaded.")}
            description={t('Reload Open Science to try loading this panel again.')}
            secondaryButton={{ label: t('Close'), onClick: onClose }}
            primaryButton={{
              label: t('Reload', { context: 'window', ns: 'common' }),
              onClick: onReload
            }}
          />
        </div>
      }
    >
      <Suspense
        fallback={
          <div className={`${centeredClassName} flex-row gap-2`} role="status" aria-live="polite">
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span>{t('Loading…')}</span>
          </div>
        }
      >
        {children}
      </Suspense>
    </SettingsPanelErrorBoundary>
  )
}

export { SettingsPanelLoadingBoundary }
