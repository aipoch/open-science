// Best-effort network interface snapshot reported by the main process. Whether the machine is
// online at all is decided in the renderer (navigator.onLine); this only describes the local
// interface, which stays populated even without internet access.
export type NetworkConnectionType = 'wifi' | 'ethernet' | 'unknown'

export type NetworkInfo = {
  connectionType: NetworkConnectionType
  ipAddress: string | null
}

export const NETWORK_SYSTEM_RESUMED_CHANNEL = 'network:system-resumed'
