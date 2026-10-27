import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/isolated-fixture' } }))
const f = vi.hoisted(() => ({
  enabled: false,
  writes: 0,
  compensation: undefined as Promise<void> | undefined,
  published: undefined as (() => void) | undefined
}))
vi.mock('@aipoch/durable-files', async (original) => {
  const actual = await original<typeof import('@aipoch/durable-files')>()
  return {
    ...actual,
    writeDurableJsonFile: async (...args: Parameters<typeof actual.writeDurableJsonFile>) => {
      const write = f.enabled ? ++f.writes : 0
      if (write === 2) await f.compensation
      await actual.writeDurableJsonFile(...args)
      if (write === 1) {
        f.published?.()
        throw new Error('directory sync failed after rename')
      }
    }
  }
})

it('never accepts App B after stop publication even when old authorization completes after compensation', async () => {
  const lifetimeModule = await import('./local-service-lifetime')
  const { createLocalServiceLifetime, readServiceLifetime } = lifetimeModule
  const { startDesktopRuntimeTransport } = await import('./desktop-runtime-transport')
  const { connectDesktopRuntime } = await import('./desktop-runtime-client')
  const { ApplicationEventHub } = await import('./application-events')
  const termination = await import('./verified-service-stop')
  const stopConfirmation = await import('./runtime-stop-confirmation')
  const birthModule = await import('./process-birth-identity')
  const realTerminate = termination.terminateVerifiedService
  const configRoot = await mkdtemp(join(tmpdir(), 'published-stop-intent-'))
  const compensation = Promise.withResolvers<void>()
  const published = Promise.withResolvers<void>()
  const force = Promise.withResolvers<void>()
  f.compensation = compensation.promise
  f.published = published.resolve
  const generation = randomUUID()
  const lifetime = await createLocalServiceLifetime({
    configRoot,
    generation,
    explicitStart: false,
    stop: vi.fn(),
    report: vi.fn()
  })
  const server = await startDesktopRuntimeTransport({
    version: 'test',
    generation,
    lifetime,
    startupOptions: {
      configRoot,
      dataRoot: configRoot,
      profilePath: configRoot,
      port: 0,
      host: '127.0.0.1',
      credentialStore: 'os'
    },
    commands: { commandNames: () => [], invoke: vi.fn() },
    events: new ApplicationEventHub()
  })
  const authorizedTermination = vi.fn()
  const proof = vi
    .spyOn(termination, 'terminateVerifiedService')
    .mockImplementation(async (target) => {
      const intent = await readServiceLifetime(target.configRoot)
      if (intent?.generation === target.generation && intent.stopping) authorizedTermination()
      throw new Error('fixture never signals processes')
    })
  const waiting = vi
    .spyOn(stopConfirmation, 'waitForRuntimeStopped')
    .mockImplementation(async () => {
      await force.promise
      throw new stopConfirmation.RuntimeStopError('runtime-stop-timeout', {
        processExited: false,
        lockHeld: false,
        exitRecord: 'unchecked'
      })
    })
  const attach = (): ReturnType<typeof connectDesktopRuntime> =>
    connectDesktopRuntime({
      endpoint: server.endpoint,
      desktopInstanceId: randomUUID(),
      onEvent: () => {},
      onDisconnect: () => {}
    })
  const a = await attach()
  let releaseOldRead: (() => void) | undefined
  try {
    f.enabled = true
    const exiting = a.quit({ deadlineAt: Date.now() + 4000 })
    await published.promise
    await vi.waitFor(async () =>
      expect(await readServiceLifetime(configRoot)).toMatchObject({ stopping: true })
    )
    await expect(attach()).rejects.toThrow()
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce())
    const captured = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    releaseOldRead = release.resolve
    const reader = vi
      .spyOn(lifetimeModule, 'readServiceLifetime')
      .mockImplementationOnce(async (root) => {
        const oldIntent = await readServiceLifetime(root)
        captured.resolve()
        await release.promise
        return oldIntent
      })
    const birth = vi.spyOn(birthModule, 'processBirthIdentity').mockReturnValue('fixture-birth')
    const alive = vi.spyOn(stopConfirmation, 'isRuntimeProcessAlive').mockReturnValue(true)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const delayedTermination = realTerminate({
      configRoot,
      generation,
      pid: 987654,
      birthToken: 'fixture-birth'
    })
    const denied = expect(delayedTermination).rejects.toThrow('intent changed')
    await captured.promise
    compensation.resolve()
    await vi.waitFor(async () =>
      expect(await readServiceLifetime(configRoot)).toMatchObject({ stopping: false })
    )
    await expect(attach()).rejects.toThrow()
    expect(() => lifetime.connect('b', 'socket-b')).toThrow('stopping')
    await expect(lifetime.start()).rejects.toThrow('stopping')
    release.resolve()
    await denied
    expect(kill).not.toHaveBeenCalled()
    reader.mockRestore()
    birth.mockRestore()
    alive.mockRestore()
    kill.mockRestore()
    force.resolve()
    await exiting
    expect(proof).toHaveBeenCalledOnce()
    expect(authorizedTermination).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(lifetime.snapshot()).toMatchObject({ apps: 0, stopping: true }))
  } finally {
    compensation.resolve()
    force.resolve()
    releaseOldRead?.()
    f.enabled = false
    a.close()
    lifetime.close()
    await server.close()
    proof.mockRestore()
    waiting.mockRestore()
    vi.restoreAllMocks()
    await rm(configRoot, { recursive: true, force: true })
  }
})
