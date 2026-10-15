/** Keep Node alive until critical shutdown bookkeeping has actually settled. */
export async function withRuntimeShutdownLifetime<T>(shutdown: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 1_000)
  try {
    return await shutdown()
  } finally {
    clearInterval(keepAlive)
  }
}
