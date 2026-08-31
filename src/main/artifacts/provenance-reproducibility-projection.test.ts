import { describe, expect, it } from 'vitest'

import type {
  ArtifactProvenanceGraph,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { projectPublicArtifactExecutionSnapshot } from './provenance-execution-projection'
import { projectArtifactReproducibility } from './provenance-reproducibility-projection'

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

describe('projectArtifactReproducibility', () => {
  it('derives deterministic end-to-end and safe checkpoint previews', () => {
    const projected = projectArtifactReproducibility(graph(), [
      run('run-1', 0),
      run('run-2', 1),
      run('unrelated-run', 2)
    ])

    expect(projected.startFrontiers).toEqual([
      expect.objectContaining({
        frontierId: 'original-inputs',
        claimScope: 'end-to-end',
        eligibility: 'available',
        crossingEntityIds: ['registered-input:input-1']
      }),
      expect.objectContaining({
        frontierId: 'checkpoint:run-1',
        claimScope: 'downstream-only',
        eligibility: 'available',
        crossingEntityIds: ['file-generation:middle']
      }),
      expect.objectContaining({
        frontierId: 'checkpoint:run-2',
        claimScope: 'downstream-only',
        eligibility: 'available',
        crossingEntityIds: ['file-generation:result']
      })
    ])
    expect(projected).toMatchObject({
      executionRunCount: 3,
      includedNotebookRunCount: 2,
      skippedRunCount: 1
    })
  })

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

  it('redacts absolute paths and blocks checkpoints that depend on them', () => {
    const value = graph()
    const result = value.entities.find((entity) => entity.entityId === 'file-generation:result')
    if (result?.kind !== 'file-generation') throw new Error('missing fixture entity')
    result.relativePath = 'C:\\Users\\researcher\\private\\result.csv'
    result.pathPortability = 'absolute'
    const input = value.entities.find((entity) => entity.entityId === 'registered-input:input-1')
    if (input?.kind !== 'registered-input-generation') throw new Error('missing input fixture')
    input.filename = '/Users/researcher/private/source.csv'

    const projected = projectArtifactReproducibility(value, [run('run-1', 0), run('run-2', 1)])
    const publicResult = projected.entities.find(
      (entity) => entity.entityId === 'file-generation:result'
    )

    expect(publicResult).toMatchObject({ label: 'result.csv', pathPortability: 'absolute' })
    expect(JSON.stringify(projected)).not.toContain('researcher')
    expect(JSON.stringify(projected)).not.toContain('contentStorageKey')
    expect(projected.startFrontiers.at(-1)).toMatchObject({
      eligibility: 'blocked',
      reasonCodes: ['absolute-path-boundary']
    })
  })

  it('limits the original start and blocks checkpoints when graph evidence is conservative', () => {
    const value = graph()
    value.completeness = 'conservative'
    value.reasonCodes = ['file-reads-unavailable']

    const projected = projectArtifactReproducibility(value, [run('run-1', 0), run('run-2', 1)])

    expect(projected.startFrontiers[0]).toMatchObject({
      eligibility: 'limited',
      reasonCodes: ['file-reads-unavailable']
    })
    expect(
      projected.startFrontiers.slice(1).every((frontier) => frontier.eligibility === 'blocked')
    ).toBe(true)
  })

  it('allows an input-free end-to-end path when execution evidence is complete', () => {
    const value = graph()
    value.entities = value.entities.filter(
      (entity) => entity.kind !== 'registered-input-generation'
    )
    value.edges = value.edges.filter(
      (edge) => edge.kind === 'depends-on' || edge.entityId !== 'registered-input:input-1'
    )

    const projected = projectArtifactReproducibility(value, [run('run-1', 0), run('run-2', 1)])

    expect(projected.startFrontiers[0]).toMatchObject({
      frontierId: 'original-inputs',
      eligibility: 'available',
      crossingEntityIds: []
    })
    expect(projected.startFrontiers.slice(1).map((frontier) => frontier.eligibility)).toEqual([
      'available',
      'available'
    ])
  })

  it('projects Cell dependencies while blocking an unrestorable in-memory checkpoint', () => {
    const value = graph()
    value.entities = value.entities.filter(
      (entity) =>
        entity.entityId !== 'registered-input:input-1' &&
        entity.entityId !== 'file-generation:middle'
    )
    value.edges = value.edges.filter(
      (edge) =>
        edge.kind === 'depends-on' ||
        (edge.entityId !== 'registered-input:input-1' && edge.entityId !== 'file-generation:middle')
    )
    value.edges.push({
      kind: 'depends-on',
      activityId: 'run-2',
      dependencyActivityId: 'run-1',
      authority: 'authoritative',
      evidenceSource: 'dependency-analysis'
    })

    const projected = projectArtifactReproducibility(value, [run('run-1', 0), run('run-2', 1)])

    expect(projected.edges).toContainEqual({
      kind: 'depends-on',
      activityId: 'run-2',
      dependencyActivityId: 'run-1',
      authority: 'authoritative',
      evidenceSource: 'dependency-analysis'
    })
    expect(projected.startFrontiers).toContainEqual(
      expect.objectContaining({
        frontierId: 'checkpoint:run-1',
        eligibility: 'blocked',
        crossingEntityIds: [],
        reasonCodes: ['advisory-boundary']
      })
    )
  })

  it('blocks only the ambiguous checkpoint where parallel branches cross the same boundary', () => {
    const value = graph()
    value.activities.splice(1, 0, {
      activityId: 'run-parallel',
      kind: 'notebook-run',
      sequence: 0,
      runIndex: 2,
      inclusion: 'target-closure',
      evidenceState: 'available'
    })
    value.entities.splice(2, 0, {
      entityId: 'file-generation:parallel',
      kind: 'file-generation',
      generationId: 'parallel',
      relativePath: 'intermediate/parallel.csv',
      pathPortability: 'relative',
      checksum: checksum('d'),
      sizeBytes: 12,
      contentStorageKey: `execution-file-evidence/${checksum('d')}`
    })
    value.edges.splice(
      2,
      0,
      {
        kind: 'used',
        activityId: 'run-parallel',
        entityId: 'registered-input:input-1',
        authority: 'authoritative',
        evidenceSource: 'registered-contract'
      },
      {
        kind: 'generated',
        activityId: 'run-parallel',
        entityId: 'file-generation:parallel',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'used',
        activityId: 'run-2',
        entityId: 'file-generation:parallel',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      }
    )
    const projected = projectArtifactReproducibility(value, [
      run('run-1', 0),
      run('run-2', 1),
      run('run-parallel', 2)
    ])

    expect(projected.startFrontiers).toHaveLength(3)
    expect(projected.startFrontiers[1]).toMatchObject({
      eligibility: 'blocked',
      crossingEntityIds: ['file-generation:middle', 'file-generation:parallel'],
      reasonCodes: ['ambiguous-activity-order']
    })
    expect(projected.startFrontiers[2]).toMatchObject({
      frontierId: 'checkpoint:run-2',
      eligibility: 'available',
      crossingEntityIds: ['file-generation:result']
    })
  })

  it('keeps Compute activities in the path without counting them as Notebook runs', () => {
    const value = graph()
    const compute = value.activities.find((activity) => activity.activityId === 'run-2')
    if (!compute) throw new Error('missing Compute fixture activity')
    compute.kind = 'compute-job'
    delete compute.runIndex

    const projected = projectArtifactReproducibility(value, [
      run('run-1', 0),
      run('unrelated-run', 1)
    ])

    expect(projected.activities.map((activity) => activity.kind)).toEqual([
      'notebook-run',
      'compute-job',
      'artifact-publication'
    ])
    expect(projected).toMatchObject({
      executionRunCount: 2,
      includedNotebookRunCount: 1,
      skippedRunCount: 1
    })
    expect(projected.startFrontiers.map((frontier) => frontier.frontierId)).toEqual([
      'original-inputs',
      'checkpoint:run-1',
      'checkpoint:run-2'
    ])
  })

  it('projects persisted logical output groups without exposing immutable storage references', () => {
    const value = graph()
    value.entities.splice(
      2,
      0,
      {
        entityId: 'file-generation:zarr-metadata',
        kind: 'file-generation',
        generationId: 'zarr-metadata',
        relativePath: 'results/model.zarr/.zgroup',
        pathPortability: 'relative',
        checksum: checksum('d'),
        sizeBytes: 12,
        contentStorageKey: `execution-file-evidence/${checksum('d')}`
      },
      {
        entityId: 'file-generation:zarr-chunk',
        kind: 'file-generation',
        generationId: 'zarr-chunk',
        relativePath: 'results/model.zarr/0.0',
        pathPortability: 'relative',
        checksum: checksum('e'),
        sizeBytes: 24,
        contentStorageKey: `execution-file-evidence/${checksum('e')}`
      }
    )
    value.edges.splice(
      3,
      0,
      {
        kind: 'generated',
        activityId: 'run-2',
        entityId: 'file-generation:zarr-metadata',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'generated',
        activityId: 'run-2',
        entityId: 'file-generation:zarr-chunk',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      }
    )
    value.outputGroups = [
      {
        outputId: 'scientific-output-zarr',
        activityId: 'run-2',
        storageShape: 'directory-tree',
        formatHint: 'zarr',
        memberEntityIds: ['file-generation:zarr-metadata', 'file-generation:zarr-chunk'],
        riskCodes: ['format-validity-not-verified', 'multi-file-consistency-not-verified']
      }
    ]

    const projected = projectArtifactReproducibility(value, [run('run-1', 0), run('run-2', 1)])

    expect(projected.outputGroups).toEqual([
      {
        outputId: 'scientific-output-zarr',
        activityId: 'run-2',
        label: 'results/model.zarr',
        storageShape: 'directory-tree',
        formatHint: 'zarr',
        memberEntityIds: ['file-generation:zarr-metadata', 'file-generation:zarr-chunk'],
        riskCodes: ['format-validity-not-verified', 'multi-file-consistency-not-verified']
      }
    ])
    expect(JSON.stringify(projected.outputGroups)).not.toContain('contentStorageKey')
  })

  it('uses the shared stem for companion files with different extensions', () => {
    const value = graph()
    value.entities.push(
      {
        entityId: 'file-generation:geotiff',
        kind: 'file-generation',
        generationId: 'geotiff',
        relativePath: 'maps/elevation.tif',
        pathPortability: 'relative',
        checksum: checksum('f'),
        sizeBytes: 24,
        contentStorageKey: `execution-file-evidence/${checksum('f')}`
      },
      {
        entityId: 'file-generation:world-file',
        kind: 'file-generation',
        generationId: 'world-file',
        relativePath: 'maps/elevation.tfw',
        pathPortability: 'relative',
        checksum: checksum('0'),
        sizeBytes: 24,
        contentStorageKey: `execution-file-evidence/${checksum('0')}`
      }
    )
    value.edges.splice(
      3,
      0,
      {
        kind: 'generated',
        activityId: 'run-2',
        entityId: 'file-generation:geotiff',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'generated',
        activityId: 'run-2',
        entityId: 'file-generation:world-file',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      }
    )
    value.outputGroups = [
      {
        outputId: 'scientific-output-geotiff',
        activityId: 'run-2',
        storageShape: 'file-set',
        formatHint: 'geotiff',
        memberEntityIds: ['file-generation:geotiff', 'file-generation:world-file'],
        riskCodes: ['multi-file-consistency-not-verified']
      }
    ]

    expect(projectArtifactReproducibility(value, []).outputGroups[0]?.label).toBe('maps/elevation')
  })
})
