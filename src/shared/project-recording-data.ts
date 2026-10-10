import { z } from 'zod'
import { projectRecordingValueSchema } from './project-recording'

/** Optional declared project output, not an executable script or a .science manifest field. */
export const PROJECT_RECORDING_DATA_FILENAME = 'project-recording-data.json'
export const MAX_PROJECT_RECORDING_DATA_BYTES = 512 * 1024
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const evidence = {
  id,
  sequence: count,
  /** Author-reported time; the recorder retains its own separate intake time. */
  reportedAt: count.optional()
}
export const projectRecordingDataSchema = z
  .object({
    format: z.literal('open-science-project-recording-data'),
    version: z.literal(1),
    states: z
      .array(
        z
          .object({
            ...evidence,
            label: z.string().min(1).max(512).optional(),
            value: projectRecordingValueSchema
          })
          .strict()
      )
      .max(500),
    events: z
      .array(
        z
          .object({
            ...evidence,
            name: z.string().min(1).max(512),
            data: projectRecordingValueSchema.optional()
          })
          .strict()
      )
      .max(500)
  })
  .strict()
  .superRefine((data, ctx) => {
    for (const entries of [data.states, data.events]) {
      const ids = new Set<string>()
      for (const [index, entry] of entries.entries()) {
        if (ids.has(entry.id) || (index && entry.sequence <= entries[index - 1].sequence))
          ctx.addIssue({
            code: 'custom',
            message: 'Project declaration identity or sequence is inconsistent.'
          })
        ids.add(entry.id)
      }
    }
  })
export type ProjectRecordingData = z.infer<typeof projectRecordingDataSchema>
export function parseProjectRecordingData(bytes: Uint8Array): ProjectRecordingData {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PROJECT_RECORDING_DATA_BYTES)
    throw new Error('Project declaration exceeds its content limit.')
  return projectRecordingDataSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  )
}
