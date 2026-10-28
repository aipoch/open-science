import { serviceLifetimeRecordSchema } from './local-service-lifetime'
import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { runtimeStartupOptionsSchema } from './runtime-startup-options'

export { runtimeStartupOptionsSchema, type RuntimeStartupOptions } from './runtime-startup-options'

const root = z.string().min(1).refine(isAbsolute, 'Expected an absolute directory')
export const desktopRuntimeInfoSchema = z
  .object({
    lifetime: serviceLifetimeRecordSchema
      .extend({ apps: z.number().int().nonnegative() })
      .optional(),
    launch: z.enum(['desktop', 'cli']),
    control: z.enum(['granted', 'held']),
    controlReason: z.enum(['controller-held', 'operation-pending', 'runtime-stopping']).optional(),
    generation: z.string().uuid(),
    birthToken: z.string().optional(),
    entryPath: root,
    startupOptions: runtimeStartupOptionsSchema
  })
  .strict()
export type DesktopRuntimeInfo = z.infer<typeof desktopRuntimeInfoSchema>
