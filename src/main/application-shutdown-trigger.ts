export type ApplicationShutdownTrigger = 'quit' | 'update' | 'migration-relaunch' | 'system'

let requestedTrigger: ApplicationShutdownTrigger = 'quit'

// Records the reason for the next orderly app shutdown. The returned rollback is used when the API
// that was expected to initiate quitting throws synchronously and the current process stays alive.
export const markApplicationShutdownTrigger = (
  trigger: Exclude<ApplicationShutdownTrigger, 'quit'>
): (() => void) => {
  requestedTrigger = trigger
  return () => {
    if (requestedTrigger === trigger) requestedTrigger = 'quit'
  }
}

export const currentApplicationShutdownTrigger = (): ApplicationShutdownTrigger => requestedTrigger

export const clearApplicationShutdownTrigger = (): void => {
  requestedTrigger = 'quit'
}
