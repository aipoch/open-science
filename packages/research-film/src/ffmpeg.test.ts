import { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExportModelPort } from './ports.js'
import { createVideoExportTools, findSystemVideoEncoders } from './ffmpeg.js'
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
it.skipIf(process.platform === 'win32')(
  'does not start another system capability check while a killed process has not exited',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'film-encoder-discovery-'))
    roots.push(root)
    const path = join(root, 'ffmpeg')
    const ready = join(root, 'ready')
    const controller = new AbortController()
    await writeFile(
      path,
      `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
setTimeout(() => {}, 4000);`,
      { mode: 0o700 }
    )
    const kill = ChildProcess.prototype.kill
    const observed = new Set<ChildProcess>()
    const spy = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
      this: ChildProcess,
      signal
    ) {
      if (this.spawnfile !== path) return kill.call(this, signal)
      observed.add(this)
      return true
    })
    vi.stubEnv('PATH', root)
    const settled = vi.fn()
    const result = findSystemVideoEncoders(controller.signal).then(settled, settled)
    try {
      await vi.waitFor(() => readFile(ready))
      vi.useFakeTimers()
      controller.abort()
      await vi.advanceTimersByTimeAsync(5000)
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/did not confirm shutdown/i) })
      )
      await expect(findSystemVideoEncoders(new AbortController().signal)).rejects.toThrow(
        /did not confirm shutdown/i
      )
      expect(observed.size).toBe(1)
    } finally {
      vi.useRealTimers()
      vi.unstubAllEnvs()
      spy.mockRestore()
      const child = observed.values().next().value
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()))
        kill.call(child, 'SIGKILL')
        await exited
      }
      await result
    }
  }
)
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
