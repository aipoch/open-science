import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  packArchiveFile,
  PACK_PATH_BUDGET_FILE,
  type BundleManifest,
  type PackPathBudget
} from './bundle-manifest'
import {
  createFetchBundleAdapter,
  fetchLanguagePack,
  type LanguagePackFetchDeps
} from './language-pack-fetch'
import type { ProvisionProgress } from './provisioner'

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

  it('runs an independent post-download sha256 verification (defense-in-depth)', async () => {
    // Even though the production download verifies inline, fetchLanguagePack must still run its own
    // post-download hash as a separate integrity gate. A wrong hasher here must fail the fetch.
    const sha256 = vi.fn(async () => 'f'.repeat(64))
    const deps = makeDeps({ sha256 })
    await expect(
      fetchLanguagePack(makeDestDir(), 'https://cdn/envs', 1, 'osx-arm64', 'python', '3.11', deps)
    ).rejects.toThrow(/sha256 mismatch/)
    expect(sha256).toHaveBeenCalled()
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

  it('rejects partial path-budget metadata before downloading a pack', async () => {
    const m = manifest()
    m.subdir = 'win-64'
    m.packs['python-3.12'].maxCacheRelativePath = 211
    const deps = makeDeps({}, m)

    await expect(
      fetchLanguagePack(makeDestDir(), 'https://cdn/envs', 1, 'win-64', 'python', '3.12', deps)
    ).rejects.toThrow(/path budget fields.*together/i)
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
      onProgress?.({
        phase: 'downloading',
        transferred: 50,
        total: 200,
        percent: 25,
        bytesPerSecond: 1000,
        attempt: 0
      })
      await writeDownload(url, destPath)
      onProgress?.({
        phase: 'downloading',
        transferred: 200,
        total: 200,
        percent: 100,
        bytesPerSecond: 1000,
        attempt: 0
      })
    })
    const extract = vi.fn(async (_archivePath: string, destDir: string) => {
      await mkdir(destDir, { recursive: true })
      await writeFile(
        join(destDir, 'python-3.12.lock'),
        `@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/osx-arm64/package-1.conda#${packageMd5}\n`
      )
      await writeFile(join(destDir, 'package-1.conda'), packageBytes)
    })
    const progress: ProvisionProgress[] = []
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
    // A download-phase event carries the nested DownloadProgress detail for the UI speed line.
    const withDownload = progress.find((event) => event.download)
    expect(withDownload?.download).toMatchObject({ phase: 'downloading', attempt: 0 })
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

  it('rejects a win-64 pack whose manifest has no conservative or recorded path budget', async () => {
    const root = makeDestDir()
    const m = manifest()
    m.subdir = 'win-64'
    m.packs['python-3.11'] = {
      ...m.packs['python-3.11'],
      file: packArchiveFile('python', '3.11')
    }
    const deps = makeDeps({}, m)
    const extract = vi.fn(async (_archivePath: string, destDir: string) => {
      await mkdir(destDir, { recursive: true })
      await writeFile(
        join(destDir, 'python-3.11.lock'),
        '@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/win-64/package-1.conda#0cc175b9c0f1b6a831c399e269772661\n'
      )
      await writeFile(join(destDir, 'package-1.conda'), 'a')
    })
    const adapter = createFetchBundleAdapter(root, 'https://cdn/envs', {
      ...deps,
      subdir: 'win-64',
      extract
    })

    await expect(
      adapter(
        { name: 'default-python', language: 'python', version: '3.11', packages: [] },
        1,
        () => {}
      )
    ).resolves.toBeUndefined()
  })

  it.each(['fresh commit', 'verified rename-race winner'])(
    'records the win-64 pack path budget on %s',
    async (scenario) => {
      const root = makeDestDir()
      const budget: PackPathBudget = { maxCacheRelativePath: 211, maxEnvRelativePath: 133 }
      const m = manifest()
      m.subdir = 'win-64'
      m.packs['python-3.12'] = { ...m.packs['python-3.12'], ...budget }
      const deps = makeDeps({}, m)
      const extract = vi.fn(async (_archivePath: string, destDir: string) => {
        await mkdir(destDir, { recursive: true })
        await writeFile(
          join(destDir, 'python-3.12.lock'),
          '@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/win-64/package-1.conda#0cc175b9c0f1b6a831c399e269772661\n'
        )
        await writeFile(join(destDir, 'package-1.conda'), 'a')
      })
      const finalDir = join(root, 'packs', '1', 'win-64', 'python-3.12')
      if (scenario === 'verified rename-race winner') {
        await mkdir(finalDir, { recursive: true })
        await writeFile(
          join(finalDir, 'python-3.12.lock'),
          '@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/win-64/package-1.conda#0cc175b9c0f1b6a831c399e269772661\n'
        )
        await writeFile(join(finalDir, 'package-1.conda'), 'a')
      }
      const adapter = createFetchBundleAdapter(root, 'https://cdn/envs', {
        ...deps,
        subdir: 'win-64',
        extract
      })

      const bundle = await adapter(
        { name: 'default-python', language: 'python', version: '3.12', packages: [] },
        1,
        () => {}
      )

      expect(bundle?.pathBudget).toEqual(budget)
      await expect(readFile(join(finalDir, PACK_PATH_BUDGET_FILE), 'utf8')).resolves.toBe(
        `${JSON.stringify(budget)}\n`
      )
    }
  )

  it('preserves a partial .part in the stable cache when a download fails, for resume', async () => {
    // Simulate an interrupted download: write a .part next to the archive destPath, then throw. The
    // adapter must wipe the disposable .incoming-* staging in its finally, but LEAVE the .part so a
    // manual retry resumes via Range instead of restarting the whole pack.
    const root = makeDestDir()
    const deps = makeDeps()
    let partPath = ''
    deps.download = vi.fn(async (_url: string, destPath: string) => {
      partPath = `${destPath}.part`
      writeFileSync(partPath, Buffer.from('partial-bytes'))
      throw new Error('ECONNRESET mid-download')
    })
    const adapter = createFetchBundleAdapter(root, 'https://cdn/envs', {
      ...deps,
      subdir: 'osx-arm64'
    })
    await expect(
      adapter(
        { name: 'default-python', language: 'python', version: '3.12', packages: [] },
        1,
        () => {}
      )
    ).rejects.toThrow(/Managed runtime pack unavailable/)

    // The .part survived, under a per-session cache key then the version/subdir segments.
    expect(partPath).toContain(join('packs', '.cache'))
    expect(partPath.endsWith(join('1', 'osx-arm64', 'python-3.12.tar.zst.part'))).toBe(true)
    expect(existsSync(partPath)).toBe(true)
    // …while no .incoming-* staging dir was left behind.
    const leftovers = readdirSync(join(root, 'packs')).filter((n) => n.startsWith('.incoming-'))
    expect(leftovers).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('uses a distinct cache dir per adapter instance so a prior session cannot resume', async () => {
    // Two adapters model two app sessions. Each must download under its OWN cache key, so one
    // session's leftover .part is invisible to the other — the "start from scratch" guarantee holds
    // by construction, independent of the startup wipe. Capture each session's archive dir.
    const root = makeDestDir()
    const capture = (): { deps: ReturnType<typeof makeDeps>; dirOf: () => string } => {
      const deps = makeDeps()
      let dir = ''
      deps.download = vi.fn(async (_url: string, destPath: string) => {
        dir = destPath.slice(0, destPath.lastIndexOf('/'))
        throw new Error('stop after capturing the path')
      })
      return { deps, dirOf: () => dir }
    }
    const a = capture()
    const b = capture()
    const spec = {
      name: 'default-python',
      language: 'python' as const,
      version: '3.12',
      packages: []
    }
    await createFetchBundleAdapter(root, 'https://cdn/envs', { ...a.deps, subdir: 'osx-arm64' })(
      spec,
      1,
      () => {}
    ).catch(() => {})
    await createFetchBundleAdapter(root, 'https://cdn/envs', { ...b.deps, subdir: 'osx-arm64' })(
      spec,
      1,
      () => {}
    ).catch(() => {})

    // Same version/subdir, but the two sessions resolved to DIFFERENT cache dirs (distinct keys).
    expect(a.dirOf()).not.toBe(b.dirOf())
    expect(a.dirOf()).toContain(join('packs', '.cache'))
    expect(b.dirOf()).toContain(join('packs', '.cache'))
    await rm(root, { recursive: true, force: true })
  })
})
