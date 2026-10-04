import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import type {
  ArtifactExecutionSnapshot,
  ArtifactVersionDescriptor,
  ArtifactVersionEvidence
} from '../../shared/artifact-provenance'
import type { ArtifactVersionReviewProjection } from '../../shared/reviewer'
import {
  buildAggregateCompleteRoCrateArchive,
  buildAggregateRoCrateArchive,
  buildAggregateRoCrateMetadata,
  PROJECT_COMPLETE_PROFILE,
  PROJECT_LIGHTWEIGHT_PROFILE,
  SESSION_LIGHTWEIGHT_PROFILE,
  type AggregateRoCrateSource
} from './ro-crate-aggregate-export'
import type {
  ArtifactVersionRoCrateSource,
  RoCrateEntity,
  RoCrateMetadataDocument
} from './ro-crate-export'
import { sha256 } from './provenance-canonical'

const artifactSource = (
  versionNumber = 1,
  overrides: Partial<ArtifactVersionEvidence> = {}
): ArtifactVersionRoCrateSource => {
  const versionId = `version-${versionNumber}`
  const descriptor: ArtifactVersionDescriptor = {
    projectId: 'project-1',
    sessionId: 'session-1',
    id: versionId,
    name: `report-${versionNumber}.csv`,
    size: 4,
    mtimeMs: 0,
    artifactId: 'artifact-1',
    versionId,
    versionNumber,
    checksum: String(versionNumber).repeat(64),
    createdAt: `2026-09-${String(10 + versionNumber).padStart(2, '0')}T00:00:00.000Z`,
    state: 'finalized',
    originKind: 'agent_generated'
  }
  const evidence: ArtifactVersionEvidence = {
    schema_version: 1,
    project_id: descriptor.projectId,
    app_session_id: descriptor.sessionId,
    artifact_id: descriptor.artifactId,
    version_id: descriptor.versionId,
    version_number: descriptor.versionNumber,
    filename: descriptor.name,
    content_type: 'text/csv',
    size_bytes: descriptor.size,
    checksum: descriptor.checksum,
    created_at: descriptor.createdAt,
    conversation: {
      root_frame_id: 'root-frame-1',
      agent_frame_id: 'agent-frame-1',
      message_branch_id: 'branch-1',
      runtime_segment_id: 'segment-1',
      prompt_message_id: 'prompt-1'
    },
    is_user_upload: false,
    execution_status: { state: 'unavailable', reason: 'producer-not-supplied' },
    inputs: [],
    producer: { state: 'unavailable', reason: 'producer-not-supplied' },
    environment_status: { state: 'unavailable', reason: 'environment-not-supported' },
    ...overrides
  }
  descriptor.name = evidence.filename
  descriptor.size = evidence.size_bytes
  descriptor.checksum = evidence.checksum
  descriptor.createdAt = evidence.created_at
  return { descriptor, contentStatus: { state: 'available' }, evidence }
}

const executionWithLock = (checksum: string): ArtifactExecutionSnapshot => ({
  schemaVersion: 2,
  rootFrameId: 'root-frame-1',
  agentFrameId: 'agent-frame-1',
  messageBranchId: 'branch-1',
  terminalPromptMessageId: 'prompt-1',
  producerRunId: 'run-1',
  producerRunIndex: 1,
  createdAt: '2026-09-11T00:00:00.000Z',
  inputFiles: [],
  runs: [
    {
      runId: 'run-1',
      runIndex: 1,
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'segment-1',
      promptMessageId: 'prompt-1',
      kernelKind: 'python',
      script: 'print("done")',
      status: 'completed',
      startedAt: '2026-09-10T23:59:59.000Z',
      completedAt: '2026-09-11T00:00:00.000Z',
      outputs: [],
      inputFileVersionKeys: [],
      environmentLock: {
        state: 'available',
        format: 'environment-lock-bundle',
        lockChecksum: checksum
      }
    }
  ]
})

const reviewFor = (versionId: string): ArtifactVersionReviewProjection => {
  const assessment = {
    id: 'review-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    turnMessageId: 'message-1',
    scope: { turnMessageId: 'message-1', blocks: [], artifactVersionIds: [versionId] },
    lifecycle: 'complete' as const,
    outcome: 'pass' as const,
    model: 'reviewer-model',
    reviewerLog: [],
    createdAt: 0,
    updatedAt: 0
  }
  return {
    binding: 'version',
    selectedVersionId: versionId,
    selectedVersionAssessment: {
      ...assessment,
      checks: [],
      scopeSnapshot: { state: 'available', blocks: [] }
    },
    latestChainReview: {
      ...assessment,
      checks: [],
      scopeSnapshot: { state: 'available', blocks: [] }
    },
    selectedVersionChecks: [],
    turnLevelChecks: [],
    selectedVersionDispositions: [],
    history: []
  }
}

const sessionSource = (
  versions: readonly ArtifactVersionRoCrateSource[],
  overrides: Partial<Extract<AggregateRoCrateSource, { scope: 'session' }>> = {}
): Extract<AggregateRoCrateSource, { scope: 'session' }> => ({
  scope: 'session',
  projectId: 'project-1',
  sessionId: 'session-1',
  snapshotCapturedAt: '2026-09-12T00:00:00.000Z',
  displayNameSnapshot: 'Crate research',
  versions,
  ...overrides
})

const projectSource = (
  versions: readonly ArtifactVersionRoCrateSource[]
): Extract<AggregateRoCrateSource, { scope: 'project' }> => ({
  scope: 'project',
  projectId: 'project-1',
  snapshotCapturedAt: '2026-09-12T00:00:00.000Z',
  displayNameSnapshot: 'Project research',
  versions
})

const entity = (document: RoCrateMetadataDocument, id: string): RoCrateEntity => {
  const found = document['@graph'].find((candidate) => candidate['@id'] === id)
  if (!found) throw new Error(`Missing entity ${id}`)
  return found
}

const archiveMetadata = (archive: Uint8Array): RoCrateMetadataDocument =>
  JSON.parse(strFromU8(unzipSync(archive)['ro-crate-metadata.json']!)) as RoCrateMetadataDocument

describe('aggregate RO-Crate export', () => {
  it('emits a lightweight session crate without embedding artifact data', () => {
    const version = artifactSource(1)
    version.review = reviewFor(version.evidence.version_id)
    const document = buildAggregateRoCrateMetadata(sessionSource([version]))

    expect(document['@context']).toBe('https://w3id.org/ro/crate/1.1/context')
    expect(entity(document, './')).toMatchObject({
      '@type': 'Dataset',
      name: 'Crate research',
      conformsTo: { '@id': SESSION_LIGHTWEIGHT_PROFILE },
      hasPart: [{ '@id': 'artifacts/artifact-1/versions/version-1/' }]
    })
    expect(entity(document, 'artifacts/artifact-1/versions/version-1/')).toMatchObject({
      '@type': 'Dataset',
      mainEntity: { '@id': 'urn:open-science:version:version-1' },
      conformsTo: {
        '@id': 'urn:open-science:ro-crate-profile:artifact-version-lightweight'
      }
    })
    expect(entity(document, 'urn:open-science:version:version-1')).toMatchObject({
      '@type': 'File',
      sha256: version.evidence.checksum
    })
    expect(document['@graph'].some((candidate) => candidate['@id']?.startsWith('data/'))).toBe(
      false
    )

    const firstArchive = buildAggregateRoCrateArchive(sessionSource([version]))
    const files = unzipSync(firstArchive)
    expect(Object.keys(files).some((path) => path.startsWith('data/'))).toBe(false)
    expect(firstArchive).toEqual(buildAggregateRoCrateArchive(sessionSource([version])))
  })

  it('emits a complete project crate with content, input relationships, and required locks', async () => {
    const payload = Buffer.from('result\n42\n')
    const input = Buffer.from('sample\nAda\n')
    const lock = '{"schemaVersion":1,"format":"environment-lock-bundle"}\n'
    const checksum = sha256(payload)
    const inputChecksum = sha256(input)
    const lockChecksum = sha256(lock)
    const first = artifactSource(1, {
      filename: 'result.csv',
      size_bytes: payload.byteLength,
      checksum,
      inputs: [
        {
          ordinal: 1,
          input_file_version_id: 'input-version-1',
          source_kind: 'upload-version',
          source_file_id: 'upload-1',
          source_version_number: 1,
          source_project_id: 'project-1',
          source_session_id: 'session-1',
          filename: 'sample.csv',
          content_type: 'text/csv',
          size_bytes: input.byteLength,
          checksum: inputChecksum,
          storage_key: 'uploads/input-version-1',
          strongest_association: 'turn-attached'
        }
      ],
      producer: {
        state: 'available',
        notebook_session_id: 'notebook-1',
        producer_run_id: 'run-1',
        run_index: 1,
        kernel_kind: 'python',
        association_method: 'agent-declared-and-session-validated'
      },
      reproduction_code: 'print("done")',
      environment: {
        capture_kind: 'completed-run',
        environment_name: 'analysis',
        kernel_kind: 'python',
        runtime_source: 'managed',
        runtime_version: '3.12.4',
        platform: 'linux',
        architecture: 'x64',
        packages: [],
        inventory_sources: ['kernel-native'],
        installed_inventory: {
          captured_at: '2026-09-11T00:00:00.000Z',
          source: 'full-scan',
          validation: 'full-scan'
        },
        captured_at: '2026-09-11T00:00:00.000Z',
        source_manifest_checksum: 'd'.repeat(64),
        complete: true,
        capture_status: 'complete'
      }
    })
    first.execution = executionWithLock(lockChecksum)
    first.execution.runs[0]!.inputFileVersionKeys = [
      { sourceKind: 'upload-version', inputFileVersionId: 'input-version-1' }
    ]
    first.descriptor.size = payload.byteLength
    first.descriptor.checksum = checksum
    first.review = reviewFor(first.evidence.version_id)
    const second = artifactSource(2)
    second.evidence.app_session_id = 'session-2'
    second.descriptor.sessionId = 'session-2'
    second.contentStatus = { state: 'unavailable', reason: 'missing' }

    const archive = await buildAggregateCompleteRoCrateArchive(projectSource([second, first]), {
      readVersionContent: async (versionId) =>
        versionId === first.evidence.version_id ? payload : undefined,
      readInputContent: async () => input,
      readEnvironmentLock: async (checksumToRead) =>
        checksumToRead === lockChecksum ? lock : undefined
    })
    const files = unzipSync(archive)
    const metadata = archiveMetadata(archive)
    const payloadId = `data/sha256/${checksum}`
    const inputId = `data/sha256/${inputChecksum}`
    const lockPath = `provenance/environment-locks/${lockChecksum}.json`

    expect(entity(metadata, './')).toMatchObject({
      conformsTo: { '@id': PROJECT_COMPLETE_PROFILE },
      description: expect.stringContaining('not fully self-contained')
    })
    expect(Buffer.from(files[payloadId]!)).toEqual(payload)
    expect(Buffer.from(files[inputId]!)).toEqual(input)
    expect(strFromU8(files[lockPath]!)).toBe(lock)
    expect(entity(metadata, payloadId)).toMatchObject({
      '@type': 'File',
      sha256: checksum,
      contentSize: String(payload.byteLength)
    })
    expect(entity(metadata, '#artifact-version/version-1/create-action/run-1')).toMatchObject({
      '@type': 'CreateAction',
      object: [{ '@id': inputId }],
      result: [{ '@id': payloadId }]
    })
    expect(entity(metadata, '#artifact-version/version-1/review/review-1')).toMatchObject({
      '@type': 'AssessAction',
      object: [{ '@id': payloadId }]
    })
    expect(entity(metadata, '#artifact-version/version-1/environment')).toMatchObject({
      '@type': 'SoftwareApplication'
    })
    expect(entity(metadata, lockPath)).toMatchObject({
      '@type': 'File',
      sha256: lockChecksum
    })
  })

  it('merges in-scope dependency identities when optional provenance is absent', () => {
    const first = artifactSource(1)
    const second = artifactSource(2, {
      inputs: [
        {
          ordinal: 1,
          input_file_version_id: first.evidence.version_id,
          source_kind: 'artifact-version',
          source_file_id: 'artifact-1',
          source_version_number: first.evidence.version_number,
          source_project_id: first.evidence.project_id,
          source_session_id: first.evidence.app_session_id,
          filename: 'dependency.csv',
          content_type: 'text/csv',
          size_bytes: first.evidence.size_bytes,
          checksum: first.evidence.checksum,
          storage_key: 'artifacts/project-1/artifact-1',
          strongest_association: 'turn-attached'
        }
      ]
    })

    const document = buildAggregateRoCrateMetadata(projectSource([second, first]))
    expect(entity(document, './').conformsTo).toEqual({ '@id': PROJECT_LIGHTWEIGHT_PROFILE })
    expect(entity(document, 'artifacts/artifact-1/versions/version-1/')).toBeDefined()
    expect(entity(document, `urn:open-science:version:${first.evidence.version_id}`)).toMatchObject(
      {
        '@type': 'File',
        name: first.evidence.filename,
        alternateName: ['dependency.csv'],
        sha256: first.evidence.checksum
      }
    )
  })

  it('fails closed for invalid and cyclic input references', () => {
    const invalid = artifactSource()
    invalid.execution = executionWithLock('a'.repeat(64))
    invalid.execution.runs[0]!.inputFileVersionKeys = [
      { sourceKind: 'upload-version', inputFileVersionId: 'missing-version' }
    ]
    expect(() => buildAggregateRoCrateMetadata(sessionSource([invalid]))).toThrow(
      'unknown input reference'
    )

    const conflicting = artifactSource(3, {
      inputs: [
        {
          ordinal: 1,
          input_file_version_id: 'conflicting-input',
          source_kind: 'upload-version',
          source_file_id: 'upload-conflicting',
          source_version_number: 1,
          source_project_id: 'project-1',
          source_session_id: 'session-1',
          filename: 'conflicting.csv',
          size_bytes: 5,
          checksum: '1'.repeat(64),
          storage_key: 'uploads/conflicting',
          strongest_association: 'turn-attached'
        }
      ]
    })
    expect(() =>
      buildAggregateRoCrateMetadata(sessionSource([artifactSource(1), conflicting]))
    ).toThrow('content checksum has conflicting sizes')

    const first = artifactSource(1, {
      inputs: [
        {
          ordinal: 1,
          input_file_version_id: 'version-2',
          source_kind: 'upload-version',
          source_file_id: 'upload-2',
          source_version_number: 1,
          source_project_id: 'project-1',
          source_session_id: 'session-1',
          filename: 'second.csv',
          size_bytes: 4,
          checksum: '2'.repeat(64),
          storage_key: 'uploads/version-2',
          strongest_association: 'turn-attached'
        }
      ]
    })
    const second = artifactSource(2, {
      inputs: [
        {
          ordinal: 1,
          input_file_version_id: 'version-1',
          source_kind: 'upload-version',
          source_file_id: 'upload-1',
          source_version_number: 1,
          source_project_id: 'project-1',
          source_session_id: 'session-1',
          filename: 'first.csv',
          size_bytes: 4,
          checksum: '1'.repeat(64),
          storage_key: 'uploads/version-1',
          strongest_association: 'turn-attached'
        }
      ]
    })
    expect(() => buildAggregateRoCrateMetadata(sessionSource([first, second]))).toThrow(
      'cyclic input reference'
    )
  })

  it('serializes session and project profile variants deterministically', () => {
    const source = sessionSource([artifactSource()])
    const lightweight = buildAggregateRoCrateArchive(source)
    expect(lightweight).toEqual(buildAggregateRoCrateArchive(source))
    expect(entity(archiveMetadata(lightweight), './').conformsTo).toEqual({
      '@id': SESSION_LIGHTWEIGHT_PROFILE
    })

    const project = projectSource([artifactSource()])
    expect(entity(buildAggregateRoCrateMetadata(project), './').conformsTo).toEqual({
      '@id': PROJECT_LIGHTWEIGHT_PROFILE
    })
  })
})
