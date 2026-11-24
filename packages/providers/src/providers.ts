export { OFFICIAL_VENDORS } from './providers/data'
export {
  isOfficialVendorId,
  getOfficialVendor,
  resolveVendorBaseUrl,
  resolveVendorChatCompletionsBaseUrl,
  resolveVendorResponsesBaseUrl,
  resolveVendorApiKeyUrl,
  resolveVendorModelsUrl,
  resolveVendorApiEndpoints,
  usesVendorMessagesApiKeyHeader,
  isVendorModelMultimodal,
  resolveVendorModelApiEndpoints
} from './providers/lookup'
export type {
  OfficialVendorId,
  VendorRegion,
  OfficialModel,
  OfficialVendor,
  ImageGenerationProviderDefinition
} from './providers/types'
export { getVendorModelReasoningCapability } from './providers/lookup'
export {
  cloudflareGatewayAcceptsModel,
  cloudflareGatewayBase,
  cloudflareGatewayProtocol,
  foundryGatewayBase,
  parseCloudflareGateway,
  parseFoundryLocation,
  validCloudflareAccountId,
  validCloudflareGatewayId,
  type CloudflareGateway
} from './protocols/gateway-endpoints'
export {
  CLOUDFLARE_GATEWAY_MODELS,
  manualProviderDefaultContextWindow,
  manualProviderDefinition,
  manualProviderPresetModels,
  publishedManualProviderContextWindow,
  resolveManualProviderConnection,
  sameManualProviderCredentialScope,
  type ManualProviderConnection
} from './providers/manual-connections'
export { resolveProviderProbePolicy } from './providers/probe-policy'
export type {
  ModelProtocol,
  ModelReasoningEffort,
  ResolvedReasoningEffort,
  CustomReasoningEffortTransport,
  ReasoningCapability
} from './protocols/types'

export type {
  ClassificationAdapter,
  ClassificationModelDefinition
} from './providers/classification'
export {
  getProviderDefinition,
  getProviderModels,
  resolveProviderImageBaseUrl
} from './providers/definitions'
export type { ProviderDefinition } from './providers/definitions'
export type { ModelCapability, ModelIdentity, ModelDefinition } from './models/types'

export { resolveVendorModelCatalog } from './providers/lookup'
export type {
  CatalogModel,
  CatalogSnapshot,
  CatalogStatus,
  CatalogErrorCode,
  CatalogRequestOptions
} from './protocols/catalog'
