import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { runtimeStartupOptionsSchema } from './runtime-startup-options'

export { runtimeStartupOptionsSchema, type RuntimeStartupOptions } from './runtime-startup-options'

const root = z.string().min(1).refine(isAbsolute, 'Expected an absolute directory')
export const desktopRuntimeInfoSchema = z
  .object({
    launch: z.enum(['desktop', 'cli']),
    control: z.enum(['granted', 'held']),
    controlReason: z.enum(['controller-held', 'operation-pending', 'runtime-stopping']).optional(),
    generation: z.string().uuid(),
    entryPath: root,
    startupOptions: runtimeStartupOptionsSchema
  })
  .strict()
export type DesktopRuntimeInfo = z.infer<typeof desktopRuntimeInfoSchema>
