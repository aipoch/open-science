import { z } from 'zod'
import {
  managedOutputSelectionSchema,
  managedSessionScopeSchema
} from '../../shared/managed-execution'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
const scopeSchema = managedSessionScopeSchema.extend({ operationId: identity }).strict()
const provenanceSchema = z
  .object({
    rootFrameId: identity,
    agentFrameId: identity,
    messageBranchId: identity,
    runtimeSegmentId: identity,
    promptMessageId: identity
  })
  .strict()
const selectedFileSchema = managedOutputSelectionSchema.pick({ filename: true, path: true })
const fileSchema = selectedFileSchema
  .extend({
    sha256: checksum,
    sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    generationId: identity
  })
  .strict()
const grantSchema = scopeSchema
  .extend({
    collectionId: checksum,
    producerRunId: identity,
    producerProvenance: provenanceSchema,
    outputs: z.array(fileSchema).max(100)
  })
  .strict()
  .superRefine(({ outputs }, context) => {
    const filenames = new Set<string>()
    const paths = new Set<string>()
    for (const [index, output] of outputs.entries()) {
      if (filenames.has(output.filename))
        context.addIssue({
          code: 'custom',
          path: ['outputs', index, 'filename'],
          message: 'Duplicate recovery output filename.'
        })
      if (
        [...paths].some(
          (path) =>
            path === output.path ||
            path.startsWith(output.path + '/') ||
            output.path.startsWith(path + '/')
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['outputs', index, 'path'],
          message: 'Conflicting recovery output paths.'
        })
      filenames.add(output.filename)
      paths.add(output.path)
    }
  })
const selectionSchema = selectedFileSchema.extend({ producerRunId: identity }).strict()

export type ManagedOutputRecoveryScope = Readonly<z.infer<typeof scopeSchema>>
export type ManagedOutputRecoveryProvenance = Readonly<z.infer<typeof provenanceSchema>>
export type ManagedOutputRecoveryFile = Readonly<z.infer<typeof fileSchema>>
export type ManagedOutputRecoveryProof = Readonly<{
  collectionId: string
  producerRunId: string
  producerProvenance: ManagedOutputRecoveryProvenance
  output: ManagedOutputRecoveryFile
  signal: AbortSignal
}>

const authorityBrand = Symbol('managed-output-recovery-authority')
export type ManagedOutputRecoveryAuthority = Readonly<{ [authorityBrand]: true }>
type Grant = ManagedOutputRecoveryScope & {
  collectionId: string
  producerRunId: string
  producerProvenance: ManagedOutputRecoveryProvenance
  outputs: readonly ManagedOutputRecoveryFile[]
  controller: AbortController
  signal: AbortSignal
}
const grants = new WeakMap<ManagedOutputRecoveryAuthority, Grant>()

/** Main only: mint from verified retained execution evidence, never from a caller's declarations.
 * This grant identifies original output evidence; it grants no path access or execution authority.
 */
export function createManagedOutputRecoveryAuthority(
  input: ManagedOutputRecoveryScope & {
    collectionId: string
    producerRunId: string
    producerProvenance: ManagedOutputRecoveryProvenance
    outputs: readonly ManagedOutputRecoveryFile[]
    signal?: AbortSignal
  }
): ManagedOutputRecoveryAuthority {
  const { signal, ...definition } = input
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new Error('Recovery authority requires an AbortSignal.')
  signal?.throwIfAborted()
  // Zod clones all accepted declaration data. Freeze the nested copies before retaining them.
  const parsed = grantSchema.parse(definition)
  const controller = new AbortController()
  const authority: ManagedOutputRecoveryAuthority = Object.freeze({ [authorityBrand]: true })
  grants.set(
    authority,
    Object.freeze({
      ...parsed,
      producerProvenance: Object.freeze(parsed.producerProvenance),
      outputs: Object.freeze(parsed.outputs.map((output) => Object.freeze(output))),
      controller,
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    })
  )
  return authority
}

export function revokeManagedOutputRecoveryAuthority(
  authority: ManagedOutputRecoveryAuthority
): void {
  grants.get(authority)?.controller.abort(new Error('Managed output recovery authority has ended.'))
}

/** Only a Main writer may consume this proof. It must still re-observe the exact file bytes and
 * original generation and retain Artifact's ancestry and unique-producer checks.
 */
export function resolveManagedOutputRecoveryAuthority(
  authority: ManagedOutputRecoveryAuthority,
  scope: ManagedOutputRecoveryScope,
  selection: Readonly<z.infer<typeof selectionSchema>>
): ManagedOutputRecoveryProof {
  const grant = grants.get(authority)
  const actualScope = scopeSchema.parse({
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    operationId: scope.operationId
  })
  if (
    !grant ||
    grant.projectId !== actualScope.projectId ||
    grant.sessionId !== actualScope.sessionId ||
    grant.operationId !== actualScope.operationId
  )
    throw new Error('Managed output recovery authority does not belong to this operation.')
  grant.signal.throwIfAborted()
  const selected = selectionSchema.parse(selection)
  if (selected.producerRunId !== grant.producerRunId)
    throw new Error('Managed output recovery authority does not match the original Notebook Run.')
  const output = grant.outputs.find(
    (file) => file.filename === selected.filename && file.path === selected.path
  )
  if (!output)
    throw new Error('Managed output recovery authority does not include this exact output.')
  return Object.freeze({
    collectionId: grant.collectionId,
    producerRunId: grant.producerRunId,
    producerProvenance: grant.producerProvenance,
    output,
    signal: grant.signal
  })
}
