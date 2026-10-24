import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'
import type { NotebookExecutionRequest } from './execution-contract'
import type { NotebookEnvironmentManifest } from '../../shared/notebook'

configureTestRuntimeMetadata()
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('R execution without variable snapshots', () => {
  it.each(['available', 'environment-failure'] as const)(
    'executes consecutive cells without persisting variable values: %s',
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'stage-execution-owner-'))
      roots.push(root)
      const requests: NotebookExecutionRequest[] = []
      const manifest: NotebookEnvironmentManifest = {
        schemaVersion: 1,
        captureKind: 'completed-run',
        capturedAt: '2026-10-20T00:00:00Z',
        installedInventory: {
          capturedAt: '2026-10-20T00:00:00Z',
          source: 'full-scan',
          validation: 'full-scan'
        },
        kernelKind: 'r',
        environmentName: 'default-r',
        runtimeSource: 'managed',
        inventorySources: ['kernel-native'],
        packages: [],
        complete: true,
        captureStatus: 'complete'
      }
      const captureCompletedRun = vi.fn().mockResolvedValue({
        manifest,
        checksum: 'a'.repeat(64),
        storagePath: '',
        environmentLock: {
          state: 'available' as const,
          format: 'environment-lock-bundle' as const,
          lockChecksum: 'b'.repeat(64)
        }
      })
      if (scenario === 'environment-failure')
        captureCompletedRun.mockRejectedValue(new Error('environment unavailable'))
      const repository = new NotebookRunRepository(root)
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository,
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun,
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn(),
          refreshAfterPackageMutation: vi.fn()
        },
        executorFactory: () => ({
          execute: async (request) => {
            requests.push(request)
            expect(request).not.toHaveProperty('stageCheckpoint')
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })
      const request = {
        projectId: 'default-project',
        sessionId: 'session',
        workspaceCwd: root,
        language: 'r' as const,
        code: 'res <- results(dds)'
      }
      const first = await service.execute(request)
      const second = await service.execute({ ...request, cellId: first.cellId })
      expect(first.runId).not.toBe(second.runId)
      expect(captureCompletedRun).toHaveBeenCalledTimes(2)
      const history = await new NotebookRunRepository(root).readSessionRuns(
        'default-project',
        'session'
      )
      expect(history).toHaveLength(2)
      for (const run of history) {
        expect(run.status).toBe('completed')
        expect(run).not.toHaveProperty('stageCheckpoint')
      }
      await expect(
        readdir(join(requests[0].notebookSessionRoot, '.r-stage-checkpoints'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        readdir(join(root, 'runtime', 'provenance', 'r-stage-checkpoints'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await service.shutdownAll()
    }
  )
})
