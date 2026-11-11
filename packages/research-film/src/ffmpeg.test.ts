import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExportModelPort } from './ports.js'
import { createVideoExportTools } from './ffmpeg.js'
import { VIDEO_EXPORT_REVISIONS } from './ffmpeg-catalog.js'

vi.mock('./ffmpeg-catalog.js', async (original) => ({
  ...(await original<object>()),
  videoExportTarget: 'test',
  videoExportBinaries: ['ffmpeg', 'ffprobe'].map((file) => ({
    file,
    size: 7,
    sha256: createHash('sha256').update('fixture').digest('hex')
  }))
}))
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('pins binaries and notices for each supported platform without a default npm dependency', () => {
  expect(VIDEO_EXPORT_REVISIONS).toHaveLength(5)
  for (const revision of VIDEO_EXPORT_REVISIONS) {
    expect(revision.assets.map((a) => a.file)).toEqual([
      'ffmpeg.bin.gz',
      'ffprobe.bin.gz',
      'license.txt',
      'readme.txt'
    ])
    for (const asset of revision.assets) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(asset.url).toContain('/releases/download/b6.1.1/')
      expect(asset.size).toBeGreaterThan(0)
    }
  }
})
it('does not install on discovery and reuses compatible system tools', async () => {
  const install = vi.fn()
  const owner = {
    getSnapshot: async () => ({ availability: 'notInstalled' }),
    install,
    acquireUse: vi.fn()
  } as unknown as ExportModelPort
  const paths = { encoderPath: '/system/ffmpeg', probePath: '/system/ffprobe' }
  const tools = createVideoExportTools(owner, async () => paths)
  expect(await tools.available(new AbortController().signal)).toBe(true)
  expect(await tools.acquire('unused', new AbortController().signal)).toMatchObject(paths)
  expect(install).not.toHaveBeenCalled()
  expect(owner.acquireUse).not.toHaveBeenCalled()
  expect(
    await createVideoExportTools(owner, async () => undefined).available(
      new AbortController().signal
    )
  ).toBe(false)
})
it('verifies extracted binaries and holds the model lease until the export releases it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-tools-'))
  roots.push(root)
  const compressed = join(root, 'asset.gz')
  await writeFile(compressed, gzipSync('fixture'))
  const release = vi.fn()
  const owner = {
    getSnapshot: async () => ({ availability: 'ready', installedRevision: 'ffmpeg-6-1-1-test' }),
    acquireUse: async () => ({
      revision: 'ffmpeg-6-1-1-test',
      assets: ['ffmpeg', 'ffprobe'].map((name) => ({ file: name + '.bin.gz', path: compressed })),
      release
    })
  } as unknown as ExportModelPort
  const tools = createVideoExportTools(owner, vi.fn())
  const paths = await tools.acquire(root, new AbortController().signal)
  expect(await readFile(paths.encoderPath, 'utf8')).toBe('fixture')
  expect(release).not.toHaveBeenCalled()
  paths.release()
  expect(release).toHaveBeenCalledOnce()
  await rm(paths.encoderPath)
  await rm(paths.probePath)
  await writeFile(compressed, gzipSync('invalid'))
  await expect(tools.acquire(root, new AbortController().signal)).rejects.toThrow('checksum')
  expect(release).toHaveBeenCalledTimes(2)
})
