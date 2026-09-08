import { describe, it, expect } from 'vitest'
import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import {
  validateReproductionContext,
  validateReproductionDiskSpace
} from './reproduction-preflight'

const fixture = (kind: 'r' | 'python'): PersistedArtifactExecutionSnapshot => ({
  schemaVersion: 2,
  rootFrameId: 'root',
  agentFrameId: 'agent',
  messageBranchId: 'branch',
  terminalPromptMessageId: 'prompt',
  producerRunId: 'two',
  producerRunIndex: 1,
  createdAt: '',
  inputFiles: [],
  runs: ['one', 'two'].map((id, index) => ({
    runId: id,
    runIndex: index,
    agentFrameId: 'agent',
    messageBranchId: 'branch',
    runtimeSegmentId: 'segment',
    promptMessageId: 'prompt',
    kernelEpochId: 'same',
    kernelKind: kind,
    script: '',
    status: 'completed',
    startedAt: '',
    outputs: [],
    inputFileVersionKeys: []
  })),
  reproducibilityRecipe: {
    schemaVersion: 1,
    recipeId: '',
    targetVersionId: 'version',
    targetEntityId: 'output',
    targetChecksum: '',
    graphChecksum: '',
    capture: { state: 'sealed', reasonCodes: [] },
    steps: ['one', 'two'].map((id, index) => ({
      kind: 'notebook-run',
      stepId: id,
      activityId: `activity-${id}`,
      runId: id,
      runIndex: index,
      sequence: index,
      kernelKind: kind,
      sourceChecksum: '',
      environmentRequirementId: id,
      inputEntityIds: [],
      outputEntityIds: []
    })),
    environmentRequirements: ['one', 'two'].map((id) => ({
      requirementId: id,
      kernelKind: kind,
      lockChecksum: id,
      lockState: 'available'
    })),
    frontiers: [
      {
        frontierId: 'original-inputs',
        claimScope: 'end-to-end',
        stepIds: ['one', 'two'],
        crossingFiles: [
          {
            entityId: 'input',
            checksum: '',
            sizeBytes: 200 * 1024 * 1024,
            contentStorageKey: 'input',
            materializationPath: 'inputs/data'
          }
        ],
        reasonCodes: []
      }
    ]
  }
})
describe('reproduction preflight', () => {
  it.each(['python', 'r'] as const)(
    'detects %s lock transitions before restoring packages',
    (kind) => {
      const execution = fixture(kind)
      expect(() => validateReproductionContext(execution, 'original-inputs')).toThrow(
        'changed environment locks'
      )
      execution.runs[1]!.kernelEpochId = 'new'
      expect(() => validateReproductionContext(execution, 'original-inputs')).not.toThrow()
      execution.runs[1]!.kernelEpochId = 'same'
      execution.reproducibilityRecipe!.frontiers[0]!.stepIds = ['two']
      expect(() => validateReproductionContext(execution, 'original-inputs')).not.toThrow()
    }
  )
  it('budgets streamed large inputs against available temporary-volume space', async () => {
    const recipe = fixture('r').reproducibilityRecipe!
    await expect(
      validateReproductionDiskSpace(recipe, 'original-inputs', async () => 100 * 1024 * 1024)
    ).rejects.toThrow('free space')
    await expect(
      validateReproductionDiskSpace(recipe, 'original-inputs', async () => 300 * 1024 * 1024)
    ).resolves.toBeUndefined()
    await expect(
      validateReproductionDiskSpace(recipe, 'original-inputs', async () => undefined)
    ).resolves.toBeUndefined()
  })
})
