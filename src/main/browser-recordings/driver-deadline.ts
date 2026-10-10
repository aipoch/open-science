/** A blocked project renderer must never block recording stop, publication or execution cleanup. */
export async function recordingDeadline<T>(pending: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Browser recording renderer timed out.')),
          milliseconds
        )
        timer.unref()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
