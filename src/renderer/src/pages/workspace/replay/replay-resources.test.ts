// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReplayResource } from '../../../../../shared/replay'
import {
  ReplayResourceCache,
  readReplayResource,
  type ReplayPreparedResource
} from './replay-resources'
import { freezeReplaySvg, replayImageSource } from './replay-svg'

const resource = (id: string): ReplayResource => ({
  id,
  name: 'plot.svg',
  projectId: 'p',
  sessionId: 's',
  artifactId: 'a',
  versionId: id,
  locator: `artifact-version://${id}`,
  availability: 'recorded'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('historical replay resources', () => {
  it('reads archived uploads through their own exact-version reader and storage owner', async () => {
    const uploadRead = vi.fn().mockResolvedValue({
      content: 'sample,value\n1,4.5',
      encoding: 'utf8',
      truncated: false,
      size: 18
    })
    const artifactRead = vi.fn()
    vi.stubGlobal('api', {
      uploads: { readPreview: uploadRead },
      artifacts: { readPreview: artifactRead }
    })
    const upload: ReplayResource = {
      id: 'upload:original',
      source: 'upload',
      fileId: 'input-file',
      name: 'observations.csv',
      projectId: 'p',
      sessionId: 'upload-owner',
      versionId: 'original',
      availability: 'recorded',
      locator: 'upload-version://original'
    }
    expect(await readReplayResource(upload)).toMatchObject({ status: 'ready', kind: 'table' })
    expect(uploadRead).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: 'original',
        fileId: 'input-file',
        sessionId: 'upload-owner',
        path: 'upload-version://original'
      })
    )
    uploadRead.mockRejectedValueOnce(new Error('original upload bytes missing'))
    expect(await readReplayResource(upload)).toEqual({
      status: 'unavailable',
      reason: 'read-failed'
    })
    expect(await readReplayResource({ ...upload, versionId: undefined })).toEqual({
      status: 'unavailable',
      reason: 'not-recorded'
    })
    expect(uploadRead).toHaveBeenCalledTimes(2)
    expect(artifactRead).not.toHaveBeenCalled()
  })
  it('reads the exact historical Version, freezes SVG, and never falls back after a missing Version', async () => {
    const readPreview = vi.fn().mockResolvedValue({
      content: btoa('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L8 8"/></svg>'),
      encoding: 'base64',
      truncated: false,
      size: 100
    })
    vi.stubGlobal('api', {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { artifacts: { readPreview } }
    })
    const preview = await readReplayResource(resource('v1'))
    expect(readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'v1', path: 'artifact-version://v1', sessionId: 's' })
    )
    expect(preview).toMatchObject({ status: 'ready', kind: 'image' })
    readPreview.mockRejectedValueOnce(new Error('missing'))
    expect(await readReplayResource(resource('v2'))).toEqual({
      status: 'unavailable',
      reason: 'read-failed'
    })
    expect(readPreview).toHaveBeenCalledTimes(2)
    expect(await readReplayResource({ ...resource('unversioned'), versionId: undefined })).toEqual({
      status: 'unavailable',
      reason: 'not-recorded'
    })
    expect(readPreview).toHaveBeenCalledTimes(2)
  })

  it('keeps chart primitives and local references while removing animation and external activity', () => {
    const frozen = freezeReplaySvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><defs><path id="line" d="M0 0L5 5"/></defs><use href="#line"/><script>alert(1)</script><foreignObject/><image href="https://example.com/pixel"/><animate attributeName="x"/><style>@import "https://example.com/a.css";</style><path style="fill: url(https://example.com/a.svg)" d="M3 3L8 8"/></svg>'
    )!
    const markup = decodeURIComponent(frozen.split(',')[1])
    expect(markup).toContain('href="#line"')
    expect(markup).toContain('M3 3L8 8')
    expect(markup).not.toMatch(/https:|onload|script|foreignObject|animate|@import/u)
  })

  it('bounds in-flight reads and preserves timed-out material even when a late response arrives', async () => {
    vi.useFakeTimers()
    const resolvers: ((value: ReplayPreparedResource) => void)[] = []
    const reader = vi.fn(
      () => new Promise<ReplayPreparedResource>((resolve) => resolvers.push(resolve))
    )
    const cache = new ReplayResourceCache(reader, 20)
    const first = cache.prepare(resource('v1'))
    const second = cache.prepare(resource('v2'))
    const queued = cache.prepare(resource('v3'))
    await Promise.resolve()
    expect(reader).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20)
    expect(await first).toEqual({ status: 'timeout' })
    expect(await second).toEqual({ status: 'timeout' })
    expect(await queued).toEqual({ status: 'timeout' })
    resolvers[0]({
      status: 'ready',
      kind: 'text',
      content: 'late',
      mimeType: 'text/plain',
      truncated: false
    })
    await Promise.resolve()
    expect(await cache.prepare(resource('v1'))).toEqual({ status: 'timeout' })
    expect(reader).toHaveBeenCalledTimes(2)
  })
})

it('limits cached payload bytes while keeping settled missing decisions after eviction', async () => {
  const reader = vi.fn(async (item: ReplayResource): Promise<ReplayPreparedResource> =>
    item.id === 'missing'
      ? { status: 'unavailable' }
      : {
          status: 'ready',
          kind: 'text',
          content: 'x'.repeat(900),
          mimeType: 'text/plain',
          truncated: false
        }
  )
  const cache = new ReplayResourceCache(reader, 5000, 24, 2048)
  await cache.prepare(resource('missing'))
  await cache.prepare(resource('one'))
  await cache.prepare(resource('two'))
  expect(cache.stats.bytes).toBeLessThanOrEqual(2048)
  expect(cache.stats.entries).toBe(1)
  await cache.prepare(resource('one'))
  expect(reader).toHaveBeenCalledTimes(4)
  expect(await cache.prepare(resource('missing'))).toEqual({ status: 'unavailable' })
  expect(reader).toHaveBeenCalledTimes(4)
})

it('rejects animated raster containers that would escape the logical replay clock', () => {
  const apng = '\x89PNG\r\n\x1a\n' + '\x00\x00\x00\x08acTL' + '\x00'.repeat(12)
  const webp = 'RIFF' + '\x00'.repeat(4) + 'WEBPVP8X' + '\x00'.repeat(4) + '\x02' + '\x00'.repeat(9)
  expect(replayImageSource('image/png', btoa(apng))).toBeUndefined()
  expect(replayImageSource('image/webp', btoa(webp))).toBeUndefined()
})
