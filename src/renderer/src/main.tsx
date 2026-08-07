import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installStreamdown } from '@/components/streamdown/install-streamdown'
import { applyTheme, resolveInitialTheme } from '@/lib/theme'
import { startNetworkMonitor } from '@/stores/network-store'
import { installRendererFailureDiagnostics } from './renderer-diagnostics'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSettingsStore } from '@/stores/settings-store'

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

// Start connectivity monitoring (online/offline events + the initial reachability probe)
// before React renders so indicators and the Network panel read a live store from first paint.
startNetworkMonitor()

// Install before React renders so Streamdown hooks work on first interaction.
installStreamdown()

// Swallow file drops that miss an explicit dropzone: without this, Electron navigates the whole window
// to the dropped file (file://…), tearing down the app. Dropzones call stopPropagation/preventDefault
// themselves, so this only catches strays.
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
