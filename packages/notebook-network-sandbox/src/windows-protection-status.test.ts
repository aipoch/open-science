import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const helper = vi.hoisted(() => ({
  port: 0,
  statusCalls: 0,
  gatewayProbeExitCode: 0 as number | null,
  outsideProbeExitCode: 33 as number | null,
  fenceInstalled: true,
  hold: undefined as Promise<void> | undefined
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  access: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn((_path: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    queueMicrotask(async () => {
      if (args[0] === 'status') {
        helper.statusCalls++
        child.stdout.write(
          JSON.stringify({
            profileExists: true,
            loopbackAllowed: true,
            networkFenceReady: helper.fenceInstalled,
            owned: true,
            ownershipState: 'owned',
            gatewayPort: helper.port
          })
        )
        child.emit('close', 0)
      } else {
        const spec = JSON.parse(Buffer.from(args[3]!, 'base64url').toString()) as {
          arguments: string[]
        }
        const gatewayProbe = spec.arguments.at(-1)!.includes(`127.0.0.1', ${helper.port})`)
        if (!gatewayProbe) await helper.hold
        child.emit(
          'close',
          gatewayProbe ? helper.gatewayProbeExitCode : helper.outsideProbeExitCode
        )
      }
    })
    return child
  })
}))

import { checkWindowsAppContainer } from '../runtime/src/platform/windows-appcontainer.js'
import { NotebookNetworkSandbox } from './index.js'

const servers: Server[] = []
const listen = async (port: number): Promise<Server> => {
  const server = createServer()
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}
const close = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()))
afterEach(async () => {
  helper.hold = undefined
  helper.statusCalls = 0
  helper.gatewayProbeExitCode = 0
  helper.outsideProbeExitCode = 33
  helper.fenceInstalled = true
  await Promise.all(servers.splice(0).map(close))
})

it('shares an in-flight fence probe and rechecks actual port occupancy after it finishes', async () => {
  const allocation = await listen(0)
  helper.port = (allocation.address() as { port: number }).port
  await close(allocation)
  let release!: () => void
  helper.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const checks = Array.from({ length: 4 }, () =>
    checkWindowsAppContainer('fixture-host', 'fixture-installation', 'fixture-receipt')
  )
  try {
    await expect.poll(() => helper.statusCalls).toBeGreaterThan(0)
    release()
    expect(await Promise.all(checks)).toEqual(
      Array.from({ length: 4 }, () => ({ warnings: [], errors: [] }))
    )
    expect(helper.statusCalls).toBe(1)
    const occupied = await listen(helper.port)
    expect(
      (await checkWindowsAppContainer('fixture-host', 'fixture-installation', 'fixture-receipt'))
        .errors
    ).toEqual([`Notebook AppContainer gateway port ${helper.port} is unavailable`])
    await close(occupied)
    expect(
      await checkWindowsAppContainer('fixture-host', 'fixture-installation', 'fixture-receipt')
    ).toEqual({ warnings: [], errors: [] })
    expect(helper.statusCalls).toBe(3)
  } finally {
    release()
    await Promise.allSettled(checks)
  }
})

it.each([1, 33, 34, null])(
  'reports a failed gateway probe (%s) as a check error, not missing installation',
  async (exitCode) => {
    const allocation = await listen(0)
    helper.port = (allocation.address() as { port: number }).port
    await close(allocation)
    // Native status confirms installation; the allowed-port probe fails independently.
    helper.gatewayProbeExitCode = exitCode
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: process.cwd() }
    })
    const result = await sandbox.status('win32')
    expect(result.kind).toBe('error')
    expect(JSON.stringify(result)).not.toContain('network fence is not installed')
    helper.gatewayProbeExitCode = 0
    await expect(sandbox.status('win32')).resolves.toMatchObject({ kind: 'ready' })
  }
)

it.each([0, 1, null])(
  'does not accept an inconclusive outside-port probe (%s)',
  async (exitCode) => {
    const allocation = await listen(0)
    helper.port = (allocation.address() as { port: number }).port
    await close(allocation)
    helper.outsideProbeExitCode = exitCode
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: process.cwd() }
    })
    await expect(sandbox.status('win32')).resolves.toMatchObject({ kind: 'error' })
  }
)

it('still requests setup when native status confirms that the fence is missing', async () => {
  const allocation = await listen(0)
  helper.port = (allocation.address() as { port: number }).port
  await close(allocation)
  helper.fenceInstalled = false
  const sandbox = new NotebookNetworkSandbox({
    policy: { allowedDomains: [], deniedDomains: [] },
    resources: { root: process.cwd() }
  })
  await expect(sandbox.status('win32')).resolves.toMatchObject({
    kind: 'setupRequired',
    reasons: ['Notebook AppContainer loopback network fence is not installed']
  })
})

it.each([false, true])(
  'preserves check errors after initialization (initial probe fails: %s)',
  async (initialProbeFails) => {
    const allocation = await listen(0)
    helper.port = (allocation.address() as { port: number }).port
    await close(allocation)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const sandbox = new NotebookNetworkSandbox({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: process.cwd() }
    })
    try {
      if (initialProbeFails) helper.gatewayProbeExitCode = 1
      await sandbox.initialize()
      helper.gatewayProbeExitCode = 1
      await expect(sandbox.status()).resolves.toMatchObject({ kind: 'error' })
      helper.gatewayProbeExitCode = 0
      await expect(sandbox.status()).resolves.toMatchObject({ kind: 'ready' })
      helper.fenceInstalled = false
      await expect(sandbox.status()).resolves.toMatchObject({ kind: 'setupRequired' })
    } finally {
      await sandbox.dispose()
      Object.defineProperty(process, 'platform', platform)
    }
  }
)
