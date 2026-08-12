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
  rootFrameId: 'root-a',
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
    rootFrameId: null,
    ...overrides
  })

const harness = (
  items = [upload(), artifact()]
): {
  service: HostArtifactsService
  readHostArtifactCatalog: ReturnType<typeof vi.fn>
  resolveVersionContent: ReturnType<typeof vi.fn>
  resolveManagedUploadPath: ReturnType<typeof vi.fn>
} => {
  const readHostArtifactCatalog = vi.fn(async ({ versionId }: { versionId?: string }) =>
    versionId ? items.filter((item) => item.versionId === versionId) : items
  )
  const resolveVersionContent = vi.fn(async () => ({ path: '/managed/artifact.csv' }))
  const resolveManagedUploadPath = vi.fn(async () => '/managed/upload.pdf')
  return {
    service: new HostArtifactsService({ readHostArtifactCatalog } as HostArtifactCatalog, {
      artifact: { resolveVersionContent },
      upload: { resolveManagedUploadPath }
    }),
    readHostArtifactCatalog,
    resolveVersionContent,
    resolveManagedUploadPath
  }
}

const context = { projectId: 'project-a', sessionId: 'calling-session' }

describe('HostArtifactsService', () => {
  it('returns the current Project catalog across Sessions with the stable snake_case projection', async () => {
    const { service, readHostArtifactCatalog } = harness()

    await expect(service.list({}, context)).resolves.toEqual({
      count: 2,
      project_id: 'project-a',
      truncated: false,
      artifacts: [
        expect.objectContaining({
          id: 'upload-1',
          filename: 'report.pdf',
          latest_version_id: 'upload-version-1',
          session_id: 'session-b',
          root_frame_id: null,
          is_user_upload: true,
          latest_version_created_at: '2026-08-02T00:00:00.000Z'
        }),
        expect.objectContaining({
          id: 'artifact-1',
          latest_version_id: 'artifact-version-1',
          session_id: 'session-a',
          root_frame_id: 'root-a',
          is_user_upload: false
        })
      ]
    })
    expect(readHostArtifactCatalog).toHaveBeenCalledWith({ projectId: 'project-a' })
  })

  it('narrows by Session, filename/exact, content type, and UTC half-open time bounds', async () => {
    const { service } = harness([
      upload({ filename: 'Final Report.pdf', sortAtMs: Date.parse('2026-08-02T00:00:00Z') }),
      artifact({ filename: 'report.csv', sortAtMs: Date.parse('2026-08-03T00:00:00Z') })
    ])

    await expect(
      service.list(
        {
          session_id: 'session-b',
          filename: 'Report',
          exact: false,
          content_type: 'APPLICATION/PDF',
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
    expect(first).toMatchObject({ count: 2, truncated: true })
    const second = await service.list(
      { filename: '.pdf', limit: 2, cursor: first.next_cursor },
      context
    )
    expect(second).toMatchObject({ count: 1, truncated: false })
    await expect(
      service.list({ filename: 'different', cursor: first.next_cursor }, context)
    ).rejects.toThrow('cursor does not match')
    await expect(service.list({ limit: 0 }, context)).rejects.toThrow('between 1 and 100')
    await expect(service.list({ limit: 101 }, context)).rejects.toThrow('between 1 and 100')
  })

  it('supports direct Version lookup and rejects every mixed or malformed option', async () => {
    const { service, readHostArtifactCatalog } = harness()

    await expect(
      service.list({ version_id: 'artifact-version-1' }, context)
    ).resolves.toMatchObject({
      count: 1,
      artifacts: [{ latest_version_id: 'artifact-version-1' }]
    })
    expect(readHostArtifactCatalog).toHaveBeenLastCalledWith({
      projectId: 'project-a',
      versionId: 'artifact-version-1'
    })

    for (const options of [
      { version_id: 'v1', limit: 1 },
      { project_id: 'all' },
      { search: 'r', filename: 'r' },
      { exact: true },
      { unknown: true },
      { after: '2026-02-30' },
      { after: '2026-08-03', before: '2026-08-03' },
      { after: '2026-08-03T10:00:00' },
      { exact: 'yes', filename: 'x' },
      { session_id: 1 }
    ]) {
      await expect(service.list(options, context)).rejects.toThrow(/host\.artifacts/u)
    }
  })

  it('resolves Artifact and Upload Versions through their existing checksum-validating resolvers', async () => {
    const h = harness()

    await expect(h.service.resolvePath('artifact-version-1', context)).resolves.toBe(
      '/managed/artifact.csv'
    )
    expect(h.resolveVersionContent).toHaveBeenCalledWith({
      projectId: 'project-a',
      appSessionId: 'session-a',
      artifactId: 'artifact-1',
      versionId: 'artifact-version-1'
    })
    await expect(h.service.resolvePath('upload-version-1', context)).resolves.toBe(
      '/managed/upload.pdf'
    )
    expect(h.resolveManagedUploadPath).toHaveBeenCalledWith(
      { path: expect.stringContaining('upload-version:') },
      { projectId: 'project-a', sessionId: 'session-b' }
    )
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
    const ambiguous = new HostArtifactsService(ambiguousCatalog, {
      artifact: { resolveVersionContent: vi.fn() },
      upload: { resolveManagedUploadPath: vi.fn() }
    })
    await expect(ambiguous.resolvePath('collision', context)).rejects.toThrow('ambiguous')

    const corrupt = harness()
    corrupt.resolveVersionContent.mockRejectedValueOnce(new Error('checksum mismatch'))
    await expect(corrupt.service.resolvePath('artifact-version-1', context)).rejects.toThrow(
      'checksum mismatch'
    )

    const relative = harness()
    relative.resolveVersionContent.mockResolvedValueOnce({ path: 'relative.csv' })
    await expect(relative.service.resolvePath('artifact-version-1', context)).rejects.toThrow(
      'relative path'
    )
  })
})
