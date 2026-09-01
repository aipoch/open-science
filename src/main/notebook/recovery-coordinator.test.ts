import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { operationJournalPath, RuntimeOperationJournal } from './operation-journal'
import { NotebookRecoveryCoordinator } from './recovery-coordinator'
import {
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  rBin,
  readyMarkerPath
} from './runtime-paths'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

const createRuntimeRoot = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), 'open-science-notebook-recovery-'))
  return join(root, 'runtime')
}

const beginInterruptedMaterialize = async (
  runtimeRoot: string,
  operationId: string,
  targetPath: string,
  options: { runtimeId?: string; phase?: string } = {}
): Promise<RuntimeOperationJournal> => {
  const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
  await journal.begin({
    operationId,
    kind: 'materialize',
    runtimeId: options.runtimeId ?? DEFAULT_PY_ENV,
    phase: options.phase ?? 'create-python',
    startedAt: 100,
    targetPath
  })
  return journal
}

describe('NotebookRecoveryCoordinator', () => {
  it('finishes an interrupted managed-Runtime removal using only the exact journalled targets', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    const marker = readyMarkerPath(runtimeRoot)
    const preserved = envPrefix(runtimeRoot, 'analysis')
    await Promise.all([
      mkdir(prefix, { recursive: true }),
      mkdir(preserved, { recursive: true }),
      mkdir(dirname(marker), { recursive: true })
    ])
    await writeFile(marker, 'ready')
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'remove-after-crash',
      kind: 'remove',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'remove-python',
      startedAt: 100,
      targetPaths: [prefix, marker]
    })

    await new NotebookRecoveryCoordinator(runtimeRoot).recover()

    expect(existsSync(prefix)).toBe(false)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(preserved)).toBe(true)
    expect(await journal.pending()).toEqual([])
  })

  it('retains an interrupted removal whose persisted targets are not the exact managed pair', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const unsafe = join(root!, 'outside-runtime')
    await mkdir(unsafe, { recursive: true })
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'unsafe-remove-after-crash',
      kind: 'remove',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'remove-python',
      startedAt: 100,
      targetPaths: [envPrefix(runtimeRoot, DEFAULT_PY_ENV), unsafe]
    })

    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot)
    await coordinator.recover()

    expect(existsSync(unsafe)).toBe(true)
    expect(await journal.pending()).toHaveLength(1)
    expect(coordinator.isPrefixBlocked(envPrefix(runtimeRoot, DEFAULT_PY_ENV))).toBe(false)
  })

  it('blocks recreation when removal succeeds but journal completion remains pending', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    const marker = readyMarkerPath(runtimeRoot)
    await Promise.all([
      mkdir(prefix, { recursive: true }),
      mkdir(dirname(marker), { recursive: true })
    ])
    await writeFile(marker, 'ready')
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'remove-completion-pending',
      kind: 'remove',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'remove-python',
      startedAt: 100,
      targetPaths: [prefix, marker]
    })
    const complete = vi
      .spyOn(RuntimeOperationJournal.prototype, 'complete')
      .mockRejectedValueOnce(new Error('journal fsync failed'))
    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot)

    try {
      await coordinator.recover()
    } finally {
      complete.mockRestore()
    }

    expect(existsSync(prefix)).toBe(false)
    expect(existsSync(marker)).toBe(false)
    expect(await journal.pending()).toHaveLength(1)
    expect(coordinator.isPrefixBlocked(prefix)).toBe(true)
    expect(coordinator.snapshot().blockedPrefixes).toContain(prefix)
  })

  it('finalizes a leftover working cache only after recovery has no blocked writer', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const finalizeWorkingCache = vi.fn().mockResolvedValue(true)
    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      finalizeWorkingCache
    })

    await coordinator.recover()

    expect(finalizeWorkingCache).toHaveBeenCalledWith(runtimeRoot, {
      mode: 'current-candidates'
    })
  })

  it('publishes a committed archive intent before clearing its journal and working cache', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    const publications = [
      {
        workingRoot: 'D:\\OpenScienceTmp\\m-test',
        authorizations: [
          { file: 'python-1.conda', algorithm: 'sha256' as const, digest: 'a'.repeat(64) }
        ]
      }
    ]
    await journal.begin({
      operationId: 'publish-after-crash',
      kind: 'install',
      runtimeId: 'analysis',
      phase: 'install-python',
      startedAt: 100,
      archivePublications: publications
    })
    const publishWorkingCacheArchives = vi.fn().mockResolvedValue(undefined)
    const finalizeWorkingCache = vi.fn().mockResolvedValue(true)

    await new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      publishWorkingCacheArchives,
      finalizeWorkingCache
    }).recover()

    expect(publishWorkingCacheArchives).toHaveBeenCalledWith(runtimeRoot, publications)
    expect(await journal.pending()).toEqual([])
    expect(finalizeWorkingCache).toHaveBeenCalledWith(runtimeRoot, {
      mode: 'exact',
      workingRoots: [publications[0].workingRoot]
    })
  })

  it('completes publication recovery when no disposable-cache finalizer is configured', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'publish-without-finalizer',
      kind: 'install',
      runtimeId: 'analysis',
      phase: 'install-python',
      startedAt: 100,
      archivePublications: [
        {
          workingRoot: 'D:\\OpenScienceTmp\\m-test',
          authorizations: [{ file: 'python-1.conda', algorithm: 'sha256', digest: 'a'.repeat(64) }]
        }
      ]
    })

    await new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      publishWorkingCacheArchives: vi.fn().mockResolvedValue(undefined)
    }).recover()

    expect(await journal.pending()).toEqual([])
  })

  it('retains publication evidence and the working cache when recovered publication fails', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'publish-retry',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create-python',
      startedAt: 100,
      archivePublications: [
        {
          workingRoot: 'D:\\OpenScienceTmp\\m-test',
          authorizations: [{ file: 'python-1.conda', algorithm: 'sha256', digest: 'a'.repeat(64) }]
        }
      ]
    })
    const finalizeWorkingCache = vi.fn().mockResolvedValue(true)

    await new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      publishWorkingCacheArchives: vi.fn().mockRejectedValue(new Error('disk full')),
      finalizeWorkingCache
    }).recover()

    expect((await journal.pending()).map(({ operationId }) => operationId)).toEqual([
      'publish-retry'
    ])
    expect(finalizeWorkingCache).not.toHaveBeenCalled()
  })

  it('cleans a distinct recovered fallback when a later publication remains retained', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    const completedRoot = 'E:\\PreviousTemp\\OpenScienceTmp\\m-complete'
    const retainedRoot = 'F:\\PreviousTemp\\OpenScienceTmp\\m-retained'
    for (const [operationId, workingRoot] of [
      ['publish-complete', completedRoot],
      ['publish-retained', retainedRoot]
    ]) {
      await journal.begin({
        operationId,
        kind: 'install',
        runtimeId: operationId,
        phase: 'install-python',
        startedAt: 100,
        archivePublications: [
          {
            workingRoot,
            authorizations: [
              {
                file: `${operationId}.conda`,
                algorithm: 'sha256',
                digest: 'a'.repeat(64)
              }
            ]
          }
        ]
      })
    }
    const publishWorkingCacheArchives = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full'))
    const finalizeWorkingCache = vi.fn().mockResolvedValue(true)

    await new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      publishWorkingCacheArchives,
      finalizeWorkingCache
    }).recover()

    expect((await journal.pending()).map((record) => record.operationId)).toEqual([
      'publish-retained'
    ])
    expect(finalizeWorkingCache).toHaveBeenCalledWith(runtimeRoot, {
      mode: 'exact',
      workingRoots: [completedRoot]
    })
  })

  it('keeps the exact fallback durable until transient cleanup succeeds on a later startup', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    const workingRoot = 'E:\\PreviousTemp\\OpenScienceTmp\\m-retry'
    await journal.begin({
      operationId: 'cleanup-retry',
      kind: 'install',
      runtimeId: 'analysis',
      phase: 'install-python',
      startedAt: 100,
      archivePublications: [
        {
          workingRoot,
          authorizations: [{ file: 'analysis.conda', algorithm: 'sha256', digest: 'a'.repeat(64) }]
        }
      ]
    })
    const publishWorkingCacheArchives = vi.fn().mockResolvedValue(undefined)
    const finalizeWorkingCache = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)

    await new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      publishWorkingCacheArchives,
      finalizeWorkingCache
    }).recover()
    expect((await journal.pending()).map((record) => record.operationId)).toEqual(['cleanup-retry'])

    await new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      publishWorkingCacheArchives,
      finalizeWorkingCache
    }).recover()
    expect(await journal.pending()).toEqual([])
    expect(publishWorkingCacheArchives).toHaveBeenCalledTimes(2)
  })

  it('suppresses cleanup when the journal becomes corrupt during recovery', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'corrupt-after-publication',
      kind: 'install',
      runtimeId: 'analysis',
      phase: 'install-python',
      startedAt: 100,
      archivePublications: [
        {
          workingRoot: 'D:\\OpenScienceTmp\\m-test',
          authorizations: [{ file: 'python-1.conda', algorithm: 'sha256', digest: 'a'.repeat(64) }]
        }
      ]
    })
    const finalizeWorkingCache = vi.fn().mockResolvedValue(true)
    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      publishWorkingCacheArchives: async () => {
        await writeFile(operationJournalPath(runtimeRoot), '{ corrupt', 'utf8')
      },
      finalizeWorkingCache
    })

    await coordinator.recover()

    expect(coordinator.snapshot().corruptJournal).toBe(true)
    expect(finalizeWorkingCache).not.toHaveBeenCalled()
  })

  it('does not clean a cache retained under an equivalent Windows path spelling', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    const firstRoot = 'E:\\PreviousTemp\\OpenScienceTmp\\m-shared'
    const secondRoot = 'e:/previoustemp/opensciencetmp/m-shared'
    for (const [operationId, workingRoot] of [
      ['shared-published', firstRoot],
      ['shared-retained', secondRoot]
    ]) {
      await journal.begin({
        operationId,
        kind: 'install',
        runtimeId: operationId,
        phase: 'install-python',
        startedAt: 100,
        archivePublications: [
          {
            workingRoot,
            authorizations: [
              { file: `${operationId}.conda`, algorithm: 'sha256', digest: 'a'.repeat(64) }
            ]
          }
        ]
      })
    }
    const finalizeWorkingCache = vi.fn().mockResolvedValue(true)

    await new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      publishWorkingCacheArchives: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('disk full')),
      finalizeWorkingCache,
      workingCacheKey: (path) => win32.normalize(path).toLowerCase()
    }).recover()

    expect(finalizeWorkingCache).not.toHaveBeenCalled()
    expect((await journal.pending()).map((record) => record.operationId).sort()).toEqual([
      'shared-published',
      'shared-retained'
    ])
  })

  it('blocks an ambiguous post-mutation publication and retains the working cache', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const targetPath = join(runtimeRoot, 'envs', 'analysis')
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'publication-crash-window',
      kind: 'install',
      runtimeId: 'analysis',
      phase: 'install-python',
      startedAt: 100,
      targetPath,
      archivePublicationPending: true
    })
    const finalizeWorkingCache = vi.fn().mockResolvedValue(true)
    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      finalizeWorkingCache
    })

    await coordinator.recover()

    expect(coordinator.snapshot()).toMatchObject({
      blockedPrefixes: [targetPath],
      blockedRuntimeIds: ['analysis']
    })
    expect(await journal.pending()).toHaveLength(1)
    expect(finalizeWorkingCache).not.toHaveBeenCalled()
  })

  it('owns blocked and live-unconfirmed recovery state in one snapshot', async () => {
    const coordinator = new NotebookRecoveryCoordinator(await createRuntimeRoot())

    coordinator.markLiveUnconfirmed('/runtime/envs/default-python', 'managed:python:default')

    expect(coordinator.snapshot()).toMatchObject({
      readiness: 'not-started',
      blockedPrefixes: ['/runtime/envs/default-python'],
      blockedRuntimeIds: ['managed:python:default'],
      liveUnconfirmedPrefixes: ['/runtime/envs/default-python'],
      liveUnconfirmedRuntimeIds: ['managed:python:default'],
      corruptJournal: false
    })
  })

  it('keeps a corrupt journal fail-closed while allowlisting only the reset prefix', async () => {
    const runtimeRoot = await createRuntimeRoot()
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(operationJournalPath(runtimeRoot), '{ not json', 'utf8')
    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot)

    await coordinator.recover()

    const resetPrefix = join(runtimeRoot, 'envs', 'default-python')
    const otherPrefix = join(runtimeRoot, 'envs', 'analysis')
    expect(coordinator.snapshot()).toMatchObject({ readiness: 'ready', corruptJournal: true })
    expect(coordinator.isPrefixBlocked(resetPrefix)).toBe(true)
    expect(coordinator.isPrefixBlocked(otherPrefix)).toBe(true)

    coordinator.allowCorruptReset(resetPrefix)

    expect(coordinator.isPrefixBlocked(resetPrefix)).toBe(false)
    expect(coordinator.isPrefixBlocked(otherPrefix)).toBe(true)
  })

  it('removes an interrupted materialize prefix that has conda metadata but no interpreter', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    await mkdir(join(prefix, 'conda-meta'), { recursive: true })
    const journal = await beginInterruptedMaterialize(runtimeRoot, 'partial-python', prefix)

    await new NotebookRecoveryCoordinator(runtimeRoot).recover()

    expect({ prefixExists: existsSync(prefix), pending: await journal.pending() }).toEqual({
      prefixExists: false,
      pending: []
    })
  })

  describe.skipIf(process.platform === 'win32')('language-specific interpreter recovery', () => {
    it.each(['create-r', 'restore'])(
      'verifies the R interpreter for an interrupted %s operation',
      async (phase) => {
        const runtimeRoot = await createRuntimeRoot()
        const prefix = envPrefix(runtimeRoot, DEFAULT_R_ENV)
        await mkdir(join(prefix, 'conda-meta'), { recursive: true })
        await mkdir(dirname(pythonBin(prefix)), { recursive: true })
        await writeFile(pythonBin(prefix), `#!${process.execPath}\nprocess.exit(0)\n`)
        await chmod(pythonBin(prefix), 0o755)
        await writeFile(rBin(prefix), 'not an R interpreter')
        const journal = await beginInterruptedMaterialize(runtimeRoot, `r-${phase}`, prefix, {
          runtimeId: DEFAULT_R_ENV,
          phase
        })

        await new NotebookRecoveryCoordinator(runtimeRoot).recover()

        expect({ prefixExists: existsSync(prefix), pending: await journal.pending() }).toEqual({
          prefixExists: false,
          pending: []
        })
      }
    )
  })

  it('retains recovery evidence without touching a journal target outside managed envs', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const outside = join(dirname(runtimeRoot), 'outside')
    await mkdir(join(outside, 'conda-meta'), { recursive: true })
    const journal = await beginInterruptedMaterialize(runtimeRoot, 'outside-target', outside)

    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot)
    await coordinator.recover()

    expect(existsSync(outside)).toBe(true)
    expect((await journal.pending()).map(({ operationId }) => operationId)).toEqual([
      'outside-target'
    ])
    expect(coordinator.isPrefixBlocked(outside)).toBe(true)
    expect(coordinator.isRuntimeIdBlocked(DEFAULT_PY_ENV)).toBe(true)
  })

  it('retains recovery evidence when a managed prefix resolves outside the env root', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const outside = join(dirname(runtimeRoot), 'outside')
    await mkdir(join(outside, 'conda-meta'), { recursive: true })
    await mkdir(dirname(pythonBin(outside)), { recursive: true })
    await writeFile(pythonBin(outside), 'not an interpreter')
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    await mkdir(dirname(prefix), { recursive: true })
    await symlink(outside, prefix, process.platform === 'win32' ? 'junction' : 'dir')
    const journal = await beginInterruptedMaterialize(runtimeRoot, 'escaping-prefix', prefix)

    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot)
    await coordinator.recover()

    expect(existsSync(prefix)).toBe(true)
    expect((await journal.pending()).map(({ operationId }) => operationId)).toEqual([
      'escaping-prefix'
    ])
    expect(coordinator.isPrefixBlocked(prefix)).toBe(true)
    expect(coordinator.isRuntimeIdBlocked(DEFAULT_PY_ENV)).toBe(true)
  })

  it('retains an incomplete prefix when the managed env root resolves outside the runtime', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const outsideEnvs = join(dirname(runtimeRoot), 'outside-envs')
    await mkdir(outsideEnvs, { recursive: true })
    await mkdir(runtimeRoot, { recursive: true })
    await symlink(
      outsideEnvs,
      join(runtimeRoot, 'envs'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    await mkdir(join(prefix, 'conda-meta'), { recursive: true })
    const journal = await beginInterruptedMaterialize(runtimeRoot, 'escaping-env-root', prefix)

    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot)
    await coordinator.recover()

    expect(existsSync(prefix)).toBe(true)
    expect((await journal.pending()).map(({ operationId }) => operationId)).toEqual([
      'escaping-env-root'
    ])
    expect(coordinator.isPrefixBlocked(prefix)).toBe(true)
    expect(coordinator.isRuntimeIdBlocked(DEFAULT_PY_ENV)).toBe(true)
  })

  it('retains a managed prefix symlink without deleting its sibling target', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const sibling = join(runtimeRoot, 'envs', 'sibling')
    await mkdir(join(sibling, 'conda-meta'), { recursive: true })
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    await symlink(sibling, prefix, process.platform === 'win32' ? 'junction' : 'dir')
    const journal = await beginInterruptedMaterialize(runtimeRoot, 'sibling-prefix', prefix)

    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot)
    await coordinator.recover()

    expect(existsSync(sibling)).toBe(true)
    expect((await journal.pending()).map(({ operationId }) => operationId)).toEqual([
      'sibling-prefix'
    ])
    expect(coordinator.isPrefixBlocked(prefix)).toBe(true)
    expect(coordinator.isRuntimeIdBlocked(DEFAULT_PY_ENV)).toBe(true)
  })

  it('retains recovery evidence for a dangling managed prefix symlink', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    await mkdir(dirname(prefix), { recursive: true })
    await symlink(
      join(dirname(prefix), 'missing'),
      prefix,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const journal = await beginInterruptedMaterialize(runtimeRoot, 'dangling-prefix', prefix)

    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot)
    await coordinator.recover()

    expect((await lstat(prefix)).isSymbolicLink()).toBe(true)
    expect((await journal.pending()).map(({ operationId }) => operationId)).toEqual([
      'dangling-prefix'
    ])
    expect(coordinator.isPrefixBlocked(prefix)).toBe(true)
    expect(coordinator.isRuntimeIdBlocked(DEFAULT_PY_ENV)).toBe(true)
  })

  it('fails closed after disposal even if reset commands clear known blocks', async () => {
    const coordinator = new NotebookRecoveryCoordinator(await createRuntimeRoot())
    const prefix = '/runtime/envs/default-python'
    coordinator.markLiveUnconfirmed(prefix, 'managed:python:default')

    await coordinator.dispose()
    coordinator.clearPrefixBlock(prefix)
    coordinator.clearRuntimeBlock('managed:python:default')
    coordinator.allowCorruptReset(prefix)

    expect(coordinator.snapshot().readiness).toBe('disposed')
    expect(coordinator.isPrefixBlocked(prefix)).toBe(true)
    expect(coordinator.isRuntimeIdBlocked('managed:python:default')).toBe(true)
    await expect(coordinator.recover()).rejects.toThrow(/disposed/)
  })
})
