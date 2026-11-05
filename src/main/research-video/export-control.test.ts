import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { createResearchVideoExportControl } from './export-control'
import type { ApplicationCallerLease } from '../application-command-router'
const native = vi.hoisted(() => ({ chooseSavePath: vi.fn(), renderResearchVideo: vi.fn() }))
vi.mock('../desktop-interaction', () => ({ desktopFileInteraction: () => native }))
const lease = (id: string): ApplicationCallerLease =>
  new ApplicationCallerLeaseRegistry().acquire({ leaseId: id, surface: 'electron' }).lease
const tools = {
  available: vi.fn(async () => true),
  snapshot: vi.fn(async () => ({ downloadBytes: 42 }) as never),
  acquire: vi.fn(async () => ({
    encoderPath: '/test/ffmpeg',
    probePath: '/test/ffprobe',
    release: vi.fn()
  }))
}
const content = Buffer.from(
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="open-science-research-video" content="1"><title>Heat &amp; Light: Where?</title><style>body{}</style><div id="root">player</div></html>'
)
it.each([
  ['generated document', content],
  [
    'explicit head element',
    Buffer.from(
      '<!doctype html><html><head><meta name="open-science-research-video" content="1"><title>Heat &amp; Light: Where?</title></head><body>player</body></html>'
    )
  ]
])(
  'exports %s with its decoded title and atomically replaces the chosen output',
  async (_shape, content) => {
    const root = await mkdtemp(join(tmpdir(), 'video-export-control-'))
    let htmlPath = ''
    try {
      const destination = join(root, 'result.mp4')
      await writeFile(destination, 'old')
      const readRange = vi.fn(async (owner, request) => {
        if (owner.leaseId !== 'owner') throw new Error('not owned')
        return {
          begin: request.begin,
          end: request.end,
          total: content.length,
          data: content.subarray(request.begin, request.end)
        }
      })
      native.chooseSavePath.mockResolvedValue({ canceled: false, filePath: destination })
      native.renderResearchVideo.mockImplementation(async (request) => {
        htmlPath = request.htmlPath
        expect(await readFile(destination, 'utf8')).toBe('old')
        expect(await readFile(htmlPath, 'utf8')).toBe(content.toString())
        await writeFile(`${htmlPath}.mp4`, 'new')
        return `${htmlPath}.mp4`
      })
      const control = createResearchVideoExportControl({ readRange }, tools)
      await expect(control.export(lease('other'), { resourceId: 'r' })).rejects.toThrow('not owned')
      await control.export(lease('owner'), { resourceId: 'r' })
      expect(native.chooseSavePath).toHaveBeenLastCalledWith(
        { defaultPath: 'Heat-&-Light-Where.mp4', filters: [{ name: 'MP4', extensions: ['mp4'] }] },
        undefined
      )
      expect(await readFile(destination, 'utf8')).toBe('new')
      await expect(stat(htmlPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
it('cancels the owning export without publishing, and cannot cancel another caller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-export-cancel-'))
  let htmlPath = ''
  try {
    const destination = join(root, 'result.mp4')
    await writeFile(destination, 'old')
    const readRange = vi.fn(async (_owner, request) => ({
      begin: request.begin,
      end: request.end,
      total: content.length,
      data: content.subarray(request.begin, request.end)
    }))
    native.chooseSavePath.mockResolvedValue({ canceled: false, filePath: destination })
    let started!: () => void
    const ready = new Promise<void>((r) => {
      started = r
    })
    native.renderResearchVideo.mockImplementation(async (request, signal) => {
      htmlPath = request.htmlPath
      started()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    })
    const control = createResearchVideoExportControl({ readRange }, tools),
      owner = lease('owner')
    const pending = control.export(owner, { resourceId: 'r' })
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await ready
    control.cancel(lease('other'), { resourceId: 'r' })
    control.cancel(owner, { resourceId: 'r' })
    await rejected
    expect(await readFile(destination, 'utf8')).toBe('old')
    await expect(stat(htmlPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('offers installation only after authorizing the preview, without opening a save dialog', async () => {
  const readRange = vi.fn(async (_owner, request) => ({
    begin: request.begin,
    end: request.end,
    total: content.length,
    data: content.subarray(request.begin, request.end)
  }))
  const chooseCalls = native.chooseSavePath.mock.calls.length
  const missing = { ...tools, available: vi.fn(async () => false) }
  const control = createResearchVideoExportControl({ readRange }, missing)
  expect(await control.export(lease('owner'), { resourceId: 'r' })).toEqual({
    canceled: false,
    needsInstallation: { downloadBytes: 42 }
  })
  expect(readRange).toHaveBeenCalled()
  expect(native.chooseSavePath).toHaveBeenCalledTimes(chooseCalls)
  await control.close()
})
