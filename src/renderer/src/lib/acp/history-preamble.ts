import type { AcpMessageImage } from '../../../../shared/acp-image-contract'
import type {
  HistoryReplayDescriptor,
  HistoryReplayTarget
} from '../../../../shared/history-replay-contract'
import { resolveModelContextWindow } from '../../../../shared/provider-model-policy'
import { buildSessionHistoryReplay } from '../../../../shared/session-history-replay'
import { isHiddenControlMessage } from '../../../../shared/session-persistence'
import {
  requiresChatCompletionsBridge,
  type AgentFrameworkId,
  type AgentFrameworkView,
  type ProviderView
} from '../../../../shared/settings'
import type { UploadedAttachment } from '../../../../shared/uploads'
import type { ChatMessage } from '../../stores/session-store'

export const resolveHistoryReplayTarget = (
  frameworkId: AgentFrameworkId | undefined,
  provider?: ProviderView,
  framework?: AgentFrameworkView
): HistoryReplayTarget => {
  if (frameworkId === 'opencode') return 'opencode'
  if (frameworkId === 'codebuddy') return 'codebuddy'
  if (frameworkId !== 'codex') return 'claude-code'
  if (
    provider &&
    framework &&
    requiresChatCompletionsBridge(provider, {
      id: framework.id,
      supportedApiTypes: framework.supportedApiTypes ?? ['responses']
    })
  ) {
    return 'codex-bridge'
  }
  return 'codex-response'
}

export const resolveSessionHistoryReplayDescriptor = (
  session: {
    agentFrameworkId?: AgentFrameworkId
    agentBackendId?: string
    agentModel?: string
  },
  providers: ProviderView[],
  frameworks: AgentFrameworkView[]
): HistoryReplayDescriptor => {
  const frameworkId = session.agentFrameworkId
  const provider = providers.find(
    (candidate) => session.agentBackendId === `${frameworkId}:${candidate.id}`
  )
  const framework = frameworks.find((candidate) => candidate.id === frameworkId)
  const target =
    frameworkId === 'codex' && (!provider || !framework)
      ? 'codex-bridge'
      : resolveHistoryReplayTarget(frameworkId, provider, framework)

  return {
    target,
    contextWindow: provider?.vendorId
      ? resolveModelContextWindow(
          provider.vendorId,
          session.agentModel ?? provider.model ?? provider.models[0]
        )
      : provider?.contextWindow
  }
}

export const buildWorkspaceHistoryReplay = (
  messages: ChatMessage[],
  descriptor: HistoryReplayDescriptor,
  projectId?: string,
  supportsImageInput?: boolean
):
  | {
      historyPreamble: string
      historyAttachments: UploadedAttachment[]
      historyImages: AcpMessageImage[]
    }
  | undefined => {
  return buildSessionHistoryReplay(
    messages.filter((message) => !isHiddenControlMessage(message)),
    descriptor,
    projectId,
    supportsImageInput
  )
}

export {
  buildHistoryPreamble,
  buildHistoryReplay,
  estimateHistoryTokens,
  resolveHistoryReplayBudget
} from '../../../../shared/history-preamble'
export type {
  HistoryReplayDescriptor,
  HistoryReplayTarget
} from '../../../../shared/history-preamble'
