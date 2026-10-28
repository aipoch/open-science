import { z } from 'zod'
import { defineApplicationCommandContract } from './application-command-contract'

export const USE_CASE_MANIFEST_URL =
  'https://statics.aipoch.com/open-science/usecases/manifest.json'
export const useCaseSourceSchema = z
  .object({
    useCase: z
      .string()
      .max(200)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })
  .strict()
export type UseCaseSource = z.infer<typeof useCaseSourceSchema>
const filename = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !/[/\\]/.test(value) &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
      value !== '.' &&
      value !== '..'
  )
const manifestSchema = z
  .array(
    z.object({
      name: useCaseSourceSchema.shape.useCase,
      title: z.string().trim().min(1).max(1000),
      cover: z.object({ file_name: filename }),
      case: z.object({
        file_name: filename.refine((value) => /\.science$/i.test(value)),
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 ** 3),
        sha256: z.string().regex(/^[a-f\d]{64}$/i)
      })
    })
  )
  .max(10000)

export type UseCase = {
  slug: string
  title: string
  imageUrl: string
  packageUrl: string
  sizeBytes: number
  sha256: string
}

// Mirror the website's published slug/filename contract; source paths and release URLs are not resource authority.
export const parseUseCases = (value: unknown): UseCase[] => {
  const names = new Set<string>()
  return manifestSchema.parse(value).map((item) => {
    if (names.has(item.name)) throw new Error('Duplicate use case')
    names.add(item.name)
    const resource = (name: string): string =>
      new URL(`${item.name}/${encodeURIComponent(name)}`, USE_CASE_MANIFEST_URL).href
    return {
      slug: item.name,
      title: item.title,
      imageUrl: resource(item.cover.file_name),
      packageUrl: resource(item.case.file_name),
      sizeBytes: item.case.bytes,
      sha256: item.case.sha256.toLowerCase()
    }
  })
}

export const useCaseCatalogContract = defineApplicationCommandContract(
  z.tuple([z.enum(['cached', 'refreshed'])]),
  z.array(
    z.object({
      slug: useCaseSourceSchema.shape.useCase,
      title: z.string(),
      imageUrl: z.string(),
      packageUrl: z.string(),
      sizeBytes: z.number(),
      sha256: z.string()
    })
  )
)
