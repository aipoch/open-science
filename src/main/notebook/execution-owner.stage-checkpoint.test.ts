import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
const checksum = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('R stage capture execution ownership', () => {
  it.each(['available', 'environment-failure', 'file-failure'] as const)(
    'binds per-run state after environment capture and persists %s evidence',
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
            expect(request.kernelEpochId).toBeTruthy()
            expect(request.stageCheckpoint).toBeDefined()
            // A normal successful cell still completes when optional evidence cannot be published.
            await writeFile(request.stageCheckpoint!.inputPath, `before-${requests.length}`)
            if (scenario !== 'file-failure')
              await writeFile(request.stageCheckpoint!.outputPath, `after-${requests.length}`)
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: [],
              stageCheckpointCapture: {
                state: 'available',
                inputNames: ['dds'],
                outputNames: ['res']
              }
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
      expect(requests[0].stageCheckpoint!.inputPath).not.toBe(
        requests[1].stageCheckpoint!.inputPath
      )
      expect(captureCompletedRun).toHaveBeenCalledTimes(2)
      const history = await new NotebookRunRepository(root).readSessionRuns(
        'default-project',
        'session'
      )
      expect(history).toHaveLength(2)
      for (const [index, run] of history.entries()) {
        expect(run.status).toBe('completed')
        if (scenario === 'available') {
          expect(run.stageCheckpoint).toMatchObject({
            state: 'available',
            runId: run.runId,
            kernelEpochId: requests[index].kernelEpochId,
            sourceChecksum: checksum(request.code),
            environmentLockChecksum: 'b'.repeat(64),
            inputNames: ['dds'],
            outputNames: ['res']
          })
          if (run.stageCheckpoint?.state !== 'available') throw new Error('missing sealed state')
          expect(await readFile(join(root, run.stageCheckpoint.input.storageKey), 'utf8')).toBe(
            `before-${index + 1}`
          )
        } else expect(run.stageCheckpoint).toMatchObject({ state: 'unavailable' })
      }
      expect(await readdir(join(requests[0].notebookSessionRoot, '.r-stage-checkpoints'))).toEqual(
        []
      )
      await service.shutdownAll()
    }
  )
})
