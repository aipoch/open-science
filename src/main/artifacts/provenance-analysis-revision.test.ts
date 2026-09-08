import { expect, it } from 'vitest'
import type {
  ArtifactProvenanceGraph,
  PersistedArtifactExecutionSnapshot
} from '../../shared/artifact-provenance'
import {
  sealArtifactAnalysisRevision,
  artifactAnalysisRevisionMatchesGraph
} from './provenance-analysis-revision'
import { decodeArtifactExecutionSnapshot } from './provenance-execution-snapshot-decoder'
import { projectPublicArtifactExecutionSnapshot } from './provenance-execution-projection'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'

const graph: ArtifactProvenanceGraph = {
  schemaVersion: 1,
  targetEntityId: 'target',
  completeness: 'incomplete',
  reasonCodes: ['target-generation-unavailable'],
  activities: [
    {
      activityId: 'publication',
      kind: 'artifact-publication',
      sequence: 1,
      parentActivityId: 'run',
      inclusion: 'target-closure',
      evidenceState: 'available'
    }
  ],
  entities: [
    {
      entityId: 'target',
      kind: 'artifact-version',
      versionId: 'v1',
      filename: 'out.csv',
      checksum: 'a'.repeat(64),
      sizeBytes: 1
    }
  ],
  edges: [
    {
      kind: 'generated',
      activityId: 'publication',
      entityId: 'target',
      authority: 'authoritative',
      evidenceSource: 'artifact-publication'
    }
  ]
}
const snapshot = (): PersistedArtifactExecutionSnapshot => ({
  schemaVersion: 2,
  rootFrameId: 'r',
  agentFrameId: 'a',
  messageBranchId: 'b',
  terminalPromptMessageId: 'm',
  producerRunId: 'run',
  producerRunIndex: 0,
  createdAt: '2026-09-10T00:00:00Z',
  inputFiles: [],
  runs: [],
  provenanceGraph: graph
})

it('binds immutable analysis identity to both rules and the sealed graph', () => {
  const revision = sealArtifactAnalysisRevision(graph, true)
  expect(sealArtifactAnalysisRevision(graph, true)).toEqual(revision)
  expect(artifactAnalysisRevisionMatchesGraph(revision, graph)).toBe(true)
  expect(
    artifactAnalysisRevisionMatchesGraph(revision, { ...graph, reasonCodes: ['history-truncated'] })
  ).toBe(false)
  expect(
    artifactAnalysisRevisionMatchesGraph(
      { ...revision, dependencyAnalyzer: { version: 1, revision: 'other' } },
      graph
    )
  ).toBe(false)
  expect(sealArtifactAnalysisRevision(graph, false).dependencyAnalyzer).toBeUndefined()
  expect(sealArtifactAnalysisRevision(graph, false).revisionId).not.toBe(revision.revisionId)
})
it('reads older rule revisions without replacing them with current rules', () => {
  const fields = sealArtifactAnalysisRevision(graph, true)
  const { revisionId, ...unsigned } = fields
  expect(revisionId).toHaveLength(64)
  unsigned.dependencyAnalyzer = { version: 1, revision: 'tree-sitter-in-process-1' }
  const analysisRevision = {
    ...unsigned,
    revisionId: sha256(canonicalJson(unsigned as unknown as CanonicalJson))
  }
  const serialized = JSON.stringify({ ...snapshot(), analysisRevision })
  const result = decodeArtifactExecutionSnapshot(serialized)
  expect(result).toMatchObject({ status: 'valid', value: { analysisRevision } })
  if (result.status !== 'valid') throw new Error('expected valid snapshot')
  expect(projectPublicArtifactExecutionSnapshot(result.value, []).analysisRevision).toEqual(
    analysisRevision
  )
  expect(JSON.stringify({ ...snapshot(), analysisRevision })).toBe(serialized)
})
it('does not invent an analysis revision for historical snapshots', () => {
  const result = decodeArtifactExecutionSnapshot(JSON.stringify(snapshot()))
  expect(result.status).toBe('valid')
  if (result.status !== 'valid') throw new Error('expected valid legacy snapshot')
  expect(result.value.analysisRevision).toBeUndefined()
})
it('keeps execution readable but excludes replay metadata from a future analysis format', () => {
  const value = { ...snapshot(), analysisRevision: { schemaVersion: 2 } }
  const original = JSON.stringify(value)
  const result = decodeArtifactExecutionSnapshot(original)
  expect(result).toMatchObject({ status: 'valid', value: { runs: [] } })
  if (result.status !== 'valid') throw new Error('expected readable execution')
  expect(result.value.analysisRevision).toBeUndefined()
  expect(result.value.provenanceGraph).toBeUndefined()
  expect(result.value.reproducibilityRecipe).toBeUndefined()
  expect(JSON.stringify(value)).toBe(original)
})
it('rejects corrupted current-format identities', () => {
  const revision = sealArtifactAnalysisRevision(graph, true)
  for (const analysisRevision of [
    { ...revision, revisionId: '0'.repeat(64) },
    { ...revision, graphChecksum: '0'.repeat(64) },
    { ...revision, unexpected: true }
  ]) {
    expect(
      decodeArtifactExecutionSnapshot(JSON.stringify({ ...snapshot(), analysisRevision }))
    ).toEqual({ status: 'corrupt' })
  }
})
