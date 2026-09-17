import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ home: '', logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => (name === 'home' ? boundary.home : join(boundary.home, 'profile'))
  },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../logger', () => ({ createLogger: () => boundary.logger }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename) }
})

import { createCliCommandOwner } from './ipc'
import { installCliLauncher, planCliLauncher, type CliLauncherEnv } from './launcher'

// Only Electron/process inputs are doubled: maintenance, status, ownership checks and file writes
// run through the production command owner against task-private files. No real AppImage is started.
describe.skipIf(process.platform === 'win32')(
  'CLI startup maintenance through command owner',
  () => {
    let env: CliLauncherEnv
    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      vi.mocked(lstat).mockImplementation(actual.lstat)
      vi.mocked(rename).mockImplementation(actual.rename)
      boundary.home = await mkdtemp(join(tmpdir(), 'cli-maintenance-'))
      env = {
        platform: 'linux',
        packaged: true,
        homeDir: boundary.home,
        userDataDir: join(boundary.home, 'profile'),
        pathVar: '',
        appExecPath: join(boundary.home, '.mount_current', 'open-science'),
        cliEntryPath: join(boundary.home, '.mount_current', 'resources', 'cli', 'index.mjs'),
        appImagePath: join(boundary.home, 'Open-Science-current.AppImage')
      }
      await writeFile(env.appImagePath!, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      vi.stubGlobal('process', {
        ...process,
        platform: 'linux',
        execPath: env.appExecPath,
        resourcesPath: join(boundary.home, '.mount_current', 'resources')
      })
      vi.stubEnv('APPIMAGE', env.appImagePath!)
      vi.clearAllMocks()
    })
    afterEach(async () => {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      await rm(boundary.home, { recursive: true, force: true })
    })

    it('leaves a working launcher with only legacy brand copy byte-for-byte intact', async () => {
      const owner = createCliCommandOwner()
      await owner.install()
      const target = planCliLauncher(env).target
      const legacy = (await readFile(target, 'utf8')).replaceAll('Open-Science ', 'Open Science ')
      await writeFile(target, legacy)
      expect(await owner.getStatus()).toMatchObject({ installed: true })
      await owner.ensureCurrent()
      expect(await readFile(target, 'utf8')).toBe(legacy)
      expect(boundary.logger.info).not.toHaveBeenCalledWith(
        'updated cli launcher',
        expect.anything()
      )
    })

    it.each(['AppImage', 'desktop'] as const)(
      'preserves another usable %s binding until explicit reinstall',
      async (kind) => {
        const other = {
          ...env,
          appImagePath:
            kind === 'AppImage' ? join(boundary.home, "Open Science's other.AppImage") : undefined
        }
        if (other.appImagePath)
          await writeFile(other.appImagePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        else {
          other.appExecPath = join(boundary.home, 'old app', 'Open Science')
          other.cliEntryPath = join(boundary.home, 'old app', 'cli.mjs')
          await mkdir(join(boundary.home, 'old app'))
          await writeFile(other.appExecPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
          await writeFile(other.cliEntryPath, '')
        }
        const target = (await installCliLauncher(other)).target
        const original = await readFile(target, 'utf8')
        const owner = createCliCommandOwner()
        await owner.ensureCurrent()
        expect(await readFile(target, 'utf8')).toBe(original)
        expect(await owner.getStatus()).toMatchObject({ installed: true })
        await owner.install()
        expect(await readFile(target, 'utf8')).toBe(planCliLauncher(env).shim)
        await owner.uninstall()
        await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    )

    it('does not take over a binding whose availability cannot be established', async () => {
      const other = { ...env, appImagePath: join(boundary.home, 'not-executable.AppImage') }
      await writeFile(other.appImagePath, '')
      await chmod(other.appImagePath, 0o600)
      const target = (await installCliLauncher(other)).target
      const original = await readFile(target, 'utf8')
      await createCliCommandOwner().ensureCurrent()
      expect(await readFile(target, 'utf8')).toBe(original)
    })

    it('retains explicit ownership refusal for install and uninstall', async () => {
      const owner = createCliCommandOwner()
      const { target, binDir } = planCliLauncher(env)
      await mkdir(binDir, { recursive: true })
      const unrelated = '#!/bin/sh\necho unrelated\n'
      await writeFile(target, unrelated)
      await owner.ensureCurrent()
      await expect(owner.install()).rejects.toThrow(/not managed/)
      await expect(owner.uninstall()).rejects.toThrow(/not managed/)
      expect(await readFile(target, 'utf8')).toBe(unrelated)
    })
    it.each(['moved AppImage', 'old FUSE mount'])(
      'repairs a confirmed missing %s binding through startup maintenance',
      async (kind) => {
        const other =
          kind === 'moved AppImage'
            ? { ...env, appImagePath: join(boundary.home, 'moved.AppImage') }
            : {
                ...env,
                appImagePath: undefined,
                appExecPath: join(boundary.home, '.mount_old', 'open-science'),
                cliEntryPath: join(boundary.home, '.mount_old', 'resources', 'cli', 'index.mjs')
              }
        const target = (await installCliLauncher(other)).target
        const owner = createCliCommandOwner()
        expect(await owner.getStatus()).toMatchObject({ installed: false })
        await owner.ensureCurrent()
        expect(await readFile(target, 'utf8')).toBe(planCliLauncher(env).shim)
        expect(await owner.getStatus()).toMatchObject({ installed: true })
      }
    )

    it('preserves the previous launcher when publishing its necessary repair fails', async () => {
      const other = { ...env, appImagePath: join(boundary.home, 'moved.AppImage') }
      const target = (await installCliLauncher(other)).target
      const original = await readFile(target, 'utf8')
      vi.mocked(rename).mockRejectedValueOnce(
        Object.assign(new Error('read only'), { code: 'EROFS' })
      )
      await createCliCommandOwner().ensureCurrent()
      expect(await readFile(target, 'utf8')).toBe(original)
      expect(boundary.logger.error).toHaveBeenCalledWith(
        'cli launcher reconciliation failed',
        expect.any(Error)
      )
    })

    it('does not replace a new binding installed while the old binding is being checked', async () => {
      const other = { ...env, appImagePath: join(boundary.home, 'moved.AppImage') }
      const target = (await installCliLauncher(other)).target
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      const replacement =
        '#!/bin/sh\n# Open-Science command-line launcher. Managed by the app. Format version: 1.\necho new binding\n'
      vi.mocked(lstat).mockImplementation(async (...args) => {
        if (args[0] === other.appImagePath) {
          await writeFile(target + '.replacement', replacement)
          await actual.rename(target + '.replacement', target)
        }
        return actual.lstat(...args)
      })
      await createCliCommandOwner().ensureCurrent()
      expect(await readFile(target, 'utf8')).toBe(replacement)
      expect(boundary.logger.error).toHaveBeenCalledWith(
        'cli launcher reconciliation failed',
        expect.any(Error)
      )
    })
  }
)
