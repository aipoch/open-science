import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ArtifactVersionEvidence } from '../../shared/artifact-provenance'
import {
  PACKAGE_MAX_BYTES,
  PACKAGE_RO_CRATE_METADATA,
  type SessionPackageManifest
} from '../../shared/session-package'
import { sha256 } from '../artifacts/provenance-canonical'
import type { PackageRecords } from './native-snapshot'
import {
  buildSessionPackageRoCrateMetadata,
  validatePackageRoCrateMetadata,
  writePackageRoCrateMetadata
} from './ro-crate'

const fixture = (): { records: PackageRecords; manifest: SessionPackageManifest } => {
  const evidence = (id: string): ArtifactVersionEvidence => ({
    schema_version: 1,
    project_id: 'p',
    app_session_id: 's',
    artifact_id: id,
    version_id: id,
    version_number: 1,
    filename: 'same.csv',
    content_type: 'text/csv',
    size_bytes: 4,
    checksum: sha256(id),
    created_at: '2026-09-21T00:00:00.000Z',
    conversation: {
      root_frame_id: 'root',
      agent_frame_id: 'agent',
      message_branch_id: id,
      runtime_segment_id: 'segment',
      prompt_message_id: 'prompt'
    },
    is_user_upload: false,
    execution_status: { state: 'unavailable', reason: 'producer-not-supplied' },
    environment_status: { state: 'unavailable', reason: 'producer-not-supplied' },
    producer: { state: 'unavailable', reason: 'producer-not-supplied' },
    inputs: [
      {
        ordinal: 0,
        input_file_version_id: 'input',
        source_kind: 'upload-version',
        source_file_id: 'upload',
        source_project_id: 'p',
        source_session_id: 's',
        filename: 'input.csv',
        size_bytes: 4,
        checksum: sha256('input'),
        storage_key: 'uploads/p/s/input',
        strongest_association: 'turn-attached'
      }
    ]
  })
  const versions = ['v1', 'v2'].map((id) => {
    const value = evidence(id)
    const serialized = JSON.stringify(value)
    return {
      id,
      originKind: 'agent_generated',
      filename: value.filename,
      contentStorageKey: `artifacts/p/s/${id}`,
      contentType: 'text/csv',
      sizeBytes: '4',
      checksum: value.checksum,
      evidenceJson: serialized,
      evidenceChecksum: sha256(serialized),
      executionSnapshotJson: null
    }
  })
  const upload = {
    id: 'input',
    filename: 'input.csv',
    contentStorageKey: 'uploads/p/s/input',
    contentType: 'text/csv',
    sizeBytes: '4',
    checksum: sha256('input')
  }
  const records: PackageRecords = {
    schemaVersion: 1,
    tables: {
      ArtifactVersion: versions,
      UploadVersion: [upload],
      FileOriginSession: [],
      Review: [],
      Finding: [],
      ReviewFindingDisposition: [],
      ReviewScopeSnapshot: [],
      UploadFile: [],
      ArtifactVersionInput: [],
      ArtifactMessageSnapshot: [],
      ArtifactLineage: []
    }
  }
  const manifest: SessionPackageManifest = {
    format: 'open-science-session',
    schemaVersion: 1,
    createdAt: 0,
    source: { projectId: 'p', sessionId: 's', projectName: 'Research', title: 'Research' },
    excludedFiles: [],
    omissions: [],
    inventory: [
      ...['session.json', 'records.json', 'README.md'].map((path) => ({
        path,
        kind: 'records' as const,
        checksum: sha256(path),
        sizeBytes: 1
      })),
      ...[...versions, upload].map((row) => ({
        path: `objects/${sha256(row.contentStorageKey)}`,
        kind: 'file' as const,
        storageKey: row.contentStorageKey,
        checksum: row.checksum,
        sizeBytes: 4
      }))
    ]
  }
  return { records, manifest }
}

describe('Session package RO-Crate projection', () => {
  it('links exact inputs and scopes per-version actions without duplicating payloads', async () => {
    const { records, manifest } = fixture()
    const document = await buildSessionPackageRoCrateMetadata(manifest, records)
    const graph = new Map(document['@graph'].map((entity) => [entity['@id'], entity]))
    expect(graph.size).toBe(document['@graph'].length)
    expect(document['@context']).toBe('https://w3id.org/ro/crate/1.1/context')
    expect(graph.get(PACKAGE_RO_CRATE_METADATA)).toMatchObject({
      about: { '@id': './' },
      conformsTo: { '@id': 'https://w3id.org/ro/crate/1.1' }
    })
    for (const id of ['v1', 'v2']) {
      expect(graph.get(`#artifact/${id}/create-action/publication`)).toMatchObject({
        object: [{ '@id': `objects/${sha256('uploads/p/s/input')}` }],
        result: [{ '@id': `objects/${sha256(`artifacts/p/s/${id}`)}` }]
      })
    }
    const files = document['@graph'].filter((entity) => entity['@type'] === 'File')
    expect(files).toHaveLength(manifest.inventory.length)
    for (const entry of manifest.inventory) {
      expect(graph.get(entry.path)).toMatchObject({
        sha256: entry.checksum,
        contentSize: String(entry.sizeBytes)
      })
    }
    expect(graph.get('./')!.hasPart).toEqual(
      manifest.inventory.map(({ path }) => ({ '@id': path }))
    )
    expect(await buildSessionPackageRoCrateMetadata(manifest, records)).toEqual(document)
  })

  it('retains omitted inputs as checksum references without claiming their bytes are included', async () => {
    const { records, manifest } = fixture()
    manifest.inventory = manifest.inventory.filter(
      (entry) => entry.storageKey !== 'uploads/p/s/input'
    )
    manifest.excludedFiles = [
      { storageKey: 'uploads/p/s/input', filename: 'input.csv', sizeBytes: 4 }
    ]
    const document = await buildSessionPackageRoCrateMetadata(manifest, records)
    expect(
      document['@graph'].find((entity) => entity['@id'] === 'urn:open-science:version:input')
    ).toMatchObject({ sha256: sha256('input'), description: expect.stringContaining('excluded') })
    expect(
      document['@graph'].find(
        (entity) => entity['@id'] === '#artifact/v1/create-action/publication'
      )
    ).toMatchObject({ object: [{ '@id': 'urn:open-science:version:input' }] })
    expect(JSON.stringify(document)).not.toContain(`objects/${sha256('uploads/p/s/input')}`)
    expect(document['@graph'].find((entity) => entity['@id'] === './')!.hasPart).toContainEqual({
      '@id': 'urn:open-science:version:input'
    })
  })

  it('keeps distinct versions with identical bytes and names separately addressable', async () => {
    const { records, manifest } = fixture()
    const second = records.tables.ArtifactVersion[1]!
    second.checksum = records.tables.ArtifactVersion[0]!.checksum
    second.evidenceJson = JSON.stringify({
      ...JSON.parse(String(second.evidenceJson)),
      checksum: second.checksum
    })
    second.evidenceChecksum = sha256(second.evidenceJson)
    manifest.inventory.find((entry) => entry.storageKey === 'artifacts/p/s/v2')!.checksum = String(
      records.tables.ArtifactVersion[0]!.checksum
    )
    const document = await buildSessionPackageRoCrateMetadata(manifest, records)
    for (const id of ['v1', 'v2'])
      expect(
        document['@graph'].find(
          (entity) => entity['@id'] === `objects/${sha256(`artifacts/p/s/${id}`)}`
        )
      ).toMatchObject({ identifier: [`urn:open-science:version:${id}`] })
  })

  it('merges names and MIME types when versions share one packaged object', async () => {
    const { records, manifest } = fixture()
    const first = records.tables.ArtifactVersion[0]!
    const second = records.tables.ArtifactVersion[1]!
    const secondEvidence: ArtifactVersionEvidence = {
      ...JSON.parse(String(second.evidenceJson)),
      filename: 'result.txt',
      content_type: 'text/plain',
      checksum: first.checksum
    }
    second.filename = secondEvidence.filename
    second.contentType = secondEvidence.content_type ?? null
    second.checksum = secondEvidence.checksum
    second.contentStorageKey = first.contentStorageKey
    second.evidenceJson = JSON.stringify(secondEvidence)
    second.evidenceChecksum = sha256(second.evidenceJson)
    manifest.inventory = manifest.inventory.filter(
      (entry) => entry.storageKey !== 'artifacts/p/s/v2'
    )

    const document = await buildSessionPackageRoCrateMetadata(manifest, records)
    const object = document['@graph'].find(
      (entity) => entity['@id'] === `objects/${sha256(String(first.contentStorageKey))}`
    )!
    expect(object).toMatchObject({
      name: 'result.txt',
      alternateName: ['same.csv'],
      encodingFormat: ['text/csv', 'text/plain']
    })
  })

  it('rejects one checksum declared with conflicting sizes', async () => {
    const { records, manifest } = fixture()
    const artifact = records.tables.ArtifactVersion[0]!
    const upload = records.tables.UploadVersion[0]!
    upload.checksum = artifact.checksum
    upload.sizeBytes = 5

    await expect(buildSessionPackageRoCrateMetadata(manifest, records)).rejects.toThrow(
      'RO-Crate content checksum has conflicting sizes'
    )
  })

  it.each(['checksum', 'sizeBytes'] as const)('rejects an inventory %s mismatch', async (field) => {
    const { records, manifest } = fixture()
    const entry = manifest.inventory.find((entry) => entry.storageKey === 'artifacts/p/s/v1')!
    if (field === 'checksum') entry.checksum = 'f'.repeat(64)
    else entry.sizeBytes++
    await expect(buildSessionPackageRoCrateMetadata(manifest, records)).rejects.toThrow(
      'content metadata mismatch'
    )
  })

  it('preserves review scope without promoting unbound findings into version assessments', async () => {
    const { records, manifest } = fixture()
    records.tables.Review.push({
      id: 'review',
      scope: JSON.stringify({ artifactVersionIds: ['v1'] }),
      model: 'reviewer',
      lifecycle: 'complete',
      outcome: 'pass',
      createdAt: '2026-09-21T00:00:00Z',
      updatedAt: '2026-09-21T00:01:00Z'
    })
    records.tables.Finding.push(
      {
        id: 'bound',
        reviewId: 'review',
        artifactVersionId: 'v1',
        artifactBindingState: 'scope_validated',
        status: 'pass',
        claim: 'Check',
        evidence: 'Evidence'
      },
      {
        id: 'legacy',
        reviewId: 'review',
        artifactVersionId: 'v2',
        artifactBindingState: 'legacy_unverified',
        status: 'pass',
        claim: 'Old check',
        evidence: 'Evidence'
      }
    )
    const document = await buildSessionPackageRoCrateMetadata(manifest, records)
    expect(document['@graph'].find((entity) => entity['@id'] === '#review/review')).toMatchObject({
      '@type': 'AssessAction',
      object: [{ '@id': `objects/${sha256('artifacts/p/s/v1')}` }]
    })
    expect(
      document['@graph'].find((entity) => entity['@id'] === '#review/review/check/bound')
    ).toHaveProperty('itemReviewed')
    expect(
      document['@graph'].find((entity) => entity['@id'] === '#review/review/check/legacy')
    ).not.toHaveProperty('itemReviewed')
  })

  it('retains each Connector invocation and agent snapshot without overwriting history', async () => {
    const { records, manifest } = fixture()
    for (const [index, row] of records.tables.ArtifactVersion.entries()) {
      const evidence: ArtifactVersionEvidence = JSON.parse(String(row.evidenceJson))
      evidence.agent_name = `Agent name ${index}`
      evidence.producer = {
        state: 'available',
        kind: 'connector',
        connector_id: 'connector',
        tool_id: 'tool',
        invocation_id: `invocation-${index}`,
        implementation_version: `${index}.0`,
        arguments_checksum: sha256('arguments'),
        association_method: 'app-owned-handler'
      }
      row.evidenceJson = JSON.stringify(evidence)
      row.evidenceChecksum = sha256(row.evidenceJson)
    }
    const document = await buildSessionPackageRoCrateMetadata(manifest, records)
    const graph = new Map(document['@graph'].map((entity) => [entity['@id'], entity]))
    for (const [index, id] of ['v1', 'v2'].entries()) {
      const action = graph.get(`#artifact/${id}/create-action/publication`)!
      const instruments = action.instrument as { '@id': string }[]
      expect(graph.get(instruments[0]['@id'])).toMatchObject({
        softwareVersion: `${index}.0`,
        description: expect.stringContaining(`invocation-${index}`)
      })
      const agent = action.agent as { '@id': string }
      expect(graph.get(agent['@id'])).toMatchObject({ name: `Agent name ${index}` })
    }
  })

  it('references retained environment locks in native records and distinguishes missing locks', async () => {
    const { records, manifest } = fixture()
    const checksum = sha256('lock'),
      missing = sha256('missing')
    records.reproducibility = {
      versions: [
        {
          versionId: 'v1',
          sourceScope: { projectId: 'p', appSessionId: 's', artifactId: 'v1', versionId: 'v1' },
          entityIds: {},
          omittedOutputChecksums: [],
          metadataKeys: [],
          outputs: [],
          environmentLocks: [{ checksum, serialized: 'lock' }, { checksum: missing }]
        }
      ]
    }
    const document = await buildSessionPackageRoCrateMetadata(manifest, records)
    const graph = new Map(document['@graph'].map((entity) => [entity['@id'], entity]))
    expect(graph.get(`#environment-lock/${checksum}`)).toMatchObject({
      identifier: `urn:sha256:${checksum}`,
      isPartOf: { '@id': 'records.json' }
    })
    expect(graph.get(`#environment-lock/${missing}`)).not.toHaveProperty('isPartOf')
    expect(graph.get('#artifact/v1')!.mentions).toEqual(
      expect.arrayContaining([
        { '@id': `#environment-lock/${checksum}` },
        { '@id': `#environment-lock/${missing}` }
      ])
    )
  })

  it.each([
    'checksum',
    'size',
    'unlinked file',
    'duplicate identity',
    'extra file',
    'descriptor',
    'missing name',
    'missing description',
    'missing license',
    'missing datePublished',
    'invalid datePublished'
  ])('rejects conflicting or incomplete metadata: %s', async (change) => {
    const { records, manifest } = fixture()
    manifest.requiredFeatures = ['ro-crate']
    const document = await buildSessionPackageRoCrateMetadata(manifest, records)
    const file = document['@graph'].find((entity) => entity['@type'] === 'File')!
    const root = document['@graph'].find((entity) => entity['@id'] === './')!
    if (change === 'checksum') file.sha256 = sha256('wrong bytes')
    else if (change === 'size') file.contentSize = '999'
    else if (change === 'unlinked file') root.hasPart = []
    else if (change === 'duplicate identity') document['@graph'].push({ ...file })
    else if (change === 'extra file') document['@graph'].push({ ...file, '@id': 'objects/unknown' })
    else if (change.startsWith('missing ')) delete root[change.slice('missing '.length)]
    else if (change === 'invalid datePublished') root.datePublished = '2026-02-31'
    else document['@graph'][0].about = { '@id': '#wrong-root' }
    const directory = await mkdtemp(join(tmpdir(), 'ro-crate-validation-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, PACKAGE_RO_CRATE_METADATA), JSON.stringify(document))
    await expect(validatePackageRoCrateMetadata(directory, manifest, records)).rejects.toThrow(
      'RO-Crate metadata does not match'
    )
  })

  it.each(['bytes', 'entry count'])('includes metadata in the package %s limit', async (limit) => {
    const { records, manifest } = fixture()
    if (limit === 'bytes') manifest.inventory[0].sizeBytes = PACKAGE_MAX_BYTES
    else manifest.inventory = Array.from({ length: 10000 }, () => manifest.inventory[0])
    await expect(writePackageRoCrateMetadata('unused', manifest, records)).rejects.toThrow(
      'RO-Crate metadata exceeds the Session package limit'
    )
  })

  it('responds to cancellation before projecting artifacts', async () => {
    const { records, manifest } = fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancel projection'))
    await expect(
      buildSessionPackageRoCrateMetadata(manifest, records, controller.signal)
    ).rejects.toThrow('cancel projection')
  })
})
