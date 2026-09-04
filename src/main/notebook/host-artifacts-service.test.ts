import { describe, expect, it, vi } from 'vitest'

import type { HostArtifactCatalogItem } from '../../shared/project-files'
import { HostArtifactsService, type HostArtifactCatalog } from './host-artifacts-service'

const artifact = (overrides: Partial<HostArtifactCatalogItem> = {}): HostArtifactCatalogItem => ({
  source: 'artifact',
  sourceFileId: 'artifact-1',
  versionId: 'artifact-version-1',
  checksum: 'a'.repeat(64),
  projectId: 'project-a',
  sessionId: 'session-a',
  filename: 'clinical-genomics.csv',
  contentType: 'text/csv',
  sizeBytes: 42,
  sortAtMs: Date.parse('2026-08-01T00:00:00.000Z'),
  createdAt: '2026-08-01T00:00:00.000Z',
  sourceCreatedAt: '2026-08-01T00:00:00.000Z',
  sourceFileCreatedAt: '2026-07-01T00:00:00.000Z',
  rootFrameId: 'root-a',
  agentFrameId: 'frame-a',
  ...overrides
})

const upload = (overrides: Partial<HostArtifactCatalogItem> = {}): HostArtifactCatalogItem =>
  artifact({
    source: 'upload',
    sourceFileId: 'upload-1',
    versionId: 'upload-version-1',
    sessionId: 'session-b',
    filename: 'report.pdf',
    contentType: 'application/pdf',
    sortAtMs: Date.parse('2026-08-02T00:00:00.000Z'),
    createdAt: '2026-08-02T00:00:00.000Z',
    sourceCreatedAt: '2026-08-02T00:00:00.000Z',
    sourceFileCreatedAt: '2026-07-02T00:00:00.000Z',
    rootFrameId: null,
    agentFrameId: null,
    ...overrides
  })

const harness = (
  items = [upload(), artifact()]
): {
  service: HostArtifactsService
  readHostArtifactCatalog: ReturnType<typeof vi.fn>
  stageVersion: ReturnType<typeof vi.fn>
} => {
  const readHostArtifactCatalog = vi.fn(async ({ versionId }: { versionId?: string }) =>
    versionId ? items.filter((item) => item.versionId === versionId) : items
  )
  const stageVersion = vi.fn(async (request: { sourceKind: string }) =>
    request.sourceKind === 'artifact-version'
      ? '/managed-inputs/artifact.csv'
      : '/managed-inputs/upload.pdf'
  )
  return {
    service: new HostArtifactsService({ readHostArtifactCatalog } as HostArtifactCatalog, {
      stageVersion
    }),
    readHostArtifactCatalog,
    stageVersion
  }
}

const context = { projectId: 'project-a', sessionId: 'calling-session' }

describe('HostArtifactsService', () => {
  it('returns the current Project catalog across Sessions with a fixed camelCase projection', async () => {
    const { service, readHostArtifactCatalog } = harness()

    await expect(service.list({}, context)).resolves.toEqual({
      count: 2,
      projectId: 'project-a',
      truncated: false,
      artifacts: [
        {
          id: 'upload-1',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          sizeBytes: 42,
          latestVersionId: 'upload-version-1',
          checksum: 'a'.repeat(64),
          projectId: 'project-a',
          sessionId: 'session-b',
          rootFrameId: null,
          agentFrameId: null,
          isUserUpload: true,
          createdAt: '2026-07-02T00:00:00.000Z',
          latestVersionCreatedAt: '2026-08-02T00:00:00.000Z'
        },
        {
          id: 'artifact-1',
          filename: 'clinical-genomics.csv',
          contentType: 'text/csv',
          sizeBytes: 42,
          latestVersionId: 'artifact-version-1',
          checksum: 'a'.repeat(64),
          projectId: 'project-a',
          sessionId: 'session-a',
          rootFrameId: 'root-a',
          agentFrameId: 'frame-a',
          isUserUpload: false,
          createdAt: '2026-07-01T00:00:00.000Z',
          latestVersionCreatedAt: '2026-08-01T00:00:00.000Z'
        }
      ]
    })
    expect(readHostArtifactCatalog).toHaveBeenCalledWith({ projectId: 'project-a' })
  })

  it('narrows by exact producer Frame without expanding a shared root or including Uploads', async () => {
    const { service } = harness([
      upload(),
      artifact({ sourceFileId: 'root', rootFrameId: 'root-a', agentFrameId: 'root-a' }),
      artifact({
        sourceFileId: 'child-a',
        versionId: 'child-a-v1',
        rootFrameId: 'root-a',
        agentFrameId: 'child-a'
      }),
      artifact({
        sourceFileId: 'child-b',
        versionId: 'child-b-v1',
        rootFrameId: 'root-a',
        agentFrameId: 'child-b'
      })
    ])

    await expect(service.list({ frame_id: 'child-a' }, context)).resolves.toMatchObject({
      count: 1,
      artifacts: [{ id: 'child-a', rootFrameId: 'root-a', agentFrameId: 'child-a' }]
    })
    await expect(service.list({ frame_id: 'root-a' }, context)).resolves.toMatchObject({
      count: 1,
      artifacts: [{ id: 'root', agentFrameId: 'root-a' }]
    })
    await expect(service.list({ frame_id: 'historical-producer' }, context)).resolves.toMatchObject(
      {
        count: 0,
        artifacts: []
      }
    )
  })

  it('narrows by filename/exact, MIME prefix, and UTC half-open time bounds', async () => {
    const { service } = harness([
      upload({ filename: 'Final Report.pdf', sortAtMs: Date.parse('2026-08-02T00:00:00Z') }),
      artifact({ filename: 'report.csv', sortAtMs: Date.parse('2026-08-03T00:00:00Z') })
    ])

    await expect(
      service.list(
        {
          filename: 'Report',
          exact: false,
          content_type: 'APPLICATION/',
          after: '2026-08-02',
          before: '2026-08-03'
        },
        context
      )
    ).resolves.toMatchObject({ count: 1, artifacts: [{ filename: 'Final Report.pdf' }] })
    await expect(
      service.list({ filename: 'Final Report.pdf', exact: true }, context)
    ).resolves.toMatchObject({ count: 1 })
    await expect(
      service.list({ filename: 'final report.pdf', exact: true }, context)
    ).resolves.toMatchObject({ count: 0 })
    const nested = harness([upload({ filename: 'nested/Final Report.pdf' })])
    await expect(
      nested.service.list({ filename: 'Final Report.pdf', exact: true }, context)
    ).resolves.toMatchObject({ count: 1 })
    await expect(service.list({ content_type: 'text/csv' }, context)).resolves.toMatchObject({
      count: 1,
      artifacts: [{ contentType: 'text/csv' }]
    })
    await expect(service.list({ content_type: ' text/ ' }, context)).resolves.toMatchObject({
      count: 1,
      artifacts: [{ contentType: 'text/csv' }]
    })
    for (const contentType of ['bogus/', 'text', 'text/csv/']) {
      await expect(service.list({ content_type: contentType }, context)).rejects.toThrow(
        'valid MIME type'
      )
    }
  })

  it('matches only the latest producer when one lineage was updated by another Frame', async () => {
    const historical = artifact({ versionId: 'shared-v1', agentFrameId: 'frame-a' })
    const latest = artifact({ versionId: 'shared-v2', agentFrameId: 'frame-b' })
    const readHostArtifactCatalog: HostArtifactCatalog['readHostArtifactCatalog'] = async ({
      versionId
    }) => (versionId === historical.versionId ? [historical] : [latest])
    const service = new HostArtifactsService({ readHostArtifactCatalog }, { stageVersion: vi.fn() })

    await expect(service.list({ frame_id: 'frame-a' }, context)).resolves.toMatchObject({
      count: 0,
      artifacts: []
    })
    await expect(service.list({ frame_id: 'frame-b' }, context)).resolves.toMatchObject({
      count: 1,
      artifacts: [{ latestVersionId: 'shared-v2', agentFrameId: 'frame-b' }]
    })
    await expect(service.list({ version_id: 'shared-v1' }, context)).rejects.toThrow(
      'unknown option'
    )
  })

  it('uses the shared fuzzy score for ordering without exposing scores', async () => {
    const { service } = harness([
      artifact({ sourceFileId: 'later', filename: 'final-report.pdf', sortAtMs: 2 }),
      artifact({ sourceFileId: 'prefix', filename: 'report.pdf', sortAtMs: 1 })
    ])

    const result = await service.list({ search: 'report' }, context)

    expect(result.artifacts.map((item) => item.id)).toEqual(['prefix', 'later'])
    expect(result.artifacts.every((item) => !('_score' in item) && !('score' in item))).toBe(true)
  })

  it('binds cursors to filters and enforces the limit range', async () => {
    const { service } = harness([
      upload({ sourceFileId: 'one', versionId: 'v1' }),
      upload({ sourceFileId: 'two', versionId: 'v2' }),
      upload({ sourceFileId: 'three', versionId: 'v3' })
    ])

    const first = await service.list({ filename: '.pdf', limit: 2 }, context)
    expect(first).toMatchObject({ count: 3, truncated: true })
    const second = await service.list(
      { filename: '.pdf', limit: 2, cursor: first.nextCursor },
      context
    )
    expect(second).toMatchObject({ count: 3, truncated: false })
    expect(second.artifacts).toHaveLength(1)
    await expect(
      service.list({ filename: 'different', cursor: first.nextCursor }, context)
    ).rejects.toThrow('cursor does not match')
    await expect(
      service.list({ filename: '.pdf', frame_id: 'frame-a', cursor: first.nextCursor }, context)
    ).rejects.toThrow('cursor does not match')
    await expect(service.list({ limit: 0 }, context)).rejects.toThrow('between 1 and 100')
    await expect(service.list({ limit: 101 }, context)).rejects.toThrow('between 1 and 100')
  })

  it('rejects an obsolete offset cursor and a changed catalog snapshot with stable errors', async () => {
    let items = [
      artifact({ sourceFileId: 'C', versionId: 'C-v1', sortAtMs: 3 }),
      artifact({ sourceFileId: 'A', versionId: 'A-v1', sortAtMs: 2 }),
      artifact({ sourceFileId: 'B', versionId: 'B-v1', sortAtMs: 1 })
    ]
    const catalog: HostArtifactCatalog = {
      readHostArtifactCatalog: vi.fn(async () => items)
    }
    const service = new HostArtifactsService(catalog, { stageVersion: vi.fn() })

    const first = await service.list({ limit: 2 }, context)
    expect(first.artifacts.map((item) => item.id)).toEqual(['C', 'A'])
    const unchangedSecond = await service.list({ limit: 2, cursor: first.nextCursor }, context)
    expect(unchangedSecond.artifacts.map((item) => item.id)).toEqual(['B'])
    items = [artifact({ sourceFileId: 'A', versionId: 'A-v2', sortAtMs: 4 }), items[0]!, items[2]!]
    await expect(service.list({ limit: 2, cursor: first.nextCursor }, context)).rejects.toThrow(
      /HOST_ARTIFACTS_CURSOR_SNAPSHOT_CHANGED/u
    )

    const obsolete = Buffer.from(
      JSON.stringify({ version: 1, queryKey: 'obsolete', offset: 2 }),
      'utf8'
    ).toString('base64url')
    await expect(service.list({ cursor: obsolete }, context)).rejects.toThrow(
      /cursor format is obsolete.*first page/iu
    )
  })

  it('rejects historical Version filtering and every mixed or malformed option', async () => {
    const { service } = harness()
    for (const options of [
      { version_id: 'artifact-version-1' },
      { version_id: 'v1', limit: 1 },
      { project_id: 'all' },
      { search: 'r', filename: 'r' },
      { exact: true },
      { unknown: true },
      { after: '2026-02-30' },
      { after: '2026-08-03', before: '2026-08-03' },
      { after: '2026-08-03T10:00:00' },
      { exact: 'yes', filename: 'x' },
      { frame_id: 1 },
      { frame_id: '   ' },
      { session_id: 'session-a' },
      { sessionId: 'session-a' }
    ]) {
      await expect(service.list(options, context)).rejects.toThrow(/host\.artifacts/u)
    }
  })

  it('fails closed when the Catalog omits source file creation metadata', async () => {
    const { service } = harness([artifact({ sourceFileCreatedAt: undefined })])

    await expect(service.list({}, context)).rejects.toThrow(
      'Host Artifact source file metadata is incomplete'
    )
  })

  it('stages the exact requested Artifact or Upload Version', async () => {
    const h = harness()

    await expect(h.service.resolvePath('artifact-version-1', context)).resolves.toBe(
      '/managed-inputs/artifact.csv'
    )
    expect(h.stageVersion).toHaveBeenCalledWith({
      projectId: 'project-a',
      targetSessionId: 'calling-session',
      sourceKind: 'artifact-version',
      inputFileVersionId: 'artifact-version-1',
      expectedSourceFileId: 'artifact-1'
    })
    await expect(h.service.resolvePath('upload-version-1', context)).resolves.toBe(
      '/managed-inputs/upload.pdf'
    )
    expect(h.stageVersion).toHaveBeenCalledWith({
      projectId: 'project-a',
      targetSessionId: 'calling-session',
      sourceKind: 'upload-version',
      inputFileVersionId: 'upload-version-1',
      expectedSourceFileId: 'upload-1'
    })
  })

  it('fails closed for missing, ambiguous, corrupt, and relative-path Versions', async () => {
    const missing = harness([])
    await expect(missing.service.resolvePath('missing', context)).rejects.toThrow(
      'not found in the current Project'
    )

    const ambiguousCatalog: HostArtifactCatalog = {
      readHostArtifactCatalog: vi.fn(async () => {
        throw new Error('Artifact Version id is ambiguous across generated Artifacts and Uploads.')
      })
    }
    const ambiguous = new HostArtifactsService(ambiguousCatalog, { stageVersion: vi.fn() })
    await expect(ambiguous.resolvePath('collision', context)).rejects.toThrow('ambiguous')

    const corrupt = harness()
    corrupt.stageVersion.mockRejectedValueOnce(new Error('checksum mismatch'))
    await expect(corrupt.service.resolvePath('artifact-version-1', context)).rejects.toThrow(
      'checksum mismatch'
    )

    const relative = harness()
    relative.stageVersion.mockResolvedValueOnce('relative.csv')
    await expect(relative.service.resolvePath('artifact-version-1', context)).rejects.toThrow(
      'relative path'
    )
  })
})
