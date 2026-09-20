import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ApplicationErrorBoundary } from '@/components/application-error-boundary'
import { DatabaseStartupGate } from '@/components/database-startup-gate'
import { installStreamdown } from '@/components/streamdown/install-streamdown'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { applyHtmlLang, resolveInitialLocale } from '@/lib/locale-preference'
import { applyTheme, resolveInitialTheme } from '@/lib/theme'
import { startNetworkMonitor } from '@/stores/network-store'
import { installRendererFailureDiagnostics } from './renderer-diagnostics'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSettingsStore } from '@/stores/settings-store'
import { startLocalePreferenceSync } from '@/stores/locale-store'

const rendererBootMark = 'open-science:renderer-boot-start'
performance.mark(rendererBootMark)

// Keep renderer JavaScript failures distinct from native renderer-process exits without relaying raw
// messages, stacks, URLs, or application state across preload. The bridge is Electron-only; the Web
// surface intentionally keeps this local diagnostics channel absent.
installRendererFailureDiagnostics({
  target: window,
  getSurface: () => {
    const settings = useSettingsStore.getState()
    if (settings.isSettingsOpen) return 'settings'
    if (settings.isLoaded && settings.onboardingCompletedAt === undefined) return 'onboarding'
    return useNavigationStore.getState().view
  },
  report: (report) => window.api.diagnostics?.reportRendererFailure(report)
})

// Apply the saved theme to <html> before the first paint so dark mode doesn't flash light on startup.
applyTheme(resolveInitialTheme())

// Swallow file drops that miss an explicit dropzone: without this, Electron navigates the whole window
// to the dropped file (file://…), tearing down the app. Dropzones call stopPropagation/preventDefault
// themselves, so this only catches strays.
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

// Load only the selected language before mounting, retaining a translated first app paint.
const initialLocale = resolveInitialLocale()
const startRenderer = (): void => {
  initI18n(initialLocale)
  applyHtmlLang(initialLocale)
  startLocalePreferenceSync()

  // Start connectivity monitoring (online/offline events + the initial reachability probe)
  // before React renders so indicators and the Network panel read a live store from first paint.
  startNetworkMonitor()

  // Install before React renders so Streamdown hooks work on first interaction.
  installStreamdown()

  const rendererRoot = createRoot(document.getElementById('root')!)
  performance.mark('open-science:renderer-root-created')
  performance.measure(
    'open-science:renderer-bootstrap',
    rendererBootMark,
    'open-science:renderer-root-created'
  )

  rendererRoot.render(
    <StrictMode>
      <ApplicationErrorBoundary>
        <DatabaseStartupGate>
          <App />
        </DatabaseStartupGate>
      </ApplicationErrorBoundary>
    </StrictMode>
  )
  performance.mark('open-science:renderer-render-scheduled')
}
const preparing = prepareI18nLocale(initialLocale)
if (preparing) {
  void preparing.then(startRenderer).catch((error: unknown) => {
    initI18n('en')
    const StartupFailure = (): never => {
      throw error
    }
    createRoot(document.getElementById('root')!).render(
      <ApplicationErrorBoundary>
        <StartupFailure />
      </ApplicationErrorBoundary>
    )
  })
} else startRenderer()
