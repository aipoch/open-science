export class ReadDeadlineError extends Error {
  constructor() {
    super('The read did not complete before its deadline.')
    this.name = 'ReadDeadlineError'
  }
}

// This bounds a read's observer, not its underlying transport. Always observe late settlements,
// but never publish them through the expired promise. Callers still own generation invalidation.
export function readWithDeadline<T>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReadDeadlineError()), timeoutMs)
    try {
      read().then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}
