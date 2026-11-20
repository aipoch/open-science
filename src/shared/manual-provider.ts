import type { ModelProtocol, OfficialVendorId } from '@aipoch/providers'

export type ManualProviderConnection = Readonly<{
  location: string
  protocol: ModelProtocol
}>

type ManualProviderDefinition = Readonly<{
  defaultConnection: ManualProviderConnection
  protocols: readonly ModelProtocol[]
  locations?: readonly string[]
  sharedCredential?: true
  modelExamples?: Partial<Record<ModelProtocol, string>>
  parseLocation: (location: string, protocol: ModelProtocol) => string | undefined
  baseUrl: (location: string, protocol: ModelProtocol) => string
}>

/** 接受资源名或匹配当前协议的公有云推理 URI。 */
function parseFoundryLocation(location: string, protocol: ModelProtocol): string | undefined {
  const resourceName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  const serviceHost = 'services.ai.azure.com'
  if (resourceName.test(location)) return `${location}.${serviceHost}`

  const url = URL.parse(location.includes('://') ? location : `https://${location}`)
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    (url.search && (protocol !== 'chat-completions' || url.search !== '?api-version=v1'))
  )
    return undefined

  const suffixes = protocol === 'messages' ? [serviceHost] : [serviceHost, 'openai.azure.com']
  const suffix = suffixes.find((domain) => url.hostname.endsWith(`.${domain}`))
  if (!suffix || !resourceName.test(url.hostname.slice(0, -(suffix.length + 1)))) return undefined
  const path = url.pathname.replace(/\/$/, '')
  const validPaths =
    protocol === 'messages'
      ? ['', '/anthropic', '/anthropic/v1/messages']
      : ['', '/openai/v1', '/openai/v1/chat/completions']
  return validPaths.includes(path) ? url.hostname : undefined
}

const vectrustLocations = ['api.openai-next.com', 'us.api.openai-next.com'] as const

const definitions: Partial<Record<OfficialVendorId, ManualProviderDefinition>> = {
  vectrust: {
    defaultConnection: { location: vectrustLocations[0], protocol: 'chat-completions' },
    protocols: ['messages', 'chat-completions', 'responses'],
    locations: vectrustLocations,
    sharedCredential: true,
    modelExamples: {
      messages: 'claude-opus-5-5',
      'chat-completions': 'gpt-6.1-sol',
      responses: 'gpt-6.1-sol'
    },
    parseLocation: (location) => vectrustLocations.find((endpoint) => location === endpoint),
    baseUrl: (hostname, protocol) => `https://${hostname}${protocol === 'messages' ? '' : '/v1'}`
  },
  'microsoft-foundry': {
    defaultConnection: { location: '', protocol: 'messages' },
    protocols: ['messages', 'chat-completions'],
    parseLocation: parseFoundryLocation,
    baseUrl: (hostname, protocol) =>
      `https://${hostname}/${protocol === 'messages' ? 'anthropic' : 'openai/v1'}`
  },
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

export function sameManualProviderCredentialScope(
  vendorId: OfficialVendorId | undefined,
  left?: ManualProviderConnection,
  right?: ManualProviderConnection
): boolean {
  if (!left || !right) return left === right
  if (!vendorId) return left.location === right.location
  const leftLocation = resolveManualProviderConnection(vendorId, left)?.connection.location
  const rightLocation = resolveManualProviderConnection(vendorId, right)?.connection.location
  if (!leftLocation || !rightLocation) return false
  return (
    leftLocation === rightLocation || manualProviderDefinition(vendorId)?.sharedCredential === true
  )
}
