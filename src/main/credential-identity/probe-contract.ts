export type IdentityProbeResult = Readonly<{
  status: 'exists' | 'not-found' | 'access-blocked' | 'error' | 'unsupported'
  reason?: string
  osStatus?: number
}>
