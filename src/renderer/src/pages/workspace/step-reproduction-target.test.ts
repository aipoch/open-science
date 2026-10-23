import { describe, expect, it, vi } from 'vitest'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import type {
  ArtifactVersionExecutionProvenance,
  ProvenanceNotebookRun
} from '../../../../shared/artifact-provenance'
import type { ProjectFileItem } from '../../../../shared/project-files'
import type { SessionReproducibilityBatch } from '../../../../shared/session-reproducibility'
import { findStepReproductionTarget, isStepReproductionBatch } from './step-reproduction-target'

const scope = { projectId: 'p', appSessionId: 's' }
const checkpoint = {
  state: 'available' as const,
  schemaVersion: 1 as const,
  runId: 'run-7',
  kernelEpochId: 'epoch',
  sourceChecksum: 'source',
  environmentLockChecksum: 'lock',
  input: { checksum: 'before', storageKey: 'input', sizeBytes: 12 },
  output: { checksum: 'after', storageKey: 'output', sizeBytes: 20 },
  inputNames: ['data'],
  outputNames: ['result']
}
const run = {
  runId: 'run-7',
  kernelKind: 'r',
  status: 'completed',
  script: 'result <- nrow(data)',
  kernelEpochId: 'epoch',
  stageCheckpoint: checkpoint
} as NotebookRunRecord
const captured = (): ProvenanceNotebookRun =>
  ({ ...structuredClone(run), runIndex: 6 }) as unknown as ProvenanceNotebookRun
const file = {
  source: 'artifact',
  sourceFileId: 'a',
  sourceVersionId: 'v2',
  name: 'result.csv'
} as ProjectFileItem
const execution = (capturedRun = captured()): ArtifactVersionExecutionProvenance =>
  ({
    execution: {
      schemaVersion: 2,
      rootFrameId: 'root',
      agentFrameId: 'root',
      messageBranchId: 'branch',
      terminalPromptMessageId: 'prompt',
      producerRunId: 'run-7',
      producerRunIndex: 6,
      createdAt: new Date(0).toISOString(),
      inputFiles: [],
      runs: [capturedRun],
      workflow: {
        state: 'available',
        captureId: 'a'.repeat(64),
        stages: [{ runId: 'run-7', runIndex: 6, kernelKind: 'r', outputCount: 1 }],
        boundaries: []
      }
    }
  }) as ArtifactVersionExecutionProvenance

describe('frozen step reproduction target', () => {
  it('pins the enumerated version and its exact captured run without selecting upstream steps', async () => {
    const readExecution = vi.fn().mockResolvedValue(execution())
    const target = await findStepReproductionTarget({ run, scope, files: [file], readExecution })
    expect(readExecution).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      artifactId: 'a',
      versionId: 'v2'
    })
    expect(target).toMatchObject({
      artifactId: 'a',
      versionId: 'v2',
      workflow: {
        captureId: 'a'.repeat(64),
        independent: true,
        targetRunIds: ['run-7'],
        boundaryEntityIds: []
      }
    })
  })

  it.each([
    ['source', { script: 'result <- 99' }],
    ['epoch', { kernelEpochId: 'new-epoch' }],
    ['truncated source', { scriptTruncated: true }],
    [
      'input checkpoint',
      { stageCheckpoint: { ...checkpoint, input: { ...checkpoint.input, checksum: 'other' } } }
    ],
    ['environment lock', { stageCheckpoint: { ...checkpoint, environmentLockChecksum: 'other' } }],
    ['missing checkpoint', { stageCheckpoint: undefined }]
  ])('rejects a matching run ID with different %s', async (_label, changes) => {
    const readExecution = vi
      .fn()
      .mockResolvedValue(execution({ ...captured(), ...changes } as ProvenanceNotebookRun))
    expect(
      await findStepReproductionTarget({ run, scope, files: [file], readExecution })
    ).toBeUndefined()
    expect(readExecution).toHaveBeenCalledTimes(1)
  })

  it('does not invent a capture when the current artifact version no longer covers the run', async () => {
    const value = execution()
    value.execution!.workflow = { state: 'unavailable', reason: 'incomplete-evidence' }
    const readExecution = vi.fn().mockResolvedValue(value)
    expect(
      await findStepReproductionTarget({ run, scope, files: [file], readExecution })
    ).toBeUndefined()
  })

  it('never resolves failed or non-R runs to independent R reproduction', async () => {
    const readExecution = vi.fn()
    for (const changes of [{ status: 'failed' }, { kernelKind: 'python' }]) {
      expect(
        await findStepReproductionTarget({
          run: { ...run, ...changes } as NotebookRunRecord,
          scope,
          files: [file],
          readExecution
        })
      ).toBeUndefined()
    }
    expect(readExecution).not.toHaveBeenCalled()
  })

  it('owns a saved batch only after resolving the same artifact, version, capture and single run', async () => {
    const target = await findStepReproductionTarget({
      run,
      scope,
      files: [file],
      readExecution: async () => execution()
    })
    const batch = {
      ...scope,
      targets: [{ ...target, status: 'queued' }]
    } as SessionReproducibilityBatch
    expect(isStepReproductionBatch(batch, scope, undefined)).toBe(false)
    expect(isStepReproductionBatch(batch, scope, target)).toBe(true)
    for (const changed of [
      { versionId: 'v1' },
      { artifactId: 'other' },
      { workflow: { ...target!.workflow, captureId: 'b'.repeat(64) } },
      { workflow: { ...target!.workflow, targetRunIds: ['run-7', 'upstream'] } },
      { workflow: { ...target!.workflow, boundaryEntityIds: ['boundary'] } }
    ]) {
      expect(
        isStepReproductionBatch(
          { ...batch, targets: [{ ...batch.targets[0], ...changed }] },
          scope,
          target
        )
      ).toBe(false)
    }
    expect(isStepReproductionBatch({ ...batch, appSessionId: 'another' }, scope, target)).toBe(
      false
    )
  })
})
