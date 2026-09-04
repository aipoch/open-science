import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  findPythonCommand,
  isPython3Version,
  resolvePythonCommand,
  validateNotebookHelperExports
} from './python-command'

describe('resolvePythonCommand', () => {
  it('accepts Python 3 versions and rejects Python 2', () => {
    expect(isPython3Version('Python 3.12.2')).toBe(true)
    expect(isPython3Version('Python 2.7.18')).toBe(false)
  })

  it('returns undefined from the non-blocking environment probe when Python is missing', async () => {
    const result = await findPythonCommand({
      platform: 'linux',
      probe: vi.fn().mockResolvedValue(false)
    })

    expect(result).toBeUndefined()
  })

  it('prefers python3, then python, on unix', async () => {
    const tried: string[] = []
    const result = await resolvePythonCommand({
      platform: 'linux',
      probe: ({ command }) => {
        tried.push(command)
        return Promise.resolve(command === 'python')
      }
    })

    expect(tried).toEqual(['python3', 'python'])
    expect(result).toEqual({ command: 'python', baseArgs: [] })
  })

  it('does not execute /usr/bin/python3 during automatic macOS detection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-python-stub-'))
    const bin = join(root, 'bin')
    const marker = join(root, 'python3-invoked')
    const originalPath = process.env.PATH

    try {
      await mkdir(bin)
      await writeFile(
        join(bin, 'python3'),
        `#!/bin/sh\nprintf invoked > "${marker}"\nprintf 'Python 3.9.6\\n'\n`
      )
      await chmod(join(bin, 'python3'), 0o755)
      process.env.PATH = bin

      const result = await findPythonCommand({
        platform: 'darwin',
        resolveExecutables: async (command) => (command === 'python3' ? ['/usr/bin/python3'] : [])
      })

      expect(result).toBeUndefined()
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still probes a non-Apple python3 on macOS', async () => {
    const probe = vi.fn().mockResolvedValue(true)

    const result = await findPythonCommand({
      platform: 'darwin',
      probe,
      resolveExecutables: async () => ['/opt/homebrew/bin/python3']
    })

    expect(result).toEqual({ command: '/opt/homebrew/bin/python3', baseArgs: [] })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('finds a later non-Apple python3 when /usr/bin appears first on PATH', async () => {
    const probe = vi.fn(({ command }) => Promise.resolve(command === '/opt/homebrew/bin/python3'))

    const result = await findPythonCommand({
      platform: 'darwin',
      probe,
      resolveExecutables: async () => ['/usr/bin/python3', '/opt/homebrew/bin/python3']
    })

    expect(result).toEqual({ command: '/opt/homebrew/bin/python3', baseArgs: [] })
    expect(probe).not.toHaveBeenCalledWith({ command: '/usr/bin/python3', baseArgs: [] })
  })

  it('ignores /usr/bin/python3 even when Apple developer tools are available', async () => {
    const probe = vi.fn(({ command }) => Promise.resolve(command === 'python3'))

    const result = await findPythonCommand({
      platform: 'darwin',
      probe,
      resolveExecutables: async () => ['/usr/bin/python3']
    })

    expect(result).toBeUndefined()
    expect(probe).not.toHaveBeenCalledWith({ command: 'python3', baseArgs: [] })
  })

  it('prefers the `py -3` launcher on windows', async () => {
    const result = await resolvePythonCommand({
      platform: 'win32',
      probe: ({ command }) => Promise.resolve(command === 'py')
    })

    expect(result).toEqual({ command: 'py', baseArgs: ['-3'] })
  })

  it('falls through py -> python -> python3 on windows', async () => {
    const tried: string[] = []
    const result = await resolvePythonCommand({
      platform: 'win32',
      probe: ({ command }) => {
        tried.push(command)
        return Promise.resolve(command === 'python3')
      }
    })

    expect(tried).toEqual(['py', 'python', 'python3'])
    expect(result).toEqual({ command: 'python3', baseArgs: [] })
  })

  it('falls back to the preferred candidate when none respond', async () => {
    const win = await resolvePythonCommand({
      platform: 'win32',
      probe: () => Promise.resolve(false)
    })
    const nix = await resolvePythonCommand({
      platform: 'linux',
      probe: () => Promise.resolve(false)
    })

    expect(win).toEqual({ command: 'py', baseArgs: ['-3'] })
    expect(nix).toEqual({ command: 'python3', baseArgs: [] })
  })
})

describe('validateNotebookHelperExports', () => {
  it('validates trusted bundled helpers when Python lacks audit hooks', async () => {
    const python = await resolvePythonCommand()
    const legacyPython = {
      ...python,
      baseArgs: [...python.baseArgs, '-c', 'import sys; del sys.addaudithook; exec(sys.argv[-1])']
    }
    const source = 'def compose_figure():\n    return None\n'

    await expect(
      validateNotebookHelperExports('figure-composer', source, ['compose_figure'], {
        python: legacyPython,
        trustedSource: true
      })
    ).resolves.toBeUndefined()
    await expect(
      validateNotebookHelperExports('external-helper', source, ['compose_figure'], {
        python: legacyPython
      })
    ).rejects.toThrow('external helper validation requires Python audit-hook support')
  })

  it('validates UTF-8 helper source when the interpreter defaults stdin to a legacy encoding', async () => {
    const python = await resolvePythonCommand()

    await expect(
      validateNotebookHelperExports(
        'utf8-helper',
        'def public_value():\n    return "a — b"\n',
        ['public_value'],
        {
          python: { ...python, baseArgs: [...python.baseArgs, '-X', 'utf8=0'] },
          env: {
            LC_ALL: 'C',
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR
          }
        }
      )
    ).resolves.toBeUndefined()
  })
})
