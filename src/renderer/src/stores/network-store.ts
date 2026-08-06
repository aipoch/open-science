import { create } from 'zustand'

type NetworkStore = {
  // Whether the browser believes the machine has a network connection. Seeded from
  // navigator.onLine and kept current by the window online/offline events; an 'online'
  // event automatically clears the offline UI everywhere this store is read.
  isOnline: boolean
  // Re-reads navigator.onLine on demand — used by the Network panel's Retry button so the
  // "how we know we are online" knowledge stays in this one module.
  recheckOnline: () => void
}

export const useNetworkStore = create<NetworkStore>(() => ({
  isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
  recheckOnline: () => useNetworkStore.setState({ isOnline: navigator.onLine })
}))

// The listeners live at module scope (not in a component) so the store stays accurate even
// before any subscriber mounts.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => useNetworkStore.setState({ isOnline: true }))
  window.addEventListener('offline', () => useNetworkStore.setState({ isOnline: false }))
}
