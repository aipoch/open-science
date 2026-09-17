import type { ChatApiEndpoint } from '../../shared/settings'

export type ProviderFailureObservation = Readonly<{
  category: 'auth' | 'model-not-found'
  status: number
  startedAt: number
  model?: string
  endpoint: ChatApiEndpoint
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
