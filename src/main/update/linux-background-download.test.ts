import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadLinuxBackgroundDownloads } from './linux-background-download'

const busctl = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: busctl })
}))

let root: string
let resources: string
const config =
  'provider: generic\nchannel: latest\nurl: https://statics.aipoch.com/open-science/app/stable\nupdaterCacheDirName: open-science-updater\n'
beforeEach(async () => {
  busctl.mockReset()
  root = await mkdtemp(join(tmpdir(), 'linux-background-'))
  resources = join(root, 'resources')
  await mkdir(resources)
  await writeFile(join(resources, 'app-update.yml'), config)
})
afterEach(() => rm(root, { recursive: true, force: true }))

it.each(['deb', 'AppImage'])(
  'admits only a confirmed unmetered %s download and remembers opt-out',
  async (format) => {
    const image = format === 'AppImage' ? join(root, 'Open-Science.AppImage') : undefined
    if (image) await writeFile(image, '')
    else await writeFile(join(resources, 'package-type'), 'deb')
    const load = (): ReturnType<typeof loadLinuxBackgroundDownloads> =>
      loadLinuxBackgroundDownloads(root, resources, root, image, image && root)
    const policy = await load()
    expect(policy?.preference.enabled).toBe(true)
    for (const output of ['u 4\nu 1', 'u 4\nu 0', 'u 4\nu 4', 'u 4\nu 3', 'u 3\nu 2']) {
      busctl.mockResolvedValue({ stdout: output })
      expect(await policy?.canDownload(1024)).toBe(false)
    }
    busctl.mockRejectedValueOnce(new Error('No system bus'))
    expect(await policy?.canDownload(1024)).toBe(false)
    busctl.mockResolvedValue({ stdout: 'u 4\nu 2\n' })
    expect(await policy?.canDownload(1024)).toBe(true)
    expect(await policy?.canDownload(Number.MAX_SAFE_INTEGER)).toBe(false)
    policy?.preference.setEnabled(false)
    expect((await load())?.preference.enabled).toBe(false)
  }
)
it('keeps unpacked copies and other feeds on manual download', async () => {
  const load = (): ReturnType<typeof loadLinuxBackgroundDownloads> =>
    loadLinuxBackgroundDownloads(root, resources, root, undefined, undefined)
  expect(await load()).toBeUndefined()
  await writeFile(join(resources, 'package-type'), 'deb')
  await writeFile(join(resources, 'app-update.yml'), config.replace('/stable', '/nightly'))
  expect(await load()).toBeUndefined()
})
