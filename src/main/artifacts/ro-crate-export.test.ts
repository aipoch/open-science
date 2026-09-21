import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import type {
  ArtifactExecutionSnapshot,
  ArtifactVersionDescriptor,
  ArtifactVersionEvidence
} from '../../shared/artifact-provenance'
import type { ArtifactVersionReviewProjection, ReviewCheck } from '../../shared/reviewer'
import {
  buildArtifactVersionCompleteRoCrateArchive,
  buildArtifactVersionRoCrateArchive,
  buildArtifactVersionRoCrateMetadata,
  COMPLETE_PROFILE,
  LIGHTWEIGHT_PROFILE,
  serializeRoCrateMetadata,
  type ArtifactVersionRoCrateSource,
  type RoCrateEntity,
  type RoCrateMetadataDocument
} from './ro-crate-export'
import { sha256 } from './provenance-canonical'

const descriptor = (): ArtifactVersionDescriptor => ({
  projectId: 'project-1',
  sessionId: 'session-1',
  id: 'version-1',
  runId: 'artifact-run-1',
  name: 'report.csv',
  size: 120,
  mtimeMs: 0,
  artifactId: 'artifact-1',
  versionId: 'version-1',
  versionNumber: 3,
  checksum: 'a'.repeat(64),
  createdAt: '2026-09-10T00:00:00.000Z',
  state: 'finalized',
  originKind: 'agent_generated'
})

const evidence = (): ArtifactVersionEvidence => ({
  schema_version: 1,
  project_id: 'project-1',
  app_session_id: 'session-1',
  artifact_id: 'artifact-1',
  version_id: 'version-1',
  version_number: 3,
  filename: 'report.csv',
  content_type: 'text/csv',
  size_bytes: 120,
  checksum: 'a'.repeat(64),
  created_at: '2026-09-10T00:00:00.000Z',
  agent_name: 'Research assistant',
  conversation: {
    root_frame_id: 'root-frame-1',
    agent_frame_id: 'agent-frame-1',
    message_branch_id: 'branch-1',
    runtime_segment_id: 'segment-1',
    prompt_message_id: 'prompt-1'
  },
  is_user_upload: false,
  reproduction_code:
    'import pandas as pd\ndf = pd.read_csv("samples.csv")\ndf.to_csv("report.csv")\n',
  execution_status: { state: 'available' },
  inputs: [
    {
      ordinal: 1,
      input_file_version_id: 'input-version-1',
      source_kind: 'upload-version',
      source_file_id: 'upload-1',
      source_version_number: 2,
      source_created_at: '2026-09-09T00:00:00.000Z',
      source_project_id: 'project-1',
      source_session_id: 'session-1',
      filename: 'samples.csv',
      content_type: 'text/csv',
      size_bytes: 64,
      checksum: 'b'.repeat(64),
      storage_key: 'uploads/input-version-1',
      strongest_association: 'turn-attached'
    }
  ],
  producer: {
    state: 'available',
    notebook_session_id: 'nb-1',
    producer_run_id: 'run-1',
    run_index: 2,
    kernel_kind: 'python',
    association_method: 'agent-declared-and-session-validated'
  },
  environment: {
    capture_kind: 'completed-run',
    environment_name: 'analysis',
    kernel_kind: 'python',
    runtime_source: 'managed',
    runtime_version: '3.12.4',
    platform: 'linux',
    architecture: 'x64',
    packages: [
      {
        name: 'pandas',
        version: '2.2.0',
        version_status: 'known',
        ecosystem: 'python',
        evidence_sources: ['python-importlib-metadata'],
        loaded_state: 'attached'
      }
    ],
    python_version: '3.12.4',
    inventory_sources: ['kernel-native'],
    installed_inventory: {
      captured_at: '2026-09-10T00:00:00.000Z',
      source: 'full-scan',
      validation: 'full-scan'
    },
    captured_at: '2026-09-10T00:00:00.000Z',
    source_manifest_checksum: 'c'.repeat(64),
    complete: true,
    capture_status: 'complete'
  },
  environment_status: { state: 'available' }
})

const execution = (): ArtifactExecutionSnapshot => ({
  schemaVersion: 2,
  rootFrameId: 'root-frame-1',
  agentFrameId: 'agent-frame-1',
  messageBranchId: 'branch-1',
  terminalPromptMessageId: 'prompt-1',
  producerRunId: 'run-1',
  producerRunIndex: 2,
  createdAt: '2026-09-10T00:00:00.000Z',
  inputFiles: [],
  runs: [
    {
      runId: 'run-1',
      runIndex: 2,
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'segment-1',
      promptMessageId: 'prompt-1',
      kernelKind: 'python',
      environmentName: 'analysis',
      script: 'import pandas as pd',
      status: 'completed',
      startedAt: '2026-09-09T23:59:00.000Z',
      completedAt: '2026-09-10T00:00:00.000Z',
      outputs: [],
      inputFileVersionKeys: [
        { sourceKind: 'upload-version', inputFileVersionId: 'input-version-1' }
      ]
    },
    {
      runId: 'run-0',
      runIndex: 1,
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'segment-0',
      promptMessageId: 'prompt-0',
      kernelKind: 'r',
      script: 'summary <- read.csv("samples.csv")',
      status: 'failed',
      startedAt: '2026-09-09T23:58:00.000Z',
      outputs: [{ type: 'error', message: 'boom' }],
      inputFileVersionKeys: []
    }
  ]
})

const check = (): ReviewCheck => ({
  id: 'check-1',
  reviewId: 'review-1',
  status: 'pass',
  claim: 'Checksum matches the declared output',
  evidence: 'sha256 verified against the artifact registry',
  resolution: 'open',
  sortIndex: 0,
  reflagCount: 0
})

const review = (): ArtifactVersionReviewProjection => {
  const base = {
    id: 'review-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    turnMessageId: 'message-1',
    scope: { turnMessageId: 'message-1', blocks: [], artifactVersionIds: ['version-1'] },
    lifecycle: 'complete' as const,
    outcome: 'pass' as const,
    model: 'reviewer-model-1',
    reviewerLog: [],
    createdAt: 1788998400000,
    updatedAt: 1788998500000
  }
  return {
    binding: 'version',
    selectedVersionId: 'version-1',
    selectedVersionAssessment: {
      ...base,
      checks: [check()],
      scopeSnapshot: { state: 'available', blocks: [] }
    },
    latestChainReview: { ...base, checks: [], scopeSnapshot: { state: 'available', blocks: [] } },
    selectedVersionChecks: [check()],
    turnLevelChecks: [],
    selectedVersionDispositions: [],
    history: []
  }
}

const source = (
  overrides: Partial<ArtifactVersionRoCrateSource> = {}
): ArtifactVersionRoCrateSource => ({
  descriptor: descriptor(),
  contentStatus: { state: 'available' },
  evidence: evidence(),
  execution: execution(),
  review: review(),
  ...overrides
})

const completeSource = (): {
  source: ArtifactVersionRoCrateSource
  payload: Buffer
  input: Buffer
} => {
  const payload = Buffer.from('value\n42\n')
  const input = Buffer.from('sample\nAda\n')
  const completeEvidence = evidence()
  completeEvidence.size_bytes = payload.byteLength
  completeEvidence.checksum = sha256(payload)
  completeEvidence.inputs = [
    {
      ...completeEvidence.inputs[0]!,
      size_bytes: input.byteLength,
      checksum: sha256(input)
    }
  ]
  return {
    source: source({
      descriptor: {
        ...descriptor(),
        size: payload.byteLength,
        checksum: sha256(payload)
      },
      evidence: completeEvidence
    }),
    payload,
    input
  }
}

const entity = (document: RoCrateMetadataDocument, id: string): RoCrateEntity => {
  const found = document['@graph'].find((candidate) => candidate['@id'] === id)
  if (!found) throw new Error(`Missing entity ${id}`)
  return found
}

const byType = (document: RoCrateMetadataDocument, type: string): RoCrateEntity[] =>
  document['@graph'].filter((candidate) => candidate['@type'] === type)

describe('Artifact Version RO-Crate export', () => {
  it('emits the required RO-Crate 1.1 structure', () => {
    const document = buildArtifactVersionRoCrateMetadata(source())
    expect(document['@context']).toBe('https://w3id.org/ro/crate/1.1/context')
    expect(document['@graph'][0]).toMatchObject({
      '@type': 'CreativeWork',
      '@id': 'ro-crate-metadata.json',
      about: { '@id': './' },
      conformsTo: { '@id': 'https://w3id.org/ro/crate/1.1' }
    })
    const root = entity(document, './')
    expect(root['@type']).toBe('Dataset')
    expect(root.conformsTo).toEqual({ '@id': LIGHTWEIGHT_PROFILE })
    expect(root.datePublished).toBe('2026-09-10T00:00:00.000Z')
    expect(root.license).toBe(
      'License information was not provided. This export grants no additional usage rights.'
    )
    expect(root.name).toBe('report.csv (Artifact Version v3) RO-Crate')
    expect(root.mainEntity).toEqual({ '@id': 'urn:open-science:version:version-1' })
    expect(String(root.description)).toContain('not a deterministic replay contract')
    const ids = document['@graph'].map((candidate) => candidate['@id'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('maps the payload and inputs to File entities referenced by checksum', () => {
    const document = buildArtifactVersionRoCrateMetadata(source())
    const payload = entity(document, 'urn:open-science:version:version-1')
    expect(payload).toMatchObject({
      '@type': 'File',
      name: 'report.csv',
      contentSize: '120',
      sha256: 'a'.repeat(64),
      encodingFormat: 'text/csv',
      dateCreated: '2026-09-10T00:00:00.000Z',
      version: 'v3'
    })
    const input = entity(document, 'urn:open-science:version:input-version-1')
    expect(input).toMatchObject({
      '@type': 'File',
      name: 'samples.csv',
      contentSize: '64',
      sha256: 'b'.repeat(64)
    })
  })

  it('maps execution history to CreateAction entities with branch context', () => {
    const document = buildArtifactVersionRoCrateMetadata(source())
    const actions = byType(document, 'CreateAction')
    expect(actions).toHaveLength(2)
    const producerRun = entity(document, '#create-action/run-1')
    expect(producerRun).toMatchObject({
      actionStatus: 'CompletedActionStatus',
      startTime: '2026-09-09T23:59:00.000Z',
      endTime: '2026-09-10T00:00:00.000Z',
      agent: { '@id': 'urn:open-science:agent:agent-frame-1' },
      object: [{ '@id': 'urn:open-science:version:input-version-1' }],
      result: [{ '@id': 'urn:open-science:version:version-1' }]
    })
    expect(producerRun.instrument).toEqual([{ '@id': '#producer-code' }, { '@id': '#environment' }])
    const branch = (producerRun.additionalProperty as Array<{ name: string; value: string }>).map(
      (property) => property.name
    )
    expect(branch).toEqual(
      expect.arrayContaining(['messageBranchId', 'runtimeSegmentId', 'promptMessageId'])
    )
    const failedRun = entity(document, '#create-action/run-0')
    expect(failedRun).toMatchObject({
      actionStatus: 'FailedActionStatus',
      description: 'Run status: failed.'
    })
    expect(failedRun.instrument).toEqual([{ '@id': '#kernel/r' }])
  })

  it('maps producer code, environment inventory, and reviewer evidence', () => {
    const document = buildArtifactVersionRoCrateMetadata(source())
    const code = entity(document, '#producer-code')
    expect(code).toMatchObject({
      '@type': 'SoftwareSourceCode',
      programmingLanguage: 'python'
    })
    expect(code.text).toContain('import pandas')
    const environment = entity(document, '#environment')
    expect(environment).toMatchObject({
      '@type': 'SoftwareApplication',
      name: 'analysis',
      softwareVersion: '3.12.4',
      softwareRequirements: [{ '@id': '#package/python/pandas' }]
    })
    expect(entity(document, '#package/python/pandas')).toMatchObject({
      name: 'pandas',
      softwareVersion: '2.2.0'
    })
    const assessment = entity(document, '#review/review-1')
    expect(assessment).toMatchObject({
      '@type': 'AssessAction',
      actionStatus: 'CompletedActionStatus',
      startTime: '2026-09-10T00:00:00.000Z',
      endTime: '2026-09-10T00:01:40.000Z',
      agent: { '@id': '#reviewer/reviewer-model-1' },
      object: [{ '@id': 'urn:open-science:version:version-1' }],
      result: [{ '@id': '#review-check/check-1' }]
    })
    expect(entity(document, '#review-check/check-1')).toMatchObject({
      '@type': 'Review',
      itemReviewed: { '@id': 'urn:open-science:version:version-1' }
    })
  })

  it('synthesizes a publication CreateAction without an execution snapshot', () => {
    const document = buildArtifactVersionRoCrateMetadata(source({ execution: undefined }))
    expect(byType(document, 'CreateAction')).toEqual([
      expect.objectContaining({
        '@id': '#create-action/publication',
        name: 'Artifact version publication',
        endTime: '2026-09-10T00:00:00.000Z',
        result: [{ '@id': 'urn:open-science:version:version-1' }],
        object: [{ '@id': 'urn:open-science:version:input-version-1' }]
      })
    ])
  })

  it('builds a deterministic lightweight archive with verified provenance sidecars', () => {
    const value = source()
    const first = buildArtifactVersionRoCrateArchive(value)
    const second = buildArtifactVersionRoCrateArchive(value)
    expect(first).toEqual(second)
    const files = unzipSync(first)
    expect(Object.keys(files).sort()).toEqual([
      'provenance/artifact-version-evidence.json',
      'provenance/execution-snapshot.json',
      'provenance/review-projection.json',
      'ro-crate-metadata.json'
    ])
    const metadata = JSON.parse(
      strFromU8(files['ro-crate-metadata.json']!)
    ) as RoCrateMetadataDocument
    const evidenceSidecar = strFromU8(files['provenance/artifact-version-evidence.json']!)
    const sidecarEntity = entity(metadata, 'provenance/artifact-version-evidence.json')
    expect(sidecarEntity).toMatchObject({
      '@type': 'File',
      sha256: sha256(evidenceSidecar),
      contentSize: String(Buffer.byteLength(evidenceSidecar, 'utf8'))
    })
    const root = entity(metadata, './')
    expect(root.hasPart).toEqual([
      { '@id': 'provenance/artifact-version-evidence.json' },
      { '@id': 'provenance/execution-snapshot.json' },
      { '@id': 'provenance/review-projection.json' },
      { '@id': 'urn:open-science:version:version-1' },
      { '@id': 'urn:open-science:version:input-version-1' }
    ])
  })

  it('retains later dependencies after repeated package names', () => {
    const value = source()
    const environment = value.evidence.environment!
    const first = environment.packages[0]!
    environment.packages = [first, { ...first, version: 'older' }, { ...first, name: 'numpy' }]
    const document = buildArtifactVersionRoCrateMetadata(value)
    expect(entity(document, '#package/python/pandas').softwareVersion).toBe(first.version)
    expect(entity(document, '#package/python/numpy').name).toBe('numpy')
    expect(entity(document, '#environment').softwareRequirements).toEqual([
      { '@id': '#package/python/pandas' },
      { '@id': '#package/python/numpy' }
    ])
  })

  it('builds a deterministic complete archive with verified data files and relative references', async () => {
    const fixture = completeSource()
    const readers = {
      readVersionContent: async () => fixture.payload,
      readInputContent: async () => fixture.input
    }
    const first = await buildArtifactVersionCompleteRoCrateArchive(fixture.source, readers)
    const second = await buildArtifactVersionCompleteRoCrateArchive(fixture.source, readers)
    expect(first).toEqual(second)

    const files = unzipSync(first)
    expect(Object.keys(files).sort()).toEqual([
      'data/report.csv',
      'data/samples.csv',
      'provenance/artifact-version-evidence.json',
      'provenance/execution-snapshot.json',
      'provenance/review-projection.json',
      'ro-crate-metadata.json'
    ])
    expect(Buffer.from(files['data/report.csv']!)).toEqual(fixture.payload)
    expect(Buffer.from(files['data/samples.csv']!)).toEqual(fixture.input)

    const metadata = JSON.parse(
      strFromU8(files['ro-crate-metadata.json']!)
    ) as RoCrateMetadataDocument
    const root = entity(metadata, './')
    expect(root.conformsTo).toEqual({ '@id': COMPLETE_PROFILE })
    expect(root.datePublished).toBe(fixture.source.evidence.created_at)
    expect(root.license).toBe(
      'License information was not provided. This export grants no additional usage rights.'
    )
    expect(root.mainEntity).toEqual({ '@id': 'data/report.csv' })
    expect(root.hasPart).toEqual([
      { '@id': 'provenance/artifact-version-evidence.json' },
      { '@id': 'provenance/execution-snapshot.json' },
      { '@id': 'provenance/review-projection.json' },
      { '@id': 'data/report.csv' },
      { '@id': 'data/samples.csv' }
    ])
    expect(entity(metadata, 'data/report.csv')).toMatchObject({
      contentSize: String(fixture.payload.byteLength),
      sha256: sha256(fixture.payload)
    })
    expect(entity(metadata, 'data/samples.csv')).toMatchObject({
      contentSize: String(fixture.input.byteLength),
      sha256: sha256(fixture.input)
    })
    expect(entity(metadata, '#create-action/run-1')).toMatchObject({
      object: [{ '@id': 'data/samples.csv' }],
      result: [{ '@id': 'data/report.csv' }]
    })
  })

  it('stores identical content once and points every matching version at the archived file', async () => {
    const fixture = completeSource()
    const duplicateExecution = execution()
    duplicateExecution.runs[0]!.inputFileVersionKeys.push({
      sourceKind: 'upload-version',
      inputFileVersionId: 'input-version-2'
    })
    const duplicateEvidence = {
      ...fixture.source.evidence,
      inputs: [
        fixture.source.evidence.inputs[0]!,
        {
          ...fixture.source.evidence.inputs[0]!,
          ordinal: 2,
          input_file_version_id: 'input-version-2',
          source_file_id: 'upload-2',
          filename: 'duplicate.csv'
        }
      ]
    }
    const archive = await buildArtifactVersionCompleteRoCrateArchive(
      { ...fixture.source, evidence: duplicateEvidence, execution: duplicateExecution },
      {
        readVersionContent: async () => fixture.payload,
        readInputContent: async () => fixture.input
      }
    )
    const files = unzipSync(archive)
    expect(
      Object.keys(files)
        .filter((path) => path.startsWith('data/'))
        .sort()
    ).toEqual(['data/report.csv', 'data/samples.csv'])
    const metadata = JSON.parse(
      strFromU8(files['ro-crate-metadata.json']!)
    ) as RoCrateMetadataDocument
    expect(entity(metadata, '#create-action/run-1').object).toEqual([{ '@id': 'data/samples.csv' }])
  })

  it('keeps checksum references and explains complete-profile content that cannot be included', async () => {
    const fixture = completeSource()
    fixture.source.evidence.inputs.push({
      ...fixture.source.evidence.inputs[0]!,
      ordinal: 2,
      input_file_version_id: 'input-version-2',
      source_file_id: 'upload-2',
      filename: 'missing.csv'
    })
    const archive = await buildArtifactVersionCompleteRoCrateArchive(
      {
        ...fixture.source,
        contentStatus: { state: 'unavailable', reason: 'missing' }
      },
      {
        readVersionContent: async () => {
          throw new Error('payload reader must not run when content is unavailable')
        },
        readInputContent: async (input) =>
          input.input_file_version_id === 'input-version-1' ? Buffer.from('wrong bytes') : undefined
      }
    )
    const files = unzipSync(archive)
    expect(Object.keys(files).some((path) => path.startsWith('data/'))).toBe(false)
    const metadata = JSON.parse(
      strFromU8(files['ro-crate-metadata.json']!)
    ) as RoCrateMetadataDocument
    const root = entity(metadata, './')
    expect(root.conformsTo).toEqual({ '@id': COMPLETE_PROFILE })
    expect(root.mainEntity).toEqual({ '@id': 'urn:open-science:version:version-1' })
    expect(String(root.description)).toContain('could not be included')
    expect(String(entity(metadata, 'urn:open-science:version:version-1').description)).toContain(
      'currently unavailable (missing)'
    )
    expect(
      String(entity(metadata, 'urn:open-science:version:input-version-1').description)
    ).toContain('failed checksum verification')
    expect(
      String(entity(metadata, 'urn:open-science:version:input-version-2').description)
    ).toContain('could not be read')
  })

  it('rejects different content that resolves to the same archive path', async () => {
    const fixture = completeSource()
    fixture.source.evidence.inputs[0]!.filename = 'report.csv'
    await expect(
      buildArtifactVersionCompleteRoCrateArchive(fixture.source, {
        readVersionContent: async () => fixture.payload,
        readInputContent: async () => fixture.input
      })
    ).rejects.toThrow('RO-Crate archive path conflicts: data/report.csv')
  })

  it.each(['report #1%.csv', 'résumé data.csv'])(
    'encodes URI references for %s without renaming ZIP entries',
    async (filename) => {
      const fixture = completeSource()
      fixture.source.evidence.filename = filename
      fixture.source.evidence.inputs[0]!.filename = `input ${filename}`
      fixture.source.evidence.inputs.push({
        ...fixture.source.evidence.inputs[0]!,
        ordinal: 2,
        input_file_version_id: 'input-version-2'
      })
      const files = unzipSync(
        await buildArtifactVersionCompleteRoCrateArchive(fixture.source, {
          readVersionContent: async () => fixture.payload,
          readInputContent: async () => fixture.input
        })
      )
      const metadata = JSON.parse(
        strFromU8(files['ro-crate-metadata.json']!)
      ) as RoCrateMetadataDocument
      const payloadId = `data/${encodeURIComponent(filename)}`
      const inputId = `data/${encodeURIComponent(`input ${filename}`)}`
      expect(Buffer.from(files[`data/${filename}`]!)).toEqual(fixture.payload)
      expect(Buffer.from(files[`data/input ${filename}`]!)).toEqual(fixture.input)
      expect(entity(metadata, './')).toMatchObject({
        mainEntity: { '@id': payloadId },
        hasPart: expect.arrayContaining([{ '@id': payloadId }, { '@id': inputId }])
      })
      expect(entity(metadata, payloadId).name).toBe(filename)
      expect(entity(metadata, inputId).name).toBe(`input ${filename}`)
      expect(entity(metadata, '#create-action/run-1')).toMatchObject({
        object: [{ '@id': inputId }],
        result: [{ '@id': payloadId }]
      })
      expect(entity(metadata, '#review/review-1').object).toEqual([{ '@id': payloadId }])
      expect(entity(metadata, '#review-check/check-1').itemReviewed).toEqual({ '@id': payloadId })
      expect(Object.keys(files).filter((path) => path.startsWith('data/'))).toHaveLength(2)
    }
  )

  it.each([
    ['report.csv', 'REPORT.csv'],
    ['résumé.csv', 're\u0301sume\u0301.csv']
  ])('rejects portable path collisions between %s and %s', async (payloadName, inputName) => {
    const fixture = completeSource()
    fixture.source.evidence.filename = payloadName
    fixture.source.evidence.inputs[0]!.filename = inputName
    await expect(
      buildArtifactVersionCompleteRoCrateArchive(fixture.source, {
        readVersionContent: async () => fixture.payload,
        readInputContent: async () => fixture.input
      })
    ).rejects.toThrow('RO-Crate archive path conflicts:')
  })

  it('serializes stable metadata JSON', () => {
    const document = buildArtifactVersionRoCrateMetadata(source())
    const serialized = serializeRoCrateMetadata(document)
    expect(serialized.endsWith('\n')).toBe(true)
    expect(JSON.parse(serialized)).toEqual(document)
    expect(serializeRoCrateMetadata(document)).toBe(serialized)
  })
})
