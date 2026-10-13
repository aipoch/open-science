import type { OfficialVendorId } from '../../shared/provider-registry'
import type {
  CustomReasoningEffortTransport,
  ModelReasoningEffort
} from '../../shared/reasoning-effort'
import type { ProviderFailureObserver } from './provider-failure-observation'
import type { ResponsesBridgeNamespacedTool } from './responses-protocol-types'
import type { ChatSkillSelectorCandidate, ChatSkillSelectorInput } from './skill-selection-contract'

export type ResponsesBridgeTarget = {
  onProviderFailure?: ProviderFailureObserver
  baseUrl: string
  key?: string
  vendorId?: OfficialVendorId
  reasoningEffortTransport?: CustomReasoningEffortTransport
  // Codex uses a catalog model for its local metadata; bridge providers may need a different
  // upstream model id (for example, DeepSeek's model name).
  model?: string
  namespacedTools?: ResponsesBridgeNamespacedTool[]
  // The active model's resolved API value. This explicitly overrides Codex's transport-model effort,
  // which may use a smaller vocabulary or emit its own default. Undefined strips the field.
  reasoningEffort?: ModelReasoningEffort
  reviewerScope?: {
    namespacedTools: ResponsesBridgeNamespacedTool[]
  }
}

export type ResponsesBridgeModelTarget = Pick<
  ResponsesBridgeTarget,
  'model' | 'vendorId' | 'reasoningEffortTransport' | 'reasoningEffort' | 'onProviderFailure'
>

export type ResponsesBridgeConnection = {
  baseUrl: string
  token: string
  // Opaque, non-secret identity for this in-memory bridge instance. Session recovery compares it to
  // avoid resuming Codex history after the hidden reasoning cache has been lost.
  continuityToken?: string
  // Absent is the legacy Chat Completions bridge. Native Responses compatibility stays on the
  // Responses wire protocol and opts in explicitly so framework config can preserve its model.
  kind?: 'responses-compatibility'
}

export type ResponsesBridgeSkillCandidate = ChatSkillSelectorCandidate

export type ResponsesBridgeSkillInput = ChatSkillSelectorInput
