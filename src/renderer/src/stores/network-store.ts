import { projectRendererFailure } from '../renderer-diagnostics'
import { readWithDeadline } from '../lib/read-with-deadline'
import { create } from 'zustand'
import { useSettingsStore } from './settings-store'
import { useDesktopRuntimeRecoveryStore } from './desktop-runtime-recovery-store'

// Real end-to-end reachability probed by the main process (the same HTTPS HEAD check the
// onboarding environment step uses). 'unknown' means a probe is in flight and surfaces render it
// as "checking"; 'probe-failed' means the check itself could not finish.
export type NetworkConnectivity = 'unknown' | 'reachable' | 'unreachable' | 'probe-failed'

type NetworkStore = {
  // Whether the browser believes the machine has a network connection. Seeded from
  // navigator.onLine and kept current by the window online/offline events; an 'online'
  // event automatically clears the offline UI everywhere this store is read.
  isOnline: boolean
  // End-to-end internet reachability, so a live link with a broken path out (DNS, proxy,
  // firewall) reads differently from a healthy connection.
  connectivity: NetworkConnectivity
  // Re-reads navigator.onLine on demand — used by the Network panel's Retry button so the
  // "how we know we are online" knowledge stays in this one module.
  recheckOnline: () => void
  // Probes real reachability. `announce` flips connectivity to 'unknown' for the duration and
  // holds the result for MIN_CHECKING_MS (user-visible re-checks); silent probes apply as soon
  // as the answer lands. With no link the probe short-circuits to 'unreachable' — no point
  // issuing HTTPS requests we know cannot get out.
  probeConnectivity: (options?: { announce?: boolean; invalidate?: boolean }) => Promise<void>
}

// Minimum time an announced probe's Checking… presentation stays visible, so a clicked
// re-check reads as a deliberate check instead of a flash.
const MIN_CHECKING_MS = 500

export const useNetworkStore = create<NetworkStore>((set, get) => {
  let probeGeneration = 0

  let inFlight: { generation: number; promise: Promise<void> } | undefined

  const runProbe = async ({ announce = false, invalidate = false } = {}): Promise<void> => {
    const generation = ++probeGeneration
    // A planned shutdown invalidates pending probes, but says nothing about internet access.
    if (useDesktopRuntimeRecoveryStore.getState().closing) return
    const startedAt = Date.now()

    const holdAnnouncedState = async (): Promise<void> => {
      if (!announce) return
      const remaining = MIN_CHECKING_MS - (Date.now() - startedAt)
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining))
      }
    }

    if (announce || invalidate) set({ connectivity: 'unknown' })

    let reachable: boolean
    if (!navigator.onLine) {
      reachable = false
    } else {
      const checkConnectivity = window.api?.network?.checkConnectivity
      if (!checkConnectivity) {
        // Web surface has no probe bridge; the navigator.onLine signal is all there is.
        reachable = true
      } else {
        try {
          // The recovery store starts connected before its React subscriber mounts.
          // Startup admission is separate: probing now would turn a starting backend
          // into a sticky internet-check failure before the app can even open.
          const startup = window.api?.runtimeStartup
          if (startup) {
            const state = await readWithDeadline(startup.getState, 10_000)
            if (probeGeneration !== generation || useDesktopRuntimeRecoveryStore.getState().closing)
              return
            if (state.phase !== 'ready') {
              set({ connectivity: get().isOnline ? 'unknown' : 'unreachable' })
              return
            }
          }
          // Electron can report runtime ready before the backend finishes composing its
          // RPC owners. Database startup publishes ready only after that composition.
          const backendStartup = window.api?.databaseStartup
          if (backendStartup) {
            const state = await readWithDeadline(backendStartup.getState, 10_000)
            if (probeGeneration !== generation || useDesktopRuntimeRecoveryStore.getState().closing)
              return
            if (state.phase !== 'ready') {
              set({ connectivity: get().isOnline ? 'unknown' : 'unreachable' })
              return
            }
          }
          if (useDesktopRuntimeRecoveryStore.getState().phase !== 'connected') {
            throw new Error('Backend unavailable for network check.')
          }
          const epoch = useDesktopRuntimeRecoveryStore.getState().epoch
          reachable = await readWithDeadline(checkConnectivity, 10_000)
          if (epoch !== useDesktopRuntimeRecoveryStore.getState().epoch) {
            throw new Error('Backend connection changed during network check.')
          }
        } catch (error) {
          if (probeGeneration !== generation || useDesktopRuntimeRecoveryStore.getState().closing)
            return
          try {
            window.api?.diagnostics?.reportRendererFailure(
              projectRendererFailure('handled-error', error, 'settings', 'network-check')
            )
          } catch {
            /* Diagnostics must not change the probe outcome. */
          }
          // A failed check says nothing about registry reachability. Never present an old answer
          // as the result of this attempt, including silent refreshes after runtime recovery.
          await holdAnnouncedState()
          if (
            probeGeneration === generation &&
            !useDesktopRuntimeRecoveryStore.getState().closing &&
            get().isOnline
          ) {
            set({ connectivity: 'probe-failed' })
          }
          return
        }
      }
    }

    await holdAnnouncedState()
    if (
      probeGeneration === generation &&
      !useDesktopRuntimeRecoveryStore.getState().closing &&
      (get().isOnline || !reachable)
    ) {
      const connectivity = reachable ? 'reachable' : 'unreachable'
      set({ connectivity })
    }
  }

  return {
    isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    connectivity: 'unknown',
    recheckOnline: () => {
      if (get().isOnline !== navigator.onLine) probeGeneration++
      set({ isOnline: navigator.onLine })
    },
    probeConnectivity: (options = {}) => {
      if (!options.invalidate && inFlight?.generation === probeGeneration) return inFlight.promise
      const promise = runProbe(options)
      const pending = { generation: probeGeneration, promise }
      inFlight = pending
      void promise.finally(() => {
        if (inFlight === pending) inFlight = undefined
      })
      return promise
    }
  }
})

// Installs the window listeners and runs the first probe. Called once from the app entry
// (main.tsx) — deliberately NOT at module scope, so importing the store in tests stays free
// of side effects. Probing happens on startup, on every link recovery, on window focus /
// becoming visible while a previous probe is still failing, and on demand (Retry). There is
// no background polling: a live link with a recovered path out (proxy, DNS) is picked up
// when the user returns to the window, not on a timer.
let monitorStarted = false

export const startNetworkMonitor = (): void => {
  if (monitorStarted || typeof window === 'undefined') return
  monitorStarted = true

  window.api?.runtimeStartup?.onStateChanged(() => {
    void useNetworkStore.getState().probeConnectivity({ invalidate: true })
  })
  window.api?.databaseStartup?.onStateChanged(() => {
    void useNetworkStore.getState().probeConnectivity({ invalidate: true })
  })

  useSettingsStore.subscribe((state, previous) => {
    const next = state.networkProxy
    const before = previous.networkProxy
    if (
      next.mode === before.mode &&
      next.server === before.server &&
      next.bypassRules === before.bypassRules
    )
      return
    // A new proxy invalidates both the cached result and all older in-flight probes.
    void useNetworkStore.getState().probeConnectivity({ announce: true, invalidate: true })
  })

  useDesktopRuntimeRecoveryStore.subscribe((state, previous) => {
    if (
      state.closing !== previous.closing ||
      state.epoch !== previous.epoch ||
      (state.phase === 'connected' && previous.phase !== 'connected')
    ) {
      void useNetworkStore
        .getState()
        .probeConnectivity({ announce: state.phase === 'connected', invalidate: true })
    }
  })

  window.api?.network?.onSystemResumed?.(() => {
    useNetworkStore.getState().recheckOnline()
    void useNetworkStore.getState().probeConnectivity({ announce: true, invalidate: true })
  })

  window.addEventListener('online', () => {
    useNetworkStore.setState({ isOnline: true })
    void useNetworkStore.getState().probeConnectivity({ announce: true, invalidate: true })
  })
  window.addEventListener('offline', () => {
    // A dropped link is a known-unreachable state, so surfaces can show it immediately.
    useNetworkStore.getState().recheckOnline()
    useNetworkStore.setState({ isOnline: false, connectivity: 'unreachable' })
  })

  let silentRecheckQueued = false
  let silentProbeInFlight = false
  const silentlyRecheckIfStale = (): void => {
    const { isOnline, connectivity } = useNetworkStore.getState()
    if (!isOnline) return
    if (connectivity !== 'unreachable' && connectivity !== 'probe-failed') return
    if (silentProbeInFlight) return
    silentProbeInFlight = true
    void useNetworkStore
      .getState()
      .probeConnectivity()
      .finally(() => {
        silentProbeInFlight = false
      })
  }
  const scheduleSilentRecheck = (): void => {
    if (silentRecheckQueued) return
    silentRecheckQueued = true
    queueMicrotask(() => {
      silentRecheckQueued = false
      silentlyRecheckIfStale()
    })
  }

  window.addEventListener('focus', scheduleSilentRecheck)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSilentRecheck()
  })

  if (navigator.onLine) {
    void useNetworkStore.getState().probeConnectivity()
  } else {
    // Starting offline is a known-down state, same as the offline event.
    useNetworkStore.setState({ connectivity: 'unreachable' })
  }
}
