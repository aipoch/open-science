import { z } from 'zod'
import type { ArtifactVersionEvidence } from './artifact-provenance'
import { imageModelErrorSchema, type ImageErrorDetail } from './image-model-error'
import { imageEditSnapshotSchema } from './image-edit-contract'

const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
export const imageTaskScopeSchema = z
  .object({
    projectId: identity,
    sessionId: identity
  })
  .strict()
// Query-only pagination; task records retain their existing format.
export const imageTaskListSchema = imageTaskScopeSchema
  .extend({
    history: z
      .object({
        branchId: identity,
        before: z
          .object({ createdAt: z.number().finite(), id: z.string().uuid() })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    recovery: z
      .object({ frameId: identity, branchId: identity, sourceVersionId: identity })
      .strict()
      .optional()
  })
  .strict()
  .refine(({ history, recovery }) => !history || !recovery)
export type ImageTaskList = z.infer<typeof imageTaskListSchema>
export const matchesImageTaskSource = (
  task: Pick<ImageTask, 'frameId' | 'branchId'> & {
    edit: { source: Pick<ImageTask['edit']['source'], 'sourceVersionId'> }
  },
  source: NonNullable<ImageTaskList['recovery']>
): boolean =>
  task.frameId === source.frameId &&
  task.branchId === source.branchId &&
  task.edit.source.sourceVersionId === source.sourceVersionId

export const imageTaskEvidenceMatches = (
  evidence: ArtifactVersionEvidence | undefined,
  taskId: string,
  sourceVersionId: string
): boolean =>
  evidence?.image_task_id === taskId &&
  evidence.connector_execution?.normalized_arguments?.sourceVersionId === sourceVersionId &&
  evidence.inputs?.length === 1 &&
  evidence.inputs[0]?.input_file_version_id === sourceVersionId

export class ImageTaskIntegrityError extends Error {
  constructor(readonly taskIds: readonly string[]) {
    super(`Image task integrity could not be verified: ${taskIds.join(', ')}.`)
    this.name = 'ImageTaskIntegrityError'
  }
}
export const imageTaskStartSchema = imageTaskScopeSchema
  .extend({
    id: z.string().uuid(),
    frameId: identity,
    branchId: identity,
    prompt: z.string().trim().max(32_000),
    edit: imageEditSnapshotSchema
  })
  .strict()
  .refine(({ prompt, edit }) => Boolean(prompt || edit.regions.length), {
    message: 'An image edit requires an instruction.'
  })
  .refine(({ edit, projectId }) => edit.source.projectId === projectId, {
    message: 'Image task identity or source project does not match.'
  })
export const imageTaskIdentitySchema = imageTaskScopeSchema
  .extend({ id: z.string().uuid() })
  .strict()
export type ImageTaskScope = z.infer<typeof imageTaskScopeSchema>
export type ImageTaskStart = z.infer<typeof imageTaskStartSchema>
export type ImageTaskIdentity = z.infer<typeof imageTaskIdentitySchema>
export type ImageTaskState =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown'
export const imageTaskResultSchema = z
  .object({
    artifactId: identity,
    versionId: identity,
    versionNumber: z.number().int().positive(),
    name: z.string().min(1).max(512),
    mimeType: z.string().optional(),
    size: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export type ImageTaskResult = z.infer<typeof imageTaskResultSchema>
const imageTaskExecutionModelSchema = z
  .object({ provider: z.string().min(1).max(128).optional(), model: z.string().min(1).max(256) })
  .strict()
export type ImageTaskExecutionModel = z.infer<typeof imageTaskExecutionModelSchema>

export const imageTaskSchema = z
  .object({
    ...imageTaskStartSchema.shape,
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome-unknown']),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    executionModel: imageTaskExecutionModelSchema.optional(),
    error: imageModelErrorSchema.optional(),
    result: imageTaskResultSchema.optional()
  })
  .strict()
  .superRefine((task, ctx) => {
    if (
      !imageTaskStartSchema.safeParse({
        id: task.id,
        projectId: task.projectId,
        sessionId: task.sessionId,
        frameId: task.frameId,
        branchId: task.branchId,
        prompt: task.prompt,
        edit: task.edit
      }).success ||
      (task.state === 'succeeded' && !task.result)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid image task.' })
  })
export type ImageTask = z.infer<typeof imageTaskSchema>
export type ImageTaskStartResult = ImageTask | { error: ImageErrorDetail }
export const imageTaskIsActive = (task: Pick<ImageTask, 'state'>): boolean =>
  task.state === 'queued' || task.state === 'running'
