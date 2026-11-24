import {
  manualProviderDefinition,
  type ManualProviderConnection,
  type OfficialVendorId
} from '@aipoch/providers'

export const supportsManualProviderContextWindow = (
  vendorId: OfficialVendorId | undefined
): boolean => vendorId === 'cloudflare-ai-gateway' || Boolean(manualProviderDefinition(vendorId))

export const usesCloudProviderModels = (vendorId: OfficialVendorId | undefined): boolean =>
  vendorId === 'cloudflare-ai-gateway' ||
  vendorId === 'aws-bedrock' ||
  vendorId === 'microsoft-foundry'

export const sameManualProviderConnection = (
  left?: ManualProviderConnection,
  right?: ManualProviderConnection
): boolean =>
  left?.location.trim().toLowerCase() === right?.location.trim().toLowerCase() &&
  left?.protocol === right?.protocol
