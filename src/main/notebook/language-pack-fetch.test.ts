import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { packArchiveFile, type BundleManifest } from './bundle-manifest'
import {
  createFetchBundleAdapter,
  fetchLanguagePack,
  type LanguagePackFetchDeps
} from './language-pack-fetch'

const makeDestDir = (): string => mkdtempSync(join(tmpdir(), 'os-pack-'))

const manifest = (): BundleManifest => ({
  schema: 1,
  envVersion: 1,
  subdir: 'osx-arm64',
  packs: {
    'python-3.11': {
      language: 'python',
      version: '3.11',
      file: packArchiveFile('python', '3.11'),
      sha256: 'a'.repeat(64),
      size: 100
    },
    'python-3.12': {
      language: 'python',
      version: '3.12',
      file: packArchiveFile('python', '3.12'),
      sha256: 'b'.repeat(64),
      size: 200
    },
    'r-4.3': {
      language: 'r',
      version: '4.3',
      file: packArchiveFile('r', '4.3'),
      sha256: 'c'.repeat(64),
      size: 300
    }
  }
})

// A deps set that serves the manifest, records downloads, and hashes to whatever the manifest expects
// (so verification passes) unless overridden.
const makeDeps = (
  overrides: Partial<LanguagePackFetchDeps> = {},
  m: BundleManifest = manifest()
): LanguagePackFetchDeps & { downloaded: string[] } => {
  const downloaded: string[] = []
  const shaByFile: Record<string, string> = {}
  const sizeByFile: Record<string, number> = {}
  for (const entry of Object.values(m.packs)) {
    shaByFile[entry.file] = entry.sha256
    sizeByFile[entry.file] = entry.size
  }
  return {
    downloaded,
    fetchText: vi.fn(async () => JSON.stringify(m)),
    // Write a file of the manifest-declared size so the real statSync size pre-check passes.
    download: vi.fn(async (url: string, destPath: string) => {
      downloaded.push(url)
      const file = destPath.split('/').pop() as string
      writeFileSync(destPath, Buffer.alloc(sizeByFile[file] ?? 0))
    }),
    // Return the manifest's expected sha256 for whichever file was requested.
    sha256: async (path: string) => {
      const file = path.split('/').pop() as string
      return shaByFile[file] ?? 'deadbeef'
    },
    ...overrides
  }
}

describe('fetchLanguagePack', () => {
  it('fetches ONLY the chosen (language, version) pack and verifies it', async () => {
    const deps = makeDeps()
    const dest = makeDestDir()
    const result = await fetchLanguagePack(
      dest,
      'https://cdn.example/envs',
      1,
      'osx-arm64',
      'python',
      '3.12',
      deps
    )
    expect(result.id).toBe('python-3.12')
    expect(result.entry.file).toBe('python-3.12.tar.zst')
    // Exactly one pack downloaded, and it's the chosen version's file at the composed CDN key.
    expect(deps.downloaded).toEqual([
      'https://cdn.example/envs/runtime-bundle/1/osx-arm64/python-3.12.tar.zst'
    ])
    expect(deps.download).toHaveBeenCalledTimes(1)
    expect(result.filePath).toBe(join(dest, 'python-3.12.tar.zst'))
  })

  it('rejects when the downloaded pack fails its sha256 check', async () => {
    const deps = makeDeps({ sha256: async () => 'f'.repeat(64) })
    await expect(
      fetchLanguagePack(makeDestDir(), 'https://cdn/envs', 1, 'osx-arm64', 'python', '3.11', deps)
    ).rejects.toThrow(/sha256 mismatch/)
  })

  it('rejects a version that was not published', async () => {
    const deps = makeDeps()
    await expect(
      fetchLanguagePack(makeDestDir(), 'https://cdn/envs', 1, 'osx-arm64', 'python', '3.99', deps)
    ).rejects.toThrow(/no python 3\.99 pack/)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('rejects when the manifest envVersion disagrees with the expected version', async () => {
    const m = manifest()
    m.envVersion = 2
    const deps = makeDeps({}, m)
    await expect(
      fetchLanguagePack(makeDestDir(), 'https://cdn/envs', 1, 'linux-64', 'python', '3.11', deps)
    ).rejects.toThrow(/envVersion/)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('rejects when the manifest subdir disagrees with the requested platform', async () => {
    const deps = makeDeps()
    await expect(
      fetchLanguagePack(makeDestDir(), 'https://cdn/envs', 1, 'linux-64', 'python', '3.11', deps)
    ).rejects.toThrow(/subdir/)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('rejects an unsupported manifest schema', async () => {
    const m = manifest()
    m.schema = 999
    const deps = makeDeps({}, m)
    await expect(
      fetchLanguagePack(makeDestDir(), 'https://cdn/envs', 1, 'linux-64', 'r', '4.3', deps)
    ).rejects.toThrow(/schema/)
  })
})

describe('createFetchBundleAdapter', () => {
  it('downloads, verifies, extracts, seeds the cache, and returns the committed lock path', async () => {
    const root = makeDestDir()
    const packageBytes = 'package-bytes'
    const packageMd5 = createHash('md5').update(packageBytes).digest('hex')
    const m = manifest()
    const deps = makeDeps({}, m)
    const writeDownload = deps.download
    deps.download = vi.fn(async (url, destPath, onProgress) => {
      onProgress?.(50, 200)
      await writeDownload(url, destPath)
      onProgress?.(200, 200)
    })
    const extract = vi.fn(async (_archivePath: string, destDir: string) => {
      await mkdir(destDir, { recursive: true })
      await writeFile(
        join(destDir, 'python-3.12.lock'),
        `@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/osx-arm64/package-1.conda#${packageMd5}\n`
      )
      await writeFile(join(destDir, 'package-1.conda'), packageBytes)
    })
    const progress: Array<{ message: string; progress: number }> = []
    const adapter = createFetchBundleAdapter(root, 'https://cdn/envs', {
      ...deps,
      subdir: 'osx-arm64',
      extract
    })

    const bundle = await adapter(
      { name: 'default-python', language: 'python', version: '3.12', packages: [] },
      1,
      (update) => progress.push(update)
    )

    expect(bundle?.lockPath).toBe(
      join(root, 'packs', '1', 'osx-arm64', 'python-3.12', 'python-3.12.lock')
    )
    expect(await readFile(bundle?.lockPath ?? '', 'utf8')).toContain('@EXPLICIT')
    expect(deps.download).toHaveBeenCalledTimes(1)
    expect(extract).toHaveBeenCalledOnce()
    await expect(readFile(join(root, 'pkgs', 'package-1.conda'), 'utf8')).resolves.toBe(
      packageBytes
    )
    expect(progress.map((event) => event.message)).toContain('Fetching managed runtime manifest…')
    expect(progress.map((event) => event.message)).toContain(
      'Downloading managed python runtime (25%)'
    )
    expect(progress.map((event) => event.message)).toContain(
      'Downloading managed python runtime (100%)'
    )
    expect(progress.map((event) => event.message)).toContain('Downloaded python-3.12.tar.zst')
    await rm(root, { recursive: true, force: true })
  })

  it('throws an actionable source error when the CDN fails', async () => {
    const progress: string[] = []
    const adapter = createFetchBundleAdapter(makeDestDir(), 'https://cdn/envs', {
      fetchText: vi.fn(async () => {
        throw new Error('manifest request failed')
      }),
      download: vi.fn(async () => undefined)
    })

    await expect(
      adapter(
        { name: 'default-python', language: 'python', version: '3.12', packages: [] },
        1,
        (update) => progress.push(update.message)
      )
    ).rejects.toThrow('Managed runtime pack unavailable: manifest request failed')
    expect(progress.at(-1)).toContain('Managed runtime pack unavailable')
  })
})
