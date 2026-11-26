import { resolveChatCompletionsBaseUrl } from '../protocols/endpoints'

const presets = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234' },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    baseUrl: 'http://localhost:8080',
    endpointCandidates: ['http://127.0.0.1:9931', 'http://127.0.0.1:8080']
  },
  { id: 'vllm', label: 'vLLM', baseUrl: 'http://localhost:8000' },
  { id: 'magpie', label: 'Magpie', baseUrl: 'http://127.0.0.1:3425/v1' }
] as const

export type LocalProviderPresetId = (typeof presets)[number]['id']
export type LocalModelPreset = Readonly<{
  id: LocalProviderPresetId
  label: string
  baseUrl: string
  endpointCandidates?: readonly string[]
}>

export const LOCAL_MODEL_PRESETS: readonly LocalModelPreset[] = presets

export const isLocalProviderPresetId = (value: unknown): value is LocalProviderPresetId =>
  LOCAL_MODEL_PRESETS.some(({ id }) => id === value)

export type LocalProviderConnection = {
  localPresetId?: LocalProviderPresetId | null
  baseUrl?: string
}

/** Reuse a saved local preset credential only for the same server origin. */
export function sameLocalProviderCredentialScope(
  left: LocalProviderConnection,
  right: LocalProviderConnection
): boolean {
  if (!left.localPresetId && !right.localPresetId) return true
  const origin = URL.parse(left.baseUrl ?? '')?.origin
  return origin !== undefined && origin === URL.parse(right.baseUrl ?? '')?.origin
}

/** Resolve model discovery on the same server, even when the input names an inference endpoint. */
export function resolveLocalModelDiscoveryUrl(baseUrl: string): string | undefined {
  const endpoint = URL.parse(baseUrl.trim())
  if (!endpoint) return undefined
  endpoint.pathname = endpoint.pathname.replace(/(\/v1)\/(messages|responses)\/*$/i, '$1')
  const modelsBase = resolveChatCompletionsBaseUrl({ baseUrl: endpoint.href })
  return modelsBase && `${modelsBase}/models`
}
