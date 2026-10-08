import type { PromptResponse } from '@agentclientprotocol/sdk'
import {
  sanitizeAcpTurnTokenUsage,
  type AcpMessageImage,
  type AcpTurnTokenUsage
} from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import type { ExplicitAgentBackendTarget } from '../settings/backend-target'

export type RestrictedInferenceErrorCode =
  'cancelled' | 'output-limit' | 'shutting-down' | 'tool-violation' | 'transport-unavailable'

export class RestrictedInferenceError extends Error {
  constructor(
    readonly code: RestrictedInferenceErrorCode,
    message: string,
    readonly usage?: AcpTurnTokenUsage
  ) {
    super(message)
  }
}

export const extractRestrictedInferenceUsage = (error: unknown): AcpTurnTokenUsage | undefined => {
  if (error instanceof RestrictedInferenceError) return error.usage
  if (!(error instanceof Error)) return undefined
  return sanitizeAcpTurnTokenUsage(Object.getOwnPropertyDescriptor(error, 'usage')?.value)
}

export type RestrictedInferenceResult = Readonly<{
  text: string
  frameworkId: AgentFrameworkId
  model: string
  stopReason: PromptResponse['stopReason']
  usage?: AcpTurnTokenUsage
}>

export type RestrictedInferenceRunInput = Readonly<{
  prompt: string
  images?: readonly AcpMessageImage[]
  target: ExplicitAgentBackendTarget
  systemPrompt: string
  agentName: string
  description: string
  signal?: AbortSignal
  outputLimitBytes?: number
}>

export type RestrictedInferenceClient = {
  run(input: RestrictedInferenceRunInput): Promise<RestrictedInferenceResult>
  supportsTarget(target: ExplicitAgentBackendTarget): boolean
  shutdown(): Promise<void>
  sweepStaleProfiles(): Promise<void>
}
