import { z } from 'zod'
import { isPortableResearchReproductionPath } from './research-reproduction'
import { managedOutputSelectionSchema } from './managed-execution'
import { runtimeViewLaunchSchema } from './runtime-view'
import type {
  RunObservationDemoViewingAdmission,
  RunObservationSelection,
  RunObservationTarget
} from './run-observation'
import type { RecordedObservationTarget } from './run-observation-recorded'

export const RESEARCH_DEMO_FORMAT = 'open-science-replay-demo'
export const RESEARCH_DEMO_MAX_BYTES = 64 * 1024
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u)
const text = z.string().trim().min(1).max(4096)
const path = z.string().refine(isPortableResearchReproductionPath)

/** Optional ordinary Artifact content. A declaration is not an execution capability. */
export const researchDemoDescriptionSchema = z
  .object({
    format: z.literal(RESEARCH_DEMO_FORMAT),
    version: z.literal(1),
    title: text,
    description: text,
    descriptorSha256: sha256,
    planKey: key,
    substitutions: z.array(text).min(1).max(32),
    entrypoint: z.object({ materialKey: key, path: path.optional() }).strict(),
    arguments: z
      .array(
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes('\0'))
      )
      .max(64)
      .default([]),
    timeoutMs: z.number().int().min(1000).max(600_000),
    // The author keeps the same process serving after its demonstration actions finish.
    viewing: z
      .object({ mode: z.literal('until-stop-or-timeout') })
      .strict()
      .optional(),
    outputs: z.array(managedOutputSelectionSchema).max(100).default([]),
    localServicePort: z.number().int().min(1024).max(65535).optional(),
    projectView: runtimeViewLaunchSchema.optional()
  })
  .strict()
  .refine((value) => !value.projectView || value.localServicePort !== undefined, {
    message: 'A project view requires an owned local service.'
  })
  .refine((value) => !value.viewing || value.projectView !== undefined, {
    message: 'A viewing lifetime requires a project view.'
  })
export type ResearchDemoDescription = z.infer<typeof researchDemoDescriptionSchema>

export function parseResearchDemoDescription(
  json: string
):
  | { status: 'valid'; description: ResearchDemoDescription }
  | { status: 'invalid' | 'unsupported' } {
  if (new TextEncoder().encode(json).byteLength > RESEARCH_DEMO_MAX_BYTES)
    return { status: 'invalid' }
  try {
    const value: unknown = JSON.parse(json)
    const containers: (Set<string> | null)[] = []
    for (const match of json.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}[\]:,]/gu)) {
      const token = match[0]
      if (token === '{') containers.push(new Set())
      else if (token === '[') containers.push(null)
      else if (token === '}' || token === ']') containers.pop()
      else if (token.startsWith('"')) {
        let next = match.index + token.length
        while (next < json.length && /\s/u.test(json[next])) next++
        if (json[next] !== ':') continue
        const name = JSON.parse(token) as string
        const object = containers.at(-1)
        if (object?.has(name) || ['__proto__', 'constructor', 'prototype'].includes(name))
          return { status: 'invalid' }
        object?.add(name)
      }
      if (containers.length > 16) return { status: 'invalid' }
    }
    if (
      value &&
      typeof value === 'object' &&
      'format' in value &&
      'version' in value &&
      value.format === RESEARCH_DEMO_FORMAT &&
      Number.isSafeInteger(value.version) &&
      Number(value.version) > 1
    )
      return { status: 'unsupported' }
    const parsed = researchDemoDescriptionSchema.safeParse(value)
    return parsed.success ? { status: 'valid', description: parsed.data } : { status: 'invalid' }
  } catch {
    return { status: 'invalid' }
  }
}

export const researchDemoSourceSchema = z
  .object({
    projectId: identity,
    sourceSessionId: identity,
    sourceImportId: identity
  })
  .strict()
export type ResearchDemoSource = z.infer<typeof researchDemoSourceSchema>
export const startResearchDemoSchema = researchDemoSourceSchema
  .extend({
    demoVersionId: identity,
    expectedSourceIdentity: z.string().min(1).max(4096),
    requestId: identity
  })
  .strict()
export type StartResearchDemoRequest = z.infer<typeof startResearchDemoSchema>
export const researchDemoReferenceSchema = researchDemoSourceSchema
  .extend({ requestId: identity })
  .strict()
export type ResearchDemoReference = z.infer<typeof researchDemoReferenceSchema>
export const researchDemoQuestionRequestSchema = researchDemoReferenceSchema
  .extend({
    viewerId: z.string().uuid(),
    selectionId: identity,
    destinationSessionId: identity.optional()
  })
  .strict()
export type ResearchDemoQuestionRequest = z.infer<typeof researchDemoQuestionRequestSchema>
export type ResearchDemoQuestion = {
  selection: RunObservationSelection
  source: ResearchDemoSource
  requestId: string
  destination: { projectId: string; sessionId?: string }
  purpose: 'offline-demo'
}
export type ResearchDemoBlockReason =
  | 'invalid-demo'
  | 'unsupported-demo'
  | 'descriptor-unavailable'
  | 'materials-unavailable'
  | 'runtime-unavailable'
  | 'entrypoint-unavailable'
  | 'secrets-required'
  | 'service-unavailable'
export type ResearchDemoCandidate = {
  demoVersionId: string
  title: string
  description?: string
  descriptorVersionId?: string
  planKey?: string
  status: 'ready' | 'blocked'
  blockers: ResearchDemoBlockReason[]
  substitutions: string[]
  demoViewing?: RunObservationDemoViewingAdmission
}
export type ResearchDemoInspection = {
  source: ResearchDemoSource & { identity: string; title?: string }
  candidates: ResearchDemoCandidate[]
}
export type ResearchDemoState =
  | 'preparing'
  | 'starting'
  | 'running'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'recovery-pending'
export type ResearchDemoReceipt = {
  source: ResearchDemoSource
  requestId: string
  demoVersionId: string
  title: string
  substitutions: string[]
  purpose: 'offline-demo'
  demoViewing?: RunObservationDemoViewingAdmission
  sessionId?: string
  operationRequestId?: string
  runTarget?: RunObservationTarget
  recordingTarget?: RecordedObservationTarget
  state: ResearchDemoState
  createdAt: number
  updatedAt: number
  errorCode?:
    'preparation-failed' | 'execution-failed' | 'recording-unavailable' | 'recovery-required'
  recordingStatus?: 'pending' | 'saved' | 'unavailable'
}
export type ResearchDemoHistory = { receipts: ResearchDemoReceipt[]; carrierSessionId?: string }
