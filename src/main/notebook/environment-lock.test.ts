import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DiscoveredInterpreter } from '../../shared/notebook-runtime'
import {
  downloadExplicitLockPackages,
  exportEnvironmentLock,
  managedEnvironmentRef,
  parseExplicitLock
} from './environment-lock'
import { isSafePackageBasename } from './pack-content'
import { md5File } from './provisioner-runtime'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  writeReadyMarker
} from './runtime-paths'

const roots: string[] = []
const makeRuntimeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'envlock-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const interpreter = (overrides: Partial<DiscoveredInterpreter>): DiscoveredInterpreter => ({
  language: 'python',
  provenance: 'app-managed',
  envId: '/runtime/envs/default-python/bin/python',
  interpreterPath: '/runtime/envs/default-python/bin/python',
  label: 'Default Python',
  runnable: true,
  ...overrides
})

// Realistic `micromamba list --explicit --md5` stdout: comment/header lines, padded URL lines,
// and a non-URL title line that must all be stripped.
const EXPLICIT_STDOUT = [
  '# platform: linux-64',
  '@EXPLICIT',
  '  https://conda.anaconda.org/conda-forge/noarch/python-3.12.conda#abc123  ',
  'https://conda.anaconda.org/conda-forge/linux-64/numpy-2.1.conda#def456',
  'a non-URL title line'
].join('\n')

const EXPLICIT_LOCK =
  [
    '@EXPLICIT',
    'https://conda.anaconda.org/conda-forge/noarch/python-3.12.conda#abc123',
    'https://conda.anaconda.org/conda-forge/linux-64/numpy-2.1.conda#def456'
  ].join('\n') + '\n'

describe('exportEnvironmentLock', () => {
  it('normalizes valid explicit output into a validated @EXPLICIT lock', async () => {
    const capture = vi.fn().mockResolvedValue(EXPLICIT_STDOUT)
    const lock = await exportEnvironmentLock(
      { name: 'default-python', prefix: '/runtime/envs/default-python' },
      { mm: '/mm', capture }
    )
    expect(lock).toBe(EXPLICIT_LOCK)
    expect(capture).toHaveBeenCalledWith([
      '/mm',
      '--no-rc',
      'list',
      '--prefix',
      '/runtime/envs/default-python',
      '--explicit',
      '--md5'
    ])
  })

  it('rejects an env whose exported lock has no package URLs', async () => {
    const capture = vi.fn().mockResolvedValue('# nothing installed\n@EXPLICIT\n')
    await expect(
      exportEnvironmentLock(
        { name: 'default-r', prefix: '/runtime/envs/default-r' },
        { mm: '/mm', capture }
      )
    ).rejects.toThrow('Could not export default-r: the exported lock contains no package URLs.')
  })

  it('propagates micromamba capture failures unchanged', async () => {
    const failure = new Error('micromamba failed (/mm list --prefix): no such environment')
    const capture = vi.fn().mockRejectedValue(failure)
    await expect(
      exportEnvironmentLock(
        { name: 'half-made', prefix: '/runtime/envs/half-made' },
        { mm: '/mm', capture }
      )
    ).rejects.toBe(failure)
  })
})

describe('managedEnvironmentRef', () => {
  it('resolves and exports a managed Python env from a discovered interpreter', async () => {
    const runtime = await makeRuntimeRoot()
    const prefix = envPrefix(runtime, DEFAULT_PY_ENV)
    const ref = managedEnvironmentRef(interpreter({ condaEnv: DEFAULT_PY_ENV }), runtime)
    expect(ref).toEqual({ name: DEFAULT_PY_ENV, prefix })
    if (!ref) throw new Error('expected a managed ref')

    const capture = vi.fn().mockResolvedValue(EXPLICIT_STDOUT)
    await expect(exportEnvironmentLock(ref, { mm: '/mm', capture })).resolves.toBe(EXPLICIT_LOCK)
    expect(capture.mock.calls[0]?.[0]).toContain(prefix)
  })

  it('resolves and exports a managed R env from a discovered interpreter', async () => {
    const runtime = await makeRuntimeRoot()
    const prefix = envPrefix(runtime, DEFAULT_R_ENV)
    const ref = managedEnvironmentRef(
      interpreter({
        language: 'r',
        provenance: 'app-managed',
        condaEnv: DEFAULT_R_ENV,
        interpreterPath: '/runtime/envs/default-r/bin/R'
      }),
      runtime
    )
    expect(ref).toEqual({ name: DEFAULT_R_ENV, prefix })
    if (!ref) throw new Error('expected a managed ref')

    const capture = vi.fn().mockResolvedValue(EXPLICIT_STDOUT)
    await expect(exportEnvironmentLock(ref, { mm: '/mm', capture })).resolves.toBe(EXPLICIT_LOCK)
    expect(capture.mock.calls[0]?.[0]).toContain(prefix)
  })

  it('returns undefined rather than guessing when a managed interpreter has no conda env name', () => {
    expect(managedEnvironmentRef(interpreter({ condaEnv: undefined }), '/runtime')).toBeUndefined()
  })

  it('treats agent-created envs as managed', () => {
    const runtime = '/runtime'
    const ref = managedEnvironmentRef(
      interpreter({ provenance: 'agent-created', condaEnv: 'my-analysis' }),
      runtime
    )
    expect(ref).toEqual({ name: 'my-analysis', prefix: envPrefix(runtime, 'my-analysis') })
  })

  it('returns undefined for user-own interpreters, even inside a foreign conda env', () => {
    const ref = managedEnvironmentRef(
      interpreter({
        provenance: 'user-own',
        condaEnv: 'my-conda-env',
        interpreterPath: '/home/u/miniconda3/envs/my-conda-env/bin/python'
      }),
      '/runtime'
    )
    expect(ref).toBeUndefined()
  })

  it('resolves the Windows short default prefix when the ready marker commits it', async () => {
    const runtime = await makeRuntimeRoot()
    const shortPrefix = join(runtime, 'envs', '.p')
    await mkdir(shortPrefix, { recursive: true })
    writeReadyMarker(runtime, DEFAULT_ENV_VERSION, 'ready', '.p')

    const ref = managedEnvironmentRef(
      interpreter({
        condaEnv: DEFAULT_PY_ENV,
        interpreterPath: join(shortPrefix, 'python.exe')
      }),
      runtime,
      'win32'
    )
    expect(ref).toEqual({ name: DEFAULT_PY_ENV, prefix: shortPrefix })
    if (!ref) throw new Error('expected a managed ref')

    const capture = vi.fn().mockResolvedValue(EXPLICIT_STDOUT)
    await expect(exportEnvironmentLock(ref, { mm: 'C:\\mm.exe', capture })).resolves.toBe(
      EXPLICIT_LOCK
    )
    expect(capture.mock.calls[0]?.[0]).toContain(shortPrefix)
  })
})

const md5Of = (content: string): string => {
  const hash = createHash('md5')
  hash.update(content)
  return hash.digest('hex')
}

const lockLine = (subdir: string, file: string, md5: string): string =>
  `https://conda.anaconda.org/conda-forge/${subdir}/${file}#${md5}`

describe('parseExplicitLock', () => {
  const MD5 = md5Of('pkg')
  const lock = (lines: string[]): string => `@EXPLICIT\n${lines.join('\n')}\n`

  it('parses a valid lock into pinned entries and ignores comments', () => {
    const entries = parseExplicitLock(
      lock([
        '# platform: linux-64',
        lockLine('linux-64', 'python-3.12.conda', MD5),
        lockLine('noarch', 'numpy-2.1.conda', MD5)
      ]),
      { platform: 'linux', arch: 'x64' }
    )
    expect(entries).toEqual([
      {
        url: `https://conda.anaconda.org/conda-forge/linux-64/python-3.12.conda`,
        file: 'python-3.12.conda',
        md5: MD5
      },
      {
        url: `https://conda.anaconda.org/conda-forge/noarch/numpy-2.1.conda`,
        file: 'numpy-2.1.conda',
        md5: MD5
      }
    ])
  })

  it('rejects a lock that is missing the @EXPLICIT marker', () => {
    expect(() =>
      parseExplicitLock(lock([lockLine('linux-64', 'a.conda', MD5)]).replace('@EXPLICIT\n', ''), {
        platform: 'linux',
        arch: 'x64'
      })
    ).toThrow('not a valid @EXPLICIT')
  })

  it('rejects a lock with no package URLs', () => {
    expect(() => parseExplicitLock('@EXPLICIT\n', { platform: 'linux', arch: 'x64' })).toThrow(
      'no package URLs'
    )
  })

  it('rejects malformed md5 and malformed URLs', () => {
    expect(() =>
      parseExplicitLock(lock([lockLine('linux-64', 'a.conda', 'zz')]), {
        platform: 'linux',
        arch: 'x64'
      })
    ).toThrow('malformed package entry')
    expect(() =>
      parseExplicitLock(lock([`https://conda.anaconda.org#${MD5}`]), {
        platform: 'linux',
        arch: 'x64'
      })
    ).toThrow('malformed package entry')
  })

  it('rejects sha256-digest locks with a clear unsupported error', () => {
    const sha = 'a'.repeat(64)
    expect(() =>
      parseExplicitLock(lock([lockLine('linux-64', 'a.conda', sha)]), {
        platform: 'linux',
        arch: 'x64'
      })
    ).toThrow('sha256')
  })

  it('rejects a lock exported for a different platform', () => {
    expect(() =>
      parseExplicitLock(lock([lockLine('osx-arm64', 'python-3.12.conda', MD5)]), {
        platform: 'linux',
        arch: 'x64'
      })
    ).toThrow('osx-arm64')
  })

  it('rejects duplicate package files', () => {
    expect(() =>
      parseExplicitLock(
        lock([lockLine('linux-64', 'a.conda', MD5), lockLine('linux-64', 'a.conda', MD5)]),
        { platform: 'linux', arch: 'x64' }
      )
    ).toThrow('duplicate')
  })

  it('rejects an unsupported non-URL body line instead of dropping it', () => {
    expect(() =>
      parseExplicitLock(lock(['python=3.12, numpy']), { platform: 'linux', arch: 'x64' })
    ).toThrow('unsupported line')
  })

  it('rejects a backslash traversal basename before it reaches any download destination', () => {
    // `url.split('/')` leaves `..\..\.env-ready` intact as the "basename"; on Windows join() would
    // resolve it OUTSIDE the staging dir — the shared basename validator must reject it first.
    expect(() =>
      parseExplicitLock(`@EXPLICIT\nhttps://example.com/linux-64/..\\..\\.env-ready#${MD5}\n`, {
        platform: 'linux',
        arch: 'x64'
      })
    ).toThrow('malformed package entry')
  })

  it('validates package basenames with Windows semantics regardless of the host', () => {
    // Every unsafe form must reject, on any host OS: traversal (both separators), dot segments,
    // Windows drive paths, and non-conda extensions.
    for (const file of [
      '..\\..\\foo.conda',
      '../foo.conda',
      '.\\foo.conda',
      'C:\\foo.conda',
      'foo/bar.conda',
      '.',
      '..',
      '.env-ready',
      'foo.txt'
    ]) {
      expect(isSafePackageBasename(file)).toBe(false)
    }
    expect(isSafePackageBasename('python-3.12.conda')).toBe(true)
    expect(isSafePackageBasename('old-base.tar.bz2')).toBe(true)
  })
})

describe('downloadExplicitLockPackages', () => {
  const MD5 = md5Of('tarball bytes')

  it('downloads every entry and verifies each md5', async () => {
    const dir = await makeRuntimeRoot()
    const entries = parseExplicitLock(
      `@EXPLICIT\n${lockLine('linux-64', 'python-3.12.conda', MD5)}\n`,
      { platform: 'linux', arch: 'x64' }
    )
    const download = vi.fn().mockImplementation(async (_url, dest) => {
      await writeFile(dest, 'tarball bytes', 'utf8')
    })
    const seen: Array<[number, number]> = []
    await downloadExplicitLockPackages(entries, dir, {
      download,
      md5: (path) => md5File(path),
      onProgress: (completed, total) => seen.push([completed, total])
    })
    expect(download).toHaveBeenCalledOnce()
    expect(seen).toEqual([[1, 1]])
    expect((await md5File(join(dir, 'python-3.12.conda'))).toLowerCase()).toBe(MD5)
  })

  it('rejects a download whose md5 does not match the lock', async () => {
    const dir = await makeRuntimeRoot()
    const entries = parseExplicitLock(
      `@EXPLICIT\n${lockLine('linux-64', 'python-3.12.conda', MD5)}\n`,
      { platform: 'linux', arch: 'x64' }
    )
    const download = vi.fn().mockImplementation(async (_url, dest) => {
      await writeFile(dest, 'CORRUPTED', 'utf8')
    })
    await expect(
      downloadExplicitLockPackages(entries, dir, { download, md5: (path) => md5File(path) })
    ).rejects.toThrow('md5 verification')
  })

  it('propagates an aborted download signal', async () => {
    const dir = await makeRuntimeRoot()
    const entries = parseExplicitLock(
      `@EXPLICIT\n${lockLine('linux-64', 'python-3.12.conda', MD5)}\n`,
      { platform: 'linux', arch: 'x64' }
    )
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const download = vi.fn().mockRejectedValue(controller.signal.reason)
    await expect(
      downloadExplicitLockPackages(entries, dir, {
        download,
        md5: (path) => md5File(path),
        signal: controller.signal
      })
    ).rejects.toThrow('cancelled')
    expect(download).toHaveBeenCalledOnce()
  })
})
