import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverDesktopBackend, desktopBackendPaths } from './desktop-runtime-launcher'
import { createDesktopPreviewProxy } from './desktop-preview-proxy'
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
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
    .mockResolvedValue(
      new Response(JSON.stringify({ generation: owner.generation, pid: owner.pid }))
    )
  vi.stubGlobal('fetch', fetcher)
  return { root, owner, fetcher }
}
describe('desktop backend discovery', () => {
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
  it('rejects an authenticated server version mismatch and a legacy Electron writer', async () => {
    const { root, owner, fetcher } = await fixture()
    await expect(discoverDesktopBackend(root, 'different')).rejects.toThrow('different version')
    await writeFile(
      join(root, 'runtime-owner.json'),
      JSON.stringify({ ...owner, host: 'electron', desktop: undefined })
    )
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ generation: owner.generation, pid: owner.pid }))
    )
    await expect(discoverDesktopBackend(root, 'test')).rejects.toThrow('older desktop runtime')
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
