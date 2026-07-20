import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UpdateManifest } from '../../shared/update'
import { UpdateService } from './service'

const manifest: UpdateManifest = {
  version: '0.3.0',
  releaseDate: '',
  notes: 'release notes',
  downloads: { 'mac-arm64': { url: 'https://cdn/x-mac-arm64.dmg', size: 5, sha256: 'h' } }
}

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response

describe('UpdateService.check', () => {
  it('reports available with the platform download when newer', async () => {
    const broadcast = vi.fn()
    const service = new UpdateService({
      fetchImpl: (() => Promise.resolve(jsonResponse(manifest))) as unknown as typeof fetch,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      broadcast
    })

    const status = await service.check()
    expect(status.state).toBe('available')
    expect(status.latest).toBe('0.3.0')
    expect(status.notes).toBe('release notes')
    expect(status.download?.url).toContain('mac-arm64')
    expect(broadcast).toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'checking' })
    )
    expect(broadcast).toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'available' })
    )
  })

  it('reports up-to-date when current >= latest', async () => {
    const service = new UpdateService({
      fetchImpl: (() => Promise.resolve(jsonResponse(manifest))) as unknown as typeof fetch,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.3.0',
      broadcast: vi.fn()
    })
    expect((await service.check()).state).toBe('up-to-date')
  })

  it('reports error when the fetch fails', async () => {
    const service = new UpdateService({
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    const status = await service.check()
    expect(status.state).toBe('error')
    expect(status.error).toBe('offline')
  })

  it('stamps applyKind "installer" on every emitted status', async () => {
    const service = new UpdateService({
      fetchImpl: (() => Promise.resolve(jsonResponse(manifest))) as unknown as typeof fetch,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    const status = await service.check()
    expect(status.applyKind).toBe('installer')
  })
})

describe('UpdateService.download', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  const downloadManifest = (size: number, sha256: string): UpdateManifest => ({
    version: '0.3.0',
    releaseDate: '',
    notes: '',
    downloads: {
      'mac-arm64': { url: 'https://statics.aipoch.com/releases/0.3.0/installer.dmg', size, sha256 }
    }
  })

  it('downloads to the path from promptSavePath, verifies, and reports ready', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    // Serve the manifest for the version.json URL and the installer body otherwise.
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target)
    })

    await service.check()
    const status = await service.download()

    expect(status.state).toBe('ready')
    expect(status.localPath).toBe(target)
    expect(existsSync(target)).toBe(true)
  })

  it('stays available and does not fetch the installer when the save dialog is canceled', async () => {
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const fetchMock = vi.fn((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(new Response(body, { status: 200 }))
    )
    const service = new UpdateService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(null)
    })

    await service.check()
    fetchMock.mockClear()
    const status = await service.download()

    expect(status.state).toBe('available')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancel aborts an in-flight download, resets to available, and leaves no partial file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const manifestForCheck = downloadManifest(100, 'irrelevant')
    let onInstallerFetch: (() => void) | undefined
    const fetched = new Promise<void>((resolve) => (onInstallerFetch = resolve))
    // The installer body hangs (one chunk, no end) and errors on abort, mimicking a real fetch.
    const fetchImpl = ((input: unknown, init?: { signal?: AbortSignal }) => {
      if (String(input).endsWith('version.json')) {
        return Promise.resolve(jsonResponse(manifestForCheck))
      }
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The user aborted a request.', 'AbortError'))
          )
        }
      })
      onInstallerFetch?.()
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as unknown as typeof fetch
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target)
    })

    await service.check()
    const downloading = service.download()
    await fetched
    const cancelled = await service.cancel()
    expect(cancelled.state).toBe('available')

    const final = await downloading
    expect(final.state).toBe('available')
    expect(final.error).toBeUndefined()
    expect(existsSync(target)).toBe(false)
  })

  it('ignores a second download() while one is already in flight', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const manifestForCheck = downloadManifest(100, 'irrelevant')
    let installerFetches = 0
    let onInstallerFetch: (() => void) | undefined
    const fetched = new Promise<void>((resolve) => (onInstallerFetch = resolve))
    const fetchImpl = ((input: unknown, init?: { signal?: AbortSignal }) => {
      if (String(input).endsWith('version.json')) {
        return Promise.resolve(jsonResponse(manifestForCheck))
      }
      installerFetches += 1
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The user aborted a request.', 'AbortError'))
          )
        }
      })
      onInstallerFetch?.()
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as unknown as typeof fetch
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target)
    })

    await service.check()
    const first = service.download()
    await fetched
    const second = await service.download()
    expect(second.state).toBe('downloading')
    expect(installerFetches).toBe(1)

    await service.cancel()
    await first
  })

  it('a retry to the SAME path waits for the cancelled download to fully settle before starting', async () => {
    // Same target for both attempts: the cancelled download's deferred rm(targetPath) would delete the
    // retry's freshly written installer unless the retry first drains that download's cleanup. Proven
    // deterministically by holding the first download open and asserting the retry starts NO second
    // fetch until it is released — a naive retry fetches immediately and later loses its file to the rm.
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    let installerFetches = 0
    let onFirstFetch: (() => void) | undefined
    let errorFirstStream: (() => void) | undefined
    const firstFetched = new Promise<void>((resolve) => (onFirstFetch = resolve))
    const fetchImpl = ((input: unknown) => {
      if (String(input).endsWith('version.json')) {
        return Promise.resolve(jsonResponse(manifestForCheck))
      }
      installerFetches += 1
      if (installerFetches === 1) {
        // Hangs after one chunk until we explicitly error it, so the first download (and its rm) only
        // completes when the test decides — the drain point the retry must respect.
        const hanging = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]))
            errorFirstStream = () =>
              controller.error(new DOMException('The user aborted a request.', 'AbortError'))
          }
        })
        onFirstFetch?.()
        return Promise.resolve(new Response(hanging, { status: 200 }))
      }
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as unknown as typeof fetch
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target)
    })

    await service.check()
    const first = service.download()
    await firstFetched
    const cancelled = await service.cancel()
    expect(cancelled.state).toBe('available')

    // Kick off the retry while the cancelled download is still settling.
    const retry = service.download()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The retry must be draining the cancelled download, not racing it: no second fetch yet.
    expect(installerFetches).toBe(1)

    // Release the first download so it errors and runs its rm cleanup; only now may the retry proceed.
    errorFirstStream?.()
    const status = await retry
    expect(status.state).toBe('ready')
    expect(installerFetches).toBe(2)
    // The retry's file, written after the cancelled download's rm, must survive.
    expect(existsSync(target)).toBe(true)
    expect(await readFile(target)).toEqual(body)

    const firstFinal = await first
    expect(firstFinal.error).toBeUndefined()
  })

  it('rejects a download whose URL host differs from the manifest host, without fetching', async () => {
    const offHostManifest: UpdateManifest = {
      version: '0.3.0',
      releaseDate: '',
      notes: '',
      downloads: {
        'mac-arm64': { url: 'https://evil.example/x-mac-arm64.dmg', size: 5, sha256: 'h' }
      }
    }
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(offHostManifest)))
    const promptSavePath = vi.fn(() => Promise.resolve('/tmp/should-not-be-used'))
    const service = new UpdateService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://cdn.trusted.example/manifest.json',
      broadcast: vi.fn(),
      promptSavePath
    })

    await service.check()
    fetchMock.mockClear()

    const status = await service.download()

    expect(status.state).toBe('error')
    expect(status.error).toBe('Untrusted download host')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(promptSavePath).not.toHaveBeenCalled()
  })
})

describe('UpdateService.apply', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  // Drives a service to the 'ready' state (checked + downloaded to `target`), with injected shell hooks.
  const downloadedService = async (
    target: string,
    overrides: { openPath?: () => Promise<string>; fileExists?: (path: string) => boolean }
  ): Promise<UpdateService> => {
    const body = Buffer.from('installer-bytes')
    const manifestForCheck: UpdateManifest = {
      version: '0.3.0',
      releaseDate: '',
      notes: '',
      downloads: {
        'mac-arm64': {
          url: 'https://statics.aipoch.com/releases/0.3.0/installer.dmg',
          size: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex')
        }
      }
    }
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target),
      ...overrides
    })
    await service.check()
    await service.download()
    return service
  }

  it('opens the installer when the downloaded file exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'open-'))
    const target = join(dir, 'installer.dmg')
    const openPath = vi.fn(() => Promise.resolve(''))
    const service = await downloadedService(target, { openPath })

    const status = await service.apply()

    expect(openPath).toHaveBeenCalledWith(target)
    expect(status.state).toBe('ready')
  })

  it('returns to available when the downloaded file is missing (e.g. the user deleted it)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'open-'))
    const target = join(dir, 'installer.dmg')
    const openPath = vi.fn(() => Promise.resolve(''))
    const service = await downloadedService(target, { openPath, fileExists: () => false })

    const status = await service.apply()

    expect(openPath).not.toHaveBeenCalled()
    expect(status.state).toBe('available')
    expect(status.localPath).toBeUndefined()
  })
})
