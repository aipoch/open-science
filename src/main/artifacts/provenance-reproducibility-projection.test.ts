import { expect, it } from 'vitest'
import {
  sealWorkflowCapture,
  projectCapturedArtifactReproducibility
} from '@aipoch/reproducibility'
import type { PersistedArtifactExecutionSnapshot } from '../../shared/artifact-provenance'
import { projectPublicArtifactExecutionSnapshot } from './provenance-execution-projection'

const snapshot = (): PersistedArtifactExecutionSnapshot => ({
  schemaVersion: 2,
  rootFrameId: 'root',
  agentFrameId: 'agent',
  messageBranchId: 'branch',
  terminalPromptMessageId: 'prompt',
  producerRunId: 'run',
  producerRunIndex: 0,
  createdAt: '2026-09-02T00:00:00.000Z',
  inputFiles: [],
  runs: [],
  reproducibilityRecipe: {
    schemaVersion: 1,
    recipeId: 'b'.repeat(64),
    targetVersionId: 'v1',
    targetEntityId: 'artifact-version:v1',
    targetChecksum: 'a'.repeat(64),
    graphChecksum: 'c'.repeat(64),
    steps: [],
    environmentRequirements: [],
    frontiers: [
      {
        frontierId: 'original-inputs',
        claimScope: 'end-to-end',
        stepIds: [],
        crossingFiles: [
          {
            entityId: 'private-input',
            checksum: 'd'.repeat(64),
            sizeBytes: 1,
            contentStorageKey: 'private/blob',
            materializationPath: 'input.csv'
          }
        ],
        reasonCodes: []
      }
    ],
    capture: { state: 'sealed', reasonCodes: [] }
  },
  provenanceGraph: {
    schemaVersion: 1,
    targetEntityId: 'artifact-version:v1',
    completeness: 'complete',
    reasonCodes: [],
    activities: [],
    edges: [],
    entities: [
      {
        entityId: 'artifact-version:v1',
        kind: 'artifact-version',
        versionId: 'v1',
        filename: 'result.csv',
        checksum: 'a'.repeat(64),
        sizeBytes: 1
      }
    ]
  }
})

it('assembles the package projection with host identity and public inputs without leaking captured internals', () => {
  const persisted = snapshot()
  const publicInputs: Parameters<typeof projectPublicArtifactExecutionSnapshot>[1] = []
  const projected = projectPublicArtifactExecutionSnapshot(persisted, publicInputs)
  expect(projected.reproducibility).toEqual(projectCapturedArtifactReproducibility(persisted))
  expect(projected.reproducibility).toBeDefined()
  expect(projected).toMatchObject({
    rootFrameId: 'root',
    agentFrameId: 'agent',
    messageBranchId: 'branch',
    terminalPromptMessageId: 'prompt',
    producerRunId: 'run',
    producerRunIndex: 0,
    createdAt: persisted.createdAt
  })
  expect(projected.inputFiles).toBe(publicInputs)
  expect(projected.runs).toBe(persisted.runs)
  expect(projected).not.toHaveProperty('provenanceGraph')
  expect(projected).not.toHaveProperty('reproducibilityRecipe')
  expect(JSON.stringify(projected)).not.toContain('private/blob')
})

it('preserves a historical snapshot without graph evidence instead of inventing a projection', () => {
  const persisted = snapshot()
  delete persisted.provenanceGraph
  expect(projectPublicArtifactExecutionSnapshot(persisted, [])).not.toHaveProperty(
    'reproducibility'
  )
})

it('projects workflow choices without exposing frozen paths or helper sources', () => {
  const persisted = snapshot()
  const graph = structuredClone(persisted.provenanceGraph!)
  graph.entities.push({
    entityId: 'side-output',
    kind: 'file-generation',
    generationId: 'generation-1',
    relativePath: 'data/side.csv',
    pathPortability: 'relative',
    checksum: 'd'.repeat(64),
    sizeBytes: 1,
    contentStorageKey: 'private/side-blob'
  })
  graph.entities.push({
    ...graph.entities.at(-1)!,
    entityId: 'unused-generation'
  } as (typeof graph.entities)[number])
  graph.activities.push({
    activityId: 'consumer',
    kind: 'notebook-run',
    sequence: 0,
    runIndex: 0,
    inclusion: 'workflow-capture',
    evidenceState: 'available'
  })
  graph.edges.push({
    kind: 'used',
    activityId: 'consumer',
    entityId: 'side-output',
    authority: 'authoritative',
    evidenceSource: 'runtime-observation'
  })
  const run = {
    runId: 'consumer',
    runIndex: 0,
    agentFrameId: 'a',
    messageBranchId: 'b',
    runtimeSegmentId: 's',
    promptMessageId: 'p',
    kernelKind: 'r' as const,
    script: 'x <- 1',
    status: 'completed' as const,
    startedAt: '2026-10-20T00:00:00.000Z',
    outputs: [],
    inputFileVersionKeys: []
  }
  persisted.workflowCapture = {
    state: 'available',
    capture: sealWorkflowCapture({ schemaVersion: 1, graph, inputFiles: [], runs: [run] })
  }
  const projected = projectPublicArtifactExecutionSnapshot(persisted, [])
  expect(projected.workflow).toMatchObject({
    state: 'available',
    boundaries: [{ entityId: 'side-output', relativePath: 'data/side.csv' }]
  })
  if (projected.workflow?.state === 'available')
    expect(projected.workflow.boundaries).toHaveLength(1)
  expect(projected).not.toHaveProperty('workflowCapture')
  expect(JSON.stringify(projected)).not.toContain('private/side-blob')
  graph.outputGroups = [
    {
      outputId: 'paired-output',
      activityId: 'consumer',
      storageShape: 'file-set',
      memberEntityIds: ['side-output', 'unused-generation'],
      riskCodes: []
    }
  ]
  persisted.workflowCapture = {
    state: 'available',
    capture: sealWorkflowCapture({ schemaVersion: 1, graph, inputFiles: [], runs: [run] })
  }
  const grouped = projectPublicArtifactExecutionSnapshot(persisted, [])
  if (grouped.workflow?.state !== 'available') throw new Error('Expected workflow choices')
  expect(grouped.workflow.boundaries.map((boundary) => boundary.entityId).sort()).toEqual([
    'side-output',
    'unused-generation'
  ])
})
