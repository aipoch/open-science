import type { OfficialVendorId } from '@aipoch/providers'

// Application-tested exclusions for the Codex Chat bridge.
const BRIDGE_UNSUPPORTED_MODELS: Partial<Record<OfficialVendorId, readonly string[]>> = {}

// Models a vendor is statically known not to drive over the Codex Responses->Chat bridge (see
// application compatibility data). Empty for vendors whose whole catalog converts.
export const resolveVendorBridgeUnsupportedModels = (id: OfficialVendorId): readonly string[] =>
  BRIDGE_UNSUPPORTED_MODELS[id] ?? []

// Static, ships-with-the-app check: whether a model can be driven over the Codex Responses->Chat
// bridge. Only meaningful for the bridged (openai) path; callers gate it behind the Codex framework.
// Custom providers (no vendorId) are assumed compatible — their key is what gets tested, not the model.
export const isModelBridgeSupported = (
  provider: { vendorId?: OfficialVendorId },
  model: string | undefined
): boolean =>
  !provider.vendorId || model === undefined
    ? true
    : !resolveVendorBridgeUnsupportedModels(provider.vendorId).includes(model)
