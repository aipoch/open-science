import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile,
  execFileSync
}))

const uuid = '12345678-1234-4321-8123-123456789abc'
const platform = process.platform

describe('windows boot identity', () => {
  beforeEach(() => {
    vi.resetModules()
    execFile.mockReset()
    execFileSync.mockReset()
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }))

  const succeed = (): void => {
    execFile.mockImplementation((_f, _a, _o, cb) => cb(null, `${uuid}\r\n`, ''))
  }

  it('reads asynchronously once and serves later sync reads from the cache', async () => {
    succeed()
    const { prefetchSystemBootIdentity, systemBootIdentity } =
      await import('./system-boot-identity')

    await expect(prefetchSystemBootIdentity()).resolves.toBe(`windows-boot:${uuid}`)
    expect(systemBootIdentity()).toBe(`windows-boot:${uuid}`)
    await prefetchSystemBootIdentity()

    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('never runs powershell synchronously on the main thread when the cache is cold', async () => {
    const { systemBootIdentity } = await import('./system-boot-identity')
    const { UpdateLifecycleError } = await import('../shared/update')

    expect(() => systemBootIdentity()).toThrow(UpdateLifecycleError)
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('reports a failed read as an UpdateLifecycleError and retries later', async () => {
    execFile.mockImplementationOnce((_f, _a, _o, cb) => cb(new Error('timed out'), '', ''))
    const { prefetchSystemBootIdentity } = await import('./system-boot-identity')

    const { UpdateLifecycleError } = await import('../shared/update')
    const failure = await prefetchSystemBootIdentity().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(UpdateLifecycleError)
    expect((failure as Error).message).toContain('boot identity')

    succeed()
    await expect(prefetchSystemBootIdentity()).resolves.toBe(`windows-boot:${uuid}`)
  })
})
