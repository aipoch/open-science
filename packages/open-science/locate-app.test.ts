import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('installed app discovery across the brand rename', () => {
  it.each([
    ['Open-Science', 'Open-Science.exe'],
    ['Open Science', 'Open Science.exe'],
    ['Open Science', 'Open-Science.exe']
  ])('finds Windows installation %s/%s', async (folder, executable) => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-locate-'))
    roots.push(root)
    // Copy the published module into an installation without repository build outputs.
    const modulePath = join(root, 'packages/open-science/locate-app.mjs')
    await mkdir(dirname(modulePath), { recursive: true })
    await copyFile(new URL('./locate-app.mjs', import.meta.url), modulePath)
    const target = join(root, 'Programs', folder, executable)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, '')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { locateApp } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    await expect(locateApp({ env: { LOCALAPPDATA: root } })).resolves.toMatchObject({
      command: target,
      packaged: true
    })
  })
})
