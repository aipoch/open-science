type OptimisticBooleanToken = Readonly<{
  key: string
  generation: number
}>

type OptimisticBooleanEntry = {
  confirmedGeneration: number
  confirmedValue: boolean
  nextGeneration: number
  pending: Map<number, boolean>
}

type OptimisticBooleanCoordinator = {
  begin: (key: string, confirmedValue: boolean, optimisticValue: boolean) => OptimisticBooleanToken
  project: (key: string, authoritativeValue: boolean) => boolean
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
// A field retains its last confirmed value while requests overlap, so rejected older writes cannot
// overwrite newer intent and a run of rejected writes returns to the original confirmed value.
export const createOptimisticBooleanCoordinator = (): OptimisticBooleanCoordinator => {
  const entries = new Map<string, OptimisticBooleanEntry>()

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
          nextGeneration: 0,
          pending: new Map()
        }
        entries.set(key, entry)
      }

      const generation = ++entry.nextGeneration
      entry.pending.set(generation, optimisticValue)
      return { key, generation }
    },
    project: (key, authoritativeValue) => {
      const entry = entries.get(key)
      if (!entry) return authoritativeValue
      entry.confirmedValue = authoritativeValue
      return projectedValue(entry)
    },
    succeed: (token, authoritativeValue) => finish(token, authoritativeValue),
    fail: (token) => finish(token)
  }
}
