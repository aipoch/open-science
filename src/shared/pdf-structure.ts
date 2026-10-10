// Stable existing failure message shared by the owner and renderer across IPC/Web.
export const PDF_CLEANUP_PENDING = 'PDF worker cleanup must finish before more parsing can start.'

import { z } from 'zod'
import { defineApplicationCommandContract } from './application-command-contract'

import { decodePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'
export {
  parsePdfStructureResult,
  checkPdfStructureDecodingBudget,
  pdfTextRunsSchema,
  pdfTableSourceItemsSchema
} from '@aipoch/pdf-structure/result'
export type { PdfStructureResult, PdfStructureIdentity } from '@aipoch/pdf-structure/result'
const id = z.string().regex(/^[a-z0-9-]{1,80}$/)

const managedSource = z
  .object({
    kind: z.literal('managed'),
    projectId: z.string().min(1).max(200),
    sourceKind: z.enum(['upload-version', 'artifact-version']),
    sourceFileId: z.string().min(1).max(200),
    sourceVersionId: z.string().min(1).max(200)
  })
  .strict()

export type ManagedPdfStructureSource = z.infer<typeof managedSource>
export type PdfStructureSource =
  Readonly<{ attachmentVersionId: string }> | Readonly<{ source: ManagedPdfStructureSource }>
export type ReadCachedPdfStructureRequest = PdfStructureSource & Readonly<{ page: number }>
export type ParsePdfStructureRequest = ReadCachedPdfStructureRequest &
  Readonly<{ requestId: string }>
export type ReadPdfStructureThumbnailRequest = ReadCachedPdfStructureRequest &
  Readonly<{
    extractionId: string
    thumbnailId: string
  }>

const literatureRequest = z.object({
  attachmentVersionId: z.string().min(1).max(200),
  page: z.number().int().positive()
})
const managedRequest = z.object({ source: managedSource, page: z.number().int().positive() })
export const readCachedPdfStructureRequest = z.union([
  literatureRequest.strict(),
  managedRequest.strict()
])
const parseFields = { requestId: z.string().uuid() }
export const parsePdfStructureRequest = z.union([
  literatureRequest.extend(parseFields).strict(),
  managedRequest.extend(parseFields).strict()
])
const thumbnailFields = { extractionId: z.string().uuid(), thumbnailId: id }
export const readPdfStructureThumbnailRequest = z.union([
  literatureRequest.extend(thumbnailFields).strict(),
  managedRequest.extend(thumbnailFields).strict()
])
export const pdfStructureCommandContracts = {
  readCached: defineApplicationCommandContract(z.tuple([readCachedPdfStructureRequest]), {
    parse(value: unknown): PdfStructureResult | undefined {
      if (value === undefined) return undefined
      return decodePdfStructureResult(value)
    }
  }),
  parse: defineApplicationCommandContract(z.tuple([parsePdfStructureRequest]), {
    parse(value: unknown): PdfStructureResult {
      return decodePdfStructureResult(value)
    }
  }),
  cancel: defineApplicationCommandContract(z.tuple([z.string().uuid()]), z.void()),
  readThumbnail: defineApplicationCommandContract(
    z.tuple([readPdfStructureThumbnailRequest]),
    z
      .string()
      .max(6 * 1024 ** 2)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
      .optional()
  ),
  clearCache: defineApplicationCommandContract(
    z.tuple([]),
    z
      .object({
        removedBytes: z.number().int().nonnegative(),
        retainedEntries: z.number().int().nonnegative()
      })
      .strict()
  )
}
