import { z } from 'zod'
import { managedSessionScopeSchema } from './managed-execution'
import type { ResearchDemoCandidate, ResearchDemoDescription } from './research-demo'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u)
export const inspectOfflinePlansRequestSchema = managedSessionScopeSchema
  .extend({
    sourceSessionId: identity,
    sourceIdentity: z.string().min(1).max(4096).optional()
  })
  .strict()
export const executeOfflinePlanRequestSchema = inspectOfflinePlansRequestSchema
  .extend({
    sourceIdentity: z.string().min(1).max(4096),
    planVersionId: identity,
    requestId: identity
  })
  .strict()
export type InspectOfflinePlansRequest = z.infer<typeof inspectOfflinePlansRequestSchema>
export type ExecuteOfflinePlanRequest = z.infer<typeof executeOfflinePlanRequestSchema>
export type OfflinePlanInspection = {
  source: { projectId: string; sessionId: string; identity: string; title?: string }
  plans: Array<
    Omit<ResearchDemoCandidate, 'demoVersionId'> & {
      planVersionId: string
      runtimeId?: string
      entrypoint?: ResearchDemoDescription['entrypoint']
      outputs?: ResearchDemoDescription['outputs']
      timeoutMs?: number
      hasProjectView: boolean
    }
  >
  /** Project processes are offline. The Agent orchestrating them can still use a model. */
  confinement: 'offline-project-process'
}
