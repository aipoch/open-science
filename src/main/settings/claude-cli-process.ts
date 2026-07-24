import { spawn, type SpawnOptions } from 'node:child_process'

// Launches a resolved Claude CLI path on every supported installation shape. Windows npm shims are
// resolved to cli.js/cli.mjs by the caller; Electron must run those entries in Node mode.
export const spawnClaudeCli = (
  resolvedPath: string,
  args: string[],
  options: SpawnOptions
): ReturnType<typeof spawn> => {
  if (/\.(js|mjs)$/i.test(resolvedPath)) {
    const env = { ...(options.env as NodeJS.ProcessEnv), ELECTRON_RUN_AS_NODE: '1' }
    return spawn(process.execPath, [resolvedPath, ...args], { ...options, env })
  }

  return spawn(resolvedPath, args, options)
}

const abortError = (signal: AbortSignal): Error => {
  const error = new Error(String(signal.reason ?? 'aborted'))
  error.name = 'AbortError'
  return error
}

// Races a subprocess-backed operation against its AbortSignal and removes the listener when either
// side settles, so repeated status checks do not retain listeners on completed controllers.
export const waitForAbortableOperation = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal
): Promise<Value> => {
  if (signal.aborted) throw abortError(signal)

  let rejectOnAbort: ((reason?: unknown) => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = reject
  })
  const onAbort = (): void => rejectOnAbort?.(abortError(signal))

  signal.addEventListener('abort', onAbort, { once: true })

  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
