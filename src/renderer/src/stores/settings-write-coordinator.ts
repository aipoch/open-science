export type SettingsWriteKey =
  | 'activeProvider'
  | 'agentFramework'
  | 'reasoningEffort'
  | 'reviewerModel'
  | 'sessionDetailsModel'
  | 'subagentModel'
  | 'visionModel'
  | 'notifications'
  | 'notificationContent'
  | 'conversationSkillImport'
  | 'closePreference'
  | 'defaultPermissionProfile'
  | 'appIcon'
  | 'projectFilesFilter'

export type OptimisticSettingsWriteKey =
  | 'reasoningEffort'
  | 'sessionDetailsModel'
  | 'notifications'
  | 'notificationContent'
  | 'conversationSkillImport'
  | 'closePreference'
  | 'defaultPermissionProfile'
  | 'appIcon'
  | 'projectFilesFilter'

type SettingsWriteToken = {
  key: SettingsWriteKey
  generation: number
  failuresAtStart: ReadonlyMap<SettingsWriteKey, number>
}

type SettingsWriteFailure = {
  id: number
  message: string
}

type OptimisticSettingsWriteState<T> = {
  confirmedValue: T
  pendingCount: number
}

export type SettingsWrite = {
  isCurrent: () => boolean
  succeed: () => void
  fail: (message: string) => void
}

export type OptimisticSettingsWrite<T> = SettingsWrite & {
  run: <Result>(write: () => Promise<Result>) => Promise<Result>
  complete: (confirmedValue?: { value: T }) => T
}

export type SettingsWriteCoordinator = {
  begin: (key: SettingsWriteKey) => SettingsWrite
  beginOptimistic: <T>(
    key: OptimisticSettingsWriteKey,
    confirmedValue: T
  ) => OptimisticSettingsWrite<T>
  acceptCommitted: (key: OptimisticSettingsWriteKey, value: unknown) => void
  hasPending: (key: OptimisticSettingsWriteKey) => boolean
  clearFailures: () => void
}

// Owns the process-local ordering, staleness and failure state for one Settings Store instance.
// Callers retain their existing command-specific settlement policy: only preference commands use
// beginOptimistic and its confirmed-value rollback; Connector commands remain outside this owner.
export const createSettingsWriteCoordinator = (
  onVisibleError: (error: string | undefined) => void
): SettingsWriteCoordinator => {
  const generations = new Map<SettingsWriteKey, number>()
  const failures = new Map<SettingsWriteKey, SettingsWriteFailure>()
  const queues = new Map<OptimisticSettingsWriteKey, Promise<unknown>>()
  const optimisticStates = new Map<
    OptimisticSettingsWriteKey,
    OptimisticSettingsWriteState<unknown>
  >()
  let failureId = 0

  const currentError = (): string | undefined => {
    const messages = [...failures.values()]
      .sort((left, right) => left.id - right.id)
      .map((failure) => failure.message)

    return messages.length > 0 ? messages.join(' ') : undefined
  }

  const isCurrent = (token: SettingsWriteToken): boolean =>
    generations.get(token.key) === token.generation

  const settle = (token: SettingsWriteToken, error?: string): void => {
    if (!isCurrent(token)) return

    if (error) {
      failureId += 1
      failures.set(token.key, { id: failureId, message: error })
    } else {
      for (const [failureKey, failureAtStart] of token.failuresAtStart) {
        if (failures.get(failureKey)?.id === failureAtStart) failures.delete(failureKey)
      }
    }

    onVisibleError(currentError())
  }

  const begin = (key: SettingsWriteKey): SettingsWrite => {
    const generation = (generations.get(key) ?? 0) + 1
    generations.set(key, generation)
    const token: SettingsWriteToken = {
      key,
      generation,
      failuresAtStart: new Map(
        [...failures].map(([failureKey, failure]) => [failureKey, failure.id])
      )
    }

    return {
      isCurrent: () => isCurrent(token),
      succeed: () => settle(token),
      fail: (message) => settle(token, message)
    }
  }

  const runQueued = async <T>(
    key: OptimisticSettingsWriteKey,
    write: () => Promise<T>
  ): Promise<T> => {
    const previous = queues.get(key)
    const current = previous ? previous.catch(() => undefined).then(write) : write()
    queues.set(key, current)

    try {
      return await current
    } finally {
      if (queues.get(key) === current) queues.delete(key)
    }
  }

  const completeOptimistic = <T>(
    key: OptimisticSettingsWriteKey,
    state: OptimisticSettingsWriteState<T>,
    confirmedValue?: { value: T }
  ): T => {
    if (confirmedValue) state.confirmedValue = confirmedValue.value
    state.pendingCount -= 1

    if (state.pendingCount === 0 && optimisticStates.get(key) === state) {
      optimisticStates.delete(key)
    }

    return state.confirmedValue
  }

  return {
    begin,
    beginOptimistic: <T>(
      key: OptimisticSettingsWriteKey,
      confirmedValue: T
    ): OptimisticSettingsWrite<T> => {
      let state = optimisticStates.get(key) as OptimisticSettingsWriteState<T> | undefined

      if (!state) {
        state = { confirmedValue, pendingCount: 0 }
        optimisticStates.set(key, state as OptimisticSettingsWriteState<unknown>)
      }
      state.pendingCount += 1

      return {
        ...begin(key),
        run: (write) => runQueued(key, write),
        complete: (value) => completeOptimistic(key, state, value)
      }
    },
    acceptCommitted: (key, value) => {
      const state = optimisticStates.get(key)
      if (state) state.confirmedValue = value
    },
    hasPending: (key) => (optimisticStates.get(key)?.pendingCount ?? 0) > 0,
    clearFailures: () => {
      failures.clear()
      onVisibleError(undefined)
    }
  }
}
