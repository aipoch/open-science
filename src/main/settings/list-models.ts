import { ANTHROPIC_VERSION } from './validate'

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
  // Plaintext key; sent as both bearer and x-api-key so either auth scheme is satisfied.
  key?: string
}

export type ListModelsDeps = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

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

// Requests the model catalog from a vendor's model-list URL. Sends both bearer and x-api-key auth so
// it works against gateways that expect either. Returns ok=false (never throws) so the caller can fall
// back to the bundled catalog and surface a message.
export const listProviderModels = async (
  target: ListModelsTarget,
  { fetchImpl = fetch, timeoutMs = DEFAULT_LIST_TIMEOUT_MS }: ListModelsDeps = {}
): Promise<ListModelsResult> => {
  let url: string

  try {
    url = new URL(target.url).toString()
  } catch {
    return { ok: false, message: 'Invalid model-list URL.' }
  }

  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION }

  if (target.key) {
    headers.authorization = `Bearer ${target.key}`
    headers['x-api-key'] = target.key
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        status: response.status,
        message: `Model list request failed (${response.status}).`
      }
    }

    const models = parseModelIds((await response.json()) as unknown)

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
