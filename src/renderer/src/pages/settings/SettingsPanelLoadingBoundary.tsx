import { AlertTriangle, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

type ErrorBoundaryProps = {
  children: ReactNode
  fallback: ReactNode
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

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

type SettingsPanelLoadingBoundaryProps = {
  panelKey: string
  children: ReactNode
  onClose: () => void
  onReload?: () => void
}

const SettingsPanelLoadingBoundary = ({
  panelKey,
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
      fallback={
        <div className={centeredClassName} role="alert">
          <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">{t("Settings panel couldn't be loaded.")}</p>
            <p className="mt-1 text-xs">
              {t('Reload Open Science to try loading this panel again.')}
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              <X aria-hidden="true" />
              {t('Close')}
            </Button>
            <Button type="button" onClick={onReload}>
              <RefreshCw aria-hidden="true" />
              {t('Reload', { context: 'window', ns: 'common' })}
            </Button>
          </div>
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
