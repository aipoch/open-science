import type { BrowserWindow, PowerMonitor } from 'electron'

import { NETWORK_SYSTEM_RESUMED_CHANNEL } from '../shared/network'

type ShutdownSignal = 'SIGTERM' | 'SIGINT'

type ShutdownSignalSource = {
  once: (signal: ShutdownSignal, listener: () => void) => unknown
  removeListener: (signal: ShutdownSignal, listener: () => void) => unknown
}

type SystemLifecycleWindow = Pick<BrowserWindow, 'isDestroyed' | 'on' | 'webContents'>

type SystemLifecycleAdapterDeps = {
  windowSessionEndEvents: boolean
  powerShutdownEvent: boolean
  headless: boolean
  signalSource: ShutdownSignalSource
  powerMonitor: Pick<PowerMonitor, 'on'>
  getWindows: () => readonly SystemLifecycleWindow[]
  requestSystemShutdown: () => void
}

type SystemLifecycleAdapters = {
  bindWindow: (window: SystemLifecycleWindow) => void
  installPowerMonitorListeners: () => void
}

// Owns the Electron/Node event adapters that feed the startup shutdown relay. Window listeners are
// installed early enough to cover the startup shell; powerMonitor is installed only after app ready.
export const installSystemLifecycleAdapters = (
  deps: SystemLifecycleAdapterDeps
): SystemLifecycleAdapters => {
  const boundWindows = new WeakSet<SystemLifecycleWindow>()

  if (deps.headless) {
    const onSignal = (): void => {
      deps.signalSource.removeListener('SIGTERM', onSignal)
      deps.signalSource.removeListener('SIGINT', onSignal)
      deps.requestSystemShutdown()
    }
    deps.signalSource.once('SIGTERM', onSignal)
    deps.signalSource.once('SIGINT', onSignal)
  }

  return {
    bindWindow: (window) => {
      if (!deps.windowSessionEndEvents || boundWindows.has(window)) return
      boundWindows.add(window)
      // Respect the OS-owned session end while giving the shutdown owner an early best-effort start.
      window.on('query-session-end', deps.requestSystemShutdown)
      // session-end can no longer delay Windows logoff/shutdown; retain it as a fallback.
      window.on('session-end', deps.requestSystemShutdown)
    },
    installPowerMonitorListeners: () => {
      deps.powerMonitor.on('resume', () => {
        for (const window of deps.getWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send(NETWORK_SYSTEM_RESUMED_CHANNEL)
          }
        }
      })

      if (!deps.powerShutdownEvent) return
      deps.powerMonitor.on('shutdown', ((event?: { preventDefault?: () => void }) => {
        // Electron's generated v39 type omits this documented event argument. Keep the bridge safe
        // if a host also omits it at runtime.
        event?.preventDefault?.()
        deps.requestSystemShutdown()
      }) as () => void)
    }
  }
}

export type { ShutdownSignalSource, SystemLifecycleAdapterDeps, SystemLifecycleWindow }
