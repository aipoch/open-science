import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  discoverDesktopBackend,
  desktopBackendPaths,
  DesktopRuntimeStoppingError
} from './desktop-runtime-launcher'
import { createDesktopPreviewProxy } from './desktop-preview-proxy'
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
function proof(
  root: string,
  owner: { generation: string; pid: number; desktop: { generation: string } }
): object {
  return {
    generation: owner.generation,
    pid: owner.pid,
    desktopGeneration: owner.desktop.generation,
    startupOptions: {
      configRoot: root,
      dataRoot: root,
      profilePath: root,
      port: 0,
      host: '127.0.0.1',
      credentialStore: 'os'
    }
  }
}
function legacyProof(owner: { generation: string; pid: number }): object {
  return { generation: owner.generation, pid: owner.pid }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-launch-'))
  directories.push(root)
  const owner = {
    schemaVersion: 1,
    generation: randomUUID(),
    pid: 123,
    host: 'node',
    port: 40000,
    desktop: {
      path: join(root, 'runtime.sock'),
      generation: randomUUID(),
      secret: 'a'.repeat(64),
      version: 'test'
    }
  }
  await writeFile(join(root, 'runtime-owner.json'), JSON.stringify(owner))
  await writeFile(join(root, 'web-token'), 'b'.repeat(43))
  const fetcher = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(proof(root, owner))))
  vi.stubGlobal('fetch', fetcher)
  return { root, owner, fetcher }
}
describe('desktop backend discovery', () => {
  it('rejects a same-version packaged runtime that lacks the required recovery command', async () => {
    const { root, owner, fetcher } = await fixture()
    fetcher.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            ...proof(root, owner),
            desktopCommands: ['projects:list']
          })
        )
    )
    await expect(
      discoverDesktopBackend(root, 'test', undefined, {
        requiredCommands: ['sessions:delete-recovery-file']
      })
    ).rejects.toMatchObject({ issue: { reason: 'runtime-incompatible', canStop: true } })
  })

  it.each([undefined, 'b'.repeat(64)])(
    'blocks a same-version stale development backend before installing its missing recovery command (%s)',
    async (backendBuildId) => {
      const { root, owner, fetcher } = await fixture()
      fetcher.mockImplementation(
        async () => new Response(JSON.stringify({ ...proof(root, owner), backendBuildId }))
      )
      await expect(
        discoverDesktopBackend(root, 'test', undefined, { buildId: 'a'.repeat(64) })
      ).rejects.toMatchObject({
        issue: { reason: 'runtime-incompatible', canStop: true, canRecover: false }
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it('authenticates the recorded generation before returning its private attachment', async () => {
    const { root, owner, fetcher } = await fixture()
    await expect(discoverDesktopBackend(root, 'test')).resolves.toEqual(owner.desktop)
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:40000/owner',
      expect.objectContaining({
        headers: {
          authorization: `Bearer ${'b'.repeat(43)}`,
          'x-open-science-runtime-generation': owner.generation
        },
        redirect: 'error'
      })
    )
  })
  it.each(['pid', 'generation'] as const)(
    'ignores stale %s evidence without deleting records',
    async (field) => {
      const { root, owner, fetcher } = await fixture()
      fetcher.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            generation: owner.generation,
            pid: owner.pid,
            [field]: field === 'pid' ? 999 : randomUUID()
          })
        )
      )
      await expect(discoverDesktopBackend(root, 'test')).resolves.toBeUndefined()
      await expect(discoverDesktopBackend(root, 'test')).resolves.toEqual(owner.desktop)
    }
  )
  it('reports a same-version service that predates startup options as a legacy service', async () => {
    const { root, owner, fetcher } = await fixture()
    fetcher.mockImplementation(
      async () => new Response(JSON.stringify({ generation: owner.generation, pid: owner.pid }))
    )
    await expect(discoverDesktopBackend(root, 'test')).rejects.toMatchObject({
      issue: { reason: 'legacy-service', canStop: true, canRecover: true }
    })
  })
  it('rejects an authenticated server version mismatch and a legacy Electron writer', async () => {
    const { root, owner, fetcher } = await fixture()
    await expect(discoverDesktopBackend(root, 'different')).rejects.toMatchObject({
      issue: { reason: 'version-mismatch', canStop: true }
    })
    await writeFile(
      join(root, 'runtime-owner.json'),
      JSON.stringify({ ...owner, host: 'electron', desktop: undefined })
    )
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ generation: owner.generation, pid: owner.pid }))
    )
    await expect(discoverDesktopBackend(root, 'test')).rejects.toMatchObject({
      issue: { reason: 'legacy-service', canStop: true, canRecover: true }
    })
  })
  it('force-stops a verified legacy service when graceful control is unavailable', async () => {
    const { root, owner, fetcher } = await fixture()
    owner.pid = process.pid
    await writeFile(join(root, 'runtime-owner.json'), JSON.stringify(owner))
    let alive = true
    const signals: string[] = []
    fetcher.mockImplementation(async () => new Response(JSON.stringify(legacyProof(owner))))
    const error = await discoverDesktopBackend(root, 'different', {
      selfPid: -1,
      inspect: async () => ({
        commandLine: '/r/node /r/backend/out/backend/index.cjs --desktop',
        parentPid: 1
      }),
      lockHeld: () => alive,
      isAlive: () => alive,
      signal: async (_pid, mode) => {
        signals.push(mode)
        if (mode === 'kill') alive = false
      },
      graceMs: 100,
      settleMs: 100
    }).catch((error) => error)
    fetcher.mockImplementation(async (url: string) =>
      url.endsWith('/owner')
        ? new Response(JSON.stringify(legacyProof(owner)))
        : new Response(null, { status: 404 })
    )
    await expect(error.stopAndContinue()).resolves.toBeUndefined()
    expect(signals).toEqual(['terminate', 'kill'])
  })
  it('does not signal when graceful control fails and identity cannot be proven', async () => {
    const { root, owner, fetcher } = await fixture()
    owner.pid = process.pid
    await writeFile(join(root, 'runtime-owner.json'), JSON.stringify(owner))
    const signals: string[] = []
    fetcher.mockImplementation(async () => new Response(JSON.stringify(legacyProof(owner))))
    const error = await discoverDesktopBackend(root, 'different', {
      selfPid: -1,
      inspect: async () => ({ commandLine: '/usr/bin/other', parentPid: 1 }),
      lockHeld: () => true,
      signal: async (_pid, mode) => void signals.push(mode)
    }).catch((error) => error)
    fetcher.mockImplementation(async (url: string) =>
      url.endsWith('/owner')
        ? new Response(JSON.stringify(legacyProof(owner)))
        : new Response(null, { status: 404 })
    )
    await expect(error.stopAndContinue()).rejects.toMatchObject({ code: 'identity-unproven' })
    expect(signals).toEqual([])
  })
  it('force-stops an Electron-hosted legacy app only after verifying its executable', async () => {
    const { root, owner, fetcher } = await fixture()
    owner.pid = process.pid
    await writeFile(
      join(root, 'runtime-owner.json'),
      JSON.stringify({ ...owner, host: 'electron', desktop: undefined })
    )
    fetcher.mockImplementation(async () => new Response(JSON.stringify(legacyProof(owner))))
    let alive = true
    const signals: string[] = []
    const error = await discoverDesktopBackend(root, 'test', {
      selfPid: -1,
      inspect: async () => ({
        commandLine: '/Applications/Open-Science.app/Contents/MacOS/Open-Science',
        parentPid: 1
      }),
      isAlive: () => alive,
      lockHeld: () => alive,
      signal: async (_pid, mode) => {
        signals.push(mode)
        if (mode === 'kill') alive = false
      },
      graceMs: 100,
      settleMs: 100
    }).catch((error) => error)
    await expect(error.stopAndContinue()).resolves.toBeUndefined()
    expect(signals).toEqual(['terminate', 'kill'])
  })
  it('does not stop a replacement owner after the confirmation was opened', async () => {
    const { root, owner, fetcher } = await fixture()
    owner.pid = process.pid
    await writeFile(join(root, 'runtime-owner.json'), JSON.stringify(owner))
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ generation: owner.generation, pid: owner.pid }))
    )
    const error = await discoverDesktopBackend(root, 'different').catch((error) => error)
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ generation: randomUUID(), pid: owner.pid }))
    )
    await expect(error.stopAndContinue()).rejects.toThrow('server changed')
    expect(fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true)
  })
  it('refuses to adopt a runtime that reports it is already stopping', async () => {
    const { root, owner, fetcher } = await fixture()
    fetcher.mockImplementation(
      async () => new Response(JSON.stringify({ ...proof(root, owner), stopping: true }))
    )
    await expect(discoverDesktopBackend(root, 'test')).rejects.toBeInstanceOf(
      DesktopRuntimeStoppingError
    )
  })
  it('locates the bundled ordinary Node without a PATH or Electron fallback', () => {
    const paths = desktopBackendPaths({
      applicationPath: join(tmpdir(), 'app'),
      resourcesPath: join(tmpdir(), 'resources'),
      packaged: true
    })
    expect(paths.command).toBe(
      join(
        tmpdir(),
        'resources',
        'node-runtime',
        process.platform === 'win32' ? 'node.exe' : 'node'
      )
    )
    expect(paths.entry).toBe(join(tmpdir(), 'resources', 'backend', 'out', 'backend', 'index.cjs'))
  })
})
describe('desktop preview proxy', () => {
  it('preserves range/CSP and streams through the fixed backend without exposing its token', async () => {
    const { root, fetcher } = await fixture()
    await writeFile(join(root, 'web-service.json'), JSON.stringify({ pid: 123, port: 40001 }))
    const proxy = await createDesktopPreviewProxy(root, 123)
    expect(proxy.port).toBe(40001)
    fetcher.mockResolvedValueOnce(
      new Response('data', {
        status: 206,
        headers: {
          'content-range': 'bytes 1-4/10',
          'content-security-policy': "default-src 'none'"
        }
      })
    )
    const response = await proxy.fetch(
      new Request('open-science-preview://resource/file', {
        headers: { range: 'bytes=1-4', cookie: 'untrusted', authorization: 'untrusted' }
      })
    )
    expect(await response.text()).toBe('data')
    expect(response.status).toBe(206)
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:40001/preview/resource/file')
    expect(init.headers.get('authorization')).toBe(`Bearer ${'b'.repeat(43)}`)
    expect(init.headers.get('cookie')).toBeNull()
    expect(response.headers.get('authorization')).toBeNull()
    proxy.dispose()
    await expect(proxy.fetch(new Request('open-science-preview://resource/file'))).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('rejects a replaced backend and non-preview schemes', async () => {
    const { root, fetcher } = await fixture()
    await writeFile(join(root, 'web-service.json'), JSON.stringify({ pid: 123, port: 40001 }))
    await expect(createDesktopPreviewProxy(root, 124)).rejects.toThrow()
    const proxy = await createDesktopPreviewProxy(root, 123)
    await expect(proxy.fetch(new Request('file:///private/secret'))).rejects.toThrow()
    await expect(
      proxy.fetch(new Request('open-science-preview://resource/file', { method: 'POST' }))
    ).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    proxy.dispose()
  })
})
