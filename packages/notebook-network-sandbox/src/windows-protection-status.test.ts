import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const helper = vi.hoisted(() => ({
  port: 0,
  statusCalls: 0,
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
            networkFenceReady: true,
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
        child.emit('close', gatewayProbe ? 0 : 33)
      }
    })
    return child
  })
}))

import { checkWindowsAppContainer } from '../runtime/src/platform/windows-appcontainer.js'

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
