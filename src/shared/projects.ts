import { z } from 'zod'

import { validationCodec, type ApplicationCommandContract } from './application-command-contract'

// Shared project types crossing the main <-> renderer IPC boundary.
//
// The SQLite/Prisma layer owns Project rows (see src/main/projects). Timestamps are normalized to
// epoch milliseconds at the repository boundary so the renderer treats them like session timestamps.

export const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    isExample: z.boolean(),
    // Optional on the wire for compatibility with older persisted payloads; absence means unpinned.
    pinned: z.boolean().optional(),
    // An absent timestamp keeps the Project on active surfaces. Archive is reversible and does not
    // affect the Project's research activity ordering.
    archivedAt: z.number().finite().optional(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
  })
  .strict()

export const createProjectRequestSchema = z
  .object({
    name: z.string(),
    description: z.string().optional()
  })
  .strict()

export const updateProjectRequestSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    pinned: z.boolean().optional()
  })
  .strict()

export const deleteProjectRequestSchema = z.object({ id: z.string() }).strict()

export const updateProjectArchiveRequestSchema = z
  .object({
    id: z.string(),
    archived: z.boolean(),
    // The last authoritative archive value prevents a stale renderer from restoring or archiving a
    // Project after another window has already changed it.
    expectedArchivedAt: z.number().finite().nullable()
  })
  .strict()

export type Project = z.infer<typeof projectSchema>
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>
export type DeleteProjectRequest = z.infer<typeof deleteProjectRequestSchema>
export type UpdateProjectArchiveRequest = z.infer<typeof updateProjectArchiveRequestSchema>

const contract = <Args extends readonly unknown[], Result>(
  args: ApplicationCommandContract<Args, Result>['args'],
  result: ApplicationCommandContract<Args, Result>['result']
): ApplicationCommandContract<Args, Result> => Object.freeze({ args, result })

export const projectApplicationCommandContracts = Object.freeze({
  list: contract(validationCodec(z.tuple([])), validationCodec(z.array(projectSchema))),
  get: contract(validationCodec(z.tuple([z.string()])), validationCodec(projectSchema.nullable())),
  create: contract(
    validationCodec(z.tuple([createProjectRequestSchema])),
    validationCodec(projectSchema)
  ),
  update: contract(
    validationCodec(z.tuple([updateProjectRequestSchema])),
    validationCodec(projectSchema)
  ),
  updateArchive: contract(
    validationCodec(z.tuple([updateProjectArchiveRequestSchema])),
    validationCodec(projectSchema)
  ),
  delete: contract(
    validationCodec(z.tuple([deleteProjectRequestSchema])),
    validationCodec(z.undefined())
  )
})
