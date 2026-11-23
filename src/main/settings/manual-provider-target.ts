import type { OfficialVendorId } from '@aipoch/providers'
import { resolveManualProviderConnection } from '../../shared/manual-provider'
import type { ResolvedProvider } from './provider-env'

/** Use the same endpoint and protocol rules for draft probes and saved models. */
export function resolveManualProviderTarget(
  vendorId: OfficialVendorId,
  connection: unknown,
  model?: string,
  key?: string
): ResolvedProvider {
  const resolved = resolveManualProviderConnection(vendorId, connection)
  if (!resolved) throw new Error('Enter a valid provider endpoint.')
  if (!model?.trim()) throw new Error('Model is required.')
  const {
    baseUrl,
    connection: { protocol }
  } = resolved
  return {
    type: 'custom',
    vendorId,
    baseUrl,
    ...(protocol === 'chat-completions' && { chatCompletionsBaseUrl: baseUrl }),
    ...(protocol === 'chat-completions' &&
      vendorId === 'microsoft-foundry' && {
        azureChatBaseUrl: baseUrl
      }),
    ...(protocol === 'responses' && { responsesBaseUrl: baseUrl }),
    model: model.trim(),
    apiEndpoints: [protocol],
    key: key?.trim()
  }
}
