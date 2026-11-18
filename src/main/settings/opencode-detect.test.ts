import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  candidateDirs,
  createDefaultDetectDeps,
  detectOpencode,
  parseVersion,
  type OpencodeDetectDeps
} from './opencode-detect'

// Builds detect deps around a set of "installed" executables keyed by absolute path.
const createDeps = (
  installed: Record<string, string>,
  overrides: Partial<OpencodeDetectDeps> = {}
): OpencodeDetectDeps => ({
  env: { PATH: '/usr/bin:/usr/local/bin' },
  homePath: '/home/user',
  // Pinned so probe order is host-independent (tests run on macOS/Linux/Windows CI runners alike).
  platform: 'linux',
  isExecutable: (path) => Promise.resolve(path in installed),
  getVersion: (path) => Promise.resolve(installed[path]),
  resolveNpmBinDirs: () => Promise.resolve([]),
  ...overrides
})

describe('opencode-detect', () => {
  it.skipIf(process.platform === 'win32').each<{
    name: string
    command: string
    run: (executable: string, signal: AbortSignal) => Promise<unknown>
  }>([
    {
      name: 'OpenCode npm prefix',
      command: 'npm',
      run: (_executable, signal) => createDefaultDetectDeps().resolveNpmBinDirs(signal)
    },
    {
      name: 'OpenCode version probe',
      command: 'opencode',
      run: (executable, signal) => createDefaultDetectDeps().probeVersion!(executable, signal)
    }
  ])('reaps the real $name descendants before cancellation settles', async ({ command, run }) => {
    const directory = await mkdtemp(join(tmpdir(), 'opencode-version-probe-'))
    const executable = join(directory, command)
    const pidFile = join(directory, 'pids.json')
    const controller = new AbortController()
    let result: Promise<unknown> | undefined
    let pids: { parent: number; descendant: number } | undefined
    try {
      await writeFile(
        executable,
        `#!${process.execPath}\n` +
          "const { spawn } = require('node:child_process');\n" +
          "const { writeFileSync } = require('node:fs');\n" +
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n" +
          `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, descendant: child.pid }));\n` +
          'setInterval(() => {}, 1000);\n'
      )
      await chmod(executable, 0o755)
      vi.stubEnv('PATH', `${directory}${delimiter}${process.env.PATH ?? ''}`)
      result = run(executable, controller.signal).catch((error: unknown) => error)
      await vi.waitFor(async () => {
        pids = JSON.parse(await readFile(pidFile, 'utf8'))
      })
      controller.abort()
      expect(await result).toMatchObject({ name: 'AbortError' })
      for (const pid of [pids!.descendant, pids!.parent]) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      }
    } finally {
      controller.abort()
      await result
      for (const pid of Object.values(pids ?? {})) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // The successful cancellation path has already reaped both processes.
        }
      }
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('parses a version string out of --version output', () => {
    expect(parseVersion('1.18.3')).toBe('1.18.3')
    expect(parseVersion('opencode 1.0.0-beta.2')).toBe('1.0.0-beta.2')
  })

  it('returns undefined when no candidate is executable', async () => {
    expect(await detectOpencode(createDeps({}))).toBeUndefined()
  })

  it('finds opencode on PATH and records its absolute path and version', async () => {
    const resolveNpmBinDirs = vi.fn(async () => [])
    const result = await detectOpencode(
      createDeps({ '/usr/local/bin/opencode': '1.18.0' }, { resolveNpmBinDirs })
    )
    expect(resolveNpmBinDirs).not.toHaveBeenCalled()

    expect(result).toEqual({ resolvedPath: '/usr/local/bin/opencode', version: '1.18.0' })
  })

  it('passes cancellation through npm discovery and version probing', async () => {
    const controller = new AbortController()
    const resolveNpmBinDirs = vi.fn().mockResolvedValue(['/npm/bin'])
    const getVersion = vi.fn().mockResolvedValue('1.18.0')

    await detectOpencode(
      createDeps({ '/npm/bin/opencode': '1.18.0' }, { resolveNpmBinDirs, getVersion }),
      controller.signal
    )

    expect(resolveNpmBinDirs).toHaveBeenCalledWith(controller.signal)
    expect(getVersion).toHaveBeenCalledWith('/npm/bin/opencode', controller.signal)
  })

  it('finds a managed opencode via extraDirs even when it is not on PATH', async () => {
    const managedDir = '/home/user/.open-science/opencode-managed/bin'
    const result = await detectOpencode(
      createDeps({ [posix.join(managedDir, 'opencode')]: '1.19.0' }, { extraDirs: [managedDir] })
    )

    expect(result).toEqual({ resolvedPath: posix.join(managedDir, 'opencode'), version: '1.19.0' })
  })

  it('probes the ~/.opencode/bin install-script target', async () => {
    const result = await detectOpencode(
      createDeps({ '/home/user/.opencode/bin/opencode': '1.20.0' })
    )

    expect(result).toEqual({
      resolvedPath: '/home/user/.opencode/bin/opencode',
      version: '1.20.0'
    })
  })

  it('skips a path that exists but cannot report a version', async () => {
    const result = await detectOpencode(
      createDeps(
        {},
        { isExecutable: () => Promise.resolve(true), getVersion: () => Promise.resolve(undefined) }
      )
    )

    expect(result).toBeUndefined()
  })

  it('continues discovery after a failed candidate probe without swallowing cancellation', async () => {
    const controller = new AbortController()
    const deps = createDeps(
      { '/usr/bin/opencode': '', '/usr/local/bin/opencode': '1.19.1' },
      {
        getVersion: async (candidate, signal) => {
          signal?.throwIfAborted()
          if (candidate === '/usr/bin/opencode') throw new Error('failed candidate')
          return '1.19.1'
        }
      }
    )
    await expect(detectOpencode(deps, controller.signal)).resolves.toMatchObject({
      version: '1.19.1'
    })
    controller.abort(new Error('cancelled'))
    await expect(detectOpencode(deps, controller.signal)).rejects.toThrow('cancelled')
  })

  it('tolerates a failing npm bin resolution', async () => {
    const result = await detectOpencode(
      createDeps({}, { resolveNpmBinDirs: () => Promise.reject(new Error('npm missing')) })
    )

    expect(result).toBeUndefined()
  })

  describe('windows', () => {
    const winDeps = (
      installed: Record<string, string>,
      overrides: Partial<OpencodeDetectDeps> = {}
    ): OpencodeDetectDeps =>
      createDeps(installed, {
        platform: 'win32',
        env: {
          PATH: 'C:\\Windows;C:\\Users\\me\\bin',
          APPDATA: 'C:\\Users\\me\\AppData\\Roaming'
        },
        homePath: 'C:\\Users\\me',
        ...overrides
      })

    it('probes %APPDATA%\\npm and the home install dirs, not the Unix dirs', async () => {
      const dirs = await Array.fromAsync(candidateDirs(winDeps({})))

      expect(dirs).toContain(win32.join('C:\\Users\\me\\AppData\\Roaming', 'npm'))
      expect(dirs).toContain(win32.join('C:\\Users\\me', '.opencode', 'bin'))
      expect(dirs).not.toContain('/opt/homebrew/bin')
    })

    it('finds opencode.exe from a managed install dir', async () => {
      const managedDir = win32.join('C:\\Users\\me\\AppData\\Local', 'open-science', 'bin')
      const result = await detectOpencode(
        winDeps({ [win32.join(managedDir, 'opencode.exe')]: '1.18.0' }, { extraDirs: [managedDir] })
      )

      expect(result).toEqual({
        resolvedPath: win32.join(managedDir, 'opencode.exe'),
        version: '1.18.0'
      })
    })

    it('finds opencode.cmd ahead of the bare name', async () => {
      const npmDir = win32.join('C:\\Users\\me\\AppData\\Roaming', 'npm')
      const result = await detectOpencode(
        winDeps({ [win32.join(npmDir, 'opencode.cmd')]: '1.1.0' })
      )

      expect(result).toEqual({
        resolvedPath: win32.join(npmDir, 'opencode.cmd'),
        version: '1.1.0'
      })
    })
  })
})
