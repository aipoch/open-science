import { z } from 'zod'

export const packageResearchFilmsSchema = z
  .array(
    z
      .object({
        id: z.string().uuid(),
        branchId: z.string().min(1).max(512).optional(),
        title: z.string().min(1).max(160),
        duration: z.number().positive(),
        playerStorageKey: z.string().max(2048),
        sourceStorageKey: z.string().max(2048)
      })
      .strict()
  )
  .min(1)
  .max(1000)
export type PackageResearchFilms = z.infer<typeof packageResearchFilmsSchema>
export const researchFilmStorageKeys = (films: PackageResearchFilms | undefined): string[] =>
  films?.flatMap((film) => [film.playerStorageKey, film.sourceStorageKey]) ?? []
