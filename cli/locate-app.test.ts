import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { locateApp, repositoryRoot } from './locate-app.mjs'
import * as fs from 'node:fs/promises'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, access: vi.fn(actual.access) }
})

describe('locateApp', () => {
  let dir: string

  beforeEach(async () => {
    vi.mocked(fs.access).mockImplementation(
      (await vi.importActual<typeof fs>('node:fs/promises')).access
    )
    dir = await mkdtemp(join(tmpdir(), 'os-locate-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves an explicit --app-path to a packaged executable', async () => {
    const exe = join(dir, 'Open-Science')
    await writeFile(exe, '')
    // Empty env so repository discovery can't shadow the explicit override.
    const app = await locateApp({ appPath: exe, env: {} })
    expect(app).toMatchObject({ command: exe, args: [], packaged: true })
  })

  it('honors OPEN_SCIENCE_APP_PATH when no --app-path is given', async () => {
    const exe = join(dir, 'app-binary')
    await writeFile(exe, '')
    const app = await locateApp({ env: { OPEN_SCIENCE_APP_PATH: exe } })
    expect(app.command).toBe(exe)
    expect(app.packaged).toBe(true)
  })

  it('prefers the Debian Electron executable over the system CLI wrapper', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const candidates = new Set(['/opt/Open-Science/open-science', '/usr/bin/open-science'])
    vi.mocked(fs.access).mockImplementation(async (path) => {
      if (!candidates.has(String(path))) throw new Error('ENOENT')
    })
    const app = await locateApp({ env: {} })
    expect(app).toMatchObject({
      command: '/opt/Open-Science/open-science',
      args: [],
      packaged: true
    })
    vi.mocked(fs.access).mockRestore()
  })

  it('throws a helpful error when the explicit path does not exist', async () => {
    await expect(locateApp({ appPath: join(dir, 'missing'), env: {} })).rejects.toThrow(/not found/)
  })

  it.each([
    ['darwin', '/Applications/Open Science.app/Contents/MacOS/Open Science'],
    ['darwin', '/Applications/Open Science.app/Contents/MacOS/Open-Science'],
    ['darwin', '/Applications/Open-Science.app/Contents/MacOS/Open Science'],
    ['win32', '/fixture/Programs/Open Science/open-science.exe'],
    ['linux', '/opt/Open Science/open-science']
  ])(
    'requires explicit selection for old or mixed-name installations on %s: %s',
    async (platform, command) => {
      vi.stubGlobal('process', { ...process, platform })
      const explicitCommand = resolve(command)
      vi.mocked(fs.access).mockImplementation(async (path) => {
        if (resolve(String(path)) !== explicitCommand) throw new Error('ENOENT')
      })
      await expect(locateApp({ env: { LOCALAPPDATA: '/fixture' } })).rejects.toThrow(
        /--app-path.*OPEN_SCIENCE_APP_PATH/
      )
      expect((await locateApp({ appPath: command, env: {} })).command).toBe(explicitCommand)
      expect((await locateApp({ env: { OPEN_SCIENCE_APP_PATH: command } })).command).toBe(
        explicitCommand
      )
    }
  )
  it('prefers the new installed bundle while an explicit old bundle remains selectable', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    const current = join('/Applications', 'Open-Science.app', 'Contents', 'MacOS', 'Open-Science')
    const legacy = resolve('/Applications/Open Science.app/Contents/MacOS/Open Science')
    const candidates = new Set([legacy, resolve(current)])
    vi.mocked(fs.access).mockImplementation(async (path) => {
      if (!candidates.has(resolve(String(path)))) throw new Error('ENOENT')
    })
    expect((await locateApp({ env: {} })).command).toBe(current)
    expect((await locateApp({ appPath: legacy, env: {} })).command).toBe(legacy)
  })
  it.each([
    ['darwin', '/Applications/Open-Science.app/Contents/MacOS/Open-Science'],
    ['darwin', '/fixture/Applications/Open-Science.app/Contents/MacOS/Open-Science'],
    ['win32', '/fixture/Programs/Open-Science/open-science.exe'],
    ['win32', '/programs/Open-Science/open-science.exe'],
    ['linux', '/opt/Open-Science/open-science']
  ])('discovers only the new default on %s: %s', async (platform, command) => {
    vi.stubGlobal('process', { ...process, platform })
    // Changing process.platform does not change node:path's host-platform implementation.
    const candidate = platform === 'linux' ? command : join(command)
    vi.mocked(fs.access).mockImplementation(async (path) => {
      if (String(path) !== candidate) throw new Error('ENOENT')
    })
    expect(
      (
        await locateApp({
          env: { HOME: '/fixture', LOCALAPPDATA: '/fixture', PROGRAMFILES: '/programs' }
        })
      ).command
    ).toBe(candidate)
  })

  it.each(['/usr/bin/open-science', '/usr/local/bin/open-science', '/custom/bin/open-science'])(
    'does not use a public CLI wrapper or arbitrary PATH candidate: %s',
    async (command) => {
      vi.stubGlobal('process', { ...process, platform: 'linux' })
      vi.mocked(fs.access).mockImplementation(async (path) => {
        if (String(path) !== command) throw new Error('ENOENT')
      })
      await expect(
        locateApp({ env: { PATH: '/custom/bin:/usr/bin:/usr/local/bin' } })
      ).rejects.toThrow(/--app-path.*OPEN_SCIENCE_APP_PATH/)
    }
  )

  it('keeps explicit precedence and never falls back from a missing explicit selection', async () => {
    const command = join(dir, 'selected')
    const configured = join(dir, 'configured')
    await writeFile(command, '')
    await writeFile(configured, '')
    expect(
      (await locateApp({ appPath: command, env: { OPEN_SCIENCE_APP_PATH: configured } })).command
    ).toBe(command)
    const missing = join(dir, 'missing')
    await expect(
      locateApp({ appPath: missing, env: { OPEN_SCIENCE_APP_PATH: configured } })
    ).rejects.toThrow(missing)
    await expect(locateApp({ env: { OPEN_SCIENCE_APP_PATH: missing } })).rejects.toThrow(missing)
  })

  it('retains repository development discovery before installed candidates', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined)
    const result = await locateApp({ env: {} })
    expect(result).toMatchObject({ packaged: false, args: [repositoryRoot], repositoryRoot })
  })

  it('does not recursively start itself through a default executable symlink', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', argv: ['node', '/fixture/cli.mjs'] })
    vi.mocked(fs.access).mockImplementation(async (path) => {
      if (String(path) !== '/opt/Open-Science/open-science') throw new Error('ENOENT')
    })
    vi.spyOn(fs, 'realpath').mockResolvedValue('/fixture/cli.mjs')
    await expect(locateApp({ env: {} })).rejects.toThrow(/--app-path/)
  })
})
