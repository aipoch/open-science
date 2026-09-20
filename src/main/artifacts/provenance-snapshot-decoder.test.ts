import { describe, expect, it } from 'vitest'

import type {
  ArtifactProvenanceGraph,
  ArtifactReproducibilityRecipe,
  PersistedArtifactExecutionSnapshot
} from '../../shared/artifact-provenance'
import { decodeArtifactExecutionSnapshot } from './provenance-execution-evidence'
import { sealArtifactReproducibilityRecipe } from './artifact-reproducibility-recipe'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import {
  decodeArtifactMessageSnapshot,
  decodeReviewScopeSnapshot
} from './provenance-snapshot-decoder'

const messageSnapshot = (schemaVersion: number): Record<string, unknown> => ({
  schemaVersion,
  snapshotId: 'snapshot-1',
  rootFrameId: 'root-1',
  agentFrameId: 'agent-1',
  messageBranchId: 'branch-1',
  terminalMessageId: 'message-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  messages: [],
  ...(schemaVersion === 3 ? { activities: [], activityGroups: [] } : {})
})

const executionSnapshot = (schemaVersion: number): Record<string, unknown> => ({
  schemaVersion,
  rootFrameId: 'root-1',
  agentFrameId: 'agent-1',
  messageBranchId: 'branch-1',
  terminalPromptMessageId: 'prompt-1',
  producerRunId: 'run-1',
  producerRunIndex: 0,
  createdAt: '2026-08-20T00:00:00.000Z',
  inputFiles: [],
  runs: [
    {
      runId: 'run-1',
      runIndex: 0,
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1',
      kernelKind: 'python',
      script: 'print(1)',
      status: 'completed',
      startedAt: '2026-08-20T00:00:00.000Z',
      outputs: [],
      inputFileVersionKeys: []
    }
  ]
})

const provenanceGraph = (): Record<string, unknown> => ({
  schemaVersion: 1,
  targetEntityId: 'artifact-version:version-1',
  completeness: 'incomplete',
  reasonCodes: ['target-generation-unavailable'],
  activities: [
    {
      activityId: 'artifact-publication:version-1',
      kind: 'artifact-publication',
      sequence: 1,
      parentActivityId: 'run-1',
      inclusion: 'target-closure',
      evidenceState: 'available'
    }
  ],
  entities: [
    {
      entityId: 'artifact-version:version-1',
      kind: 'artifact-version',
      versionId: 'version-1',
      filename: 'result.csv',
      checksum: 'a'.repeat(64),
      sizeBytes: 10
    }
  ],
  edges: [
    {
      kind: 'generated',
      activityId: 'artifact-publication:version-1',
      entityId: 'artifact-version:version-1',
      authority: 'authoritative',
      evidenceSource: 'artifact-publication'
    }
  ]
})

const resignRecipe = (
  recipe: ArtifactReproducibilityRecipe,
  patch: Partial<Omit<ArtifactReproducibilityRecipe, 'recipeId'>>
): ArtifactReproducibilityRecipe => {
  const { recipeId: _recipeId, ...draft } = recipe
  void _recipeId
  const changed = { ...draft, ...patch }
  return {
    ...changed,
    recipeId: sha256(canonicalJson(changed as unknown as CanonicalJson))
  }
}

describe('Artifact persistence decoders', () => {
  it('preserves attribution from a not-yet-known Agent framework', () => {
    const decoded = decodeArtifactMessageSnapshot(
      JSON.stringify({
        ...messageSnapshot(3),
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'Persist me',
            createdAt: 1,
            agentAttribution: { frameworkId: 'future-acp' }
          }
        ]
      })
    )

    expect(decoded).toMatchObject({
      status: 'valid',
      value: {
        messages: [{ agentAttribution: { frameworkId: 'future-acp' } }]
      }
    })
  })

  it('classifies Message v3 as valid, v2 as legacy, and future versions as unsupported', () => {
    expect(decodeArtifactMessageSnapshot(JSON.stringify(messageSnapshot(3))).status).toBe('valid')
    expect(decodeArtifactMessageSnapshot(JSON.stringify(messageSnapshot(2))).status).toBe('legacy')
    expect(decodeArtifactMessageSnapshot(JSON.stringify(messageSnapshot(4)))).toEqual({
      status: 'unsupported',
      version: 4
    })
  })

  it('classifies Execution v2 as valid and future versions as unsupported', () => {
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(executionSnapshot(2))).status).toBe(
      'valid'
    )
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(executionSnapshot(3)))).toEqual({
      status: 'unsupported',
      version: 3
    })
  })

  it.each([false, true, undefined])(
    'preserves optional dispatch evidence %s in Execution v2',
    (kernelDispatched) => {
      const value = executionSnapshot(2)
      const runs = value.runs as Record<string, unknown>[]
      Object.assign(runs[0]!, { kernelDispatched })
      const decoded = decodeArtifactExecutionSnapshot(JSON.stringify(value))
      expect(decoded.status).toBe('valid')
      if (decoded.status !== 'valid') throw new Error('expected valid execution evidence')
      if (kernelDispatched === undefined)
        expect(decoded.value.runs[0]).not.toHaveProperty('kernelDispatched')
      else expect(decoded.value.runs[0]).toHaveProperty('kernelDispatched', kernelDispatched)
    }
  )

  it.each(['false', 0, null])(
    'rejects malformed dispatch evidence %s instead of treating it as safe',
    (kernelDispatched) => {
      const value = executionSnapshot(2)
      Object.assign((value.runs as Record<string, unknown>[])[0]!, { kernelDispatched })
      expect(decodeArtifactExecutionSnapshot(JSON.stringify(value))).toEqual({ status: 'corrupt' })
    }
  )
  it('accepts additive Environment lock references without changing Execution v2', () => {
    const snapshot = executionSnapshot(2)
    const run = (snapshot.runs as Record<string, unknown>[])[0]!
    run.environmentLock = {
      state: 'partial',
      format: 'environment-lock-bundle',
      lockChecksum: 'a'.repeat(64),
      partialReasons: ['non-conda-package-detected']
    }

    expect(decodeArtifactExecutionSnapshot(JSON.stringify(snapshot)).status).toBe('valid')
    const partial = run.environmentLock as Record<string, unknown>
    partial.diagnostics = [
      {
        reason: 'package-version-mismatch',
        packageName: 'pandas',
        observedVersion: '3.0.5',
        lockedVersion: '2.0'
      }
    ]
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(snapshot)).status).toBe('valid')
    partial.diagnostics = [{ reason: 'invented-reason' }]
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(snapshot)).status).toBe('corrupt')
    partial.diagnostics = Array.from({ length: 21 }, () => ({ reason: 'source-mismatch' }))
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(snapshot)).status).toBe('corrupt')
    delete partial.diagnostics
    run.environmentLock = {
      state: 'available',
      format: 'environment-lock-bundle',
      lockChecksum: 'not-a-checksum'
    }
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(snapshot))).toEqual({ status: 'corrupt' })
  })

  it('accepts an additive v2 provenance graph and rejects a malformed graph', () => {
    expect(
      decodeArtifactExecutionSnapshot(
        JSON.stringify({ ...executionSnapshot(2), provenanceGraph: provenanceGraph() })
      ).status
    ).toBe('valid')
    expect(
      decodeArtifactExecutionSnapshot(
        JSON.stringify({
          ...executionSnapshot(2),
          provenanceGraph: { ...provenanceGraph(), unexpected: true }
        })
      )
    ).toEqual({ status: 'corrupt' })
  })

  it('keeps Execution evidence readable when nested graph or recipe versions are newer', () => {
    const snapshot = executionSnapshot(2) as unknown as PersistedArtifactExecutionSnapshot
    const graph = provenanceGraph() as unknown as ArtifactProvenanceGraph
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph,
      inputFiles: [],
      runs: snapshot.runs
    })

    const futureGraph = decodeArtifactExecutionSnapshot(
      JSON.stringify({
        ...snapshot,
        provenanceGraph: { ...graph, schemaVersion: 2 },
        reproducibilityRecipe: recipe
      })
    )
    expect(futureGraph).toMatchObject({
      status: 'valid',
      value: { runs: expect.any(Array) }
    })
    if (futureGraph.status !== 'valid') throw new Error('Expected readable Execution evidence.')
    expect(futureGraph.value.provenanceGraph).toBeUndefined()
    expect(futureGraph.value.reproducibilityRecipe).toBeUndefined()

    const futureRecipe = decodeArtifactExecutionSnapshot(
      JSON.stringify({
        ...snapshot,
        provenanceGraph: graph,
        reproducibilityRecipe: { ...recipe, schemaVersion: 2 }
      })
    )
    expect(futureRecipe).toMatchObject({
      status: 'valid',
      value: { provenanceGraph: expect.any(Object) }
    })
    if (futureRecipe.status !== 'valid') throw new Error('Expected readable Execution evidence.')
    expect(futureRecipe.value.reproducibilityRecipe).toBeUndefined()
  })

  it('accepts a sealed recipe inside Execution v2 and rejects recipe tampering', () => {
    const snapshot = executionSnapshot(2) as unknown as PersistedArtifactExecutionSnapshot
    const graph = provenanceGraph() as unknown as ArtifactProvenanceGraph
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph,
      inputFiles: [],
      runs: snapshot.runs
    })
    const value = { ...snapshot, provenanceGraph: graph, reproducibilityRecipe: recipe }

    expect(decodeArtifactExecutionSnapshot(JSON.stringify(value)).status).toBe('valid')
    expect(
      decodeArtifactExecutionSnapshot(
        JSON.stringify({
          ...value,
          reproducibilityRecipe: resignRecipe(recipe, {
            capture: { state: 'blocked', reasonCodes: ['target-source-missing'] }
          })
        })
      )
    ).toEqual({ status: 'corrupt' })
  })

  it('classifies Review scope v2 as valid, v1 as legacy, and future versions as unsupported', () => {
    expect(decodeReviewScopeSnapshot('{"schemaVersion":2,"blocks":[]}').status).toBe('valid')
    expect(decodeReviewScopeSnapshot('{"schemaVersion":1,"blocks":[]}').status).toBe('legacy')
    expect(decodeReviewScopeSnapshot('{"schemaVersion":3,"blocks":[]}')).toEqual({
      status: 'unsupported',
      version: 3
    })
  })

  it('classifies malformed and structurally invalid Artifact snapshots as corrupt', () => {
    expect(decodeArtifactMessageSnapshot('{')).toEqual({ status: 'corrupt' })
    expect(decodeArtifactExecutionSnapshot('{"schemaVersion":2}')).toEqual({
      status: 'corrupt'
    })
    expect(decodeReviewScopeSnapshot('{"schemaVersion":2,"blocks":false}')).toEqual({
      status: 'corrupt'
    })
  })

  it('rejects invalid Message and Review domain records instead of trusting their arrays', () => {
    expect(
      decodeArtifactMessageSnapshot(
        JSON.stringify({
          ...messageSnapshot(3),
          messages: [{ id: 'message-1', role: 'robot', content: 42, createdAt: 'now' }]
        })
      )
    ).toEqual({ status: 'corrupt' })
    expect(
      decodeReviewScopeSnapshot(
        JSON.stringify({
          schemaVersion: 2,
          blocks: [
            {
              blockIndex: 'zero',
              id: 'block-1',
              kind: 'message',
              sourceId: 'message-1',
              contentHash: 'hash',
              payload: {}
            }
          ]
        })
      )
    ).toEqual({ status: 'corrupt' })
  })

  it('rejects invalid Message activities and Execution domain records', () => {
    expect(
      decodeArtifactMessageSnapshot(JSON.stringify({ ...messageSnapshot(3), activities: [null] }))
    ).toEqual({ status: 'corrupt' })
    expect(
      decodeArtifactExecutionSnapshot(
        JSON.stringify({
          ...executionSnapshot(2),
          inputFiles: [null],
          runs: [
            { ...(executionSnapshot(2).runs as Record<string, unknown>[])[0], status: 'invented' }
          ]
        })
      )
    ).toEqual({ status: 'corrupt' })
  })

  it('rejects an invalid nested Message elicitation projection', () => {
    expect(
      decodeArtifactMessageSnapshot(
        JSON.stringify({
          ...messageSnapshot(3),
          activities: [
            {
              id: 'activity-1',
              kind: 'tool',
              title: 'Ask a question',
              status: 'completed',
              sortIndex: 0,
              eventIds: [],
              elicitation: {},
              createdAt: 1,
              updatedAt: 2
            }
          ]
        })
      )
    ).toEqual({ status: 'corrupt' })
  })
})
