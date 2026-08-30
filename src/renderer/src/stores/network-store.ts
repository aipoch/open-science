import { create } from 'zustand'

// Real end-to-end reachability probed by the main process (the same HTTPS HEAD check the
// onboarding environment step uses). 'unknown' means a probe is in flight and surfaces render it
// as "checking"; 'probe-failed' is the terminal recovery state when no prior answer can be restored.
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
  probeConnectivity: (options?: { announce?: boolean }) => Promise<void>
}

// Minimum time an announced probe's Checking… presentation stays visible, so a clicked
// re-check reads as a deliberate check instead of a flash.
const MIN_CHECKING_MS = 500
const REACHABILITY_RECHECK_TTL_MS = 60_000
let lastProbedAt = 0

export const useNetworkStore = create<NetworkStore>((set, get) => {
  let probeGeneration = 0
  let lastKnownConnectivity: Extract<NetworkConnectivity, 'reachable' | 'unreachable'> | undefined

  const probeConnectivity = async ({ announce = false } = {}): Promise<void> => {
    const generation = ++probeGeneration
    const startedAt = Date.now()
    const currentConnectivity = get().connectivity
    if (currentConnectivity === 'reachable' || currentConnectivity === 'unreachable') {
      lastKnownConnectivity = currentConnectivity
    }

    const holdAnnouncedState = async (): Promise<void> => {
      if (!announce) return
      const remaining = MIN_CHECKING_MS - (Date.now() - startedAt)
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining))
      }
    }

    if (announce) set({ connectivity: 'unknown' })

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
          reachable = await checkConnectivity()
        } catch {
          // Bridge failure keeps the last known reachability rather than crying wolf. When a cold
          // start has no previous answer, settle to an explicit terminal failure so Checking… never
          // becomes permanent and the user can retry.
          await holdAnnouncedState()
          const currentState = get()
          if (
            probeGeneration === generation &&
            currentState.isOnline &&
            currentState.connectivity === 'unknown'
          ) {
            set({ connectivity: lastKnownConnectivity ?? 'probe-failed' })
          }
          return
        }
      }
    }

    await holdAnnouncedState()
    if (probeGeneration === generation && (get().isOnline || !reachable)) {
      const connectivity = reachable ? 'reachable' : 'unreachable'
      lastKnownConnectivity = connectivity
      lastProbedAt = Date.now()
      set({ connectivity })
    }
  }

  return {
    isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    connectivity: 'unknown',
    recheckOnline: () => set({ isOnline: navigator.onLine }),
    probeConnectivity
  }
})

// Installs the window listeners and runs the first probe. Called once from the app entry
// (main.tsx) — deliberately NOT at module scope, so importing the store in tests stays free
// of side effects. Probing happens on startup, on every link recovery, on window focus /
// becoming visible while a previous probe is failing or its known result has expired, and on demand
// (Retry). There is no background polling: a changed path out (Wi-Fi, VPN, proxy, DNS) is picked up
// when the user returns to the window, not on a timer.
let monitorStarted = false

export const startNetworkMonitor = (): void => {
  if (monitorStarted || typeof window === 'undefined') return
  monitorStarted = true

  window.addEventListener('online', () => {
    useNetworkStore.setState({ isOnline: true })
    void useNetworkStore.getState().probeConnectivity({ announce: true })
  })
  window.addEventListener('offline', () => {
    // A dropped link is a known-unreachable state, so surfaces can show it immediately.
    useNetworkStore.setState({ isOnline: false, connectivity: 'unreachable' })
  })

  let silentRecheckQueued = false
  let silentProbeInFlight = false
  const silentlyRecheckIfStale = (): void => {
    const { isOnline, connectivity } = useNetworkStore.getState()
    if (!isOnline) return
    const now = Date.now()
    const resultExpired =
      lastProbedAt === 0 || now < lastProbedAt || now - lastProbedAt >= REACHABILITY_RECHECK_TTL_MS
    if (
      connectivity !== 'unreachable' &&
      connectivity !== 'probe-failed' &&
      !(connectivity === 'reachable' && resultExpired)
    )
      return
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
