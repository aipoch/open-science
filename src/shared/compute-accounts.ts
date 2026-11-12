export const COMPUTE_ACCOUNT_CONNECTION_REQUIRED =
  'Connect the account before adding this configuration.'

export const computeAccountProviders = ['hugging-face', 'modal'] as const
export type ComputeAccountProvider = (typeof computeAccountProviders)[number]
export type ComputeAccountStatus = {
  provider: ComputeAccountProvider
  runtimeRevision?: number
  runtimeError?: import('./compute-python-runtime').ComputePythonFailure
  state: 'disconnected' | 'pending' | 'connected' | 'expired' | 'unavailable'
  source?: 'local' | 'managed'
  identity?: string
  localAvailable?: boolean
  userCode?: string
  expiresAt?: number
  reason?:
    'missing' | 'network' | 'dependency' | 'storage' | 'authorization' | 'timeout' | 'cancelled'
}
