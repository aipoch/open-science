import {
  cloudflareGatewayAcceptsModel,
  cloudflareGatewayBase,
  cloudflareGatewayProtocol,
  foundryGatewayBase,
  parseCloudflareGateway,
  parseFoundryLocation,
  type CloudflareGateway
} from '../protocols/gateway-endpoints'
import {
  cloudflareGatewayRequestPolicy,
  foundryRequestPolicy,
  type ProviderRequestPolicy
} from '../protocols/gateway-policies'
import type { ModelProtocol } from '../protocols/types'
import type { OfficialVendorId } from './types'
import { sameLocalProviderCredentialScope, type LocalProviderConnection } from './local-connection'

export const DEFAULT_CLOUDFLARE_GATEWAY: CloudflareGateway = {
  accountId: '',
  gatewayId: 'default',
  mode: 'rest'
}

export const CLOUDFLARE_GATEWAY_MODELS: Readonly<
  Record<CloudflareGateway['mode'], readonly string[]>
> = {
  rest: [
    '@cf/openai/gpt-oss-120b',
    '@cf/openai/gpt-oss-20b',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  ],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']
}

export type ManualProviderConnection = Readonly<{
  location: string
  protocol: ModelProtocol
}>

type ManualProviderDefinition = Readonly<{
  defaultConnection: ManualProviderConnection
  protocols: readonly ModelProtocol[]
  locations?: readonly string[]
  sharedCredential?: true
  editableModelList?: true
  inferProtocolFromLocation?: true
  requestPolicy?: (baseUrl: string, protocol: ModelProtocol) => ProviderRequestPolicy | undefined
  models?: Partial<Record<ModelProtocol, readonly string[]>>
  fallbackContextWindow?: number
  defaultContextWindows?: Readonly<Partial<Record<string, number>>>
  parseLocation: (location: string, protocol: ModelProtocol) => string | undefined
  baseUrl: (location: string, protocol: ModelProtocol) => string
}>

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
    editableModelList: true,
    inferProtocolFromLocation: true,
    requestPolicy: (baseUrl, protocol) =>
      protocol === 'responses' ? undefined : foundryRequestPolicy(baseUrl, protocol),
    parseLocation: parseFoundryLocation,
    baseUrl: foundryGatewayBase
  },
  'aws-bedrock': {
    defaultConnection: { location: 'us-east-1', protocol: 'messages' },
    editableModelList: true,
    protocols: ['messages', 'chat-completions'],
    models: {
      messages: [
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'us.anthropic.claude-sonnet-4-6',
        'us.anthropic.claude-haiku-4-5-20251001-v1:0'
      ],
      'chat-completions': ['openai.gpt-oss-120b-1:0', 'openai.gpt-oss-20b-1:0']
    },
    // A commercial AWS region must fit in one label of the Bedrock hostname.
    parseLocation: (location) =>
      /^(?:us|ca|eu|ap|sa|me|af|il|mx)-[a-z]+-[1-9][0-9]?$/.test(location) ? location : undefined,
    baseUrl: (region, protocol) =>
      `https://bedrock-runtime.${region}.amazonaws.com/${protocol === 'messages' ? 'anthropic' : 'openai/v1'}`
  }
}

export const manualProviderDefinition = (
  vendorId: OfficialVendorId | undefined
): ManualProviderDefinition | undefined =>
  vendorId && Object.hasOwn(definitions, vendorId) ? definitions[vendorId] : undefined

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
  // Bedrock availability and inference profiles vary by AWS region.
  if (
    vendorId === 'aws-bedrock' &&
    connection.location.trim().toLowerCase() !== definition?.defaultConnection.location
  )
    return []
  return definition?.models?.[connection.protocol] ?? []
}

/** Use published limits only for the exact model IDs exposed by the selected route. */
export function publishedManualProviderContextWindow(
  vendorId: OfficialVendorId | undefined,
  protocol: ModelProtocol | undefined,
  model: string | undefined
): number | undefined {
  if (vendorId === 'cloudflare-ai-gateway') {
    if (protocol === 'chat-completions') {
      // Workers AI publishes its own limits, which can differ from the original weights.
      if (model === '@cf/meta/llama-3.3-70b-instruct-fp8-fast') return 24_000
      if (model === '@cf/openai/gpt-oss-120b' || model === '@cf/openai/gpt-oss-20b') return 128_000
    }
    if (protocol === 'messages') {
      if (model === 'claude-sonnet-4-5' || model === 'claude-haiku-4-5') return 200_000
      if (
        model === 'claude-opus-4-8' ||
        model === 'claude-opus-5-5' ||
        model === 'claude-sonnet-5-5' ||
        model === 'claude-haiku-5-5'
      )
        return 1_000_000
    }
  }
  if (vendorId === 'aws-bedrock') {
    if (
      protocol === 'chat-completions' &&
      (model === 'openai.gpt-oss-120b-1:0' || model === 'openai.gpt-oss-20b-1:0')
    )
      return 128_000
    if (
      protocol === 'messages' &&
      /^(?:(?:us|eu|au|jp|global)\.)?anthropic\.claude-sonnet-4-5-20250929-v1:0$/.test(model ?? '')
    )
      return 200_000
    if (protocol === 'messages' && model === 'us.anthropic.claude-sonnet-4-6') return 1_000_000
    if (protocol === 'messages' && model === 'us.anthropic.claude-haiku-4-5-20251001-v1:0')
      return 200_000
  }
  return undefined
}

/** Resolve the endpoint and normalized location for the selected protocol. */
export function resolveManualProviderConnection(
  vendorId: OfficialVendorId,
  value: unknown
): { connection: ManualProviderConnection; baseUrl: string } | undefined {
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

export type ConfiguredProviderConnectionInput = Readonly<{
  cloudflare?: CloudflareGateway
  manualConnection?: ManualProviderConnection
}>

export type ResolvedConfiguredProviderConnection = Readonly<{
  protocol: ModelProtocol
  baseUrl: string
  requestPolicy?: ProviderRequestPolicy
}> &
  (
    | { cloudflare: CloudflareGateway; manualConnection?: never }
    | { cloudflare?: never; manualConnection: ManualProviderConnection }
  )

export const configuredProviderConnectionKind = (
  vendorId: OfficialVendorId | undefined
): 'cloudflare' | 'manual' | undefined =>
  vendorId === 'cloudflare-ai-gateway'
    ? 'cloudflare'
    : manualProviderDefinition(vendorId)
      ? 'manual'
      : undefined

export const supportsConfiguredProviderModelList = (
  vendorId: OfficialVendorId | undefined
): boolean =>
  vendorId === 'cloudflare-ai-gateway' ||
  manualProviderDefinition(vendorId)?.editableModelList === true

/** Resolve the upstream URL, protocol, and request policy for a configured provider. */
export function resolveConfiguredProviderConnection(
  vendorId: OfficialVendorId,
  input: { cloudflare?: unknown; manualConnection?: unknown }
): ResolvedConfiguredProviderConnection | undefined {
  if (vendorId === 'cloudflare-ai-gateway') {
    const cloudflare = parseCloudflareGateway(input.cloudflare)
    if (!cloudflare) return undefined
    const baseUrl = cloudflareGatewayBase(cloudflare)
    return {
      cloudflare,
      protocol: cloudflareGatewayProtocol(cloudflare.mode),
      baseUrl,
      requestPolicy: cloudflareGatewayRequestPolicy(baseUrl, cloudflare.gatewayId, cloudflare.mode)
    }
  }
  const manual = resolveManualProviderConnection(vendorId, input.manualConnection)
  if (!manual) return undefined
  const { baseUrl, connection } = manual
  return {
    manualConnection: connection,
    protocol: connection.protocol,
    baseUrl,
    requestPolicy: manualProviderDefinition(vendorId)?.requestPolicy?.(baseUrl, connection.protocol)
  }
}

/** Check model compatibility while the form is still collecting connection details. */
export function configuredProviderModelError(
  input: Pick<ConfiguredProviderConnectionInput, 'cloudflare'>,
  model: string | undefined
): 'model-required' | 'incompatible-model' | undefined {
  const id = model?.trim()
  if (!id) return 'model-required'
  if (input.cloudflare && !cloudflareGatewayAcceptsModel(input.cloudflare.mode, id))
    return 'incompatible-model'
}

/** Prefer the selected model when it is in the explicit list and fall back to the first entry. */
export function selectConfiguredModelId(
  model?: string,
  ids?: readonly string[]
): string | undefined {
  const id = model?.trim() || undefined
  return ids ? (id && ids.includes(id) ? id : ids[0]) : id
}

export function configuredProviderPresetModels(
  vendorId: OfficialVendorId | undefined,
  input: ConfiguredProviderConnectionInput
): readonly string[] {
  if (vendorId === 'cloudflare-ai-gateway')
    return CLOUDFLARE_GATEWAY_MODELS[(input.cloudflare ?? DEFAULT_CLOUDFLARE_GATEWAY).mode]
  return input.manualConnection ? manualProviderPresetModels(vendorId, input.manualConnection) : []
}

/** Recover legacy model selections by keeping compatible rows and falling back to a preset. */
export function recoverConfiguredProviderModels<Model extends { readonly id: string }>(
  vendorId: OfficialVendorId,
  connection: ResolvedConfiguredProviderConnection,
  model: string | undefined,
  savedModels: readonly Model[] | undefined
): { model: string; manualModels?: Model[] } | undefined {
  const compatibleModels = savedModels?.filter(
    ({ id }) => !configuredProviderModelError(connection, id)
  )
  const manualModels = compatibleModels?.length ? compatibleModels : undefined
  const configured = selectConfiguredModelId(
    model,
    manualModels?.map(({ id }) => id)
  )
  if (!configured) return undefined

  const selected = configuredProviderModelError(connection, configured)
    ? configuredProviderPresetModels(vendorId, connection)[0]
    : configured
  return selected ? { model: selected, ...(manualModels && { manualModels }) } : undefined
}

export function configuredProviderProtocol(
  vendorId: OfficialVendorId | undefined,
  input: ConfiguredProviderConnectionInput
): ModelProtocol | undefined {
  if (vendorId === 'cloudflare-ai-gateway')
    return cloudflareGatewayProtocol((input.cloudflare ?? DEFAULT_CLOUDFLARE_GATEWAY).mode)
  const definition = manualProviderDefinition(vendorId)
  return definition && (input.manualConnection ?? definition.defaultConnection).protocol
}

/** Keep the current protocol unless the pasted location requires another supported protocol. */
export function inferManualProviderProtocol(
  vendorId: OfficialVendorId,
  input: ManualProviderConnection
): ModelProtocol {
  const definition = manualProviderDefinition(vendorId)
  if (!definition?.inferProtocolFromLocation || resolveManualProviderConnection(vendorId, input))
    return input.protocol
  return (
    definition.protocols.find((protocol) =>
      resolveManualProviderConnection(vendorId, { ...input, protocol })
    ) ?? input.protocol
  )
}

/** Keep presets supported by the new protocol and preserve custom model IDs. */
export function modelAfterManualProtocolChange(
  vendorId: OfficialVendorId,
  previous: ManualProviderConnection,
  next: ManualProviderConnection,
  model: string
): string {
  const id = model.trim()
  const nextModels = manualProviderPresetModels(vendorId, next)
  if (
    id &&
    (nextModels.includes(id) || !manualProviderPresetModels(vendorId, previous).includes(id))
  )
    return id
  return nextModels[0] ?? ''
}

type ConfiguredProviderCatalogModel = {
  id: string
  routes: Partial<Record<ModelProtocol, string>>
  publishedContextWindow?: number
  defaultContextWindow?: number
}

/** Resolve catalog routes and published limits before the host applies user overrides. */
export function resolveConfiguredProviderCatalog(
  vendorId: OfficialVendorId,
  input: ConfiguredProviderConnectionInput,
  model: string | undefined,
  configuredIds?: readonly string[]
): ConfiguredProviderCatalogModel[] {
  const connection = resolveConfiguredProviderConnection(vendorId, input)
  if (!connection || !model?.trim()) return []
  const ids = configuredIds ?? [
    model.trim(),
    ...configuredProviderPresetModels(vendorId, connection)
  ]
  const { protocol, baseUrl } = connection
  return [...new Set(ids)]
    .filter((id) => !configuredProviderModelError(connection, id))
    .map((id) => ({
      id,
      routes: { [protocol]: baseUrl },
      publishedContextWindow: publishedManualProviderContextWindow(vendorId, protocol, id),
      defaultContextWindow: manualProviderDefaultContextWindow(vendorId, id)
    }))
}

function sameCloudflareGateway(left?: CloudflareGateway, right?: CloudflareGateway): boolean {
  return (
    left?.mode === right?.mode &&
    left?.accountId.trim().toLowerCase() === right?.accountId.trim().toLowerCase() &&
    left?.gatewayId.trim() === right?.gatewayId.trim()
  )
}

type ConfiguredProviderIdentity = ConfiguredProviderConnectionInput & {
  vendorId?: OfficialVendorId
}

/** Compare routes by protocol and normalized location so equivalent endpoint aliases match. */
export function sameConfiguredProviderConnection(
  left: ConfiguredProviderIdentity,
  right: ConfiguredProviderIdentity
): boolean {
  if (left.vendorId !== right.vendorId || !sameCloudflareGateway(left.cloudflare, right.cloudflare))
    return false
  const a = left.manualConnection
  const b = right.manualConnection
  if (!a || !b) return a === b
  if (a.protocol !== b.protocol) return false
  if (a.location.trim().toLowerCase() === b.location.trim().toLowerCase()) return true
  if (!left.vendorId) return false
  const location = resolveManualProviderConnection(left.vendorId, a)?.connection.location
  return (
    location !== undefined &&
    location === resolveManualProviderConnection(left.vendorId, b)?.connection.location
  )
}

type ProviderCredentialScope = ConfiguredProviderIdentity &
  LocalProviderConnection & {
    type: string
  }

/** Allow shared credentials for Vectrust nodes while isolating Cloudflare modes and local origins. */
export function sameProviderCredentialScope(
  left: ProviderCredentialScope,
  right: ProviderCredentialScope
): boolean {
  return (
    left.type === right.type &&
    left.vendorId === right.vendorId &&
    sameCloudflareGateway(left.cloudflare, right.cloudflare) &&
    sameManualProviderCredentialScope(
      left.vendorId,
      left.manualConnection,
      right.manualConnection
    ) &&
    sameLocalProviderCredentialScope(left, right)
  )
}
