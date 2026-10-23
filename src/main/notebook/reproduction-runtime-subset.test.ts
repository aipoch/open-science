import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { CondaRuntimeSubsetPlan, NotebookEnvironmentLock } from '@aipoch/environment/contracts'
import { decodeNotebookEnvironmentLock } from '@aipoch/environment'
import { runtimeSubsetCandidateStore } from '../artifacts/reproducibility-host'
import { proposeCondaRuntimeSubset } from './reproduction-runtime-subset'

describe('runtime subset payload proposals', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  const fixture = async (): Promise<{
    root: string
    prefix: string
    mapped: string[]
    input: Parameters<typeof proposeCondaRuntimeSubset>[0]
    listMappedFiles: Mock<() => Promise<string[]>>
  }> => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-subset-observation-'))
    roots.push(root)
    const prefix = join(root, 'prefix')
    await mkdir(join(prefix, 'conda-meta'), { recursive: true })
    const inventories = {
      'r-base': ['bin/Rscript', 'lib/R/bin/exec/R', 'lib/R/lib/libR.dylib'],
      'r-jsonlite': ['lib/R/library/jsonlite/libs/jsonlite.so'],
      openblas: ['lib/libopenblas.0.dylib'],
      libblas: ['lib/libblas.3.dylib'],
      compiler: ['bin/compiler']
    }
    const packages = Object.entries(inventories).map(([name]) => ({
      name,
      version: '1.0',
      build: '0',
      url: `https://repo.example.test/osx-arm64/${name}-1.0-0.conda`,
      md5: '1'.repeat(32),
      depends: name === 'r-base' ? ['compiler >=1', 'libblas >=1'] : []
    }))
    for (const pkg of packages) {
      const files = inventories[pkg.name as keyof typeof inventories]
      for (const part of files) {
        await mkdir(dirname(join(prefix, part)), { recursive: true })
        if (pkg.name === 'libblas') await symlink('libopenblas.0.dylib', join(prefix, part))
        else await writeFile(join(prefix, part), 'fixture')
      }
      await writeFile(
        join(prefix, 'conda-meta', `${pkg.name}-1.0-0.json`),
        JSON.stringify({ ...pkg, files })
      )
    }
    const lock: NotebookEnvironmentLock = {
      schemaVersion: 1,
      format: 'environment-lock-bundle',
      kernelKind: 'r',
      environmentName: 'original',
      components: [
        {
          ecosystem: 'conda',
          format: 'conda-explicit-md5',
          resolution: 'locked',
          explicitLock:
            '@EXPLICIT\n' + packages.map((pkg) => `${pkg.url}#${pkg.md5}`).join('\n') + '\n',
          packages: packages.map((pkg) => pkg.name),
          dependencyGraph: {
            schemaVersion: 1,
            packages,
            rPackageOwnership: {
              schemaVersion: 1,
              packages: [
                { name: 'base', version: '1.0', condaPackage: 'r-base' },
                { name: 'jsonlite', version: '1.0', condaPackage: 'r-jsonlite' }
              ]
            }
          }
        }
      ]
    }
    const mapped = [
      join(prefix, 'lib/R/bin/exec/R'),
      join(prefix, 'lib/R/lib/libR.dylib'),
      join(prefix, 'lib/libopenblas.0.dylib'),
      '/usr/lib/dyld'
    ]
    const listMappedFiles = vi.fn(async () => mapped)
    const input = {
      lock,
      prefix,
      platform: 'darwin' as const,
      sourceLockChecksum: 'a'.repeat(64),
      scopeChecksum: 'b'.repeat(64),
      footprint: {
        processId: 123,
        packages: [
          { name: 'base', version: '1.0' },
          { name: 'jsonlite', version: '1.0' }
        ],
        libraryPaths: [join(prefix, 'lib/R/library/jsonlite/libs/jsonlite.so')]
      }
    }
    return { root, prefix, mapped, input, listMappedFiles }
  }

  describe('runtime subset candidate store', () => {
    const candidateFixture = async (): Promise<{
      root: string
      storageRoot: string
      directory: string
      candidate: CondaRuntimeSubsetPlan
    }> => {
      const { root, input, listMappedFiles } = await fixture()
      const candidate = await proposeCondaRuntimeSubset(input, { listMappedFiles })
      if (!candidate) throw new Error('Fixture did not produce a runtime subset proposal.')
      const storageRoot = join(root, 'storage')
      await mkdir(storageRoot)
      const directory = join(storageRoot, 'runtime', 'provenance', 'runtime-subset-candidates')
      return { root, storageRoot, directory, candidate }
    }

    it('persists a proposal across store instances and consumes it exactly once', async () => {
      const { storageRoot, directory, candidate } = await candidateFixture()
      await runtimeSubsetCandidateStore(storageRoot).save(candidate)
      expect(await readdir(directory)).toEqual([`${candidate.scopeChecksum}.json`])

      const reader = runtimeSubsetCandidateStore(storageRoot)
      expect(await reader.load(candidate.scopeChecksum)).toEqual(candidate)
      expect(await readdir(directory)).toEqual([])
      await expect(reader.load(candidate.scopeChecksum)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(directory)).toEqual([])
    })

    it('keeps a claimed proposal until release and allows a returned hint to be consumed once', async () => {
      const { storageRoot, directory, candidate } = await candidateFixture()
      const store = runtimeSubsetCandidateStore(storageRoot)
      await store.save(candidate)

      const claimed = await store.claim(candidate.scopeChecksum)
      expect(claimed.candidate).toEqual(candidate)
      const entries = await readdir(directory)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatch(
        new RegExp(`^${candidate.scopeChecksum}\\.reading-${process.pid}-[a-f0-9-]{36}$`, 'u')
      )
      expect(JSON.parse(await readFile(join(directory, entries[0]!), 'utf8'))).toEqual(candidate)
      await expect(
        runtimeSubsetCandidateStore(storageRoot).load(candidate.scopeChecksum)
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(directory)).toEqual(entries)

      await claimed.release(true)
      expect(await readdir(directory)).toEqual([`${candidate.scopeChecksum}.json`])
      const reader = runtimeSubsetCandidateStore(storageRoot)
      expect(await reader.load(candidate.scopeChecksum)).toEqual(candidate)
      await expect(reader.load(candidate.scopeChecksum)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(directory)).toEqual([])
    })

    it('does not overwrite a newer publication when returning an older claimed hint', async () => {
      const { storageRoot, directory, candidate } = await candidateFixture()
      const store = runtimeSubsetCandidateStore(storageRoot)
      await store.save(candidate)
      const claimed = await store.claim(candidate.scopeChecksum)
      const newer = { ...candidate, sourceLockChecksum: 'c'.repeat(64) }

      await runtimeSubsetCandidateStore(storageRoot).save(newer)
      expect(await readdir(directory)).toHaveLength(2)
      await claimed.release(true)

      expect(await readdir(directory)).toEqual([`${candidate.scopeChecksum}.json`])
      expect(await runtimeSubsetCandidateStore(storageRoot).load(candidate.scopeChecksum)).toEqual(
        newer
      )
      expect(await readdir(directory)).toEqual([])
    })

    it('discards released claims and cleans up a claim that fails JSON decoding', async () => {
      const { storageRoot, directory, candidate } = await candidateFixture()
      const store = runtimeSubsetCandidateStore(storageRoot)
      await store.save(candidate)
      const claimed = await store.claim(candidate.scopeChecksum)

      await claimed.release(false)
      expect(await readdir(directory)).toEqual([])
      await expect(store.load(candidate.scopeChecksum)).rejects.toMatchObject({ code: 'ENOENT' })

      await store.save(candidate)
      await writeFile(join(directory, `${candidate.scopeChecksum}.json`), '{broken')
      await expect(store.claim(candidate.scopeChecksum)).rejects.toBeInstanceOf(SyntaxError)
      expect(await readdir(directory)).toEqual([])
    })

    it('allows only one concurrent store instance to consume the same proposal', async () => {
      const { storageRoot, directory, candidate } = await candidateFixture()
      await runtimeSubsetCandidateStore(storageRoot).save(candidate)

      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          runtimeSubsetCandidateStore(storageRoot).load(candidate.scopeChecksum)
        )
      )
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toEqual([
        { status: 'fulfilled', value: candidate }
      ])
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
      expect(rejected).toHaveLength(7)
      for (const outcome of rejected) expect(outcome.reason).toMatchObject({ code: 'ENOENT' })
      expect(await readdir(directory)).toEqual([])
    })

    it('removes malformed JSON after a failed consumption', async () => {
      const { storageRoot, directory, candidate } = await candidateFixture()
      const store = runtimeSubsetCandidateStore(storageRoot)
      await store.save(candidate)
      await writeFile(join(directory, `${candidate.scopeChecksum}.json`), '{broken')

      await expect(store.load(candidate.scopeChecksum)).rejects.toBeInstanceOf(SyntaxError)
      expect(await readdir(directory)).toEqual([])
      await expect(store.load(candidate.scopeChecksum)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('discards an oversized but valid JSON file and cleans the consumed entry', async () => {
      const { storageRoot, directory, candidate } = await candidateFixture()
      const store = runtimeSubsetCandidateStore(storageRoot)
      await store.save(candidate)
      await writeFile(
        join(directory, `${candidate.scopeChecksum}.json`),
        JSON.stringify({ ...candidate, padding: 'x'.repeat(512 * 1024) })
      )

      expect(await store.load(candidate.scopeChecksum)).toBeUndefined()
      expect(await readdir(directory)).toEqual([])
    })

    it('rejects a file symlink, removes the consumed link and preserves its external target', async () => {
      const { root, storageRoot, directory, candidate } = await candidateFixture()
      const store = runtimeSubsetCandidateStore(storageRoot)
      await store.save(candidate)
      const outside = join(root, 'external-candidate.json')
      const externalBytes = JSON.stringify({ external: true, ...candidate })
      await writeFile(outside, externalBytes)
      const path = join(directory, `${candidate.scopeChecksum}.json`)
      await rm(path)
      await symlink(outside, path)

      await expect(store.load(candidate.scopeChecksum)).rejects.toThrow()
      expect(await readdir(directory)).toEqual([])
      expect(await readFile(outside, 'utf8')).toBe(externalBytes)
    })

    it.each(['cache-directory', 'runtime-directory'] as const)(
      'rejects a %s symlink without consuming or overwriting external files',
      async (scenario) => {
        const { root, storageRoot, directory, candidate } = await candidateFixture()
        const outside = join(root, 'external-cache')
        const externalDirectory =
          scenario === 'cache-directory'
            ? outside
            : join(outside, 'provenance', 'runtime-subset-candidates')
        await mkdir(externalDirectory, { recursive: true })
        const externalPath = join(externalDirectory, `${candidate.scopeChecksum}.json`)
        const externalBytes = JSON.stringify({ ...candidate, external: true })
        await writeFile(externalPath, externalBytes)
        if (scenario === 'cache-directory') {
          await mkdir(dirname(directory), { recursive: true })
          await symlink(outside, directory, 'dir')
        } else await symlink(outside, join(storageRoot, 'runtime'), 'dir')
        const store = runtimeSubsetCandidateStore(storageRoot)

        await expect(store.load(candidate.scopeChecksum)).rejects.toThrow('must be app-owned')
        await expect(store.save(candidate)).rejects.toThrow('must be app-owned')
        expect(await readFile(externalPath, 'utf8')).toBe(externalBytes)
        expect(await readdir(externalDirectory)).toEqual([`${candidate.scopeChecksum}.json`])
      }
    )

    it('rejects a runtime symlink before creating children in an external empty directory', async () => {
      const { root, storageRoot, candidate } = await candidateFixture()
      const outside = join(root, 'external-empty-runtime')
      await mkdir(outside)
      await symlink(outside, join(storageRoot, 'runtime'), 'dir')

      await expect(runtimeSubsetCandidateStore(storageRoot).save(candidate)).rejects.toThrow(
        'must be app-owned'
      )
      expect(await readdir(outside)).toEqual([])
    })

    it('reclaims only owned reader and writer files whose process is confirmed dead', async () => {
      const { storageRoot, directory, candidate } = await candidateFixture()
      const store = runtimeSubsetCandidateStore(storageRoot)
      await store.save(candidate)
      const uuid = '11111111-1111-4111-8111-111111111111'
      const dead = `${candidate.scopeChecksum}.reading-900001-${uuid}`
      const live = `${candidate.scopeChecksum}.reading-900002-${uuid}`
      const inaccessible = `${candidate.scopeChecksum}.reading-900003-${uuid}`
      const deadWriter = `${candidate.scopeChecksum}.json.900001-${uuid}.tmp`
      const liveWriter = `${candidate.scopeChecksum}.json.900002-${uuid}.tmp`
      const inaccessibleWriter = `${candidate.scopeChecksum}.json.900003-${uuid}.tmp`
      const unrelated = [
        `${candidate.scopeChecksum}.reading-900001-not-a-uuid`,
        `foreign.reading-900001-${uuid}`,
        `${candidate.scopeChecksum}.reading-0-${uuid}`,
        `${candidate.scopeChecksum}.reading-9007199254740992-${uuid}`,
        `${candidate.scopeChecksum}.reading-${uuid}`,
        `${candidate.scopeChecksum}.json.900001-not-a-uuid.tmp`,
        `foreign.json.900001-${uuid}.tmp`,
        `${candidate.scopeChecksum}.json.0-${uuid}.tmp`,
        `${candidate.scopeChecksum}.json.9007199254740992-${uuid}.tmp`,
        `${candidate.scopeChecksum}.json.900001-${uuid}.tmp.unrelated`
      ]
      const preserved = [live, inaccessible, liveWriter, inaccessibleWriter, ...unrelated]
      for (const name of [dead, deadWriter, ...preserved])
        await writeFile(join(directory, name), 'disposable hint')
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        expect(signal).toBe(0)
        if (pid === 900001) throw Object.assign(new Error('dead reader'), { code: 'ESRCH' })
        if (pid === 900002) return true
        if (pid === 900003) throw Object.assign(new Error('unknown reader'), { code: 'EPERM' })
        throw new Error(`Unexpected reader probe: ${pid}`)
      })
      try {
        await store.save(candidate)
        expect(kill).toHaveBeenCalledTimes(6)
        for (const pid of [900001, 900002, 900003]) {
          expect(
            kill.mock.calls.filter(([probedPid, signal]) => probedPid === pid && signal === 0)
          ).toHaveLength(2)
        }
        expect((await readdir(directory)).sort()).toEqual(
          [`${candidate.scopeChecksum}.json`, ...preserved].sort()
        )
        for (const name of preserved)
          expect(await readFile(join(directory, name), 'utf8')).toBe('disposable hint')
      } finally {
        kill.mockRestore()
      }
    })

    it('retains at most 64 scopes and keeps the newly saved proposal', async () => {
      const { storageRoot, directory, candidate } = await candidateFixture()
      const store = runtimeSubsetCandidateStore(storageRoot)
      for (let index = 0; index < 64; index++) {
        await store.save({ ...candidate, scopeChecksum: index.toString(16).padStart(64, '0') })
      }
      expect(await readdir(directory)).toHaveLength(64)

      const newest = { ...candidate, scopeChecksum: 'f'.repeat(64) }
      await store.save(newest)
      const entries = await readdir(directory)
      expect(entries).toHaveLength(64)
      expect(entries).toContain(`${newest.scopeChecksum}.json`)
      expect(entries.every((name) => /^[a-f0-9]{64}\.json$/u.test(name))).toBe(true)
      expect(await runtimeSubsetCandidateStore(storageRoot).load(newest.scopeChecksum)).toEqual(
        newest
      )
      expect(await readdir(directory)).toHaveLength(63)
    }, 20_000)
  })

  it('selects observed package owners and loader aliases, preserving missing declared edges', async () => {
    const { input, listMappedFiles } = await fixture()
    expect(decodeNotebookEnvironmentLock(JSON.stringify(input.lock)).status).toBe('valid')
    const plan = await proposeCondaRuntimeSubset(input, { listMappedFiles })
    expect(plan?.archiveNames).toEqual([
      'libblas-1.0-0.conda',
      'openblas-1.0-0.conda',
      'r-base-1.0-0.conda',
      'r-jsonlite-1.0-0.conda'
    ])
    expect(plan?.missingDependencies).toEqual([
      { packageName: 'r-base', dependency: 'compiler >=1' }
    ])
    expect(plan?.packages.find((pkg) => pkg.name === 'r-base')?.depends).toContain('compiler >=1')
    expect(input.lock.components.find((entry) => entry.ecosystem === 'conda')!.packages).toContain(
      'compiler'
    )
  })

  it.each([
    'foreign-map',
    'unknown-owner',
    'changed-version',
    'metadata-link',
    'missing-interpreter',
    'unsupported-platform'
  ])('does not propose a subset from %s evidence', async (scenario) => {
    const { root, prefix, mapped, input, listMappedFiles } = await fixture()
    if (scenario === 'foreign-map') {
      const foreign = join(root, 'old-environment.dylib')
      await writeFile(foreign, 'foreign')
      mapped.push(foreign)
    }
    if (scenario === 'unknown-owner') {
      const unknown = join(prefix, 'unowned.dylib')
      await writeFile(unknown, 'unknown')
      mapped.push(unknown)
    }
    if (scenario === 'changed-version') input.footprint.packages[0]!.version = '2.0'
    if (scenario === 'metadata-link') {
      const path = join(prefix, 'conda-meta/r-base-1.0-0.json')
      const outside = join(root, 'linked-metadata.json')
      await writeFile(outside, await readFile(path))
      await rm(path)
      await symlink(outside, path)
    }
    if (scenario === 'missing-interpreter') mapped.splice(0, 1)
    const effectiveInput =
      scenario === 'unsupported-platform' ? { ...input, platform: 'linux' as const } : input
    expect(await proposeCondaRuntimeSubset(effectiveInput, { listMappedFiles })).toBeUndefined()
  })

  it('preserves cancellation instead of turning it into an unavailable proposal', async () => {
    const { input, listMappedFiles } = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      proposeCondaRuntimeSubset({ ...input, signal: controller.signal }, { listMappedFiles })
    ).rejects.toThrow('cancelled')
    expect(listMappedFiles).not.toHaveBeenCalled()
  })

  it.each([
    'ordinary-file',
    'unlinked-file',
    'similar-name',
    'foreign-directory',
    'noncanonical-path',
    'writable-parent',
    'nonroot-parent',
    'symlink-parent',
    'redirected-parent',
    'non-directory-parent',
    'writable-file',
    'nonroot-file',
    'symlink-file',
    'directory-file',
    'unreadable-file',
    'dll-path'
  ])('classifies the protected Darwin logging data mmap: %s', async (scenario) => {
    const { mapped, input, listMappedFiles } = await fixture()
    const parent = '/Library/Preferences/Logging'
    const cache = `${parent}/.plist-cache.Ab12Cd34`
    const observed =
      scenario === 'similar-name'
        ? `${cache}.dylib`
        : scenario === 'foreign-directory'
          ? `/opt/logging/.plist-cache.Ab12Cd34`
          : scenario === 'noncanonical-path'
            ? `${parent}/../Logging/.plist-cache.Ab12Cd34`
            : cache
    mapped.push(observed)
    if (scenario === 'dll-path') input.footprint.libraryPaths.push(cache)
    const loggingCacheFileSystem = {
      realpath: vi.fn(async (path: string) =>
        scenario === 'redirected-parent' && path === parent ? '/outside/logging' : path
      ),
      metadata: vi.fn(async (path: string) => {
        if (path === parent) {
          return {
            kind:
              scenario === 'symlink-parent'
                ? ('symlink' as const)
                : scenario === 'non-directory-parent'
                  ? ('file' as const)
                  : ('directory' as const),
            uid: scenario === 'nonroot-parent' ? 501 : 0,
            mode: scenario === 'writable-parent' ? 0o777 : 0o755
          }
        }
        if (scenario === 'unlinked-file' || scenario === 'unreadable-file')
          throw Object.assign(new Error('file unavailable'), {
            code: scenario === 'unlinked-file' ? 'ENOENT' : 'EACCES'
          })
        return {
          kind:
            scenario === 'symlink-file'
              ? ('symlink' as const)
              : scenario === 'directory-file'
                ? ('directory' as const)
                : ('file' as const),
          uid: scenario === 'nonroot-file' ? 501 : 0,
          mode: scenario === 'writable-file' ? 0o666 : 0o644
        }
      })
    }
    const plan = await proposeCondaRuntimeSubset(input, { listMappedFiles, loggingCacheFileSystem })
    if (scenario === 'ordinary-file' || scenario === 'unlinked-file') {
      expect(plan).toBeDefined()
      expect(plan!.archiveNames).toHaveLength(4)
    } else expect(plan).toBeUndefined()
    if (['similar-name', 'foreign-directory', 'noncanonical-path', 'dll-path'].includes(scenario))
      expect(loggingCacheFileSystem.metadata).not.toHaveBeenCalled()
  })
})
