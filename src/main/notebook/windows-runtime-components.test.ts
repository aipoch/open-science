import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WindowsRuntimeComponentStore,
  WindowsRuntimeIncompatibleError,
  verifyWindowsRuntimeComponent,
  type WindowsRuntimeComponentRelease,
  type WindowsRuntimeComponentDependencies
} from './windows-runtime-components'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const archive = 'fixture archive'
const binary = 'fixture executable'
const release = (source: 'official' | 'patched' = 'patched'): WindowsRuntimeComponentRelease => ({
  component: 'node',
  version: '1.2.3',
  architecture: 'x64',
  source,
  archive: {
    url: 'https://statics.aipoch.com/open-science/notebook-runtime/fixture/component.tar.zst',
    sha256: hash(archive),
    size: Buffer.byteLength(archive)
  },
  files: { 'node.exe': hash(binary) }
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'component-store-'))
  roots.push(root)
  const download = vi.fn(async (_release, path) => {
    await writeFile(path, archive)
  })
  const extract = vi.fn(async (_path, destination) => {
    await writeFile(join(destination, 'node.exe'), binary)
  })
  const probe = vi.fn<WindowsRuntimeComponentDependencies['probe']>().mockResolvedValue(undefined)
  const store = new WindowsRuntimeComponentStore(join(root, 'cache'), { download, extract, probe })
  const request = {
    component: 'node' as const,
    architecture: 'x64',
    officialRoots: [] as string[],
    allowDownload: true
  }
  return { root, download, extract, probe, store, request }
}

describe('Windows runtime component preparation', () => {
  it('restores existing standard-mode dependencies after checking bytes without a protected probe', async () => {
    const f = await fixture()
    const selected = await f.store.select([release()], f.request)
    f.probe.mockClear()
    expect(
      await f.store.select([release()], {
        ...f.request,
        allowDownload: false,
        verifyCompatibility: false
      })
    ).toEqual(selected)
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.download).toHaveBeenCalledOnce()
    await writeFile(selected.executable, 'modified')
    await expect(
      f.store.select([release()], {
        ...f.request,
        allowDownload: false,
        verifyCompatibility: false
      })
    ).rejects.toThrow('not ready')
  })
  it('cleans an interrupted download without promoting or probing it', async () => {
    const f = await fixture()
    const controller = new AbortController()
    f.download.mockImplementation(async (_release, path) => {
      await writeFile(path, archive)
      controller.abort()
    })
    await expect(
      f.store.select([release()], { ...f.request, signal: controller.signal })
    ).rejects.toThrow()
    expect(f.extract).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
    await expect(
      f.store.select([release()], { ...f.request, allowDownload: false })
    ).rejects.toThrow('not ready')
  })

  it('falls back from an incompatible official runtime only after its cleanup was confirmed', async () => {
    const f = await fixture()
    const official = join(f.root, 'official')
    await mkdir(official)
    await writeFile(join(official, 'node.exe'), binary)
    f.probe.mockRejectedValueOnce(new WindowsRuntimeIncompatibleError('provider failed'))
    const result = await f.store.select([release('official'), release()], {
      ...f.request,
      officialRoots: [official]
    })
    expect(result.root).not.toBe(official)
    expect(f.download).toHaveBeenCalledOnce()
  })
  it('does not download or execute anything when an offline selection is missing', async () => {
    const f = await fixture()
    await expect(
      f.store.select([release()], { ...f.request, allowDownload: false })
    ).rejects.toThrow('not ready')
    expect(f.download).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
  })

  it('prefers a verified official installation over downloading a patched component', async () => {
    const f = await fixture()
    const official = join(f.root, 'official')
    await mkdir(official)
    await writeFile(join(official, 'node.exe'), binary)
    const result = await f.store.select([release(), release('official')], {
      ...f.request,
      officialRoots: [official]
    })
    expect(result.root).toBe(official)
    expect(result.release.source).toBe('official')
    expect(f.download).not.toHaveBeenCalled()
    expect(f.probe).toHaveBeenCalledOnce()
  })

  it('rejects a modified official installation before any executable probe and downloads the pinned component', async () => {
    const f = await fixture()
    const official = join(f.root, 'official')
    await mkdir(official)
    await writeFile(join(official, 'node.exe'), 'different bytes')
    const result = await f.store.select([release(), release('official')], {
      ...f.request,
      officialRoots: [official]
    })
    expect(result.root).not.toBe(official)
    expect(f.probe).toHaveBeenCalledOnce()
    expect(f.probe.mock.calls[0]?.[0]).toEqual(result)
    expect(f.download).toHaveBeenCalledOnce()
  })

  it('reuses the verified cache across store instances without another download', async () => {
    const f = await fixture()
    const first = await f.store.select([release()], f.request)
    const secondStore = new WindowsRuntimeComponentStore(join(f.root, 'cache'), f)
    const second = await secondStore.select([release()], { ...f.request, allowDownload: false })
    expect(second).toEqual(first)
    expect(f.download).toHaveBeenCalledOnce()
    expect(f.probe).toHaveBeenCalledTimes(2)
  })

  it('does not return an installed component whose AppContainer probe fails', async () => {
    const f = await fixture()
    f.probe.mockRejectedValue(new Error('contained probe failed'))
    await expect(f.store.select([release()], f.request)).rejects.toThrow('contained probe failed')
    await expect(
      f.store.select([release()], { ...f.request, allowDownload: false })
    ).rejects.toThrow('contained probe failed')
    // A transient host/probe failure does not damage the verified bytes. A later setup retries
    // compatibility at the same final path without deleting or downloading the component again.
    f.probe.mockResolvedValue(undefined)
    const recovered = await f.store.select([release()], f.request)
    expect(await readFile(recovered.executable, 'utf8')).toBe(binary)
    expect(f.download).toHaveBeenCalledOnce()
    expect(f.probe).toHaveBeenCalledTimes(3)
  })

  it('rejects a corrupt archive before extraction or execution', async () => {
    const f = await fixture()
    f.download.mockImplementation(async (_release, path) => {
      await writeFile(path, 'bad archive')
    })
    await expect(f.store.select([release()], f.request)).rejects.toThrow('archive integrity')
    expect(f.extract).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
  })

  it('does not erase an existing corrupt cache entry', async () => {
    const f = await fixture()
    const selected = await f.store.select([release()], f.request)
    await writeFile(selected.executable, 'changed')
    await expect(f.store.select([release()], f.request)).rejects.toThrow('requires repair')
    expect(await readFile(selected.executable, 'utf8')).toBe('changed')
    expect(f.download).toHaveBeenCalledOnce()
  })

  it('rejects extra loadable files in a local runtime before its probe', async () => {
    const f = await fixture()
    const selected = await f.store.select([release()], f.request)
    await writeFile(join(selected.root, 'unexpected.dll'), 'untrusted')
    await expect(verifyWindowsRuntimeComponent(release(), selected.root)).rejects.toThrow(
      'integrity'
    )
  })

  it('joins concurrent downloads for the same component', async () => {
    const f = await fixture()
    const results = await Promise.all([
      f.store.select([release()], f.request),
      f.store.select([release()], f.request)
    ])
    expect(results[0]).toEqual(results[1])
    expect(f.download).toHaveBeenCalledOnce()
  })

  it('does not turn cancellation into an automatic fallback download', async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      f.store.select([release()], { ...f.request, signal: controller.signal })
    ).rejects.toThrow()
    expect(f.download).not.toHaveBeenCalled()
  })
})
