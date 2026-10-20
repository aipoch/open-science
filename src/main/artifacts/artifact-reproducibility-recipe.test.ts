import { describe, expect, it } from 'vitest'

import type {
  ArtifactProvenanceGraph,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { artifactProvenanceGraphValue } from './artifact-provenance-graph'
import { parseArtifactExecutionSnapshot } from './provenance-execution-snapshot-decoder'
import { reproductionRecipes } from './reproducibility-host'

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
      entityId: 'registered-input:upload-version:input-1',
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
      contentStorageKey: `execution-file-evidence/blobs/sha256-${checksum('b')}`
    },
    {
      entityId: 'file-generation:result',
      kind: 'file-generation',
      generationId: 'result',
      relativePath: 'result.csv',
      pathPortability: 'relative',
      checksum: checksum('c'),
      sizeBytes: 30,
      contentStorageKey: `execution-file-evidence/blobs/sha256-${checksum('c')}`
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
      entityId: 'registered-input:upload-version:input-1',
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

const run = (
  runId: string,
  runIndex: number,
  kernelKind: 'python' | 'r' = 'python'
): ProvenanceNotebookRun => ({
  runId,
  runIndex,
  agentFrameId: 'frame-1',
  messageBranchId: 'branch-1',
  runtimeSegmentId: 'segment-1',
  promptMessageId: 'prompt-1',
  kernelKind,
  environmentName: kernelKind === 'python' ? 'default-python' : 'default-r',
  environmentLock: {
    state: 'available',
    format: 'environment-lock-bundle',
    lockChecksum: kernelKind === 'python' ? checksum('d') : checksum('e')
  },
  script: `${kernelKind === 'python' ? 'print' : 'cat'}('${runId}')`,
  status: 'completed',
  startedAt: '2026-09-02T00:00:00.000Z',
  completedAt: '2026-09-02T00:00:01.000Z',
  outputs: [],
  inputFileVersionKeys: []
})

const inputFiles: PersistedArtifactExecutionSnapshot['inputFiles'] = [
  {
    inputFileVersionId: 'input-1',
    sourceKind: 'upload-version',
    sourceFileId: 'upload-1',
    sourceProjectId: 'project-1',
    sourceSessionId: 'session-1',
    filename: 'source.csv',
    sizeBytes: 10,
    checksum: checksum('a'),
    storageKey: 'uploads/project-1/upload-1/version-1/content',
    association: 'resolver-accessed'
  }
]

describe('provenance graph and replay recipe contract', () => {
  it('round-trips a package-sealed recipe through the host snapshot decoder', () => {
    const provenanceGraph = graph()
    const runs = [run('run-1', 0), run('run-2', 1)]
    expect(artifactProvenanceGraphValue(provenanceGraph)).toBe(true)
    const reproducibilityRecipe = reproductionRecipes.sealArtifactReproducibilityRecipe({
      provenanceGraph,
      inputFiles,
      runs
    })
    const persisted: PersistedArtifactExecutionSnapshot = {
      schemaVersion: 2,
      rootFrameId: 'frame-1',
      agentFrameId: 'frame-1',
      messageBranchId: 'branch-1',
      terminalPromptMessageId: 'prompt-1',
      producerRunId: 'run-2',
      producerRunIndex: 1,
      createdAt: '2026-09-02T00:00:00.000Z',
      inputFiles,
      runs,
      provenanceGraph,
      reproducibilityRecipe
    }
    expect(parseArtifactExecutionSnapshot(JSON.stringify(persisted)).reproducibilityRecipe).toEqual(
      reproducibilityRecipe
    )
  })
})
