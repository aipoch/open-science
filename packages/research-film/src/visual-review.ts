import { z } from 'zod'

const scene = z.string().min(1).max(100)
const message = z.string().trim().min(1).max(500)
export const filmVisualIssueSchema = z
  .object({
    scene,
    line: z.number().int().nonnegative().max(2).optional(),
    app: z.literal(true).optional(),
    script: z
      .string()
      .regex(/^anims\/[\w-]+\.js$/)
      .max(120)
      .optional(),
    message
  })
  .strict()
export type FilmVisualIssue = z.infer<typeof filmVisualIssueSchema>
const framePosition = z.object({ scene, time: z.number().finite().nonnegative().max(3600) })
export const filmVisualCheckSchema = z
  .object({
    issues: z.array(filmVisualIssueSchema).max(64),
    frames: z.array(framePosition).min(1).max(12)
  })
  .strict()
export const filmVisualResultSchema = z
  .object({
    issues: filmVisualCheckSchema.shape.issues,
    frames: z
      .array(
        framePosition.extend({
          jpeg: z
            .string()
            .min(1)
            .max(512 * 1024)
        })
      )
      .max(12)
  })
  .strict()
export type FilmVisualResult = z.infer<typeof filmVisualResultSchema>
