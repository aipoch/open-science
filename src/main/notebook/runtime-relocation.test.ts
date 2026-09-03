import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { envsLockDir, exportRuntimeLocks } from './runtime-relocation'
import { DEFAULT_PY_ENV, envPrefix, pythonBin, rBin, runtimeRoot } from './runtime-paths'

const roots: string[] = []
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'reloc-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// Creates <dataRoot>/runtime/envs/<name>/bin/<python|R> so the env looks materialized.
const seedEnv = async (dataRoot: string, name: string, lang: 'python' | 'r'): Promise<void> => {
  const prefix = envPrefix(runtimeRoot(dataRoot), name)
  const bin = lang === 'python' ? pythonBin(prefix) : rBin(prefix)
  // mkdir the interpreter's actual parent (Unix bin/, Windows Lib\R\bin) so seeding works on both.
  await mkdir(dirname(bin), { recursive: true })
  await writeFile(bin, '')
}

const LOCK_STDOUT = [
  '# comment line',
  '@EXPLICIT',
  'https://conda.anaconda.org/conda-forge/noarch/numpy-1.conda#abc',
  'https://conda.anaconda.org/conda-forge/noarch/pandas-2.conda#def'
].join('\n')

describe('exportRuntimeLocks', () => {
  it('exports a normalized @EXPLICIT lock per materialized env into the new root', async () => {
    const from = await makeRoot()
    const to = await makeRoot()
    await seedEnv(from, 'default-python', 'python')
    await seedEnv(from, 'my-analysis', 'python')

    const capture = vi.fn().mockResolvedValue(LOCK_STDOUT)
    const exported = await exportRuntimeLocks(from, to, { mm: '/mm', capture })

    expect(exported.sort()).toEqual(['default-python', 'my-analysis'])
    const outDir = envsLockDir(runtimeRoot(to))
    expect((await readdir(outDir)).sort()).toEqual(['default-python.lock', 'my-analysis.lock'])
    const lock = await readFile(join(outDir, 'default-python.lock'), 'utf8')
    expect(lock.startsWith('@EXPLICIT\n')).toBe(true)
    expect(lock).toContain('numpy-1.conda#abc')
    expect(lock).not.toContain('# comment line')
    // Each env is exported against its own prefix.
    expect(capture).toHaveBeenCalledWith([
      '/mm',
      '--no-rc',
      'list',
      '--prefix',
      envPrefix(runtimeRoot(from), 'default-python'),
      '--explicit',
      '--md5'
    ])
  })

  it('exports the short Windows default under its logical lock name and ignores a legacy duplicate', async () => {
    const from = await makeRoot()
    const to = await makeRoot()
    const envsDir = join(runtimeRoot(from), 'envs')
    const shortPrefix = join(envsDir, '.p')
    const legacyPrefix = join(envsDir, DEFAULT_PY_ENV)
    for (const prefix of [shortPrefix, legacyPrefix]) {
      const bin = pythonBin(prefix, 'win32')
      await mkdir(dirname(bin), { recursive: true })
      await writeFile(bin, '')
    }

    const capture = vi.fn().mockResolvedValue(LOCK_STDOUT)
    const exported = await exportRuntimeLocks(from, to, {
      mm: '/mm',
      capture,
      platform: 'win32'
    })

    expect(exported).toEqual([DEFAULT_PY_ENV])
    expect(capture).toHaveBeenCalledOnce()
    expect(capture.mock.calls[0]?.[0]).toContain(shortPrefix)
    expect(await readdir(envsLockDir(runtimeRoot(to)))).toEqual([`${DEFAULT_PY_ENV}.lock`])
  })

  it('returns [] and writes nothing when micromamba is unavailable', async () => {
    const from = await makeRoot()
    const to = await makeRoot()
    await seedEnv(from, 'default-python', 'python')
    const capture = vi.fn()
    expect(await exportRuntimeLocks(from, to, { mm: undefined, capture })).toEqual([])
    expect(capture).not.toHaveBeenCalled()
  })

  it('ignores leftovers with no interpreter but rejects a materialized env with no package URLs', async () => {
    const from = await makeRoot()
    const to = await makeRoot()
    // A dir without any bin — mid-creation leftover.
    await mkdir(envPrefix(runtimeRoot(from), 'half-made'), { recursive: true })
    // A real env whose lock has no URLs (should be skipped, not written empty).
    await seedEnv(from, 'default-r', 'r')

    const capture = vi.fn().mockResolvedValue('@EXPLICIT\n')
    await expect(exportRuntimeLocks(from, to, { mm: '/mm', capture })).rejects.toThrow(
      'no package URLs'
    )
    // capture only runs for the env with an interpreter, never the leftover.
    expect(capture).toHaveBeenCalledTimes(1)
    await expect(readdir(envsLockDir(runtimeRoot(to)))).rejects.toThrow()
  })

  it('publishes no bundle when any materialized env export fails', async () => {
    const from = await makeRoot()
    const to = await makeRoot()
    await seedEnv(from, 'default-python', 'python')
    await seedEnv(from, 'broken', 'python')

    const capture = vi.fn().mockImplementation(async (argv: string[]) => {
      if (argv.includes(envPrefix(runtimeRoot(from), 'broken'))) throw new Error('list failed')
      return LOCK_STDOUT
    })
    await expect(exportRuntimeLocks(from, to, { mm: '/mm', capture })).rejects.toThrow(
      'list failed'
    )
    await expect(readdir(envsLockDir(runtimeRoot(to)))).rejects.toThrow()
  })

  it('removes the unpublished bundle when writing any lock fails', async () => {
    const from = await makeRoot()
    const to = await makeRoot()
    await seedEnv(from, 'default-python', 'python')
    await seedEnv(from, 'my-analysis', 'python')

    const writeLock = vi.fn((path: string, contents: string) => {
      if (path.endsWith('my-analysis.lock')) throw new Error('disk full')
      writeFileSync(path, contents, 'utf8')
    })

    await expect(
      exportRuntimeLocks(from, to, {
        mm: '/mm',
        capture: vi.fn().mockResolvedValue(LOCK_STDOUT),
        writeLock
      })
    ).rejects.toThrow('disk full')
    await expect(readdir(envsLockDir(runtimeRoot(to)))).rejects.toThrow()
    expect(await readdir(runtimeRoot(to))).toEqual([])
  })
})
