import type { ModelProtocol, OfficialVendorId } from '@aipoch/providers'

export type ManualProviderConnection = Readonly<{
  location: string
  protocol: ModelProtocol
}>

type ManualProviderDefinition = Readonly<{
  defaultConnection: ManualProviderConnection
  protocols: readonly ModelProtocol[]
  parseLocation: (location: string, protocol: ModelProtocol) => string | undefined
  baseUrl: (location: string, protocol: ModelProtocol) => string
}>

const definitions: Partial<Record<OfficialVendorId, ManualProviderDefinition>> = {
  'aws-bedrock': {
    defaultConnection: { location: 'us-east-1', protocol: 'messages' },
    protocols: ['messages', 'chat-completions'],
    // 商业分区的 Region 只能构成固定 Bedrock 域名中的一个标签。
    parseLocation: (location) =>
      /^(?:us|ca|eu|ap|sa|me|af|il|mx)-[a-z]+-[1-9][0-9]?$/.test(location) ? location : undefined,
    baseUrl: (region, protocol) =>
      `https://bedrock-runtime.${region}.amazonaws.com/${protocol === 'messages' ? 'anthropic' : 'openai/v1'}`
  }
}

export const manualProviderDefinition = (
  vendorId: OfficialVendorId | undefined
): ManualProviderDefinition | undefined => (vendorId ? definitions[vendorId] : undefined)

/** 从供应商规则解析地址，持久化数据只保存公共定位字段和协议。 */
export function resolveManualProviderConnection(vendorId: OfficialVendorId, value: unknown) {
  const definition = manualProviderDefinition(vendorId)
  if (!definition || !value || typeof value !== 'object') return undefined
  const { location, protocol } = value as Partial<ManualProviderConnection>
  if (typeof location !== 'string' || !protocol || !definition.protocols.includes(protocol))
    return undefined
  const normalized = definition.parseLocation(location.trim().toLowerCase(), protocol)
  if (!normalized) return undefined
  return {
    connection: { location: normalized, protocol },
    baseUrl: definition.baseUrl(normalized, protocol)
  }
}

export const sameManualProviderConnection = (
  left?: ManualProviderConnection,
  right?: ManualProviderConnection
): boolean =>
  left?.location.trim().toLowerCase() === right?.location.trim().toLowerCase() &&
  left?.protocol === right?.protocol

export const sameManualProviderCredentialScope = (
  left?: ManualProviderConnection,
  right?: ManualProviderConnection
): boolean => left?.location.trim().toLowerCase() === right?.location.trim().toLowerCase()
