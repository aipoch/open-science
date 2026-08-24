import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { operationJournalPath, RuntimeOperationJournal } from './operation-journal'
import { NotebookRecoveryCoordinator } from './recovery-coordinator'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV, envPrefix, pythonBin, rBin } from './runtime-paths'

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
