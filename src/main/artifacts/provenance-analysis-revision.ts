import type {
  ArtifactAnalysisRevision,
  ArtifactProvenanceGraph
} from '../../shared/artifact-provenance'
import { NOTEBOOK_ANALYZER_VERSION, NOTEBOOK_ANALYZER_REVISION } from '../notebook/analysis-version'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'

// Bump for lineage construction/closure changes, independently of its JSON schema.
const LINEAGE_BUILDER_REVISION = 'artifact-lineage-1'
const checksum = (value: unknown): string => sha256(canonicalJson(value as CanonicalJson))

export const sealArtifactAnalysisRevision = (
  graph: ArtifactProvenanceGraph,
  dependencyAnalysisAvailable: boolean
): ArtifactAnalysisRevision => {
  const fields = {
    schemaVersion: 1 as const,
    ...(dependencyAnalysisAvailable
      ? {
          dependencyAnalyzer: {
            version: NOTEBOOK_ANALYZER_VERSION,
            revision: NOTEBOOK_ANALYZER_REVISION
          }
        }
      : {}),
    lineageBuilder: { version: 1 as const, revision: LINEAGE_BUILDER_REVISION },
    graphChecksum: checksum(graph)
  }
  return { ...fields, revisionId: checksum(fields) }
}

export const artifactAnalysisRevisionMatchesGraph = (
  value: unknown,
  graph: unknown
): value is ArtifactAnalysisRevision => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !graph) return false
  const record = value as Record<string, unknown>
  const rules = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    return (
      Object.keys(item).every((key) => ['version', 'revision'].includes(key)) &&
      item.version === 1 &&
      typeof item.revision === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(item.revision)
    )
  }
  if (
    record.schemaVersion !== 1 ||
    !Object.keys(record).every((key) =>
      [
        'schemaVersion',
        'revisionId',
        'dependencyAnalyzer',
        'lineageBuilder',
        'graphChecksum'
      ].includes(key)
    ) ||
    !rules(record.lineageBuilder) ||
    (record.dependencyAnalyzer !== undefined && !rules(record.dependencyAnalyzer)) ||
    typeof record.revisionId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.revisionId) ||
    record.graphChecksum !== checksum(graph)
  )
    return false
  const { revisionId, ...fields } = record
  return revisionId === checksum(fields)
}
