import { z } from 'zod'
import { isAbsolute } from 'node:path'

// Host startup configuration is shared by Runtime admission and installation recovery.
// It has no dependency on Desktop composition or the updater.
const root = z.string().min(1).refine(isAbsolute, 'Expected an absolute directory')
export const runtimeStartupOptionsSchema = z
  .object({
    configRoot: root,
    dataRoot: root,
    profilePath: root,
    port: z.number().int().min(0).max(65535),
    host: z.literal('127.0.0.1'),
    credentialStore: z.enum(['os', 'file']),
    passwordStore: z.string().min(1).max(100).optional()
  })
  .strict()
export type RuntimeStartupOptions = z.infer<typeof runtimeStartupOptionsSchema>
