import { ResearchVideoEncoderCleanupError } from '@aipoch/research-film/export'
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { createHeadlessResearchFilmExport } from './headless-export'
import { renderHeadlessResearchFilmMp4 } from './headless-review'

vi.mock('./headless-review', () => ({ renderHeadlessResearchFilmMp4: vi.fn() }))
const renderMp4 = vi.mocked(renderHeadlessResearchFilmMp4)
const cleanup: (() => Promise<void>)[] = []

type ExportOwner = ReturnType<typeof createHeadlessResearchFilmExport>
type ExportTools = Parameters<typeof createHeadlessResearchFilmExport>[0]
type ExportModels = Parameters<typeof createHeadlessResearchFilmExport>[1]

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  renderMp4.mockReset()
})

async function setup(): Promise<{
  owner: ExportOwner
  request: Parameters<ExportOwner['render']>[0]
  available: Mock<ExportTools['available']>
  acquire: Mock<ExportTools['acquire']>
  release: Mock<() => void>
  installForUse: Mock<ExportModels['installForUse']>
}> {
  const root = await mkdtemp(join(tmpdir(), 'research-film-mp4-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'player.html')
  await writeFile(path, '<!doctype html><title>Research Film</title>')
  const player = await open(path, 'r')
  cleanup.push(() => player.close())

  const release = vi.fn<() => void>()
  const acquire = vi
    .fn<ExportTools['acquire']>()
    .mockResolvedValue({ encoderPath: 'ffmpeg', probePath: 'ffprobe', release })
  const available = vi.fn<ExportTools['available']>().mockResolvedValue(true)
  const installForUse = vi.fn<ExportModels['installForUse']>().mockResolvedValue({
    availability: 'ready',
    recommendedRevision: 'fixture',
    installedRevision: 'fixture',
    downloadBytes: 0,
    installedBytes: 1,
    hasFiles: true,
    inUse: false,
    transferredBytes: 0,
    updateAvailable: false
  })
  const owner = createHeadlessResearchFilmExport({ available, acquire }, { installForUse })
  cleanup.push(() => owner.close())
  const request = {
    player,
    size: (await player.stat()).size,
    resolution: '720p' as const,
    installExportTools: false
  }
  return { owner, request, available, acquire, release, installForUse }
}

it('requires approval before installing an encoder and disposes the downloaded export', async () => {
  const { owner, request, available, acquire, release, installForUse } = await setup()
  const signal = new AbortController().signal
  available.mockResolvedValue(false)
  await expect(owner.render(request, signal)).rejects.toMatchObject({
    code: 'film_export_tools_unavailable'
  })
  expect(installForUse).not.toHaveBeenCalled()
  expect(acquire).not.toHaveBeenCalled()
  renderMp4.mockImplementationOnce(async ({ html, directory }) => {
    expect(html).toContain('Research Film')
    const output = join(directory, 'fixture.mp4')
    await writeFile(output, 'encoded')
    return output
  })

  const output = await owner.render({ ...request, installExportTools: true }, signal)
  expect(installForUse).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
  expect(output.size).toBe(7)
  expect(await output.handle.readFile('utf8')).toBe('encoded')
  expect((await request.player.stat()).size).toBe(request.size)
  const [scratch] = acquire.mock.calls[0]
  await owner.close()
  await output.dispose()
  await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('holds admission during rendering and cancels the active export on shutdown', async () => {
  const { owner, request, acquire, release } = await setup()
  const entered = Promise.withResolvers<void>()
  const caller = new AbortController()
  renderMp4.mockImplementationOnce(async (_request, signal) => {
    entered.resolve()
    return new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
  })
  const result = owner.render(request, caller.signal)
  const rejected = expect(result).rejects.toThrow('Application is closing')
  await entered.promise
  await expect(owner.render(request, caller.signal)).rejects.toMatchObject({ code: 'film_busy' })
  await owner.close()
  await rejected
  expect(release).toHaveBeenCalledOnce()
  await expect(stat(acquire.mock.calls[0][0])).rejects.toMatchObject({ code: 'ENOENT' })
})

it('holds encoder inputs and the use lease until encoder shutdown is confirmed', async () => {
  const { owner, request, acquire, release } = await setup()
  const exit = Promise.withResolvers<void>()
  renderMp4.mockRejectedValueOnce(new ResearchVideoEncoderCleanupError(exit.promise))
  try {
    await expect(owner.render(request, new AbortController().signal)).rejects.toThrow(
      'did not confirm shutdown'
    )
    expect(release).not.toHaveBeenCalled()
    expect((await stat(acquire.mock.calls[0][0])).isDirectory()).toBe(true)
  } finally {
    exit.resolve()
  }
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  await expect(stat(acquire.mock.calls[0][0])).rejects.toMatchObject({ code: 'ENOENT' })
})
