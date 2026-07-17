import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { chainFetchBundle, createLocalBundleAdapter, resolveBundleDir } from './bundle-local'
import type { EnvSpec, FetchedBundle } from './provisioner'
import { pkgsCache } from './runtime-paths'

const PY_SPEC: EnvSpec = { name: 'default-python', language: 'python', packages: [] }

const roots: string[] = []
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-local-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveBundleDir', () => {
  it('returns an override only when it exists', async () => {
    const root = await makeRoot()
    expect(resolveBundleDir({ override: root })).toBe(root)
    expect(resolveBundleDir({ override: join(root, 'missing') })).toBeUndefined()
  })

  it('prefers app.asar.unpacked under resourcesPath', async () => {
    const root = await makeRoot()
    const unpacked = join(root, 'app.asar.unpacked', 'resources', 'default-envs')
    await mkdir(unpacked, { recursive: true })
    expect(resolveBundleDir({ resourcesPath: root })).toBe(unpacked)
  })
})

describe('createLocalBundleAdapter', () => {
  it('seeds tarballs into the pkgs cache and returns the bundled lock when the lock exists', async () => {
    const root = await makeRoot()
    const bundleDir = join(root, 'bundle')
    await mkdir(join(bundleDir, 'pkgs'), { recursive: true })
    const lockPath = join(bundleDir, 'default-python.lock')
    await writeFile(
      lockPath,
      [
        '@EXPLICIT',
        'https://conda.anaconda.org/conda-forge/osx-arm64/numpy-1.conda#aaa',
        'https://conda.anaconda.org/conda-forge/osx-arm64/python-3.12.conda#bbb'
      ].join('\n') + '\n'
    )
    await writeFile(join(bundleDir, 'pkgs', 'numpy-1.conda'), 'a')
    await writeFile(join(bundleDir, 'pkgs', 'python-3.12.conda'), 'b')

    const dataRoot = join(root, 'data')
    const adapter = createLocalBundleAdapter(dataRoot, bundleDir)
    const bundle = (await adapter(PY_SPEC, 1, () => {})) as FetchedBundle

    expect(bundle.lockPath).toBe(lockPath)
    expect((await readdir(pkgsCache(dataRoot))).sort()).toEqual([
      'numpy-1.conda',
      'python-3.12.conda'
    ])
  })

  it('returns undefined when the lock is missing, the dir is absent, or pkgs is empty', async () => {
    const root = await makeRoot()
    expect(await createLocalBundleAdapter(root, undefined)(PY_SPEC, 1, () => {})).toBeUndefined()

    const noLock = join(root, 'no-lock')
    await mkdir(join(noLock, 'pkgs'), { recursive: true })
    expect(await createLocalBundleAdapter(root, noLock)(PY_SPEC, 1, () => {})).toBeUndefined()

    const emptyPkgs = join(root, 'empty')
    await mkdir(join(emptyPkgs, 'pkgs'), { recursive: true })
    await writeFile(join(emptyPkgs, 'default-python.lock'), '@EXPLICIT\n')
    expect(await createLocalBundleAdapter(root, emptyPkgs)(PY_SPEC, 1, () => {})).toBeUndefined()
  })

  it('returns undefined when the bundle is incomplete (a lock-referenced tarball is missing)', async () => {
    const root = await makeRoot()
    const dir = join(root, 'partial')
    await mkdir(join(dir, 'pkgs'), { recursive: true })
    await writeFile(
      join(dir, 'default-python.lock'),
      [
        '@EXPLICIT',
        'https://conda.anaconda.org/conda-forge/osx-arm64/numpy-1.conda#aaa',
        'https://conda.anaconda.org/conda-forge/osx-arm64/scipy-1.conda#bbb'
      ].join('\n') + '\n'
    )
    // numpy is present but scipy (also referenced) is missing → fall back to online, not offline.
    await writeFile(join(dir, 'pkgs', 'numpy-1.conda'), 'a')
    expect(await createLocalBundleAdapter(root, dir)(PY_SPEC, 1, () => {})).toBeUndefined()
  })
})

describe('chainFetchBundle', () => {
  it('returns the first defined bundle and stops', async () => {
    const calls: string[] = []
    const chain = chainFetchBundle([
      async () => {
        calls.push('a')
        return undefined
      },
      async () => {
        calls.push('b')
        return { lockPath: '/from-b.lock' }
      },
      async () => {
        calls.push('c')
        return { lockPath: '/from-c.lock' }
      }
    ])
    const bundle = await chain(PY_SPEC, 1, () => {})
    expect(bundle).toEqual({ lockPath: '/from-b.lock' })
    expect(calls).toEqual(['a', 'b'])
  })

  it('returns undefined when every adapter declines', async () => {
    const chain = chainFetchBundle([async () => undefined, async () => undefined])
    expect(await chain(PY_SPEC, 1, () => {})).toBeUndefined()
  })
})
