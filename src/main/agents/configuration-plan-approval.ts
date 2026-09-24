import type { TrustedCallingSession } from '../../shared/agents-contract'

export type ConfigurationPlan = {
  kind: 'agent-configuration'
  operation: string
  target: string
  before?: unknown
  changes: unknown
}

export type ApproveConfigurationPlan = (
  plan: ConfigurationPlan,
  context: TrustedCallingSession
) => Promise<boolean>

/** Auto adds a concrete decision at the operation boundary; Ask/Full keep existing behavior. */
export function createAutoPlanApproval<T>(options: {
  profile: (sessionId: string) => 'ask' | 'auto' | 'full' | undefined
  request: (plan: T, context: TrustedCallingSession) => Promise<boolean>
}): (plan: T, context: TrustedCallingSession) => Promise<boolean> {
  return async (plan, context) => {
    if (context.signal?.aborted || !context.sessionId) return false
    const profile = options.profile(context.sessionId)
    if (!profile) return false
    if (profile !== 'auto') return true
    if (context.permissionPrompts === 'none') return false
    const approved = await options.request(structuredClone(plan), context)
    return approved && !context.signal?.aborted
  }
}
