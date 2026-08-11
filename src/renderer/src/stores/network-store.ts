import { create } from 'zustand'

// Real end-to-end reachability probed by the main process (the same HTTPS HEAD check the
// onboarding environment step uses). 'unknown' means there is no fresh answer and surfaces
// render it as "checking"; it never persists, because every probe eventually applies a result.
export type NetworkConnectivity = 'unknown' | 'reachable' | 'unreachable'

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

export const useNetworkStore = create<NetworkStore>((set) => {
  let probeGeneration = 0

  const probeConnectivity = async ({ announce = false } = {}): Promise<void> => {
    const generation = ++probeGeneration
    const startedAt = Date.now()

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
          // Bridge failure keeps the last known state rather than crying wolf.
          return
        }
      }
    }

    if (announce) {
      const remaining = MIN_CHECKING_MS - (Date.now() - startedAt)
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining))
      }
    }
    if (probeGeneration === generation) {
      set({ connectivity: reachable ? 'reachable' : 'unreachable' })
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
// of side effects. Probing happens on startup, on every link recovery, and on demand (panel
// mount / Retry); there is no background polling.
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

  if (navigator.onLine) {
    void useNetworkStore.getState().probeConnectivity()
  } else {
    // Starting offline is a known-down state, same as the offline event.
    useNetworkStore.setState({ connectivity: 'unreachable' })
  }
}
