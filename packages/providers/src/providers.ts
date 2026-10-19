export { OFFICIAL_VENDORS } from './providers/data'
export {
  isOfficialVendorId,
  getOfficialVendor,
  resolveVendorBaseUrl,
  resolveVendorChatCompletionsBaseUrl,
  resolveVendorResponsesBaseUrl,
  resolveVendorApiKeyUrl,
  resolveVendorModelsUrl,
  usesVendorMessagesApiKeyHeader,
  isVendorModelMultimodal,
  resolveVendorModelApiEndpoints
} from './providers/lookup'
export type {
  OfficialVendorId,
  VendorRegion,
  OfficialModel,
  OfficialVendor
} from './providers/types'
export { getVendorModelReasoningCapability } from './providers/lookup'
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
export { getProviderDefinition, getProviderModels } from './providers/definitions'
export type { ProviderDefinition } from './providers/definitions'
export type { ModelCapability, ModelIdentity, ModelDefinition } from './models/types'
