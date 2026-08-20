// Fire-and-forget notification work must not create synchronous or asynchronous failures that
// escape into the app shell. Durable inbox state remains available for a later retry.
export const runNotificationTask = (task: () => Promise<unknown>): void => {
  try {
    void task().catch(() => undefined)
  } catch {
    // Some injected/test implementations can throw before returning a Promise.
  }
}
