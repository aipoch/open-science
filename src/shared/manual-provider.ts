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
  models?: Partial<Record<ModelProtocol, readonly string[]>>
  fallbackContextWindow?: number
  defaultContextWindows?: Readonly<Partial<Record<string, number>>>
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
    // The same credential can follow the user between the two allowlisted Vectrust nodes.
    sharedCredential: true,
    // Keep the shortlist scoped to the protocols documented on NextLabs model pages.
    models: {
      messages: [
        'claude-sonnet-5-5',
        'claude-opus-5-5',
        'claude-fable-5-2',
        'claude-haiku-5-5',
        'claude-haiku-4-5'
      ],
      'chat-completions': [
        'gpt-6.2-sol',
        'gpt-6.2-astra',
        'gpt-6.1-sol',
        'gpt-6.1-terra',
        'claude-sonnet-5-5',
        'claude-opus-5-5',
        'claude-fable-5-2',
        'claude-haiku-5-5',
        'claude-haiku-4-5',
        'gemini-4-hydrogen',
        'gemini-4-neon',
        'gemini-3.8-flash',
        'gemini-3.1-pro-preview',
        'deepseek-v4-pro',
        'deepseek-v4.1-flash',
        'deepseek-v4-1-flash-260910',
        'grok-4.7',
        'qwen3.5-plus',
        'qwen3-coder-flash',
        'qwen-plus-latest',
        'glm-5.3',
        'glm-5.3-flash',
        'glm-5.2',
        'kimi-k3.1-pro',
        'kimi-k3',
        'MiniMax-M3',
        'MiniMax-M3.1-Flash'
      ],
      responses: [
        'gpt-6.2-sol',
        'gpt-6.1-sol',
        'gpt-6.2-astra',
        'gpt-6-sol',
        'gpt-6-astra',
        'gpt-6-luna'
      ]
    },
    // NextLabs documents model windows in the playground and release notes.
    fallbackContextWindow: 32_768,
    defaultContextWindows: {
      'gpt-6.2-sol': 1_050_000,
      'gpt-6.2-astra': 1_050_000,
      'gpt-6.1-sol': 1_050_000,
      'gpt-6.1-terra': 1_050_000,
      'gpt-6-sol': 1_050_000,
      'gpt-6-astra': 1_050_000,
      'gpt-6-luna': 1_050_000,
      'gpt-5.5': 1_050_000,
      'gpt-5.4': 1_050_000,
      'claude-sonnet-5-5': 1_000_000,
      'claude-opus-5-5': 1_000_000,
      'claude-fable-5-2': 1_000_000,
      'claude-haiku-5-5': 1_000_000,
      'claude-haiku-4-5': 200_000,
      'gemini-4-hydrogen': 1_048_576,
      'gemini-4-neon': 1_048_576,
      'gemini-3.8-flash': 1_048_576,
      'gemini-3.1-pro-preview': 1_048_576,
      'deepseek-v4-pro': 1_000_000,
      'deepseek-v4.1-flash': 1_000_000,
      'deepseek-v4-1-flash-260910': 1_000_000,
      'grok-4.7': 500_000,
      'qwen3.5-plus': 1_000_000,
      'qwen3-coder-flash': 1_000_000,
      'qwen-plus-latest': 1_000_000,
      'glm-5.3': 1_000_000,
      'glm-5.3-flash': 1_000_000,
      'glm-5.2': 1_000_000,
      'kimi-k3.1-pro': 1_048_576,
      'kimi-k3': 1_048_576,
      'MiniMax-M3': 1_000_000,
      'MiniMax-M3.1-Flash': 1_000_000
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

export function manualProviderDefaultContextWindow(
  vendorId: OfficialVendorId | undefined,
  model: string
): number | undefined {
  const provider = manualProviderDefinition(vendorId)
  const windows = provider?.defaultContextWindows
  return windows && Object.hasOwn(windows, model) ? windows[model] : provider?.fallbackContextWindow
}

export function manualProviderPresetModels(
  vendorId: OfficialVendorId | undefined,
  connection: ManualProviderConnection
): readonly string[] {
  const definition = manualProviderDefinition(vendorId)
  return definition?.models?.[connection.protocol] ?? []
}

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
