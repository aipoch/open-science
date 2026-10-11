import { describe, expect, it } from 'vitest'

import type {
  ArtifactProvenanceGraph,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { projectPublicArtifactExecutionSnapshot } from './provenance-execution-projection'

const checksum = (character: string): string => character.repeat(64)

const graph = (): ArtifactProvenanceGraph => ({
  schemaVersion: 1,
  targetEntityId: 'artifact-version:version-1',
  completeness: 'complete',
  reasonCodes: [],
  activities: [
    {
      activityId: 'run-1',
      kind: 'notebook-run',
      sequence: 0,
      runIndex: 0,
      inclusion: 'target-closure',
      evidenceState: 'available'
    },
    {
      activityId: 'run-2',
      kind: 'notebook-run',
      sequence: 1,
      runIndex: 1,
      inclusion: 'target-closure',
      evidenceState: 'available'
    },
    {
      activityId: 'artifact-publication:version-1',
      kind: 'artifact-publication',
      sequence: 2,
      parentActivityId: 'run-2',
      inclusion: 'target-closure',
      evidenceState: 'available'
    }
  ],
  entities: [
    {
      entityId: 'registered-input:input-1',
      kind: 'registered-input-generation',
      inputFileVersionId: 'input-1',
      sourceKind: 'upload-version',
      filename: 'source.csv',
      checksum: checksum('a'),
      sizeBytes: 10
    },
    {
      entityId: 'file-generation:middle',
      kind: 'file-generation',
      generationId: 'middle',
      relativePath: 'intermediate/clean.csv',
      pathPortability: 'relative',
      checksum: checksum('b'),
      sizeBytes: 20,
      contentStorageKey: `execution-file-evidence/${checksum('b')}`
    },
    {
      entityId: 'file-generation:result',
      kind: 'file-generation',
      generationId: 'result',
      relativePath: 'result.csv',
      pathPortability: 'relative',
      checksum: checksum('c'),
      sizeBytes: 30,
      contentStorageKey: `execution-file-evidence/${checksum('c')}`
    },
    {
      entityId: 'artifact-version:version-1',
      kind: 'artifact-version',
      versionId: 'version-1',
      filename: 'result.csv',
      checksum: checksum('c'),
      sizeBytes: 30
    }
  ],
  edges: [
    {
      kind: 'used',
      activityId: 'run-1',
      entityId: 'registered-input:input-1',
      authority: 'authoritative',
      evidenceSource: 'registered-contract'
    },
    {
      kind: 'generated',
      activityId: 'run-1',
      entityId: 'file-generation:middle',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'used',
      activityId: 'run-2',
      entityId: 'file-generation:middle',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'generated',
      activityId: 'run-2',
      entityId: 'file-generation:result',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'used',
      activityId: 'artifact-publication:version-1',
      entityId: 'file-generation:result',
      authority: 'authoritative',
      evidenceSource: 'artifact-publication'
    },
    {
      kind: 'generated',
      activityId: 'artifact-publication:version-1',
      entityId: 'artifact-version:version-1',
      authority: 'authoritative',
      evidenceSource: 'artifact-publication'
    }
  ]
})

const run = (runId: string, runIndex: number): ProvenanceNotebookRun => ({
  runId,
  runIndex,
  agentFrameId: 'frame-1',
  messageBranchId: 'branch-1',
  runtimeSegmentId: 'segment-1',
  promptMessageId: 'prompt-1',
  kernelKind: 'python',
  script: 'pass',
  status: 'completed',
  startedAt: '2026-08-31T00:00:00.000Z',
  completedAt: '2026-08-31T00:00:01.000Z',
  outputs: [],
  inputFileVersionKeys: []
})

describe('public reproducibility projection contract', () => {
  it('uses the sealed recipe to expose only executable frontiers to the renderer', () => {
    const value = graph()
    const runs = [run('run-1', 0), run('run-2', 1)]
    const execution: PersistedArtifactExecutionSnapshot = {
      schemaVersion: 2,
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      terminalPromptMessageId: 'prompt-1',
      producerRunId: 'run-2',
      producerRunIndex: 1,
      createdAt: '2026-09-02T00:00:00.000Z',
      inputFiles: [],
      runs,
      provenanceGraph: value,
      reproducibilityRecipe: {
        schemaVersion: 1,
        recipeId: checksum('d'),
        targetVersionId: 'version-1',
        targetEntityId: value.targetEntityId,
        targetChecksum: checksum('c'),
        graphChecksum: checksum('e'),
        steps: [],
        frontiers: [
          {
            frontierId: 'original-inputs',
            claimScope: 'end-to-end',
            stepIds: ['step:run-1', 'step:run-2'],
            crossingFiles: [],
            reasonCodes: ['environment-lock-missing']
          },
          {
            frontierId: 'checkpoint:run-1',
            claimScope: 'downstream-only',
            afterActivityId: 'run-1',
            stepIds: ['step:run-2'],
            crossingFiles: [],
            reasonCodes: []
          }
        ],
        environmentRequirements: [],
        capture: { state: 'sealed', reasonCodes: [] }
      }
    }

    const projected = projectPublicArtifactExecutionSnapshot(execution, []).reproducibility
    expect(projected?.startFrontiers[0]?.unavailableEntityIds).toEqual(['registered-input:input-1'])
    expect(projected?.startFrontiers[1]?.unavailableEntityIds).toEqual(['file-generation:middle'])
    execution.reproducibilityRecipe!.frontiers[0]!.crossingFiles.push({
      entityId: 'file-generation:middle',
      checksum: checksum('b'),
      sizeBytes: 200,
      contentStorageKey: 'private/blob',
      materializationPath: 'middle.csv'
    })
    const withWorkingFile = projectPublicArtifactExecutionSnapshot(execution, []).reproducibility
    expect(withWorkingFile?.startFrontiers[0]?.crossingEntityIds).toEqual([
      'registered-input:input-1',
      'file-generation:middle'
    ])
    expect(JSON.stringify(withWorkingFile)).not.toContain('private/blob')
    expect(projected?.checkReasonCodes).toEqual([])
    expect(
      projected?.startFrontiers.map(({ frontierId, eligibility, checkReasonCodes }) => ({
        frontierId,
        eligibility,
        checkReasonCodes
      }))
    ).toEqual([
      {
        frontierId: 'original-inputs',
        eligibility: 'blocked',
        checkReasonCodes: ['environment-lock-missing']
      },
      { frontierId: 'checkpoint:run-1', eligibility: 'available', checkReasonCodes: [] },
      { frontierId: 'checkpoint:run-2', eligibility: 'blocked', checkReasonCodes: [] }
    ])

    const executionWithoutRecipe = { ...execution }
    delete executionWithoutRecipe.reproducibilityRecipe
    const withoutRecipe = projectPublicArtifactExecutionSnapshot(
      executionWithoutRecipe,
      []
    ).reproducibility
    expect(withoutRecipe?.checkReasonCodes).toEqual(['compute-recipe-unavailable'])
    expect(withoutRecipe?.startFrontiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eligibility: 'blocked',
          checkReasonCodes: ['compute-recipe-unavailable']
        })
      ])
    )
  })
})
