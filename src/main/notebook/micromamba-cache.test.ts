import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_MAX_CACHE_RELATIVE_PATH,
  isTrustedMicromambaWorkingCacheForRoot,
  isTrustedWindowsCacheAcl,
  micromambaCacheLockKey,
  removeEmptyManagedParent,
  removeMicromambaCacheForRoot,
  selectMicromambaCache,
  WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES,
  windowsCacheAclHardeningScript,
  windowsCacheAclReadScript,
  type MicromambaCacheCleanupDeps,
  type MicromambaCacheDeps
} from './micromamba-cache'
import {
  finalizeRecoveredMicromambaWorkingCache,
  managedNotebookWorkingCache,
  retainMicromambaWorkingCache
} from './windows-micromamba-working-cache'
import { operationJournalPath, RuntimeOperationJournal } from './operation-journal'

const windowsDeps = (overrides: Partial<MicromambaCacheDeps> = {}): MicromambaCacheDeps => ({
  platform: 'win32',
  env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
  canonicalize: (path) => win32.normalize(path),
  prepare: (path) => win32.normalize(path),
  verifyOwnership: () => true,
  ...overrides
})

describe('managedNotebookWorkingCache', () => {
  it('exposes archive lifecycle capabilities only on Windows', () => {
    expect(managedNotebookWorkingCache('linux')).toEqual({
      finalizeWorkingCache: undefined,
      retainWorkingCache: undefined
    })
    expect(managedNotebookWorkingCache('win32')).toEqual({
      finalizeWorkingCache: expect.any(Function),
      retainWorkingCache: expect.any(Function)
    })
  })
})

describe('selectMicromambaCache', () => {
  it('keeps the physical lock identity stable when a cache is created beneath an aliased root', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'os-cache-alias-'))
    const physicalRoot = join(sandbox, 'physical')
    const aliasedRoot = join(sandbox, 'alias')
    mkdirSync(physicalRoot)
    symlinkSync(physicalRoot, aliasedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const cache = join(aliasedRoot, 'pkgs')

    const before = micromambaCacheLockKey(cache)
    mkdirSync(join(physicalRoot, 'pkgs'))
    const after = micromambaCacheLockKey(cache)

    expect(before).toBe(after)
  })

  it('chooses a deterministic same-volume cache keyed by user and canonical runtime root', () => {
    const first = selectMicromambaCache(
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps()
    )
    const repeated = selectMicromambaCache(
      'D:\\OpenScience\\runtime\\.',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps()
    )
    const otherRoot = selectMicromambaCache(
      'D:\\Other\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps()
    )

    expect(first.path).toMatch(/^D:\\OpenScienceTmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
    expect(repeated).toEqual(first)
    expect(otherRoot.path).not.toBe(first.path)
    expect(first.lockKey).toBe(first.path.toLowerCase())
  })

  it('falls back to a per-user temporary directory when the volume root is not writable', () => {
    const prepare = vi.fn((path: string) =>
      path.startsWith('D:\\') ? { rejection: 'volume root is not writable' } : path
    )

    const cache = selectMicromambaCache(
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps({
        env: {
          USERNAME: 'alice',
          USERPROFILE: 'C:\\Users\\alice',
          TEMP: 'C:\\Users\\alice\\AppData\\Local\\Temp'
        },
        prepare
      })
    )

    expect(cache.path).toMatch(/^C:\\Users\\alice\\os-tmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('keeps the runtime-volume primary ahead of an existing per-user fallback', () => {
    const prepare = vi.fn((path: string) => path)

    const cache = selectMicromambaCache(
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps({
        exists: (path) => path.includes('\\os-tmp\\'),
        prepare
      })
    )

    expect(cache.path).toMatch(/^D:\\OpenScienceTmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
    expect(prepare).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledWith(
      expect.stringMatching(/^D:\\OpenScienceTmp\\m-/),
      expect.any(Object)
    )
  })

  it('tries TMP after an unusable TEMP before falling back to the user profile', () => {
    const prepare = vi.fn((path: string) =>
      path.startsWith('D:\\') || path.startsWith('C:\\Temp')
        ? { rejection: 'candidate is unavailable' }
        : path
    )

    const cache = selectMicromambaCache(
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps({
        env: {
          USERNAME: 'alice',
          USERPROFILE: 'C:\\Users\\alice',
          TEMP: 'C:\\Temp',
          TMP: 'E:\\Tmp'
        },
        prepare
      })
    )

    expect(cache.path).toMatch(/^E:\\Tmp\\OpenScienceTmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
    expect(prepare).toHaveBeenCalledTimes(3)
  })

  it('rejects candidates that are writable but do not fit the actual pack budget', () => {
    expect(() =>
      selectMicromambaCache(
        'D:\\OpenScience\\runtime',
        250,
        windowsDeps({ env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\a-very-long-profile' } })
      )
    ).toThrow(/Candidate diagnostics:/i)
    expect(() =>
      selectMicromambaCache(
        'D:\\OpenScience\\runtime',
        250,
        windowsDeps({ env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\a-very-long-profile' } })
      )
    ).not.toThrow(/LongPathsEnabled|administrator/i)
  })

  it('reports why every Windows cache candidate was rejected', () => {
    const profile = 'C:\\Users\\peipeidamowang-with-a-long-profile'
    let message = ''
    try {
      selectMicromambaCache(
        'E:\\open science\\OpenScience\\runtime',
        DEFAULT_MAX_CACHE_RELATIVE_PATH,
        windowsDeps({
          env: { USERNAME: 'peipeidamowang', USERPROFILE: profile },
          prepare: (path) => ({
            rejection: path.startsWith('E:\\')
              ? 'ownership or permissions are not trusted'
              : 'cache marker is missing or unreadable'
          })
        })
      )
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('Candidate diagnostics:')
    expect(message).toMatch(
      /E:\\OpenScienceTmp\\m-[0-9a-hjkmnp-tv-z]{8}: ownership or permissions are not trusted/
    )
    expect(message).not.toContain('unavailable, untrusted, or not writable')
    expect(message).not.toContain('restrict write access')
    expect(message).not.toMatch(/shorter data-root/i)
  })

  it('keeps non-Windows cache behavior unchanged', () => {
    expect(
      selectMicromambaCache('/Users/alice/OpenScience/runtime', 999, {
        platform: 'darwin',
        env: {},
        canonicalize: (path) => path,
        prepare: () => {
          throw new Error('must not prepare an external cache')
        }
      })
    ).toEqual({
      path: '/Users/alice/OpenScience/runtime/pkgs',
      lockKey: '/Users/alice/OpenScience/runtime/pkgs'
    })
  })

  it('rejects a cache whose OS ownership/trust boundary cannot be verified', () => {
    expect(() =>
      selectMicromambaCache(
        'D:\\OpenScience\\runtime',
        DEFAULT_MAX_CACHE_RELATIVE_PATH,
        windowsDeps({ verifyOwnership: () => false })
      )
    ).toThrow(/ownership or permissions are not trusted/i)
  })
})

describe('removeMicromambaCacheForRoot', () => {
  const root = 'D:\\OpenScience\\runtime'
  const env = {
    USERNAME: 'alice',
    PUBLIC: 'C:\\Users\\Public',
    USERPROFILE: 'C:\\Users\\alice'
  }
  const marker = {
    schema: 1,
    canonicalRoot: root.toLowerCase(),
    userIdentity: 'alice'
  }
  const inspectTrustedParent: NonNullable<MicromambaCacheCleanupDeps['inspectParent']> = (
    path
  ) => ({
    directory: true,
    symbolicLink: false,
    physical: win32.normalize(path),
    marker: {
      schema: 1,
      kind: 'micromamba-working-cache-parent',
      userIdentity: 'alice'
    }
  })

  it('removes only a correctly marked and OS-owned cache', () => {
    const removed: string[] = []
    let inspected = 0
    const completed = removeMicromambaCacheForRoot(root, {
      platform: 'win32',
      env,
      canonicalize: (path) => win32.normalize(path),
      verifyOwnership: () => true,
      inspectParent: inspectTrustedParent,
      inspect: () => ({
        directory: true,
        symbolicLink: false,
        marker: inspected++ === 0 ? marker : { ...marker, canonicalRoot: 'd:\\tampered' }
      }),
      remove: (path) => removed.push(path)
    })

    expect(completed).toBe(true)
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatch(/^D:\\OpenScienceTmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
  })

  it('retains symlinked, unowned, and non-Windows candidates', () => {
    const remove = vi.fn()
    let inspected = 0
    removeMicromambaCacheForRoot(root, {
      platform: 'win32',
      env,
      canonicalize: (path) => win32.normalize(path),
      verifyOwnership: () => false,
      inspectParent: inspectTrustedParent,
      inspect: () => ({ directory: true, symbolicLink: inspected++ === 0, marker }),
      remove
    })
    removeMicromambaCacheForRoot(root, {
      platform: 'darwin',
      inspect: () => {
        throw new Error('must not inspect a non-Windows cache')
      },
      remove
    })

    expect(remove).not.toHaveBeenCalled()
  })

  it('removes both same-volume and per-user fallback candidates when they are owned', () => {
    const removed: string[] = []
    removeMicromambaCacheForRoot(root, {
      platform: 'win32',
      env,
      canonicalize: (path) => win32.normalize(path),
      verifyOwnership: () => true,
      inspectParent: inspectTrustedParent,
      inspect: () => ({ directory: true, symbolicLink: false, marker }),
      remove: (path) => removed.push(path)
    })

    expect(removed).toHaveLength(6)
    expect(removed[0]).toMatch(/^D:\\OpenScienceTmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
    expect(removed[1]).toMatch(/^C:\\Users\\alice\\os-tmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
    expect(removed.slice(2)).toEqual([
      expect.stringMatching(/^D:\\osp[0-9a-f]{10}$/),
      expect.stringMatching(/^C:\\Users\\alice\\osp[0-9a-f]{10}$/),
      expect.stringMatching(/^C:\\Users\\alice\\os[0-9a-hjkmnp-tv-z]{8}$/),
      expect.stringMatching(/^C:\\Users\\Public\\osp[0-9a-f]{10}$/)
    ])
  })

  it('refuses cleanup when the managed parent is linked or resolves elsewhere', () => {
    const remove = vi.fn()
    removeMicromambaCacheForRoot(root, {
      platform: 'win32',
      env,
      canonicalize: (path) => win32.normalize(path),
      verifyOwnership: () => true,
      inspectParent: (path) => ({
        ...inspectTrustedParent(path),
        symbolicLink: path === 'D:\\OpenScienceTmp',
        physical: path === 'C:\\Users\\alice\\os-tmp' ? 'C:\\Users\\alice\\unexpected-parent' : path
      }),
      inspect: (path) => ({
        directory: true,
        symbolicLink: false,
        marker:
          path.includes('\\OpenScienceTmp\\') || path.includes('\\os-tmp\\')
            ? marker
            : { ...marker, canonicalRoot: 'd:\\tampered' }
      }),
      remove
    })

    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses per-user cleanup when the physical parent escapes its boundary', () => {
    const remove = vi.fn()
    removeMicromambaCacheForRoot(root, {
      platform: 'win32',
      env,
      canonicalize: (path) => win32.normalize(path),
      verifyOwnership: () => true,
      inspectParent: (path) => ({
        ...inspectTrustedParent(path),
        physical: path === 'C:\\Users\\alice\\os-tmp' ? 'C:\\outside\\os-tmp' : path
      }),
      inspect: (path) => ({
        directory: true,
        symbolicLink: false,
        marker: path.includes('\\os-tmp\\') ? marker : { ...marker, canonicalRoot: 'd:\\tampered' }
      }),
      remove
    })

    expect(remove).not.toHaveBeenCalled()
  })

  it('reports unexpected inspection failures so durable cleanup can be retried', () => {
    expect(
      removeMicromambaCacheForRoot(root, {
        platform: 'win32',
        env,
        canonicalize: (path) => win32.normalize(path),
        inspectParent: () => {
          throw new Error('access denied')
        }
      })
    ).toBe(false)
  })
})

describe('removeEmptyManagedParent', () => {
  const parent = 'D:\\OpenScienceTmp'
  const raw = `${JSON.stringify({
    schema: 1,
    kind: 'micromamba-working-cache-parent',
    userIdentity: 'alice'
  })}\n`

  it('removes only the marker and then the verified empty parent non-recursively', () => {
    const removeMarker = vi.fn()
    const removeParent = vi.fn()

    removeEmptyManagedParent(parent, 'alice', () => true, {
      readMarker: () => raw,
      list: () => ['.open-science-temp.json'],
      removeMarker,
      removeParent
    })

    expect(removeMarker).toHaveBeenCalledWith('D:\\OpenScienceTmp\\.open-science-temp.json')
    expect(removeParent).toHaveBeenCalledWith(parent)
  })

  it('restores the marker when a concurrent child makes parent removal fail', () => {
    const restoreMarker = vi.fn()

    expect(() =>
      removeEmptyManagedParent(parent, 'alice', () => true, {
        readMarker: () => raw,
        list: () => ['.open-science-temp.json'],
        removeMarker: vi.fn(),
        removeParent: () => {
          throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' })
        },
        restoreMarker
      })
    ).toThrow(/directory not empty/)
    expect(restoreMarker).toHaveBeenCalledWith('D:\\OpenScienceTmp\\.open-science-temp.json', raw)
  })
})

describe('isTrustedMicromambaWorkingCacheForRoot', () => {
  const root = 'D:\\OpenScience\\runtime'
  const env = { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' }
  const cache = selectMicromambaCache(root, DEFAULT_MAX_CACHE_RELATIVE_PATH, windowsDeps({ env }))
  const marker = {
    schema: 1,
    canonicalRoot: root.toLowerCase(),
    userIdentity: 'alice'
  }
  const trustedDeps: MicromambaCacheCleanupDeps = {
    platform: 'win32',
    env,
    canonicalize: (path) => win32.normalize(path),
    verifyOwnership: () => true,
    inspectParent: (path) => ({
      directory: true,
      symbolicLink: false,
      physical: win32.normalize(path),
      marker: {
        schema: 1,
        kind: 'micromamba-working-cache-parent',
        userIdentity: 'alice'
      }
    }),
    inspect: () => ({ directory: true, symbolicLink: false, marker })
  }

  it('accepts the exact marker- and ownership-verified retained cache', () => {
    expect(isTrustedMicromambaWorkingCacheForRoot(root, cache.path, trustedDeps)).toBe(true)
  })

  it('accepts a marker-owned OpenScienceTmp fallback after TEMP changes', () => {
    const retained = win32.join('E:\\PreviousTemp\\OpenScienceTmp', win32.basename(cache.path))

    expect(isTrustedMicromambaWorkingCacheForRoot(root, retained, trustedDeps)).toBe(true)
  })

  it('rejects a journal path outside a managed temporary parent before scanning it', () => {
    const inspect = vi.fn(trustedDeps.inspect)
    expect(
      isTrustedMicromambaWorkingCacheForRoot(
        root,
        win32.join('C:\\Users\\alice\\Documents', win32.basename(cache.path)),
        { ...trustedDeps, inspect }
      )
    ).toBe(false)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('rejects a retained cache whose parent became a reparse point', () => {
    expect(
      isTrustedMicromambaWorkingCacheForRoot(root, cache.path, {
        ...trustedDeps,
        inspectParent: (path) => ({
          directory: true,
          symbolicLink: true,
          physical: win32.normalize(path)
        })
      })
    ).toBe(false)
  })

  it('rejects an os-tmp fallback outside the current profile', () => {
    expect(
      isTrustedMicromambaWorkingCacheForRoot(
        root,
        win32.join('C:\\OtherUser\\os-tmp', win32.basename(cache.path)),
        trustedDeps
      )
    ).toBe(false)
  })

  it('accepts a physical POSIX package cache and rejects a linked one', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'os-posix-cache-trust-'))
    const runtimeRoot = join(sandbox, 'runtime')
    const physical = join(runtimeRoot, 'pkgs')
    const linkedRuntime = join(sandbox, 'linked-runtime')
    try {
      mkdirSync(physical, { recursive: true })
      expect(
        isTrustedMicromambaWorkingCacheForRoot(runtimeRoot, physical, { platform: 'linux' })
      ).toBe(true)
      mkdirSync(linkedRuntime)
      symlinkSync(
        physical,
        join(linkedRuntime, 'pkgs'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      expect(
        isTrustedMicromambaWorkingCacheForRoot(linkedRuntime, join(linkedRuntime, 'pkgs'), {
          platform: 'linux'
        })
      ).toBe(false)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('retainMicromambaWorkingCache', () => {
  const env = { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' }

  it('publishes and cleans only after the final concurrent user releases', async () => {
    const publishArchives = vi.fn().mockResolvedValue(2)
    const cleanup = vi.fn()
    const deps = {
      platform: 'win32' as const,
      canonicalize: (path: string) => win32.normalize(path),
      publishArchives,
      cleanup
    }
    const releaseFirst = await retainMicromambaWorkingCache('D:\\OpenScience\\runtime', deps)
    const releaseSecond = await retainMicromambaWorkingCache('D:\\OpenScience\\runtime', deps)
    const archiveAuthorization = {
      file: 'a-1.conda',
      algorithm: 'sha256' as const,
      digest: 'a'.repeat(64)
    }
    const secondAuthorization = {
      file: 'b-1.conda',
      algorithm: 'sha256' as const,
      digest: 'b'.repeat(64)
    }

    const firstCompletion = releaseFirst({
      archivePublications: [
        {
          workingRoot: 'D:\\OpenScienceTmp\\m-test',
          authorizations: [archiveAuthorization]
        }
      ]
    })
    await Promise.resolve()
    expect(publishArchives).not.toHaveBeenCalled()
    const secondCompletion = releaseSecond({
      archivePublications: [
        {
          workingRoot: 'C:\\Users\\alice\\os-tmp\\m-bundle',
          authorizations: [secondAuthorization]
        }
      ]
    })
    await expect(Promise.all([firstCompletion, secondCompletion])).resolves.toEqual([true, true])
    expect(publishArchives).toHaveBeenNthCalledWith(
      1,
      'D:\\OpenScience\\runtime',
      'D:\\OpenScienceTmp\\m-test',
      [archiveAuthorization]
    )
    expect(publishArchives).toHaveBeenNthCalledWith(
      2,
      'D:\\OpenScience\\runtime',
      'C:\\Users\\alice\\os-tmp\\m-bundle',
      [secondAuthorization]
    )
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('keeps finalization incomplete when cleanup reports a retryable failure', async () => {
    const release = await retainMicromambaWorkingCache('G:\\OpenScience\\runtime', {
      platform: 'win32',
      canonicalize: (path) => win32.normalize(path),
      cleanup: () => false,
      requiresRecoveryRetention: async () => false
    })

    await expect(release({})).resolves.toBe(false)
  })

  it('blocks a new lease until final publication and cleanup finish', async () => {
    let finishPublication: (() => void) | undefined
    const publication = new Promise<number>((resolve) => {
      finishPublication = () => resolve(1)
    })
    const publishArchives = vi.fn(() => publication)
    const cleanup = vi.fn()
    const deps = {
      platform: 'win32' as const,
      canonicalize: (path: string) => win32.normalize(path),
      publishArchives,
      cleanup
    }
    const releaseFirst = await retainMicromambaWorkingCache('D:\\OpenScience\\runtime', deps)
    const firstRelease = releaseFirst({
      archivePublications: [
        {
          workingRoot: 'D:\\OpenScienceTmp\\m-test',
          authorizations: [{ file: 'a-1.conda', algorithm: 'sha256', digest: 'a'.repeat(64) }]
        }
      ]
    })
    await vi.waitFor(() => expect(publishArchives).toHaveBeenCalledOnce())

    let secondAcquired = false
    const secondLease = retainMicromambaWorkingCache('D:\\OpenScience\\runtime', deps).then(
      (lease) => {
        secondAcquired = true
        return lease
      }
    )
    await Promise.resolve()
    expect(secondAcquired).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()

    finishPublication?.()
    await expect(firstRelease).resolves.toBe(true)
    const releaseSecond = await secondLease
    expect(cleanup).toHaveBeenCalledOnce()
    await expect(releaseSecond({})).resolves.toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('retains the working cache when publication fails or recovery may still need it', async () => {
    const cleanup = vi.fn()
    const publishArchives = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(1)
    const deps = {
      platform: 'win32',
      canonicalize: (path: string) => win32.normalize(path),
      publishArchives,
      cleanup
    } as const
    const failedRelease = await retainMicromambaWorkingCache('E:\\OpenScience\\runtime', deps)
    await expect(
      failedRelease({
        archivePublications: [
          {
            workingRoot: 'E:\\OpenScienceTmp\\m-test',
            authorizations: [{ file: 'a-1.conda', algorithm: 'sha256', digest: 'a'.repeat(64) }]
          }
        ]
      })
    ).resolves.toBe(false)
    expect(cleanup).not.toHaveBeenCalled()

    const retryRelease = await retainMicromambaWorkingCache('E:\\OpenScience\\runtime', deps)
    await expect(retryRelease({})).resolves.toBe(true)
    expect(publishArchives).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledOnce()
    cleanup.mockClear()

    const retainedRelease = await retainMicromambaWorkingCache('F:\\OpenScience\\runtime', {
      platform: 'win32',
      canonicalize: (path) => win32.normalize(path),
      cleanup
    })
    await expect(retainedRelease({ retainForRecovery: true })).resolves.toBe(false)
    expect(cleanup).not.toHaveBeenCalled()

    const publishAfterRetention = vi.fn().mockResolvedValue(1)
    const laterRelease = await retainMicromambaWorkingCache('F:\\OpenScience\\runtime', {
      platform: 'win32',
      canonicalize: (path) => win32.normalize(path),
      publishArchives: publishAfterRetention,
      cleanup
    })
    const laterAuthorization = {
      file: 'later-1.conda',
      algorithm: 'sha256' as const,
      digest: 'c'.repeat(64)
    }
    await expect(
      laterRelease({
        archivePublications: [
          {
            workingRoot: 'F:\\OpenScienceTmp\\m-later',
            authorizations: [laterAuthorization]
          }
        ]
      })
    ).resolves.toBe(true)
    expect(publishAfterRetention).toHaveBeenCalledWith(
      'F:\\OpenScience\\runtime',
      'F:\\OpenScienceTmp\\m-later',
      [laterAuthorization]
    )
    expect(cleanup).not.toHaveBeenCalled()

    await finalizeRecoveredMicromambaWorkingCache(
      'F:\\OpenScience\\runtime',
      {
        platform: 'win32',
        env,
        canonicalize: (path) => win32.normalize(path),
        exists: () => true,
        cleanup
      },
      { mode: 'current-candidates' }
    )
    expect(cleanup).toHaveBeenCalledOnce()

    cleanup.mockClear()
    const releaseAfterRecovery = await retainMicromambaWorkingCache('F:\\OpenScience\\runtime', {
      platform: 'win32',
      canonicalize: (path) => win32.normalize(path),
      cleanup
    })
    await expect(releaseAfterRecovery({})).resolves.toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('retains and blocks new writers after restart while publication authority is pending', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'os-working-cache-recovery-'))
    try {
      const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
      await journal.begin({
        operationId: 'interrupted-install',
        kind: 'install',
        runtimeId: 'analysis::python',
        phase: 'install-python',
        startedAt: Date.now(),
        targetPath: join(runtimeRoot, 'envs', 'analysis'),
        archivePublicationPending: true
      })
      const cleanup = vi.fn()
      const deps = {
        platform: 'win32' as const,
        canonicalize: (path: string) => win32.normalize(path),
        cleanup
      }

      await expect(retainMicromambaWorkingCache(runtimeRoot, deps, 'new-install')).rejects.toThrow(
        'RUNTIME_CACHE_RECOVERY_BLOCKED'
      )
      expect(cleanup).not.toHaveBeenCalled()

      await journal.complete('interrupted-install')
      const releaseAfterRecovery = await retainMicromambaWorkingCache(
        runtimeRoot,
        deps,
        'new-install'
      )
      await expect(releaseAfterRecovery({ completedOperationId: 'new-install' })).resolves.toBe(
        true
      )
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('does not let a successfully published operation retain its own cache', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'os-working-cache-published-'))
    try {
      const operationId = 'completed-install'
      const workingRoot = 'C:\\OpenScienceTmp\\m-current'
      const authorization = {
        file: 'numpy-1.conda',
        algorithm: 'sha256' as const,
        digest: 'a'.repeat(64)
      }
      const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
      await journal.begin({
        operationId,
        kind: 'install',
        runtimeId: 'analysis::python',
        phase: 'install-python',
        startedAt: Date.now(),
        targetPath: join(runtimeRoot, 'envs', 'analysis'),
        archivePublications: [{ workingRoot, authorizations: [authorization] }]
      })
      const cleanup = vi.fn()
      const publishArchives = vi.fn().mockResolvedValue(1)
      const release = await retainMicromambaWorkingCache(
        runtimeRoot,
        {
          platform: 'win32',
          canonicalize: (path) => win32.normalize(path),
          cleanup,
          publishArchives
        },
        operationId
      )

      await expect(
        release({
          archivePublications: [{ workingRoot, authorizations: [authorization] }],
          completedOperationId: operationId
        })
      ).resolves.toBe(true)

      expect(publishArchives).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('refuses a new writer while recovered archive publication is still pending', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'os-working-cache-publication-block-'))
    try {
      const workingRoot = 'C:\\OpenScienceTmp\\m-recovered'
      const authorization = {
        file: 'numpy-1.conda',
        algorithm: 'sha256' as const,
        digest: 'b'.repeat(64)
      }
      const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
      await journal.begin({
        operationId: 'recovered-install',
        kind: 'install',
        runtimeId: 'analysis::python',
        phase: 'install-python',
        startedAt: Date.now(),
        targetPath: join(runtimeRoot, 'envs', 'analysis'),
        archivePublications: [{ workingRoot, authorizations: [authorization] }]
      })
      const cleanup = vi.fn()
      const deps = {
        platform: 'win32' as const,
        canonicalize: (path: string) => win32.normalize(path),
        cleanup
      }

      await expect(retainMicromambaWorkingCache(runtimeRoot, deps, 'new-install')).rejects.toThrow(
        'RUNTIME_CACHE_RECOVERY_BLOCKED'
      )
      expect(cleanup).not.toHaveBeenCalled()

      await journal.complete('recovered-install')
      const releaseAfterRepair = await retainMicromambaWorkingCache(
        runtimeRoot,
        deps,
        'new-install'
      )
      await expect(releaseAfterRepair({ completedOperationId: 'new-install' })).resolves.toBe(true)
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('finalizes a marker-owned cache left by a recovered hard exit without creating an absent one', async () => {
    const cleanup = vi.fn()
    const exists = vi.fn().mockReturnValue(true)
    await expect(
      finalizeRecoveredMicromambaWorkingCache(
        'G:\\OpenScience\\runtime',
        {
          platform: 'win32',
          env,
          canonicalize: (path) => win32.normalize(path),
          exists,
          cleanup
        },
        { mode: 'current-candidates' }
      )
    ).resolves.toBe(true)

    expect(exists).toHaveBeenCalledWith(
      expect.stringMatching(/^G:\\OpenScienceTmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
    )
    expect(cleanup).toHaveBeenCalledWith('G:\\OpenScience\\runtime')

    exists.mockReturnValue(false)
    await expect(
      finalizeRecoveredMicromambaWorkingCache(
        'H:\\OpenScience\\runtime',
        {
          platform: 'win32',
          env,
          canonicalize: (path) => win32.normalize(path),
          exists,
          cleanup
        },
        { mode: 'current-candidates' }
      )
    ).resolves.toBe(false)
  })

  it('finds and finalizes a recovered per-user fallback cache', async () => {
    const cleanup = vi.fn()

    await expect(
      finalizeRecoveredMicromambaWorkingCache(
        'G:\\OpenScience\\runtime',
        {
          platform: 'win32',
          env,
          canonicalize: (path) => win32.normalize(path),
          exists: (path) => path.includes('\\os-tmp\\'),
          cleanup
        },
        { mode: 'current-candidates' }
      )
    ).resolves.toBe(true)

    expect(cleanup).toHaveBeenCalledWith('G:\\OpenScience\\runtime')
  })

  it('finalizes the exact recovered fallback even after TEMP changes', async () => {
    const recovered = 'E:\\PreviousTemp\\OpenScienceTmp\\m-retained'
    const cleanupExact = vi.fn().mockReturnValue(true)

    await expect(
      finalizeRecoveredMicromambaWorkingCache(
        'G:\\OpenScience\\runtime',
        {
          platform: 'win32',
          env,
          canonicalize: (path) => win32.normalize(path),
          exists: (path) => win32.normalize(path) === win32.normalize(recovered),
          cleanupExact
        },
        { mode: 'exact', workingRoots: [recovered] }
      )
    ).resolves.toBe(true)

    expect(cleanupExact).toHaveBeenCalledWith('G:\\OpenScience\\runtime', recovered)
  })

  it('retains the journal when exact-cache inspection is inconclusive', async () => {
    const cleanupExact = vi.fn().mockReturnValue(true)

    await expect(
      finalizeRecoveredMicromambaWorkingCache(
        'G:\\OpenScience\\runtime',
        {
          platform: 'win32',
          env,
          canonicalize: (path) => win32.normalize(path),
          workingRootState: () => 'unknown',
          cleanupExact
        },
        {
          mode: 'exact',
          workingRoots: ['E:\\PreviousTemp\\OpenScienceTmp\\m-retained']
        }
      )
    ).resolves.toBe(false)
    expect(cleanupExact).not.toHaveBeenCalled()
  })

  it('treats the non-Windows durable package root as requiring no disposable cleanup', async () => {
    const runtimeRoot = join('data', 'OpenScience', 'runtime')
    await expect(
      finalizeRecoveredMicromambaWorkingCache(
        runtimeRoot,
        { platform: 'linux', canonicalize: (path) => path },
        { mode: 'exact', workingRoots: [join(runtimeRoot, 'pkgs')] }
      )
    ).resolves.toBe(true)
  })
})

describe('isTrustedWindowsCacheAcl', () => {
  it('builds a literal-safe least-privilege ACL hardening command', () => {
    const script = windowsCacheAclHardeningScript("C:\\Users\\O'Brien\\cache")

    expect(script).toContain("$path='C:\\Users\\O''Brien\\cache'")
    expect(script).toContain('[System.IO.Directory]::GetAccessControl($path)')
    expect(script).not.toContain('.SetOwner(')
    expect(script).toContain('$acl.SetAccessRuleProtection($true,$false)')
    expect(script).toContain('S-1-5-18')
    expect(script).toContain('S-1-5-32-544')
    expect(script).toContain('FileSystemRights]::FullControl')
    expect(script).toContain('[System.IO.Directory]::SetAccessControl($path,$acl)')
    expect(script).not.toMatch(/Everyone|Authenticated Users|S-1-1-0|S-1-5-11/i)
    expect(script).not.toMatch(/Set-Acl/i)
  })

  it('reads ACLs without relying on PowerShell security module autoloading', () => {
    const script = windowsCacheAclReadScript("C:\\Users\\O'Brien\\cache")

    expect(script).toContain(
      "$acl=[System.IO.Directory]::GetAccessControl('C:\\Users\\O''Brien\\cache')"
    )
    expect(script).toContain('$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value')
    expect(script).toContain('$acl.GetAccessRules($true,$true,')
    expect(script).not.toMatch(/Get-Acl/i)
  })

  it('allows writes only for the current user and trusted system principals', () => {
    const current = 'S-1-5-21-1000'
    expect(
      isTrustedWindowsCacheAcl({
        OwnerSid: current,
        CurrentSid: current,
        Rules: [
          { Sid: current, Rights: 'FullControl', Type: 'Allow' },
          { Sid: 'S-1-5-18', Rights: 'FullControl', Type: 'Allow' },
          { Sid: 'S-1-5-32-545', Rights: 'ReadAndExecute', Type: 'Allow' }
        ]
      })
    ).toBe(true)
  })

  it.each(['S-1-5-18', 'S-1-5-32-544'])(
    'accepts a trusted system owner %s when no foreign principal can write',
    (owner) => {
      const current = 'S-1-5-21-1000'
      expect(
        isTrustedWindowsCacheAcl({
          OwnerSid: owner,
          CurrentSid: current,
          Rules: [
            { Sid: current, Rights: 'FullControl', Type: 'Allow' },
            { Sid: owner, Rights: 'FullControl', Type: 'Allow' }
          ]
        })
      ).toBe(true)
    }
  )

  it('rejects a foreign owner or any custom group with write access', () => {
    const current = 'S-1-5-21-1000'
    expect(
      isTrustedWindowsCacheAcl({ OwnerSid: 'S-1-5-21-2000', CurrentSid: current, Rules: [] })
    ).toBe(false)
    expect(
      isTrustedWindowsCacheAcl({
        OwnerSid: current,
        CurrentSid: current,
        Rules: [{ Sid: 'S-1-5-21-3000', Rights: 'Modify, Synchronize', Type: 'Allow' }]
      })
    ).toBe(false)
  })

  it.each(['ChangePermissions', 'TakeOwnership'])(
    'rejects a foreign principal with %s',
    (rights) => {
      const current = 'S-1-5-21-1000'
      expect(
        isTrustedWindowsCacheAcl({
          OwnerSid: current,
          CurrentSid: current,
          Rules: [{ Sid: 'S-1-5-21-3000', Rights: rights, Type: 'Allow' }]
        })
      ).toBe(false)
    }
  )

  it('documents the complete dangerous-rights set used by the uninstaller', () => {
    expect(WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES).toEqual([
      'Write',
      'Modify',
      'FullControl',
      'CreateFiles',
      'AppendData',
      'Delete',
      'DeleteSubdirectoriesAndFiles',
      'ChangePermissions',
      'TakeOwnership'
    ])
  })
})
