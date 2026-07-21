import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createOverlayVenv,
  ensureOverlayProtocolFloor,
  overlayExists,
  overlayPythonBin,
  overlayVenvDir,
  prepareExternalPythonRuntime,
  slugForInterpreter
} from './venv-overlay'

const tmpRoots: string[] = []
const makeRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'os-venv-overlay-'))
  tmpRoots.push(dir)
  return dir
}
// Materializes a fake interpreter file so overlayExists() returns true.
const touchBin = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x')
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
})

describe('overlayVenvDir layout', () => {
  it('places overlays under a venvs/ sibling of envs/', () => {
    expect(overlayVenvDir('/r', 'abc123')).toBe(join('/r', 'venvs', 'abc123'))
  })
})

describe('platform-aware overlay interpreter path', () => {
  const original = process.platform
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }
  afterEach(() => setPlatform(original))

  it('uses the Unix bin/ layout on darwin/linux', () => {
    setPlatform('linux')
    const dir = '/root/venvs/e'
    expect(overlayPythonBin(dir)).toBe(join(dir, 'bin', 'python'))
  })

  it('uses the Windows Scripts\\ venv layout on win32', () => {
    setPlatform('win32')
    const dir = 'C:\\root\\venvs\\e'
    expect(overlayPythonBin(dir)).toBe(join(dir, 'Scripts', 'python.exe'))
  })
})

describe('createOverlayVenv', () => {
  it('runs `-m venv --system-site-packages <dir>` and returns the overlay bin', async () => {
    const dir = join(makeRoot(), 'venvs', 'slug')
    const calls: Array<{ command: string; args: string[] }> = []
    const run = async (command: string, args: string[]): Promise<void> => {
      calls.push({ command, args })
    }

    const bin = await createOverlayVenv('/usr/bin/python3', dir, { run })

    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('/usr/bin/python3')
    expect(calls[0].args).toEqual(['-m', 'venv', '--system-site-packages', dir])
    expect(bin).toBe(overlayPythonBin(dir))
  })

  it('prepends base launcher args (e.g. `py -3`) before -m venv', async () => {
    const dir = join(makeRoot(), 'venvs', 'slug')
    const calls: Array<{ command: string; args: string[] }> = []
    const run = async (command: string, args: string[]): Promise<void> => {
      calls.push({ command, args })
    }

    await createOverlayVenv('py', dir, { run }, ['-3'])

    expect(calls[0].command).toBe('py')
    expect(calls[0].args).toEqual(['-3', '-m', 'venv', '--system-site-packages', dir])
  })

  it('is idempotent: skips the run when the overlay bin already exists', async () => {
    const dir = join(makeRoot(), 'venvs', 'slug')
    // Pre-create the expected interpreter so overlayExists() short-circuits the subprocess.
    touchBin(overlayPythonBin(dir))
    expect(overlayExists(dir)).toBe(true)

    let called = false
    const run = async (): Promise<void> => {
      called = true
    }

    const bin = await createOverlayVenv('/usr/bin/python3', dir, { run })

    expect(called).toBe(false)
    expect(bin).toBe(overlayPythonBin(dir))
  })

  it('removes a partially-built overlay dir when the build fails, so the next run retries clean', async () => {
    const dir = join(makeRoot(), 'venvs', 'slug')
    // Simulate a build that created the interpreter symlink but then died before completing (e.g.
    // ensurepip failed): overlayExists() would otherwise treat this leftover as ready.
    const run = async (): Promise<void> => {
      touchBin(overlayPythonBin(dir))
      throw new Error('ensurepip failed')
    }

    await expect(createOverlayVenv('/usr/bin/python3', dir, { run })).rejects.toThrow(
      'ensurepip failed'
    )
    // The partial build is gone, so a subsequent first-use does not short-circuit onto a pip-less venv.
    expect(overlayExists(dir)).toBe(false)
  })
})

describe('ensureOverlayProtocolFloor', () => {
  it('accepts matplotlib already visible through system site packages', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    await ensureOverlayProtocolFloor('/overlay/bin/python', {
      run: async (command, args) => {
        calls.push({ command, args })
      }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ command: '/overlay/bin/python' })
    expect(calls[0].args).toEqual(['-c', expect.stringContaining('import json, matplotlib')])
  })

  it('installs matplotlib into the overlay when the protocol probe fails', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    await ensureOverlayProtocolFloor('/overlay/bin/python', {
      run: async (command, args) => {
        calls.push({ command, args })
        if (calls.length === 1) throw new Error('missing matplotlib')
      }
    })

    expect(calls).toHaveLength(3)
    expect(calls[0].args).toEqual(['-c', expect.stringContaining('import json, matplotlib')])
    expect(calls[1].args).toEqual(['-m', 'pip', 'install', 'matplotlib'])
    expect(calls[2].args).toEqual(['-c', expect.stringContaining('import json, matplotlib')])
  })

  it('uses the configured package index and CA, and rejects when the post-install probe fails', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    await expect(
      ensureOverlayProtocolFloor(
        '/overlay/bin/python',
        {
          run: async (_command, args, env) => {
            calls.push({ args, env })
            if (args[0] === '-c') throw new Error('protocol unavailable')
          }
        },
        { pypiIndex: 'https://packages.example/simple', caBundle: '/ca.pem' }
      )
    ).rejects.toThrow('protocol unavailable')

    expect(calls[1].args).toEqual([
      '-m',
      'pip',
      'install',
      '-i',
      'https://packages.example/simple',
      'matplotlib'
    ])
    expect(calls[1].env).toMatchObject({ PIP_CERT: '/ca.pem', SSL_CERT_FILE: '/ca.pem' })
  })
})

describe('prepareExternalPythonRuntime', () => {
  it('creates and probes the overlay before returning its interpreter', async () => {
    const root = makeRoot()
    const calls: string[][] = []
    const selection = {
      source: 'external' as const,
      interpreterPath: '/usr/bin/python3',
      interpreterArgs: ['-I'],
      appOwnedOverlay: true as const,
      packageInstallAuthorized: true
    }

    const bin = await prepareExternalPythonRuntime(
      selection,
      root,
      {},
      {
        run: async (_command, args) => void calls.push(args)
      }
    )

    expect(bin).toBe(
      overlayPythonBin(overlayVenvDir(root, slugForInterpreter('/usr/bin/python3', ['-I'])))
    )
    expect(calls[0]).toEqual([
      '-I',
      '-m',
      'venv',
      '--system-site-packages',
      join(root, 'venvs', slugForInterpreter('/usr/bin/python3', ['-I']))
    ])
    expect(calls[1]).toEqual(['-c', expect.stringContaining('import json, matplotlib')])
  })
})

describe('slugForInterpreter', () => {
  it('is deterministic for the same interpreter path', () => {
    expect(slugForInterpreter('/opt/py/bin/python3')).toBe(
      slugForInterpreter('/opt/py/bin/python3')
    )
  })

  it('differs for different interpreter paths', () => {
    expect(slugForInterpreter('/opt/a/python3')).not.toBe(slugForInterpreter('/opt/b/python3'))
  })

  it('produces a filesystem-safe segment (hex only, no separators)', () => {
    const slug = slugForInterpreter('C:\\Program Files\\Python 3.12\\python.exe')
    expect(slug).toMatch(/^[0-9a-f]+$/)
  })

  it('differs when only the launcher args differ (py -3.11 vs py -3.12) so overlays never collide', () => {
    expect(slugForInterpreter('py', ['-3.11'])).not.toBe(slugForInterpreter('py', ['-3.12']))
    // …and the path-only overload stays stable against an explicit empty-args call.
    expect(slugForInterpreter('/opt/py/bin/python3')).toBe(
      slugForInterpreter('/opt/py/bin/python3', [])
    )
  })
})
