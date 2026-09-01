import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UpdateManifest } from '../../shared/update'
import type { Logger } from '../logger'
import { UpdateService } from './service'

const VALID_SHA256 = 'a'.repeat(64)
const manifest: UpdateManifest = {
  version: '0.3.0',
  releaseDate: '',
  notes: 'release notes',
  localizedNotes: { 'zh-Hans': '发行说明' },
  downloads: {
    'mac-arm64': { url: 'https://cdn/x-mac-arm64.dmg', size: 5, sha256: VALID_SHA256 }
  }
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

const responseAt = (url: string, body: BodyInit | null, init: ResponseInit = {}): Response => {
  const response = new Response(body, init)
  Object.defineProperty(response, 'url', { value: url })
  return response
}

const installerResponse = (body: BodyInit | null, init: ResponseInit = {}): Response =>
  responseAt('https://statics.aipoch.com/releases/0.3.0/installer.dmg', body, init)

const createLogSpy = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})

const diagnosticRecords = (log: Logger): Record<string, unknown>[] =>
  (['debug', 'info', 'warn', 'error'] as const).flatMap((level) =>
    vi.mocked(log[level]).mock.calls.map(([, data]) => data as Record<string, unknown>)
  )

describe('UpdateService.check', () => {
  it('records a completed manifest check without manifest payloads', async () => {
    const log = createLogSpy()
    const service = new UpdateService({
      fetchImpl: (() => Promise.resolve(jsonResponse(manifest))) as unknown as typeof fetch,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://diagnostic-secret.example/version.json?token=secret',
      broadcast: vi.fn(),
      log
    })

    await service.check()

    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-check',
          outcome: 'completed',
          result: 'available'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('diagnostic-secret')
    expect(JSON.stringify(records)).not.toContain('release notes')
  })

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
    expect(status.localizedNotes).toEqual({ 'zh-Hans': '发行说明' })
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

  it('records a failed manifest check without the provider error message', async () => {
    const log = createLogSpy()
    const service = new UpdateService({
      fetchImpl: (() =>
        Promise.reject(new Error('raw provider diagnostic secret'))) as unknown as typeof fetch,
      currentVersion: '0.2.0',
      broadcast: vi.fn(),
      log
    })

    const status = await service.check()

    expect(status.error).toBe('raw provider diagnostic secret')
    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-check',
          outcome: 'failed',
          phase: 'fetch-manifest',
          errorCategory: 'error'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('raw provider diagnostic secret')
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

  it('stamps totalBytes on the available status from the manifest download size', async () => {
    const service = new UpdateService({
      fetchImpl: (() => Promise.resolve(jsonResponse(manifest))) as unknown as typeof fetch,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })
    const status = await service.check()
    expect(status.state).toBe('available')
    expect(status.totalBytes).toBe(5)
  })

  it('coalesces overlapping manifest checks onto the in-flight fetch', async () => {
    let releaseCheck: (() => void) | undefined
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    let fetches = 0
    const fetchImpl = (async () => {
      fetches += 1
      await checkGate
      return jsonResponse(manifest)
    }) as unknown as typeof fetch
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      broadcast: vi.fn()
    })

    const first = service.check()
    const second = service.check()
    expect(fetches).toBe(1)
    releaseCheck?.()
    const [left, right] = await Promise.all([first, second])
    expect(left).toBe(right)
    expect(left.state).toBe('available')
    expect(fetches).toBe(1)
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
        : Promise.resolve(installerResponse(body))) as unknown as typeof fetch
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

  it('does not download an installer again after the lifecycle is ready', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-ready-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    let installerFetches = 0
    const fetchImpl = ((input: unknown) => {
      if (String(input).endsWith('version.json')) {
        return Promise.resolve(jsonResponse(manifestForCheck))
      }
      installerFetches += 1
      return Promise.resolve(installerResponse(body))
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
    const ready = await service.download()
    const repeated = await service.download()

    expect(ready.state).toBe('ready')
    expect(repeated).toBe(ready)
    expect(installerFetches).toBe(1)
  })

  it('waits for an in-flight check before starting a download', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-wait-check-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    let releaseCheck: (() => void) | undefined
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    let installerFetches = 0
    const fetchImpl = (async (input: unknown) => {
      if (String(input).endsWith('version.json')) {
        await checkGate
        return jsonResponse(manifestForCheck)
      }
      installerFetches += 1
      return installerResponse(body)
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

    const checking = service.check()
    expect(service.getStatus().state).toBe('checking')
    const downloading = service.download()
    expect(installerFetches).toBe(0)
    releaseCheck?.()
    expect((await checking).state).toBe('available')
    expect((await downloading).state).toBe('ready')
    expect(installerFetches).toBe(1)
  })

  it('uses the deterministic download path without opening a save dialog when non-interactive', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-headless-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(installerResponse(body))) as unknown as typeof fetch
    const promptSavePath = vi.fn().mockResolvedValue(join(dir, 'wrong-path.dmg'))
    const defaultDownloadPath = vi.fn(() => target)
    const removeFile = vi.fn((path: string) => rm(path, { force: true }))
    const broadcast = vi.fn()
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast,
      promptSavePath,
      defaultDownloadPath,
      removeFile
    })

    await service.check()
    const status = await service.download({ nonInteractive: true })

    expect(status).toMatchObject({ state: 'ready', localPath: target })
    expect(defaultDownloadPath).toHaveBeenCalledWith('installer.dmg')
    expect(promptSavePath).not.toHaveBeenCalled()
    expect(removeFile).toHaveBeenNthCalledWith(1, target)
    expect(removeFile).toHaveBeenNthCalledWith(2, `${target}.part`)
    expect(removeFile).toHaveBeenNthCalledWith(3, `${target}.part.meta`)
    expect(broadcast).toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({
        state: 'downloading',
        progress: 100,
        downloadedBytes: body.byteLength,
        totalBytes: body.byteLength
      })
    )
  })

  it('preserves a completed download when a check is requested during the transfer', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    let manifestFetches = 0
    let resolveLateCheck: ((response: Response) => void) | undefined
    const lateCheck = new Promise<Response>((resolve) => {
      resolveLateCheck = resolve
    })
    let releaseInstaller: (() => void) | undefined
    const installerGate = new Promise<void>((resolve) => {
      releaseInstaller = resolve
    })
    let markInstallerStarted: (() => void) | undefined
    const installerStarted = new Promise<void>((resolve) => {
      markInstallerStarted = resolve
    })
    const fetchImpl = (async (input: unknown) => {
      if (String(input).endsWith('version.json')) {
        manifestFetches += 1
        return manifestFetches === 1 ? jsonResponse(manifestForCheck) : lateCheck
      }
      markInstallerStarted?.()
      await installerGate
      return installerResponse(body)
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
    await installerStarted
    const checking = service.check()
    releaseInstaller?.()
    await downloading
    resolveLateCheck?.(jsonResponse(manifestForCheck))
    await checking

    const readyStatus = service.getStatus()
    expect(await service.check()).toBe(readyStatus)

    expect(manifestFetches).toBe(2)
    expect(service.getStatus()).toEqual(
      expect.objectContaining({ state: 'ready', localPath: target, progress: 100 })
    )
  })

  it('preserves ready on check failure but accepts a strictly newer manifest', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const checksum = createHash('sha256').update(body).digest('hex')
    let manifestForCheck = downloadManifest(body.byteLength, checksum)
    let checkFailure: Error | undefined
    const fetchImpl = ((input: unknown) => {
      if (String(input).endsWith('version.json')) {
        return checkFailure
          ? Promise.reject(checkFailure)
          : Promise.resolve(jsonResponse(manifestForCheck))
      }
      return Promise.resolve(installerResponse(body))
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
    await service.download()
    const readyStatus = service.getStatus()

    checkFailure = new Error('offline')
    expect(await service.check()).toBe(readyStatus)

    checkFailure = undefined
    manifestForCheck = {
      ...downloadManifest(body.byteLength, checksum),
      version: '0.4.0',
      downloads: {
        'mac-arm64': {
          url: 'https://statics.aipoch.com/releases/0.4.0/installer.dmg',
          size: body.byteLength,
          sha256: checksum
        }
      }
    }
    const newerStatus = await service.check()
    expect(newerStatus).toEqual(expect.objectContaining({ state: 'available', latest: '0.4.0' }))
    expect(newerStatus.localPath).toBeUndefined()
  })

  it('records a completed installer download without its URL or local path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'diagnostic-private-'))
    const target = join(dir, 'private-installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(installerResponse(body))) as unknown as typeof fetch
    const log = createLogSpy()
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target),
      log
    })
    await service.check()
    vi.mocked(log.info).mockClear()

    await service.download()

    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'completed',
          result: 'ready'
        })
      ])
    )
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain('private-installer.dmg')
    expect(serialized).not.toContain('statics.aipoch.com')
  })

  it('drops a prior-session <target>.part on the first download so a restart starts fresh', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    // A leftover fragment from a previous app session at the same Save location.
    const partPath = `${target}.part`
    const metadataPath = `${partPath}.meta`
    await writeFile(partPath, Buffer.from('stale-fragment-from-last-session'))
    await writeFile(metadataPath, Buffer.from('stale-validator-sidecar'))
    const body = Buffer.from('fresh-installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(installerResponse(body))) as unknown as typeof fetch
    const removeFile = vi.fn((path: string) => rm(path, { force: true }))
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target),
      removeFile
    })

    await service.check()
    const status = await service.download()

    // The stale .part was removed before the download, and the result is the fresh body (a full
    // fetch, not a Range-resumed stale fragment that would fail the manifest checksum).
    expect(removeFile).toHaveBeenCalledWith(partPath)
    expect(removeFile).toHaveBeenCalledWith(metadataPath)
    expect(status.state).toBe('ready')
    expect(await readFile(target)).toEqual(body)
    expect(existsSync(partPath)).toBe(false)
    expect(existsSync(metadataPath)).toBe(false)
  })

  it('removes resumable artifacts only on the first download to a path this session', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(installerResponse(body))) as unknown as typeof fetch
    const removeFile = vi.fn(() => Promise.resolve())
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target),
      removeFile
    })

    await service.check()
    await service.download()
    await service.download() // same path, same session

    // Only the first download resets the .part and sidecar; the second leaves both to the core.
    expect(removeFile).toHaveBeenCalledTimes(2)
  })

  it('does not start the fetch and errors when the first .part cleanup fails', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const manifestForCheck = downloadManifest(11, VALID_SHA256)
    let installerFetches = 0
    const fetchImpl = ((input: unknown) => {
      if (String(input).endsWith('version.json'))
        return Promise.resolve(jsonResponse(manifestForCheck))
      installerFetches += 1
      return Promise.resolve(installerResponse(Buffer.from('installer-bytes')))
    }) as unknown as typeof fetch
    const removeFile = vi.fn(() => Promise.reject(new Error('EACCES: cannot delete .part')))
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target),
      removeFile
    })

    await service.check()
    const status = await service.download()

    // A failed cleanup surfaces as an error and the installer fetch never starts — we never resume a
    // fragment we could not delete.
    expect(status.state).toBe('error')
    expect(installerFetches).toBe(0)
  })

  it('re-attempts the .part cleanup on a retry after the first cleanup failed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(installerResponse(body))) as unknown as typeof fetch
    // Fail the first cleanup, succeed on the retry.
    const removeFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('EACCES: cannot delete .part'))
      .mockResolvedValueOnce(undefined)
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target),
      removeFile
    })

    await service.check()
    const first = await service.download()
    expect(first.state).toBe('error')
    const retry = await service.download()

    // The path was NOT marked fresh after the failure, so the retry cleans both artifacts and succeeds.
    expect(removeFile).toHaveBeenCalledTimes(3)
    expect(retry.state).toBe('ready')
    expect(retry.error).toBeUndefined()
  })

  it('resumes via a Range request on a same-session retry after a cancel', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-body-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const rangeHeaders: (string | null)[] = []
    let installerFetches = 0
    const fetchImpl = ((input: unknown, init?: { signal?: AbortSignal; headers?: HeadersInit }) => {
      if (String(input).endsWith('version.json'))
        return Promise.resolve(jsonResponse(manifestForCheck))
      installerFetches += 1
      rangeHeaders.push(new Headers(init?.headers).get('range'))
      if (installerFetches === 1) {
        // First attempt: emit two bytes, then hang until the user abort errors the stream — leaving a
        // flushed two-byte .part on disk to resume from.
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(body.subarray(0, 2))
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError'))
            )
          }
        })
        return Promise.resolve(
          installerResponse(stream, { status: 200, headers: { etag: '"installer-v1"' } })
        )
      }
      // Retry: serve the remaining bytes as a 206 partial-content response.
      return Promise.resolve(
        installerResponse(body.subarray(2), {
          status: 206,
          headers: {
            etag: '"installer-v1"',
            'content-range': `bytes 2-${body.byteLength - 1}/${body.byteLength}`
          }
        })
      )
    }) as unknown as typeof fetch
    // Cancel only once the core reports ≥2 bytes transferred — the write callback resolves after the
    // bytes hit the .part, so this guarantees a non-empty .part to resume from (avoids racing the abort
    // against the first chunk write).
    let onTwoBytes: (() => void) | undefined
    const twoBytes = new Promise<void>((resolve) => (onTwoBytes = resolve))
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn((_channel: string, payload: unknown) => {
        const transferred = (payload as { transferred?: number } | undefined)?.transferred
        if (typeof transferred === 'number' && transferred >= 2) onTwoBytes?.()
      }),
      promptSavePath: () => Promise.resolve(target)
    })

    await service.check()
    const downloading = service.download()
    await twoBytes
    await service.cancel()
    await downloading

    const retry = await service.download()

    // The cancel left a two-byte .part; the SAME-session retry did not re-clean it (freshTargets still
    // holds the path) and resumed from byte 2 via a Range header, completing the download.
    expect(rangeHeaders[0]).toBeNull()
    expect(rangeHeaders[1]).toBe('bytes=2-')
    expect(retry.state).toBe('ready')
    expect(await readFile(target)).toEqual(body)
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
        : Promise.resolve(installerResponse(body))
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

  it('records a failed installer download without the shell error message', async () => {
    const manifestForCheck = downloadManifest(100, VALID_SHA256)
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(manifestForCheck))) as unknown as typeof fetch
    const log = createLogSpy()
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.reject(new Error('private shell diagnostic detail')),
      log
    })
    await service.check()
    vi.mocked(log.info).mockClear()

    const status = await service.download()

    expect(status.error).toBe('private shell diagnostic detail')
    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'failed',
          phase: 'select-target',
          errorCategory: 'error'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('private shell diagnostic detail')
  })

  it('records manifest URL validation failure without the invalid URL', async () => {
    const manifestForCheck = downloadManifest(100, VALID_SHA256)
    const log = createLogSpy()
    const service = new UpdateService({
      fetchImpl: (() => Promise.resolve(jsonResponse(manifestForCheck))) as unknown as typeof fetch,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'not-a-url-private-diagnostic-detail',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve('/unused'),
      log
    })
    await service.check()
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.mocked(log[level]).mockClear()
    }

    await expect(service.download()).rejects.toThrow()

    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'failed',
          phase: 'validate-source',
          errorCategory: 'system'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('not-a-url-private-diagnostic-detail')
  })

  it('cancel aborts an in-flight download, resets to available, and leaves no partial file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const manifestForCheck = downloadManifest(100, VALID_SHA256)
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
      return Promise.resolve(installerResponse(body))
    }) as unknown as typeof fetch
    const log = createLogSpy()
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      promptSavePath: () => Promise.resolve(target),
      log
    })

    await service.check()
    vi.mocked(log.info).mockClear()
    const downloading = service.download()
    await fetched
    await vi.waitFor(() => {
      expect(service.getStatus()).toMatchObject({
        state: 'downloading',
        downloadedBytes: 3,
        totalBytes: 100
      })
    })
    const cancelled = await service.cancel()
    expect(cancelled.state).toBe('available')
    expect(cancelled).not.toHaveProperty('progress')
    expect(cancelled).not.toHaveProperty('downloadedBytes')
    expect(cancelled).not.toHaveProperty('downloadProgress')
    expect(cancelled.totalBytes).toBe(100)

    const final = await downloading
    expect(final.state).toBe('available')
    expect(final.error).toBeUndefined()
    expect(existsSync(target)).toBe(false)
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-download',
          outcome: 'cancelled',
          reason: 'user'
        })
      ])
    )
  })

  it('ignores a second download() while one is already in flight', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const manifestForCheck = downloadManifest(100, VALID_SHA256)
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
      return Promise.resolve(installerResponse(body))
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
        return Promise.resolve(installerResponse(hanging))
      }
      return Promise.resolve(installerResponse(body))
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

  it('a cancel while a retry is still draining aborts it — no hidden download starts', async () => {
    // Reproduces issue #216's core symptom for the retry path: cancel first, retry (which drains the
    // cancelled download), then cancel again during that drain. A no-op cancel here would let the retry
    // start a hidden download after the dialog closed.
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const manifestForCheck = downloadManifest(100, VALID_SHA256)
    let installerFetches = 0
    let onFirstFetch: (() => void) | undefined
    let errorFirstStream: (() => void) | undefined
    const firstFetched = new Promise<void>((resolve) => (onFirstFetch = resolve))
    const fetchImpl = ((input: unknown) => {
      if (String(input).endsWith('version.json')) {
        return Promise.resolve(jsonResponse(manifestForCheck))
      }
      installerFetches += 1
      const hanging = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          errorFirstStream = () =>
            controller.error(new DOMException('The user aborted a request.', 'AbortError'))
        }
      })
      onFirstFetch?.()
      return Promise.resolve(installerResponse(hanging))
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
    expect((await service.cancel()).state).toBe('available')

    // Retry drains the cancelled download; cancel it again while it is still draining.
    const retry = service.download()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await service.cancel()).state).toBe('available')

    // Let the first download settle so the retry's drain unblocks.
    errorFirstStream?.()
    const status = await retry
    expect(status.state).toBe('available')
    // The retry must NOT have started a second (hidden) download.
    expect(installerFetches).toBe(1)

    await first
  })

  it('recovers on a later download() after the save dialog throws (no poisoned lifecycle)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(installerResponse(body))) as unknown as typeof fetch
    let saveCall = 0
    const service = new UpdateService({
      fetchImpl,
      platform: 'darwin',
      arch: 'arm64',
      currentVersion: '0.2.0',
      manifestUrl: 'https://statics.aipoch.com/version.json',
      broadcast: vi.fn(),
      // First prompt throws (e.g. a dialog failure); the second succeeds.
      promptSavePath: () =>
        saveCall++ === 0 ? Promise.reject(new Error('dialog failed')) : Promise.resolve(target)
    })

    await service.check()
    const failed = await service.download()
    expect(failed.state).toBe('error')
    expect(failed.error).toBe('dialog failed')

    // A poisoned lifecycle would rethrow 'dialog failed' here and never reopen the dialog.
    const retry = await service.download()
    expect(retry.state).toBe('ready')
    expect(retry.localPath).toBe(target)
    expect(retry.error).toBeUndefined()
    expect(existsSync(target)).toBe(true)
  })

  it('rejects a download whose URL host differs from the manifest host, without fetching', async () => {
    const offHostManifest: UpdateManifest = {
      version: '0.3.0',
      releaseDate: '',
      notes: '',
      downloads: {
        'mac-arm64': {
          url: 'https://evil.example/x-mac-arm64.dmg',
          size: 5,
          sha256: VALID_SHA256
        }
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

  it('rejects an HTTP download URL even when its host matches the HTTPS manifest', async () => {
    const downgradedManifest: UpdateManifest = {
      version: '0.3.0',
      releaseDate: '',
      notes: '',
      downloads: {
        'mac-arm64': {
          url: 'http://cdn.trusted.example/x-mac-arm64.dmg',
          size: 5,
          sha256: 'a'.repeat(64)
        }
      }
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(downgradedManifest))
      .mockResolvedValue(installerResponse(null, { status: 404 }))
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
    expect(fetchMock).not.toHaveBeenCalled()
    expect(promptSavePath).not.toHaveBeenCalled()
  })

  it('rejects a followed redirect whose final response leaves the trusted origin', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-origin-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(
            responseAt('https://redirect-target.example/installer.dmg', body, { status: 200 })
          )) as unknown as typeof fetch
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

    expect(status.state).toBe('error')
    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${target}.part`)).toBe(false)
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
    overrides: {
      fetchImpl?: typeof fetch
      openPath?: () => Promise<string>
      fileExists?: (path: string) => boolean
      log?: Logger
    }
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
        : Promise.resolve(installerResponse(body))) as unknown as typeof fetch
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

  it('admits only one installer open while apply is in flight', async () => {
    dir = await mkdtemp(join(tmpdir(), 'open-once-'))
    const target = join(dir, 'installer.dmg')
    let resolveOpen!: (error: string) => void
    const openPath = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOpen = resolve
        })
    )
    const service = await downloadedService(target, { openPath })

    const first = service.apply()
    const second = service.apply()

    expect(openPath).toHaveBeenCalledTimes(1)
    resolveOpen('')
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { state: 'ready' },
      { state: 'ready' }
    ])
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it('does not let an older apply overwrite a newer manifest check', async () => {
    dir = await mkdtemp(join(tmpdir(), 'apply-refresh-'))
    const target = join(dir, 'installer.dmg')
    const body = Buffer.from('installer-bytes')
    let manifestChecks = 0
    const fetchImpl = ((input: unknown) => {
      if (!String(input).endsWith('version.json')) {
        return Promise.resolve(installerResponse(body))
      }
      manifestChecks += 1
      return Promise.resolve(
        jsonResponse({
          version: manifestChecks === 1 ? '0.3.0' : '0.4.0',
          releaseDate: '',
          notes: '',
          downloads: {
            'mac-arm64': {
              url: 'https://statics.aipoch.com/releases/0.3.0/installer.dmg',
              size: body.byteLength,
              sha256: createHash('sha256').update(body).digest('hex')
            }
          }
        } satisfies UpdateManifest)
      )
    }) as unknown as typeof fetch
    let resolveOpen!: (error: string) => void
    const openPath = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOpen = resolve
        })
    )
    const service = await downloadedService(target, { fetchImpl, openPath })

    const applying = service.apply()
    await expect(service.check()).resolves.toMatchObject({ state: 'available', latest: '0.4.0' })
    resolveOpen('No application is associated with this file')
    await applying

    expect(service.getStatus()).toMatchObject({ state: 'available', latest: '0.4.0' })
    expect(service.getStatus().error).toBeUndefined()
  })

  it('records a completed installer apply without its local path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'private-apply-'))
    const target = join(dir, 'private-installer.dmg')
    const log = createLogSpy()
    const service = await downloadedService(target, {
      openPath: () => Promise.resolve(''),
      log
    })
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.mocked(log[level]).mockClear()
    }

    await service.apply()

    const records = diagnosticRecords(log)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-apply',
          outcome: 'completed',
          result: 'installer-opened'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('private-installer.dmg')
  })

  it('keeps a ready installer actionable when the operating system cannot open it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'open-failure-'))
    const target = join(dir, 'installer.dmg')
    const openPath = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('No application is associated with this file')
      .mockResolvedValueOnce('')
    const service = await downloadedService(target, { openPath })

    const failed = await service.apply()

    expect(failed).toMatchObject({
      state: 'ready',
      localPath: target,
      error: expect.stringContaining('No application is associated with this file')
    })

    const retried = await service.apply()
    expect(openPath).toHaveBeenCalledTimes(2)
    expect(retried).toMatchObject({ state: 'ready', localPath: target })
    expect(retried.error).toBeUndefined()
  })

  it('returns to available when the downloaded file is missing (e.g. the user deleted it)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'open-'))
    const target = join(dir, 'installer.dmg')
    const openPath = vi.fn(() => Promise.resolve(''))
    const log = createLogSpy()
    const service = await downloadedService(target, { openPath, fileExists: () => false, log })
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.mocked(log[level]).mockClear()
    }

    const status = await service.apply()

    expect(openPath).not.toHaveBeenCalled()
    expect(status.state).toBe('available')
    expect(status.localPath).toBeUndefined()
    expect(diagnosticRecords(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update-apply',
          outcome: 'failed',
          phase: 'verify-installer',
          reason: 'installer-missing'
        })
      ])
    )
  })
})
