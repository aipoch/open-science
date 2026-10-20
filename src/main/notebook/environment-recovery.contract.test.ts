import { verifyExecutable } from './environment-process'

import { existsSync } from 'node:fs'

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { operationJournalPath, RuntimeOperationJournal } from '@aipoch/environment'
import { NotebookRecoveryCoordinator } from '@aipoch/environment'
import { createNotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'
import { DefaultRuntimeProvisioner } from '@aipoch/environment'
import type { ProvisionProgress } from '@aipoch/environment/contracts'
import { DEFAULT_PY_ENV, envPrefix, writeReadyMarker } from '@aipoch/environment'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

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

describe('NotebookRecoveryCoordinator', () => {
  it('reported recovery failure does not claim an unconfirmed worker for missing archive bytes', async () => {
    const runtimeRoot = await createRuntimeRoot()
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    await mkdir(prefix, { recursive: true })
    writeReadyMarker(runtimeRoot, 0, 'reported-recovery')
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'reported-missing-archive',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      targetPath: prefix,
      phase: 'create-python',
      startedAt: 100,
      // No spawn intent or child sidecar: this fixture has no possibly surviving worker.
      // The recorded source and durable archive are both absent, as can happen after cache loss.
      archivePublications: [
        {
          workingRoot: join(runtimeRoot, 'missing-working-cache'),
          authorizations: [
            {
              file: 'xlrd-2.0.2-pyhd8ed1ab_0.conda',
              algorithm: 'sha256',
              digest: 'a'.repeat(64)
            }
          ]
        }
      ]
    })
    const coordinator = new NotebookRecoveryCoordinator(runtimeRoot, undefined, {
      verifyExecutable
    })
    await coordinator.recover()
    expect(coordinator.status().operations).toEqual([
      expect.objectContaining({
        operationId: 'reported-missing-archive',
        reason: 'recovery-failed'
      })
    ])
    expect(coordinator.isPrefixBlocked(prefix)).toBe(true)

    const runArgv = vi.fn().mockResolvedValue(undefined)
    const progress: ProvisionProgress[] = []
    const lifecycle = createNotebookEnvironmentLifecycle({
      root: runtimeRoot,
      provisioner: new DefaultRuntimeProvisioner({
        root: runtimeRoot,
        mm: join(runtimeRoot, 'unused-micromamba'),
        channel: 'conda-forge',
        fetchBundle: async () => {
          throw new Error('Blocked recovery must not download a runtime.')
        },
        runArgv,
        verify: async () => undefined,
        isPrefixBlocked: (path) => coordinator.isPrefixBlocked(path)
      }),
      waitForRecovery: () => coordinator.ensureReady(),
      recoveryStatus: () => coordinator.status(),
      projectProgress: (event) => progress.push(event)
    })
    await lifecycle.startup()

    expect(runArgv).not.toHaveBeenCalled()
    expect(existsSync(prefix)).toBe(true)
    expect(await journal.pending()).toHaveLength(1)
    const failure = progress.find((event) => event.phase === 'error')
    expect(failure?.diagnostic).toContain('RUNTIME_RECOVERY_BLOCKED')
    expect(failure?.diagnostic).not.toContain('worker process could not be confirmed stopped')
  })
})
