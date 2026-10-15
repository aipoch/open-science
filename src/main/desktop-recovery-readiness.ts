import type { DesktopRuntimeClient } from './desktop-runtime-client'
import type { RuntimeStartupOptions } from './desktop-runtime-info'
import type { StorageStatus } from '../shared/storage'

/** Proves the replacement serves the reviewed profile and can read its work before success. */
export async function verifyDesktopRecoveryReadiness(
  client: DesktopRuntimeClient,
  config: RuntimeStartupOptions,
  timeoutMs = 60_000,
  retryStartup = false
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const operation = async (): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    if (retryStartup) await client.retryStartup()
    while (['checking', 'migrating', 'starting'].includes(client.startupState().phase)) {
      if (Date.now() >= deadline)
        throw new Error('The recovered service or original data readiness check timed out.')
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())))
    }
    if (client.startupState().phase !== 'ready')
      throw new Error('The recovered service is not ready.')
    const actual = client.runtimeInfo().startupOptions
    if (JSON.stringify(actual) !== JSON.stringify(config))
      throw new Error(
        'The recovered service configuration differs from the confirmed configuration.'
      )
    const storage = (await client.invokeHost('storage:get-status')) as StorageStatus
    if (storage.dataRoot !== config.dataRoot || storage.dataRootMissing)
      throw new Error('The original data folder is not readable after recovery.')
    await Promise.all([client.invokeHost('sessions:list'), client.invokeHost('projects:list')])
  }
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('The recovered service or original data readiness check timed out.')),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
