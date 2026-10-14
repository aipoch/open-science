import { afterEach, expect, it, vi } from 'vitest'
import { verifyDesktopRecoveryReadiness } from './desktop-recovery-readiness'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
const config = {
  configRoot: '/isolated/config',
  dataRoot: '/isolated/data',
  profilePath: '/isolated/profile',
  host: '127.0.0.1' as const,
  port: 0,
  credentialStore: 'os' as const
}
afterEach(() => vi.useRealTimers())
it.each(['storage:get-status', 'sessions:list', 'projects:list'])(
  'bounds hung %s within the total readiness deadline',
  async (hung) => {
    vi.useFakeTimers()
    const client = {
      startupState: () => ({ phase: 'ready' }),
      runtimeInfo: () => ({ startupOptions: config }),
      invokeHost: (name: string) =>
        name === hung
          ? new Promise(() => undefined)
          : Promise.resolve(
              name === 'storage:get-status'
                ? { dataRoot: config.dataRoot, dataRootMissing: false }
                : []
            )
    } as unknown as DesktopRuntimeClient
    const result = verifyDesktopRecoveryReadiness(client, config, 1000).catch((error) => error)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await result).toMatchObject({ message: expect.stringContaining('timed out') })
  }
)

it('includes an unanswered startup retry in the same total deadline', async () => {
  vi.useFakeTimers()
  const client = { retryStartup: () => new Promise(() => {}) } as unknown as DesktopRuntimeClient
  const result = verifyDesktopRecoveryReadiness(client, config, 1000, true).catch((error) => error)
  await vi.advanceTimersByTimeAsync(1001)
  expect(await result).toMatchObject({ message: expect.stringContaining('timed out') })
})

it('waits through migration and starting before reading original data', async () => {
  vi.useFakeTimers()
  let phase = 'migrating'
  const invokeHost = vi.fn(async (name: string) =>
    name === 'storage:get-status' ? { dataRoot: config.dataRoot, dataRootMissing: false } : []
  )
  const client = {
    startupState: () => ({ phase }),
    runtimeInfo: () => ({ startupOptions: config }),
    invokeHost
  } as unknown as DesktopRuntimeClient
  const result = verifyDesktopRecoveryReadiness(client, config, 1000)
  await vi.advanceTimersByTimeAsync(100)
  expect(invokeHost).not.toHaveBeenCalled()
  phase = 'starting'
  await vi.advanceTimersByTimeAsync(100)
  expect(invokeHost).not.toHaveBeenCalled()
  phase = 'ready'
  await vi.advanceTimersByTimeAsync(100)
  await expect(result).resolves.toBeUndefined()
  expect(invokeHost.mock.calls.map(([name]) => name)).toEqual([
    'storage:get-status',
    'sessions:list',
    'projects:list'
  ])
})

it.each(['blocked', 'starting'])('refuses %s without reading original data', async (phase) => {
  vi.useFakeTimers()
  const invokeHost = vi.fn()
  const client = { startupState: () => ({ phase }), invokeHost } as unknown as DesktopRuntimeClient
  const result = verifyDesktopRecoveryReadiness(client, config, 1000).catch((error) => error)
  if (phase === 'starting') await vi.advanceTimersByTimeAsync(1001)
  expect(await result).toMatchObject({
    message: expect.stringContaining(phase === 'blocked' ? 'not ready' : 'timed out')
  })
  expect(invokeHost).not.toHaveBeenCalled()
})
