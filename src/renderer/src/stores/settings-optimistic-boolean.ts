type OptimisticBooleanToken = Readonly<{
  key: string
  generation: number
}>

type OptimisticBooleanEntry = {
  confirmedGeneration: number
  confirmedValue: boolean
  pending: Map<number, boolean>
}

type OptimisticBooleanCoordinator = {
  begin: (key: string, confirmedValue: boolean, optimisticValue: boolean) => OptimisticBooleanToken
  beginProjection: () => number
  project: (key: string, authoritativeValue: boolean, generation: number) => boolean
  succeed: (token: OptimisticBooleanToken, authoritativeValue: boolean) => boolean
  fail: (token: OptimisticBooleanToken) => boolean
}

const projectedValue = (entry: OptimisticBooleanEntry): boolean => {
  let generation = entry.confirmedGeneration
  let value = entry.confirmedValue

  for (const [pendingGeneration, pendingValue] of entry.pending) {
    if (pendingGeneration <= generation) continue
    generation = pendingGeneration
    value = pendingValue
  }

  return value
}

// Coordinates one or more optimistic boolean fields without exposing pending state through Zustand.
// Pending writes and authoritative projections share one sequence, so older settlements cannot
// overwrite newer intent or snapshots. A run of rejected writes still returns to the original
// confirmed value.
export const createOptimisticBooleanCoordinator = (): OptimisticBooleanCoordinator => {
  const entries = new Map<string, OptimisticBooleanEntry>()
  let nextGeneration = 0

  const finish = (token: OptimisticBooleanToken, authoritativeValue?: boolean): boolean => {
    const entry = entries.get(token.key)
    if (!entry) return authoritativeValue ?? false

    entry.pending.delete(token.generation)
    if (authoritativeValue !== undefined && token.generation > entry.confirmedGeneration) {
      entry.confirmedGeneration = token.generation
      entry.confirmedValue = authoritativeValue
    }

    const value = projectedValue(entry)
    if (entry.pending.size === 0) entries.delete(token.key)
    return value
  }

  return {
    begin: (key, confirmedValue, optimisticValue) => {
      let entry = entries.get(key)
      if (!entry) {
        entry = {
          confirmedGeneration: 0,
          confirmedValue,
          pending: new Map()
        }
        entries.set(key, entry)
      }

      const generation = ++nextGeneration
      entry.pending.set(generation, optimisticValue)
      return { key, generation }
    },
    beginProjection: () => ++nextGeneration,
    project: (key, authoritativeValue, generation) => {
      const entry = entries.get(key)
      if (!entry) return authoritativeValue
      if (generation > entry.confirmedGeneration) {
        entry.confirmedGeneration = generation
        entry.confirmedValue = authoritativeValue
      }
      return projectedValue(entry)
    },
    succeed: (token, authoritativeValue) => finish(token, authoritativeValue),
    fail: (token) => finish(token)
  }
}
