import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeViewAccess, RuntimeViewScope } from '../shared/runtime-view'
import { ManagedRuntimeViews } from './managed-runtime-views'
import type { ManagedServiceRegistration } from './notebook/managed-execution-service'
import { RuntimeViewOwner } from './runtime-view/owner'

const roots: string[] = [],
  servers: Server[] = [],
  bridges: ManagedRuntimeViews[] = []
const scope: RuntimeViewScope = {
  projectId: 'project',
  sessionId: 'session',
  runId: 'bridge-run',
  environmentId: 'environment',
  generationId: 'generation-1'
}
const parents = ['http://viewer.localhost:1234']
const proofPath = '/__open_science_proof_0123456789abcdef0123456789abcdef'
afterEach(async () => {
  bridges.splice(0).forEach((bridge) => bridge.close())
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(listen = true): Promise<{
  bridge: ManagedRuntimeViews
  owner: RuntimeViewOwner
  controller: AbortController
  server: Server
  bind(): Promise<void>
  registration: ManagedServiceRegistration
  unregister(): void
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'os-service-bridge-run-')))
  roots.push(root)
  await chmod(root, 0o700)
  const socketPath = join(root, 'service.sock')
  const proof = randomBytes(32).toString('hex')
  const controller = new AbortController()
  const owner = new RuntimeViewOwner()
  const bridge = new ManagedRuntimeViews(owner)
  bridges.push(bridge)
  const server = createServer((req, res) => res.end(req.url === proofPath ? proof : 'project'))
  servers.push(server)
  const bind = async (): Promise<void> => {
    server.listen(socketPath)
    await once(server, 'listening')
  }
  if (listen) await bind()
  const registration = {
    scope: { ...scope },
    declaration: { title: 'Project' },
    socketPath,
    proof: { path: proofPath, value: proof },
    logicalPort: 4173,
    signal: controller.signal
  }
  const unregister = bridge.register(registration)
  return { bridge, owner, controller, server, bind, registration, unregister }
}

describe('the managed Run to project-view bridge', () => {
  it('can retry opening the same admitted generation when startup has not bound the socket yet', async () => {
    const f = await fixture(false)
    await expect(f.bridge.open(scope, 'viewer', parents)).rejects.toThrow()
    await f.bind()
    const access = await f.bridge.open(scope, 'viewer', parents)
    expect(access.view.scope).toEqual(scope)
    expect(access.view.state).toBe('ready')
    expect(f.controller.signal.aborted).toBe(false)
  })

  it('pins each viewer to its Run scope before and after opening', async () => {
    const f = await fixture()
    const entered = deferred<RuntimeViewAccess>(),
      release = deferred<void>()
    const open = f.owner.open.bind(f.owner)
    vi.spyOn(f.owner, 'open').mockImplementationOnce(async (options) => {
      const access = await open(options)
      entered.resolve(access)
      await release.promise
      return access
    })
    const pending = f.bridge.open(scope, 'viewer', parents)
    await entered.promise
    const rejected = expect(
      f.bridge.open({ ...scope, sessionId: 'other' }, 'viewer', parents)
    ).rejects.toThrow('another execution')
    release.resolve()
    await pending
    await rejected
    await expect(
      f.bridge.open({ ...scope, projectId: 'other' }, 'viewer', parents)
    ).rejects.toThrow('another execution')
  })

  it('revokes a late open after its viewer closes without aborting the Run', async () => {
    const f = await fixture()
    const entered = deferred<RuntimeViewAccess>(),
      release = deferred<void>()
    const open = f.owner.open.bind(f.owner)
    vi.spyOn(f.owner, 'open').mockImplementationOnce(async (options) => {
      const access = await open(options)
      entered.resolve(access)
      await release.promise
      return access
    })
    const pending = f.bridge.open(scope, 'viewer', parents)
    const rejection = expect(pending).rejects.toThrow('closed')
    const late = await entered.promise
    f.bridge.closeViewer('viewer')
    release.resolve()
    await rejection
    expect(f.owner.list(scope).find((view) => view.viewId === late.view.viewId)?.state).toBe(
      'closed'
    )
    expect(f.controller.signal.aborted).toBe(false)
  })

  it('does not let a closed pending open overwrite or revoke a replacement viewer', async () => {
    const f = await fixture()
    const entered = deferred<void>(),
      release = deferred<void>()
    const open = f.owner.open.bind(f.owner)
    vi.spyOn(f.owner, 'open').mockImplementationOnce(async (options) => {
      const access = await open(options)
      entered.resolve()
      await release.promise
      return access
    })
    const old = f.bridge.open(scope, 'viewer', parents)
    const rejection = expect(old).rejects.toThrow('closed')
    await entered.promise
    f.bridge.closeViewer('viewer')
    const replacement = await f.bridge.open(scope, 'viewer', parents)
    release.resolve()
    await rejection
    expect((await f.bridge.open(scope, 'viewer', parents)).view.viewId).toBe(
      replacement.view.viewId
    )
    expect(f.owner.list(scope).filter((view) => view.state === 'ready')).toHaveLength(1)
  })

  it.each(['abort', 'unregister'] as const)(
    'revokes a ready view when the Run ends through %s',
    async (method) => {
      const f = await fixture()
      const access = await f.bridge.open(scope, 'viewer', parents)
      if (method === 'abort') f.controller.abort()
      else f.unregister()
      expect(f.owner.list(scope).find((view) => view.viewId === access.view.viewId)?.state).toBe(
        'closed'
      )
      await expect(f.bridge.open(scope, 'viewer', parents)).rejects.toThrow()
      await expect(f.bridge.open(scope, 'new-viewer', parents)).rejects.toThrow()
    }
  )

  it('rejects a late result after Run revocation', async () => {
    const f = await fixture()
    const entered = deferred<void>(),
      release = deferred<void>()
    const open = f.owner.open.bind(f.owner)
    vi.spyOn(f.owner, 'open').mockImplementationOnce(async (options) => {
      const access = await open(options)
      entered.resolve()
      await release.promise
      return access
    })
    const pending = f.bridge.open(scope, 'viewer', parents)
    const rejection = expect(pending).rejects.toThrow()
    await entered.promise
    f.unregister()
    release.resolve()
    await rejection
    expect(f.owner.list(scope).every((view) => view.state === 'closed')).toBe(true)
  })

  it('does not silently reconnect an existing viewer to a replacement Run generation', async () => {
    const f = await fixture()
    await f.bridge.open(scope, 'viewer', parents)
    f.unregister()
    f.bridge.register({ ...f.registration, scope: { ...scope, generationId: 'generation-2' } })
    await expect(f.bridge.open(scope, 'viewer', parents)).rejects.toThrow()
    const fresh = await f.bridge.open(scope, 'new-viewer', parents)
    expect(fresh.view.scope.generationId).toBe('generation-2')
  })

  it('keeps a failed startup viewer pinned to its original generation', async () => {
    const f = await fixture(false)
    await expect(f.bridge.open(scope, 'viewer', parents)).rejects.toThrow()
    f.unregister()
    f.bridge.register({ ...f.registration, scope: { ...scope, generationId: 'generation-2' } })
    await f.bind()
    await expect(f.bridge.open(scope, 'viewer', parents)).rejects.toThrow()
    expect((await f.bridge.open(scope, 'new-viewer', parents)).view.scope.generationId).toBe(
      'generation-2'
    )
  })
})
