import type { ModelProtocol } from '@aipoch/providers'

export type ProviderFailureObservation = Readonly<{
  category: 'auth' | 'model-not-found'
  status: number
  startedAt: number
  model?: string
  endpoint: ModelProtocol
}>

export type ProviderFailureObserver = (failure: ProviderFailureObservation) => void | Promise<void>

// Observe only definitive upstream failures. The owner captures the provider identity and revision
// in the callback; raw upstream content and credentials never leave this transport seam.
export const observeProviderFailure = async (
  observer: ProviderFailureObserver | undefined,
  target: Pick<ProviderFailureObservation, 'model' | 'endpoint' | 'startedAt'>,
  status: number,
  errorBody?: string
): Promise<void> => {
  if (!observer) return
  let category: ProviderFailureObservation['category'] | undefined
  // Match connection validation: both rejected credentials and forbidden access are unusable.
  if (status === 401 || status === 403) category = 'auth'
  else if ((status === 400 || status === 404) && errorBody) {
    try {
      const error = JSON.parse(errorBody)?.error
      if (error?.code === 'model_not_found' || error?.type === 'model_not_found') {
        category = 'model-not-found'
      }
    } catch {
      // Unstructured messages are not proof that a model is unavailable.
    }
  }
  if (!category) return
  try {
    await observer({ category, status, ...target })
  } catch {
    // Health persistence must not replace the original upstream failure or prompt a write replay.
  }
}

const SAFE_NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'ENETUNREACH',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT'
])

const safeRead = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

export const safeNetworkErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  for (const entry of [error, safeRead(error, 'cause')]) {
    if (typeof entry !== 'object' || entry === null) continue
    const code = safeRead(entry, 'code')
    if (typeof code === 'string' && SAFE_NETWORK_ERROR_CODES.has(code)) return code
    const message = safeRead(entry, 'message')
    const chromiumCode = typeof message === 'string' && /^net::(ERR_[A-Z_]+)$/.exec(message)?.[1]
    if (chromiumCode && SAFE_NETWORK_ERROR_CODES.has(chromiumCode)) return chromiumCode
  }
  return undefined
}
