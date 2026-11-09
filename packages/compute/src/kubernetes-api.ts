export class KubernetesBackendError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'KubernetesBackendError'
  }
}

const responseMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { message?: unknown }
    if (typeof body.message === 'string' && body.message.trim()) return body.message
  } catch {
    // Fall through to the status text, which is safe to expose to the adapter caller.
  }
  return response.statusText || `Kubernetes request failed with status ${response.status}.`
}

const throwForResponse = async (response: Response): Promise<never> => {
  throw new KubernetesBackendError(response.status, await responseMessage(response))
}

export type KubernetesRequest = (path: string, init?: RequestInit) => Promise<Response>
export const createKubernetesRequest = (
  endpoint: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  baseHeaders?: HeadersInit
): KubernetesRequest => {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(baseHeaders)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')
    const response = await fetchImpl(`${endpoint}${path}`, { ...init, headers })
    if (!response.ok) await throwForResponse(response)
    return response
  }
}
