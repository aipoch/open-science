// Only exact private staging paths belong to cleanup; retry never repeats the transfer.
export class PackageCleanupPendingError<T = unknown> extends Error {
  constructor(
    readonly outcome: { value: T } | { error: unknown },
    readonly retryCleanup: () => Promise<void>,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : 'Session package cleanup failed.', { cause })
  }
}

export async function withPackageCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  const outcome = await Promise.resolve()
    .then(work)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
  try {
    await cleanup()
  } catch (error) {
    throw new PackageCleanupPendingError(outcome, cleanup, error)
  }
  if ('error' in outcome) throw outcome.error
  return outcome.value
}
