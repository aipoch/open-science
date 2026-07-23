import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  it('drops a prior-session <target>.part on the first download so a restart starts fresh', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    // A leftover fragment from a previous app session at the same Save location.
    const partPath = `${target}.part`
    await writeFile(partPath, Buffer.from('stale-fragment-from-last-session'))
    const body = Buffer.from('fresh-installer-bytes')
    const manifestForCheck = downloadManifest(
      body.byteLength,
      createHash('sha256').update(body).digest('hex')
    )
    const fetchImpl = ((input: unknown) =>
      String(input).endsWith('version.json')
        ? Promise.resolve(jsonResponse(manifestForCheck))
        : Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch
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
    expect(status.state).toBe('ready')
    expect(await readFile(target)).toEqual(body)
    expect(existsSync(partPath)).toBe(false)
  })

  it('removes the .part only on the first download to a path this session (in-session resume kept)', async () => {
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
        : Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch
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

    // Only the first download reset the .part; the second leaves it so an in-session retry resumes.
    expect(removeFile).toHaveBeenCalledTimes(1)
  })

  it('does not start the fetch and errors when the first .part cleanup fails', async () => {
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const manifestForCheck = downloadManifest(11, 'irrelevant')
    let installerFetches = 0
    const fetchImpl = ((input: unknown) => {
      if (String(input).endsWith('version.json'))
        return Promise.resolve(jsonResponse(manifestForCheck))
      installerFetches += 1
      return Promise.resolve(new Response(Buffer.from('installer-bytes'), { status: 200 }))
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
        : Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch
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

    // The path was NOT marked fresh after the failure, so the retry cleans again and then succeeds.
    expect(removeFile).toHaveBeenCalledTimes(2)
    expect(retry.state).toBe('ready')
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
        return Promise.resolve(new Response(stream, { status: 200 }))
      }
      // Retry: serve the remaining bytes as a 206 partial-content response.
      return Promise.resolve(
        new Response(body.subarray(2), {
          status: 206,
          headers: { 'content-range': `bytes 2-${body.byteLength - 1}/${body.byteLength}` }
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

  it('a cancel while a retry is still draining aborts it — no hidden download starts', async () => {
    // Reproduces issue #216's core symptom for the retry path: cancel first, retry (which drains the
    // cancelled download), then cancel again during that drain. A no-op cancel here would let the retry
    // start a hidden download after the dialog closed.
    dir = await mkdtemp(join(tmpdir(), 'svc-'))
    const target = join(dir, 'installer.dmg')
    const manifestForCheck = downloadManifest(100, 'irrelevant')
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
      return Promise.resolve(new Response(hanging, { status: 200 }))
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
        : Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch
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
    expect(existsSync(target)).toBe(true)
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
