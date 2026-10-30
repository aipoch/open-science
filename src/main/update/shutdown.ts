// One budget covers renderer saves, backend teardown and the verified Runtime stop. Reserve the
// final portion for the existing service owner to terminate and confirm its retained process object.
export const UPDATE_CLOSE_BUDGET_MS = 20_000
export const UPDATE_STOP_RESERVE_MS = 3_500
export const UPDATE_FORCE_RESERVE_MS = 1_500

export type UpdateShutdownStep<T> =
  { outcome: 'completed'; value: T } | { outcome: 'failed' | 'timeout' }

export function updateShutdownDeadline(requested?: number): number {
  return Math.min(
    typeof requested === 'number' && Number.isFinite(requested) ? requested : Infinity,
    Date.now() + UPDATE_CLOSE_BUDGET_MS
  )
}

/** A save/normal-close failure is evidence, not permission to skip the subsequent verified stop. */
export async function attemptUpdateShutdownStep<T>(
  run: () => Promise<T>,
  deadlineAt: number
): Promise<UpdateShutdownStep<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = Promise.resolve()
      .then(run)
      .then(
        (value): UpdateShutdownStep<T> => ({ outcome: 'completed', value }),
        (): UpdateShutdownStep<T> => ({ outcome: 'failed' })
      )
    return await Promise.race([
      work,
      new Promise<UpdateShutdownStep<T>>((resolve) => {
        timer = setTimeout(
          () => resolve({ outcome: 'timeout' }),
          Math.max(0, deadlineAt - Date.now())
        )
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
