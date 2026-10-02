import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

export const MANUSCRIPT_EXPORT_FORMATS = ['html', 'pdf', 'docx'] as const

export type ManuscriptExportFormat = (typeof MANUSCRIPT_EXPORT_FORMATS)[number]

export type ManuscriptArtifactReference = Readonly<{
  label: string
  artifactId: string
  versionId: string
  checksum: string
}>

export type ResolvedManuscriptReference = ManuscriptArtifactReference

export type ManuscriptCitationKey = Readonly<{
  itemId: string
  citationKey: string
}>

export type PrepareManuscriptRequest = Readonly<{
  projectId: string
  appSessionId: string
  content: string
}>

export type ManuscriptBibliography = Readonly<{
  filename: string
  content: string
  itemIds: readonly string[]
  citationKeys: readonly ManuscriptCitationKey[]
}>

export type ManuscriptBibtexExport = Readonly<{
  content: string
  citationKeys: readonly ManuscriptCitationKey[]
}>

export type PrepareManuscriptResult = Readonly<{
  /** Markdown body suitable for the workspace preview. */
  markdown: string
  /** Transformed Quarto source. It keeps front matter but removes the private binding block. */
  qmd: string
  references: readonly ResolvedManuscriptReference[]
  bibliography?: ManuscriptBibliography
}>

export type RenderManuscriptRequest = PrepareManuscriptRequest &
  Readonly<{
    format: ManuscriptExportFormat
    filename?: string
  }>

export type RenderManuscriptResult = Readonly<{
  filename: string
  mimeType: string
  dataBase64: string
  references: readonly ResolvedManuscriptReference[]
}>

export type QuartoDetection =
  | Readonly<{ available: true; path: string; version: string }>
  | Readonly<{ available: false; reason: string }>

export const isManuscriptExportFormat = (value: unknown): value is ManuscriptExportFormat =>
  typeof value === 'string' && (MANUSCRIPT_EXPORT_FORMATS as readonly string[]).includes(value)

const manuscriptArtifactReferenceSchema = z
  .object({
    label: z.string().regex(/^fig-[A-Za-z0-9][A-Za-z0-9_-]*$/u),
    artifactId: z.string().trim().min(1).max(512),
    versionId: z.string().trim().min(1).max(512),
    checksum: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict()

const resolvedManuscriptReferenceSchema = manuscriptArtifactReferenceSchema

const manuscriptBibliographySchema = z
  .object({
    filename: z.literal('references.bib'),
    content: z.string().min(1),
    itemIds: z.array(z.string().trim().min(1).max(512)).min(1).max(1_000),
    citationKeys: z
      .array(
        z
          .object({
            itemId: z.string().trim().min(1).max(512),
            citationKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.+-]{0,127}$/u)
          })
          .strict()
      )
      .min(1)
      .max(1_000)
  })
  .strict()

const prepareManuscriptRequestSchema = z
  .object({
    projectId: z.string().trim().min(1).max(512),
    appSessionId: z.string().trim().min(1).max(512),
    content: z.string().max(5 * 1024 * 1024)
  })
  .strict()

const prepareManuscriptResultSchema = z
  .object({
    markdown: z.string(),
    qmd: z.string(),
    references: z.array(resolvedManuscriptReferenceSchema).max(1_000),
    bibliography: manuscriptBibliographySchema.optional()
  })
  .strict()

const manuscriptExportFormatSchema = z.enum(MANUSCRIPT_EXPORT_FORMATS)

const renderManuscriptRequestSchema = prepareManuscriptRequestSchema
  .extend({
    format: manuscriptExportFormatSchema,
    filename: z.string().trim().min(1).max(255).optional()
  })
  .strict()

const renderManuscriptResultSchema = z
  .object({
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    dataBase64: z.string(),
    references: z.array(resolvedManuscriptReferenceSchema).max(1_000)
  })
  .strict()

const quartoDetectionSchema = z.discriminatedUnion('available', [
  z
    .object({
      available: z.literal(true),
      path: z.string().min(1).max(4096),
      version: z.string().min(1).max(255)
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      reason: z.string().min(1).max(4096)
    })
    .strict()
])

export const manuscriptApplicationCommandContracts = Object.freeze({
  detectQuarto: defineApplicationCommandContract(
    validationCodec(z.tuple([])),
    validationCodec(quartoDetectionSchema)
  ),
  prepare: defineApplicationCommandContract(
    validationCodec(z.tuple([prepareManuscriptRequestSchema])),
    validationCodec(prepareManuscriptResultSchema)
  ),
  render: defineApplicationCommandContract(
    validationCodec(z.tuple([renderManuscriptRequestSchema])),
    validationCodec(renderManuscriptResultSchema)
  ),
  export: defineApplicationCommandContract(
    validationCodec(z.tuple([renderManuscriptRequestSchema])),
    validationCodec(renderManuscriptResultSchema)
  )
})
