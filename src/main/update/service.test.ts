import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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

describe('UpdateService.openInstaller', () => {
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

    const status = await service.openInstaller()

    expect(openPath).toHaveBeenCalledWith(target)
    expect(status.state).toBe('ready')
  })

  it('returns to available when the downloaded file is missing (e.g. the user deleted it)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'open-'))
    const target = join(dir, 'installer.dmg')
    const openPath = vi.fn(() => Promise.resolve(''))
    const service = await downloadedService(target, { openPath, fileExists: () => false })

    const status = await service.openInstaller()

    expect(openPath).not.toHaveBeenCalled()
    expect(status.state).toBe('available')
    expect(status.localPath).toBeUndefined()
  })
})
