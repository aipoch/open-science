import { z } from 'zod'
import { imageModelErrorSchema } from './image-model-error'
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
      .optional()
  })
  .strict()
export type ImageTaskList = z.infer<typeof imageTaskListSchema>
export class ImageTaskIntegrityError extends Error {
  constructor(readonly taskIds: readonly string[]) {
    super('Image task output integrity could not be verified.')
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
export const imageTaskSchema = z
  .object({
    ...imageTaskStartSchema.shape,
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome-unknown']),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
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
export const imageTaskIsActive = (task: Pick<ImageTask, 'state'>): boolean =>
  task.state === 'queued' || task.state === 'running'
