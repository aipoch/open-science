import type { OfficialVendorId } from '@aipoch/providers'
import { resolveManualProviderConnection } from '../../shared/manual-provider'
import type { ResolvedProvider } from './provider-env'

/** 让草稿探测和已保存的模型使用同一套地址和协议规则。 */
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
    ...(protocol === 'responses' && { responsesBaseUrl: baseUrl }),
    model: model.trim(),
    apiEndpoints: [protocol],
    key: key?.trim()
  }
}
