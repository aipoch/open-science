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
  // Probes real reachability through the main process. `announce` flips connectivity back to
  // 'unknown' for the duration (user-visible re-checks); background polls stay silent so a
  // healthy 'reachable' never flickers through a checking state.
  probeConnectivity: (options?: { announce?: boolean }) => Promise<void>
}

// Minimum time a probe's Checking… presentation stays visible, so a fast answer reads as a
// deliberate check instead of a flash.
const MIN_CHECKING_MS = 500
// Background re-probe cadence while the machine looks online.
const CONNECTIVITY_POLL_MS = 30_000

export const useNetworkStore = create<NetworkStore>((set) => {
  let probeGeneration = 0

  const probeConnectivity = async ({ announce = false } = {}): Promise<void> => {
    const checkConnectivity = window.api?.network?.checkConnectivity
    const generation = ++probeGeneration
    const startedAt = Date.now()

    if (announce) set({ connectivity: 'unknown' })

    let reachable: boolean
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

    const remaining = MIN_CHECKING_MS - (Date.now() - startedAt)
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining))
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

// The listeners live at module scope (not in a component) so the store stays accurate even
// before any subscriber mounts. Probing starts immediately and re-runs on recovery and on a
// slow background cadence; the offline event resets to 'unknown' so recovery always re-probes.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    useNetworkStore.setState({ isOnline: true })
    void useNetworkStore.getState().probeConnectivity({ announce: true })
  })
  window.addEventListener('offline', () => {
    useNetworkStore.setState({ isOnline: false, connectivity: 'unknown' })
  })

  if (typeof navigator === 'undefined' || navigator.onLine) {
    void useNetworkStore.getState().probeConnectivity()
  }
  window.setInterval(() => {
    if (useNetworkStore.getState().isOnline) {
      void useNetworkStore.getState().probeConnectivity()
    }
  }, CONNECTIVITY_POLL_MS)
}
