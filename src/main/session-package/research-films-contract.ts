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

export const packageOperationReplayFilmsSchema = z
  .object({ schemaVersion: z.literal(1), films: packageResearchFilmsSchema })
  .strict()
export type PackageOperationReplayFilms = z.infer<typeof packageOperationReplayFilmsSchema>
export type PackageModeFilms = Array<
  PackageResearchFilms[number] & {
    mode?: 'research-explanation' | 'operation-replay'
  }
>
export const packageFilms = (records: {
  researchFilms?: PackageResearchFilms
  operationReplayFilms?: PackageOperationReplayFilms
}): PackageModeFilms => [
  ...(records.researchFilms ?? []),
  ...(records.operationReplayFilms?.films ?? []).map((film) => ({
    ...film,
    mode: 'operation-replay' as const
  }))
]
export const packageFilmRecord = ({
  mode,
  ...film
}: PackageModeFilms[number]): PackageResearchFilms[number] => {
  void mode
  return film
}
export const packageFilmNamespace = (film: Pick<PackageModeFilms[number], 'mode'>): string =>
  film.mode === 'operation-replay' ? '.operation-replay-films' : '.research-films'
