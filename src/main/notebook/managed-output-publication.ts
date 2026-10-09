import { z } from 'zod'

const identity = z.string().min(1).max(512)
const relativeFile = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes(':') &&
      ![...value].some((character) => character.charCodeAt(0) < 32) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Write intent must use a managed relative file path.'
  )
const provenance = z
  .object({
    rootFrameId: identity,
    agentFrameId: identity,
    messageBranchId: identity,
    runtimeSegmentId: identity,
    promptMessageId: identity
  })
  .strict()

/** A durable Main-issued write intent. Contains no live capability, signal or host filesystem path. */
export const managedOutputWriteAttemptSchema = z
  .object({
    schemaVersion: z.literal(1),
    request: z
      .object({
        projectId: identity,
        appSessionId: identity,
        artifactStorageSessionId: identity,
        artifactRunId: identity,
        writeOperationId: identity,
        filename: z.string().min(1).max(4096),
        contentType: z.string().max(1024).optional(),
        producerRunId: identity.optional()
      })
      .strict(),
    destination: z
      .object({
        provenanceContext: provenance,
        messageAncestry: z.array(identity).max(100000)
      })
      .strict(),
    source: z
      .object({
        kind: z.enum(['inline', 'localPath', 'managedOutput']),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        producerRunId: identity.optional(),
        producerProvenance: provenance.optional(),
        generationId: identity.optional(),
        relativePath: relativeFile.optional()
      })
      .strict()
  })
  .strict()
  .superRefine((attempt, context) => {
    if (
      Boolean(attempt.source.producerRunId) !== Boolean(attempt.source.producerProvenance) ||
      (attempt.source.kind === 'inline' &&
        (attempt.source.relativePath !== undefined || attempt.source.generationId !== undefined)) ||
      (attempt.source.kind !== 'inline' && attempt.source.relativePath === undefined) ||
      (attempt.source.generationId !== undefined && !attempt.source.producerRunId)
    )
      context.addIssue({
        code: 'custom',
        message: 'Write intent source evidence is incomplete or inconsistent.'
      })
    if (attempt.request.producerRunId !== attempt.source.producerRunId)
      context.addIssue({
        code: 'custom',
        message: 'Write intent producer identities do not match.'
      })
    if (
      !attempt.destination.messageAncestry.includes(
        attempt.destination.provenanceContext.promptMessageId
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Write intent ancestry does not include its destination prompt.'
      })
  })

export type ManagedOutputWriteAttempt = z.infer<typeof managedOutputWriteAttemptSchema>
export type ManagedOutputPublication = Readonly<{
  /** Must durably commit the complete intent before resolving; rejection prevents Artifact writes. */
  beforeWrite(attempt: ManagedOutputWriteAttempt): Promise<void>
}>

export function freezeManagedOutputWriteAttempt(value: unknown): ManagedOutputWriteAttempt {
  const attempt = managedOutputWriteAttemptSchema.parse(value)
  Object.freeze(attempt.request)
  Object.freeze(attempt.destination.provenanceContext)
  Object.freeze(attempt.destination.messageAncestry)
  Object.freeze(attempt.destination)
  if (attempt.source.producerProvenance) Object.freeze(attempt.source.producerProvenance)
  Object.freeze(attempt.source)
  return Object.freeze(attempt)
}
