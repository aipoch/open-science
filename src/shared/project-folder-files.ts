import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

const folderFileScopeSchema = z.object({
  projectId: z.string().min(1),
  relativePath: z.string().max(32768)
})
export const listProjectFolderRequestSchema = folderFileScopeSchema
  .extend({
    limit: z.number().int().min(1).max(200),
    cursor: z.string().max(65536).optional(),
    query: z.string().max(256).optional(),
    searchDescendants: z.boolean().optional(),
    excludePublishedArtifactCopies: z.boolean().optional()
  })
  .strict()
export const projectFolderListingSchema = z
  .object({
    path: z.string(),
    relativePath: z.string(),
    totalCount: z.number().int().nonnegative(),
    entries: z
      .array(
        z
          .object({
            name: z.string(),
            relativePath: z.string().optional(),
            isDirectory: z.boolean(),
            size: z.number().nonnegative(),
            mtimeMs: z.number()
          })
          .strict()
      )
      .max(200),
    nextCursor: z.string().optional(),
    truncated: z.boolean().optional()
  })
  .strict()
export const readProjectFolderPreviewRequestSchema = folderFileScopeSchema
  .extend({
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024)
      .optional(),
    encoding: z.enum(['utf8', 'base64']).optional()
  })
  .strict()
const previewSchema = z
  .object({
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']),
    size: z.number().nonnegative(),
    truncated: z.boolean()
  })
  .strict()
export type ListProjectFolderRequest = z.infer<typeof listProjectFolderRequestSchema>
export type ProjectFolderListing = z.infer<typeof projectFolderListingSchema>
export type ReadProjectFolderPreviewRequest = z.infer<typeof readProjectFolderPreviewRequestSchema>

export const projectFolderFileCommandContracts = {
  listFolder: defineApplicationCommandContract(
    validationCodec(z.tuple([listProjectFolderRequestSchema])),
    validationCodec(projectFolderListingSchema)
  ),
  readFolderPreview: defineApplicationCommandContract(
    validationCodec(z.tuple([readProjectFolderPreviewRequestSchema])),
    validationCodec(previewSchema)
  )
} as const
