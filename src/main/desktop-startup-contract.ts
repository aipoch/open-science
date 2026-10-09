import { z } from 'zod'
import type { DatabaseStartupState } from '../shared/database-startup'

const text = z.string().max(128 * 1024)
export const desktopDatabaseStartupSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('checking') }).strict(),
  z.object({ phase: z.literal('starting') }).strict(),
  z.object({ phase: z.literal('ready') }).strict(),
  z.object({ phase: z.literal('migrating'), migrationId: text }).strict(),
  z
    .object({
      phase: z.literal('blocked'),
      error: z
        .object({
          code: z.enum([
            'database_runtime_unavailable',
            'database_open_failed',
            'database_newer_than_app',
            'database_history_invalid',
            'database_migration_failed',
            'database_validation_failed',
            'database_startup_unavailable'
          ]),
          message: text,
          retryable: z.boolean(),
          migrationId: text.optional(),
          diagnostics: text.optional(),
          environment: z
            .object({ appVersion: text, platform: text, arch: text, electron: text, node: text })
            .strict()
            .optional()
        })
        .strict()
    })
    .strict()
]) satisfies z.ZodType<DatabaseStartupState>
export const desktopStartupEventSchema = z
  .object({
    kind: z.literal('startup-state'),
    state: desktopDatabaseStartupSchema,
    rpcChannels: z.array(z.string().min(1).max(256)).max(2048)
  })
  .strict()
