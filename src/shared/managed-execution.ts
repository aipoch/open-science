import { z } from 'zod'
import { runtimeViewLaunchSchema } from './runtime-view'

// Additive application requests, not .science fields or caller-issued execution capabilities.
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => character.charCodeAt(0) < 0x20)
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.includes('\\') &&
      !path.includes(':') &&
      !hasControlCharacters(path) &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Use a relative path inside the prepared environment.'
  )
export const managedSessionScopeSchema = z
  .object({
    projectId: identity,
    sessionId: identity
  })
  .strict()
export const inspectManagedMaterialsRequestSchema = managedSessionScopeSchema
  .extend({
    sourceSessionId: identity,
    sourceIdentity: z.string().min(1).max(4096).optional(),
    versionIds: z.array(identity).max(1000).optional(),
    descriptorVersionId: identity.optional()
  })
  .strict()
const explicitFiles = z
  .object({
    files: z
      .array(z.object({ versionId: identity, restorePath: relativePath }).strict())
      .min(1)
      .max(1000)
  })
  .strict()
const describedFiles = z
  .object({
    descriptorVersionId: identity,
    materialKeys: z.array(z.string().min(1).max(512)).min(1).max(1000),
    materialVersions: z.record(z.string().min(1).max(512), identity).optional()
  })
  .strict()
export const prepareManagedEnvironmentRequestSchema = managedSessionScopeSchema
  .extend({
    requestId: identity,
    sourceSessionId: identity,
    sourceIdentity: z.string().min(1).max(4096),
    versionIds: z.array(identity).max(1000).optional(),
    runtimeId: checksum,
    materials: z.union([explicitFiles, describedFiles])
  })
  .strict()
export const managedEnvironmentReferenceSchema = managedSessionScopeSchema
  .extend({
    environmentId: checksum
  })
  .strict()
export const managedCollectionReferenceSchema = managedEnvironmentReferenceSchema
  .extend({ collectionId: checksum })
  .strict()
export const collectManagedOutputsRequestSchema = managedCollectionReferenceSchema
  .extend({ requestId: identity })
  .strict()
export const managedOutputSelectionSchema = z
  .object({
    path: relativePath,
    filename: z
      .string()
      .min(1)
      .max(512)
      .refine((name) => !/[\\/]/.test(name) && !hasControlCharacters(name)),
    contentType: z.string().min(1).max(256).optional(),
    // An experiment can fail before producing a declared optional output.
    optional: z.boolean().optional()
  })
  .strict()
export const executeManagedEnvironmentRequestSchema = managedEnvironmentReferenceSchema
  .extend({
    requestId: identity,
    command: z
      .string()
      .min(1)
      .max(128 * 1024)
      .refine((value) => !value.includes('\0')),
    timeoutMs: z.number().int().min(1).max(600_000).default(60_000),
    localServicePort: z.number().int().min(1).max(65535).optional(),
    projectView: runtimeViewLaunchSchema.optional(),
    // Independent of a project Web UI; absent/false preserves existing execution behavior.
    recordObservation: z.boolean().optional(),
    // Opaque reference; only the trusted desktop can configure credentials and service hosts.
    profileId: identity.optional(),
    outputs: z.array(managedOutputSelectionSchema).max(100).default([]),
    description: z.string().min(1).max(16_384).optional()
  })
  .strict()
  .refine((request) => !request.projectView || (request.localServicePort ?? 0) >= 1024, {
    message: 'An interactive project view requires a declared local service port of 1024 or above.'
  })
/** Capture/publication is reported separately from the actual experiment outcome. */
export const managedObservationResultSchema = z
  .object({
    status: z.enum([
      'recording',
      'ready',
      'saved',
      'published',
      'pending',
      'unavailable',
      'failed'
    ]),
    recordingId: checksum.optional(),
    versionId: identity.optional(),
    warning: z
      .enum([
        'capture-unavailable',
        'capture-start-failed',
        'capture-failed',
        'capture-empty',
        'capture-partial',
        'archive-save-failed',
        'archive-recovery-pending',
        'archive-receipt-failed'
      ])
      .optional()
  })
  .strict()
export type ManagedObservationResult = z.infer<typeof managedObservationResultSchema>

export const managedOperationReferenceSchema = managedSessionScopeSchema
  .extend({
    requestId: identity
  })
  .strict()
export const createManagedSessionRequestSchema = z
  .object({
    projectId: identity,
    requestId: identity,
    title: z.string().trim().min(1).max(512)
  })
  .strict()

export type InspectManagedMaterialsRequest = z.input<typeof inspectManagedMaterialsRequestSchema>
export type PrepareManagedEnvironmentRequest = z.input<
  typeof prepareManagedEnvironmentRequestSchema
>
export type ManagedEnvironmentReference = z.input<typeof managedEnvironmentReferenceSchema>
export type ManagedCollectionReference = z.input<typeof managedCollectionReferenceSchema>
export type CollectManagedOutputsRequest = z.input<typeof collectManagedOutputsRequestSchema>
export type ExecuteManagedEnvironmentRequest = z.input<
  typeof executeManagedEnvironmentRequestSchema
>
export type ManagedOperationReference = z.input<typeof managedOperationReferenceSchema>
export type CreateManagedSessionRequest = z.input<typeof createManagedSessionRequestSchema>
export type ManagedExecutionMethod =
  | 'runtimes'
  | 'inspectMaterials'
  | 'preflight'
  | 'requestConfiguration'
  | 'getConfiguration'
  | 'prepare'
  | 'execute'
  | 'getEnvironment'
  | 'releaseEnvironment'
  | 'collectOutputs'
  | 'discardOutputs'

export type ManagedRuntimeDiagnosticCode =
  | 'node_not_found'
  | 'node_version_unsupported'
  | 'node_host_mismatch'
  | 'node_not_independent'
  | 'node_unusable'
  | 'native_service_unsupported'
export type ManagedRuntimeDiagnostics = {
  /** Local HTTP service support, separate from finding a compatible Node binary. */
  nativeServiceSupported: boolean
  /** Fixed guidance only; no candidate paths, environment values or raw probe errors. */
  issues: Array<{ code: ManagedRuntimeDiagnosticCode; message: string; action: string }>
}
