import type {
  OfficialVendorId,
  CustomReasoningEffortTransport,
  ModelReasoningEffort
} from '@aipoch/providers'

import type { ProviderFailureObserver } from './provider-failure-observation'
import type { ResponsesNamespacedTool } from '@aipoch/providers/protocol'
import type { ChatSkillSelectorCandidate, ChatSkillSelectorInput } from './skill-selection-contract'

export type ResponsesToChatCompletionsBridgeTarget = {
  onProviderFailure?: ProviderFailureObserver
  baseUrl: string
  key?: string
  vendorId?: OfficialVendorId
  reasoningEffortTransport?: CustomReasoningEffortTransport
  // Codex uses a catalog model for its local metadata; bridge providers may need a different
  // upstream model id (for example, DeepSeek's model name).
  model?: string
  namespacedTools?: ResponsesNamespacedTool[]
  // The active model's resolved API value. This explicitly overrides Codex's transport-model effort,
  // which may use a smaller vocabulary or emit its own default. Undefined strips the field.
  reasoningEffort?: ModelReasoningEffort
  reviewerScope?: {
    namespacedTools: ResponsesNamespacedTool[]
  }
}

export type ResponsesModelTarget = Pick<
  ResponsesToChatCompletionsBridgeTarget,
  'model' | 'vendorId' | 'reasoningEffortTransport' | 'reasoningEffort' | 'onProviderFailure'
>

export type ResponsesConnection = {
  baseUrl: string
  token: string
  // Opaque, non-secret identity for this in-memory bridge instance. Session recovery compares it to
  // avoid resuming Codex history after the hidden reasoning cache has been lost.
  continuityToken?: string
  // Absent is the legacy Chat Completions bridge. Native Responses compatibility stays on the
  // Responses wire protocol and opts in explicitly so framework config can preserve its model.
  kind?: 'responses-compatibility'
}

export type ResponsesSkillCandidate = ChatSkillSelectorCandidate

export type ResponsesSkillInput = ChatSkillSelectorInput
