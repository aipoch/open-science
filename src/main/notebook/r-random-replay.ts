import { rRandomStateSchema } from '../../shared/notebook-execution-context'

// Validate again at the replay boundary. Only fixed RNG names and bounded integer
// words become R code; never deserialize an R object or interpolate captured code.
export const restoreRRandomState = (source: string, captured: unknown): string => {
  if (captured === undefined) return source // Legacy captures have no RNG snapshot.
  const parsed = rRandomStateSchema.safeParse(captured)
  if (!parsed.success) throw new Error('Captured R random state is invalid.')
  if (parsed.data.state === 'unavailable')
    throw new Error(`Captured R random state cannot be restored: ${parsed.data.reason}.`)
  const { kinds, seed } = parsed.data
  // Keep the prelude on the first line so reported user-code line numbers stay intact.
  return [
    `base::RNGkind(${kinds.map((kind) => JSON.stringify(kind)).join(', ')})`,
    `base::assign(".Random.seed", c(${seed.map((word) => (word === null ? 'NA_integer_' : `${word}L`)).join(',')}), envir = base::globalenv())`,
    source
  ].join('; ')
}
