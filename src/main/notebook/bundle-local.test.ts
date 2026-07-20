import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { packArchiveFile } from './bundle-manifest'
import { chainFetchBundle, createLocalBundleAdapter, resolveBundleDir } from './bundle-local'
import { createPackArchive } from './pack-archive'
import type { EnvSpec, FetchedBundle } from './provisioner'
import { pkgsCache } from './runtime-paths'

// version '3.12' => the adapter looks up the packId-keyed bundle (not the env name).
const PY_SPEC: EnvSpec = {
  name: 'default-python',
  language: 'python',
  version: '3.12',
  packages: []
}

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
  it('seeds tarballs from a staged pack archive and extracts the bundled lock', async () => {
    const root = await makeRoot()
    const bundleDir = join(root, 'bundle')
    const packSource = join(root, 'pack-source')
    const packName = 'python-3.12'
    const archiveName = packArchiveFile('python', '3.12')
    const archivePath = join(bundleDir, archiveName)
    await mkdir(bundleDir, { recursive: true })
    await mkdir(packSource, { recursive: true })
    await writeFile(
      join(packSource, `${packName}.lock`),
      [
        '@EXPLICIT',
        'https://conda.anaconda.org/conda-forge/osx-arm64/numpy-1.conda#0cc175b9c0f1b6a831c399e269772661',
        'https://conda.anaconda.org/conda-forge/osx-arm64/python-3.12.conda#92eb5ffee6ae2fec3ad71c777531578f'
      ].join('\n') + '\n'
    )
    await writeFile(join(packSource, 'numpy-1.conda'), 'a')
    await writeFile(join(packSource, 'python-3.12.conda'), 'b')
    await createPackArchive(packSource, archivePath)
    const bytes = readFileSync(archivePath)
    await writeFile(
      join(bundleDir, 'manifest.json'),
      JSON.stringify(
        {
          schema: 1,
          envVersion: 1,
          subdir: 'osx-arm64',
          packs: {
            [packName]: {
              language: 'python',
              version: '3.12',
              file: archiveName,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              size: bytes.length
            }
          }
        },
        null,
        2
      ) + '\n'
    )

    const dataRoot = join(root, 'data')
    const adapter = createLocalBundleAdapter(dataRoot, bundleDir)
    const bundle = (await adapter(PY_SPEC, 1, () => {})) as FetchedBundle

    expect(bundle.lockPath).toBe(
      join(dataRoot, 'packs', '1', 'osx-arm64', packName, `${packName}.lock`)
    )
    expect((await readdir(pkgsCache(dataRoot))).sort()).toEqual([
      'numpy-1.conda',
      'python-3.12.conda'
    ])
  })

  it('refreshes a stale extracted pack when the staged archive is re-published', async () => {
    const root = await makeRoot()
    const bundleDir = join(root, 'bundle')
    const packName = 'python-3.12'
    const archiveName = packArchiveFile('python', '3.12')
    const archivePath = join(bundleDir, archiveName)
    await mkdir(bundleDir, { recursive: true })
    await writeFile(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        schema: 1,
        envVersion: 1,
        subdir: 'osx-arm64',
        packs: {
          [packName]: {
            language: 'python',
            version: '3.12',
            file: archiveName,
            sha256: 'f'.repeat(64),
            size: 0
          }
        }
      })
    )

    const stalePackDir = join(root, 'data', 'packs', '1', 'osx-arm64', packName)
    await mkdir(stalePackDir, { recursive: true })
    await writeFile(join(stalePackDir, `${packName}.lock`), 'stale')
    await writeFile(join(stalePackDir, 'stale.txt'), 'stale')

    const freshSource = join(root, 'fresh-source')
    await mkdir(freshSource, { recursive: true })
    await writeFile(
      join(freshSource, `${packName}.lock`),
      [
        '@EXPLICIT',
        'https://conda.anaconda.org/conda-forge/osx-arm64/numpy-2.conda#76010858c8362d7302ef5f9436aa6639'
      ].join('\n') + '\n'
    )
    await writeFile(join(freshSource, 'numpy-2.conda'), 'fresh')
    await createPackArchive(freshSource, archivePath)
    const bytes = readFileSync(archivePath)
    await writeFile(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        schema: 1,
        envVersion: 1,
        subdir: 'osx-arm64',
        packs: {
          [packName]: {
            language: 'python',
            version: '3.12',
            file: archiveName,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length
          }
        }
      })
    )

    const adapter = createLocalBundleAdapter(join(root, 'data'), bundleDir)
    const bundle = (await adapter(PY_SPEC, 1, () => {})) as FetchedBundle

    expect(bundle.lockPath).toBe(join(stalePackDir, `${packName}.lock`))
    expect(await readdir(stalePackDir)).toEqual(['numpy-2.conda', 'python-3.12.lock'])
  })

  it('rejects the legacy flat-lock/shared-pkgs bundle shape', async () => {
    const root = await makeRoot()
    const bundleDir = join(root, 'bundle')
    await mkdir(join(bundleDir, 'pkgs'), { recursive: true })
    const lockPath = join(bundleDir, 'python-3.12.lock')
    await writeFile(
      lockPath,
      [
        '@EXPLICIT',
        'https://conda.anaconda.org/conda-forge/osx-arm64/numpy-1.conda#0cc175b9c0f1b6a831c399e269772661',
        'https://conda.anaconda.org/conda-forge/osx-arm64/python-3.12.conda#92eb5ffee6ae2fec3ad71c777531578f'
      ].join('\n') + '\n'
    )
    await writeFile(join(bundleDir, 'pkgs', 'numpy-1.conda'), 'a')
    await writeFile(join(bundleDir, 'pkgs', 'python-3.12.conda'), 'b')

    const dataRoot = join(root, 'data')
    const adapter = createLocalBundleAdapter(dataRoot, bundleDir)
    await expect(adapter(PY_SPEC, 1, () => {})).resolves.toBeUndefined()
    expect(lockPath).toContain('python-3.12.lock')
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
