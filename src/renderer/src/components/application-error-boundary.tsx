import { Component, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'

import { ErrorNotice } from '@/components/error-notice'
import { projectRendererFailure } from '../renderer-diagnostics'

const ApplicationErrorFallback = (): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-lg">
        <ErrorNotice
          role="alert"
          icon={RefreshCw}
          tone="amber"
          title={t("Open-Science couldn't display this page")}
          description={t(
            'Background work may still be running. Reloading may lose unsaved changes on this page.'
          )}
          primaryButton={{ label: t('Reload page'), onClick: () => window.location.reload() }}
        />
      </div>
    </main>
  )
}

// Keep recovery outside the business stores and startup gate: either can fail while rendering.
// Recovery is user-initiated page navigation; this boundary never stops or resubmits backend work.
class ApplicationErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    try {
      window.api?.diagnostics?.reportRendererFailure(
        projectRendererFailure('handled-error', error, 'unknown')
      )
    } catch {
      // An unavailable diagnostics bridge must not break the recovery surface.
    }
  }

  render(): ReactNode {
    return this.state.failed ? <ApplicationErrorFallback /> : this.props.children
  }
}

export { ApplicationErrorBoundary }
