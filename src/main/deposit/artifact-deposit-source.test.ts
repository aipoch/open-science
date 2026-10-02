import { describe, expect, it, vi } from 'vitest'

import type {
  ArtifactLineageProvenance,
  ArtifactVersionProvenance
} from '../../shared/artifact-provenance'
import { createArtifactVersionDepositSourceReader } from './artifact-deposit-source'

const reference = {
  projectId: 'project-1',
  sessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1'
}

const lineage = (): ArtifactLineageProvenance => {
  const descriptor = provenance().descriptor
  return {
    artifactId: 'artifact-1',
    filename: 'report.csv',
    originSession: { sessionId: 'session-1', state: 'active', title: 'Climate analysis' },
    versions: [descriptor],
    selectedVersion: descriptor
  }
}

const provenance = (): ArtifactVersionProvenance => ({
  descriptor: {
    projectId: 'project-1',
    sessionId: 'session-1',
    id: 'version-1',
    runId: 'run-1',
    name: 'report.csv',
    size: 120,
    mtimeMs: 0,
    artifactId: 'artifact-1',
    versionId: 'version-1',
    versionNumber: 1,
    checksum: 'a'.repeat(64),
    createdAt: '2026-09-10T00:00:00.000Z',
    state: 'finalized',
    originKind: 'agent_generated'
  },
  contentStatus: { state: 'available' },
  evidence: {
    schema_version: 1,
    project_id: 'project-1',
    app_session_id: 'session-1',
    artifact_id: 'artifact-1',
    version_id: 'version-1',
    version_number: 1,
    filename: 'report.csv',
    content_type: 'text/csv',
    size_bytes: 120,
    checksum: 'a'.repeat(64),
    created_at: '2026-09-10T00:00:00.000Z',
    agent_name: 'Research assistant',
    conversation: {
      root_frame_id: 'root',
      agent_frame_id: 'agent',
      message_branch_id: 'branch',
      runtime_segment_id: 'segment',
      prompt_message_id: 'prompt'
    },
    is_user_upload: false,
    execution_status: { state: 'available' },
    inputs: [],
    producer: { state: 'unavailable', reason: 'producer-not-supplied' },
    environment_status: { state: 'unavailable', reason: 'producer-not-supplied' }
  },
  literature: {
    schemaVersion: 1,
    styleId: 'apa',
    locale: 'en-US',
    references: [
      {
        itemId: 'item-1',
        metadataRevision: 1,
        item: {
          itemType: 'journalArticle',
          title: 'Climate reference',
          identifiers: [{ scheme: 'doi', value: '10.1234/example', isPrimary: true }],
          creators: [],
          abstract: '',
          issuedText: '',
          containerTitle: '',
          shortTitle: '',
          language: '',
          rights: '',
          url: '',
          extra: '',
          typeFields: {}
        }
      }
    ],
    citations: [
      {
        citationId: 'citation-1',
        itemId: 'item-1',
        metadataRevision: 1
      }
    ]
  },
  messages: { state: 'unavailable', reason: 'not-loaded' },
  review: { state: 'unavailable', reason: 'not-loaded' }
})

describe('artifact deposit source reader', () => {
  it('builds metadata from the exact artifact version, session and cited literature', async () => {
    const crate = new Uint8Array([1, 2, 3, 4])
    const reader = createArtifactVersionDepositSourceReader({
      repository: {
        getLineage: vi.fn(async () => lineage()),
        getVersionProvenance: vi.fn(async () => provenance())
      },
      buildCrate: vi.fn(() => crate),
      resolveContext: vi.fn(async () => ({
        description: 'Approved analysis description.',
        contributors: [{ name: 'Ada Lovelace', orcid: '0000-0002-1825-0097' }],
        license: { id: 'cc-by-4.0', name: 'Creative Commons Attribution 4.0' }
      }))
    })
    await expect(reader.read(reference)).resolves.toMatchObject({
      artifact: {
        versionId: 'version-1',
        versionNumber: 1,
        filename: 'report.csv',
        checksum: 'a'.repeat(64)
      },
      session: {
        title: 'Climate analysis',
        description: 'Approved analysis description.'
      },
      contributors: [{ name: 'Ada Lovelace', orcid: '0000-0002-1825-0097' }],
      license: { id: 'cc-by-4.0' },
      relatedIdentifiers: [
        { identifier: '10.1234/example', relation: 'references', resourceType: 'publication' }
      ],
      crate: {
        filename: 'report.csv.ro-crate.zip',
        sizeBytes: 4,
        bytes: crate
      }
    })
  })

  it('returns undefined for an unknown artifact lineage', async () => {
    const reader = createArtifactVersionDepositSourceReader({
      repository: {
        getLineage: vi.fn(async () => undefined),
        getVersionProvenance: vi.fn()
      },
      buildCrate: vi.fn()
    })
    await expect(reader.read(reference)).resolves.toBeUndefined()
  })
})
