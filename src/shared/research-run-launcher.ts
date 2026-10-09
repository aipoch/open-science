import { z } from 'zod'
import type { ManagedRuntimeDiagnosticCode } from './managed-execution'
import type { ResearchReproductionDescription } from './research-reproduction'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u)
/** Read-only inspection. This does not create a discussion or authorize execution. */
export const inspectResearchRunRequestSchema = z
  .object({
    projectId: identity,
    sourceSessionId: identity,
    sourceImportId: identity,
    descriptorVersionId: identity.optional(),
    expectedSourceIdentity: z.string().min(1).max(4096).optional()
  })
  .strict()
export type InspectResearchRunRequest = z.infer<typeof inspectResearchRunRequestSchema>
export type ResearchRunDescriptor = {
  versionId: string
  filename: string
  sha256: string
  sizeBytes: number
}
export type ResearchRunMaterial = {
  key: string
  status: 'available' | 'external' | 'withheld' | 'missing' | 'mismatch'
  versionIds?: string[]
}
export type ResearchRunPlan = {
  key: string
  title: string
  scope: ResearchReproductionDescription['plans'][number]['scope']
  claim: string
  limitations: string[]
  materialKeys: string[]
  materials: ResearchRunMaterial[]
  materialReady: boolean
  compatibleRuntimeIds: string[]
  // Portable package-relative entrypoints only; no executable code or host paths.
  entrypoints: Array<{ materialKey: string; path?: string }>
  requirements?: Pick<
    NonNullable<ResearchReproductionDescription['plans'][number]['requirements']>,
    'node' | 'platforms'
  >
  requiresSecrets: boolean
}
export type ResearchRunRuntime = {
  runtimeId: string
  kind: 'node'
  version: string
  platform: 'darwin' | 'linux' | 'win32'
  arch: string
}
export type ResearchRunInspection = {
  source: {
    projectId: string
    sessionId: string
    importId: string
    title?: string
    identity: string
  }
  status: 'no-description' | 'choose-description' | 'ready' | 'unsupported' | 'invalid'
  descriptorCandidates: ResearchRunDescriptor[]
  descriptor?: ResearchRunDescriptor
  plans: ResearchRunPlan[]
  runtimes: ResearchRunRuntime[]
  diagnostics: {
    nativeServiceSupported: boolean
    issues: Array<{ code: ManagedRuntimeDiagnosticCode }>
  }
}

export type ResearchRunBlockReason =
  'materials-unavailable' | 'runtime-unavailable' | 'entrypoint-unavailable' | 'secrets-required'

/** Shared first-launch eligibility. The Agent still reviews setup and exact requirements. */
export const researchRunPlanBlockReasons = (plan: ResearchRunPlan): ResearchRunBlockReason[] => [
  ...(!plan.materialReady ? ['materials-unavailable' as const] : []),
  ...(!plan.compatibleRuntimeIds.length ? ['runtime-unavailable' as const] : []),
  ...(!plan.entrypoints.length ? ['entrypoint-unavailable' as const] : []),
  ...(plan.requiresSecrets ? ['secrets-required' as const] : [])
]
