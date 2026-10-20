const ANTHROPIC_VERSION = '2023-06-01'
import { readBoundedResponseText, fetchProviderRequest } from '../transport'
const DEFAULT_LIMITS = {
  modelListResponseBytes: 2 * 1024 * 1024,
  fetchedModels: 2000,
  modelIdCharacters: 512
}

// Fetches a provider's live model list from its dedicated model-list URL (from the registry). Both the
// Anthropic and OpenAI model-list shapes are `{ data: [{ id }] }`, so one parser covers the compatible
// gateways. Network and parsing are isolated here so the branch matrix stays unit-testable with an
// injected fetch.

const DEFAULT_LIST_TIMEOUT_MS = 15_000

export type ListModelsResult = {
  ok: boolean
  models?: string[]
  status?: number
  message?: string
}

export type ListModelsTarget = {
  // Full model-list endpoint URL (e.g. https://api.deepseek.com/v1/models).
  url: string
  vendorId?: string
  key?: string
}

export type ListModelsOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  limits?: Partial<typeof DEFAULT_LIMITS>
}
type ListModelsDeps = ListModelsOptions & { fetchImpl?: typeof fetch }

// Extracts non-empty string model ids from a `{ data: [{ id }] }` payload.
export const parseModelIds = (body: unknown): string[] => {
  if (typeof body !== 'object' || body === null) return []

  const data = (body as { data?: unknown }).data

  if (!Array.isArray(data)) return []

  return data
    .map((entry) =>
      typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined
    )
    .filter((id): id is string => typeof id === 'string' && id !== '')
}

// Requests the model catalog from a vendor's model-list URL. Returns ok=false (never throws) so the
// caller can fall back to the bundled catalog and surface a message.
export const listProviderModels = async (
  target: ListModelsTarget,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_LIST_TIMEOUT_MS,
    limits: overrides,
    signal: callerSignal
  }: ListModelsDeps = {}
): Promise<ListModelsResult> => {
  const limits = {
    modelListResponseBytes:
      overrides?.modelListResponseBytes ?? DEFAULT_LIMITS.modelListResponseBytes,
    fetchedModels: overrides?.fetchedModels ?? DEFAULT_LIMITS.fetchedModels,
    modelIdCharacters: overrides?.modelIdCharacters ?? DEFAULT_LIMITS.modelIdCharacters
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)
  )
    return { ok: false, message: 'Invalid model-list resource limits.' }
  let url: string

  try {
    url = new URL(target.url).toString()
  } catch {
    return { ok: false, message: 'Invalid model-list URL.' }
  }

  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION }

  if (target.key) {
    if (target.vendorId === 'anthropic') headers['x-api-key'] = target.key
    else headers.authorization = `Bearer ${target.key}`
  }

  const controller = new AbortController()
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    signal.throwIfAborted()
    const response = await fetchProviderRequest(fetchImpl, url, {
      method: 'GET',
      headers,
      signal
    })

    if (response.status < 200 || response.status >= 300) {
      // Error payloads are unused. Release even a streaming body before returning ownership.
      await response.body?.cancel().catch(() => undefined)
      return {
        ok: false,
        status: response.status,
        message: `Model list request failed (${response.status}).`
      }
    }

    const body = JSON.parse(
      await readBoundedResponseText(
        response,
        limits.modelListResponseBytes,
        'Model list response',
        undefined,
        signal
      )
    ) as unknown
    const models = parseModelIds(body)

    if (models.length > limits.fetchedModels) {
      return {
        ok: false,
        status: response.status,
        message: `The vendor returned more than ${limits.fetchedModels} models.`
      }
    }

    if (models.some((model) => Array.from(model).length > limits.modelIdCharacters)) {
      return {
        ok: false,
        status: response.status,
        message: `The vendor returned a model ID longer than ${limits.modelIdCharacters} characters.`
      }
    }

    if (models.length === 0) {
      return { ok: false, status: response.status, message: 'The vendor returned no models.' }
    }

    return { ok: true, models, status: response.status }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
