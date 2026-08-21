import type { AcpMessageImage } from '../../../../shared/acp'
import type { ChatMessage } from '../../stores/session-store'
import type {
  HistoryReplayDescriptor,
  HistoryReplayTarget
} from '../../../../shared/history-preamble'
import { buildSessionHistoryReplay } from '../../../../shared/session-history-replay'
import { isHiddenControlMessage } from '../../../../shared/session-persistence'
import type { UploadedAttachment } from '../../../../shared/uploads'
import {
  requiresChatCompletionsBridge,
  type AgentFrameworkId,
  type AgentFrameworkView,
  type ProviderView
} from '../../../../shared/settings'
import { resolveModelContextWindow } from '../../../../shared/provider-registry'

export const resolveHistoryReplayTarget = (
  frameworkId: AgentFrameworkId | undefined,
  provider?: ProviderView,
  framework?: AgentFrameworkView
): HistoryReplayTarget => {
  if (frameworkId === 'opencode') return 'opencode'
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
      : provider?.inputLimit
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
