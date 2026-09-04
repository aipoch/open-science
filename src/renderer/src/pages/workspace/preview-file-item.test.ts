import { describe, expect, it } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import type { MessagePart } from '../../../../shared/session-persistence'

import {
  createPreviewFileItem,
  createPreviewFileItemFromArtifact,
  createPreviewFileItemFromMention,
  createPreviewFileItemFromPdfContext,
  createPreviewFileItemFromUpload,
  createPreviewFileItemForArtifactVersion,
  createProjectFileResolveRequest,
  refreshPreviewFileItemFromProjectFile,
  resolveArtifactVersionDescriptor
} from './preview-file-item'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
type MessageUploadAttachment = NonNullable<ChatSession['messages'][number]['uploads']>[number]
type ArtifactMentionPart = Extract<MessagePart, { type: 'artifact'; source: 'upload' | 'artifact' }>

const createManagedArtifact = (overrides: Partial<MessageArtifact> = {}): MessageArtifact => ({
  id: 'artifact-1',
  kind: 'managed-file',
  path: '/workspace/results/report.png',
  fileUrl: 'file:///workspace/results/report.png',
  name: 'report.png',
  mimeType: 'image/png',
  size: 4096,
  mtimeMs: 1710000001000,
  ...overrides
})

const createUploadAttachment = (
  overrides: Partial<MessageUploadAttachment> = {}
): MessageUploadAttachment => ({
  id: 'upload-1',
  sessionId: 'session-1',
  name: 'safe-name.png',
  originalName: 'raw microscope image.png',
  path: '/Users/example/.open-science/uploads/default-project/session-1/safe-name.png',
  mimeType: 'image/png',
  size: 2048,
  ...overrides
})

const createMentionPart = (overrides: Partial<ArtifactMentionPart> = {}): ArtifactMentionPart => ({
  type: 'artifact',
  id: 'artifact-9',
  name: 'summary.md',
  path: '/workspace/results/summary.md',
  source: 'artifact',
  ...overrides
})

describe('preview file item helpers', () => {
  it.each([
    [
      'artifact',
      createPreviewFileItem({
        id: 'legacy-artifact-id',
        sessionId: 'session-1',
        path: '/legacy/report.md',
        name: 'report.md'
      }),
      'legacy-artifact-id',
      'legacy'
    ],
    [
      'upload',
      createPreviewFileItem({
        id: 'upload:upload-1',
        sessionId: 'session-1',
        source: 'upload',
        path: '/legacy/upload.md',
        name: 'upload.md'
      }),
      'upload-1',
      'logical'
    ],
    [
      'upload without a namespaced tab id',
      createPreviewFileItem({
        id: 'legacy-upload-1',
        sessionId: 'session-1',
        source: 'upload',
        path: '/legacy/upload.md',
        name: 'upload.md'
      }),
      'legacy-upload-1',
      'legacy'
    ]
  ] as const)(
    'builds a logical Project Files lookup for a legacy %s retry',
    (_, item, fileIdHint, identityHint) => {
      expect(createProjectFileResolveRequest(item, 'project-1')).toEqual({
        projectId: 'project-1',
        sessionId: 'session-1',
        source: item.source ?? 'artifact',
        fileIdHint,
        identityHint,
        name: item.name
      })
    }
  )

  it('reduces a restored legacy Artifact path to a filename for retry lookup', () => {
    const item = createPreviewFileItem({
      id: 'legacy-artifact-id',
      sessionId: 'session-1',
      path: String.raw`C:\legacy\nested\report.md`,
      name: String.raw`C:\legacy\nested\report.md`
    })

    expect(createProjectFileResolveRequest(item, 'project-1')).toEqual({
      projectId: 'project-1',
      sessionId: 'session-1',
      source: 'artifact',
      fileIdHint: 'legacy-artifact-id',
      identityHint: 'legacy',
      name: 'report.md'
    })
  })

  it('refreshes a legacy preview with canonical identity without changing its selected Version', () => {
    const legacyItem = createPreviewFileItem({
      id: 'legacy-preview-id',
      projectId: 'project-1',
      sessionId: 'session-1',
      path: '/legacy/report.md',
      name: 'report.md',
      selectedVersionId: 'artifact-version-1',
      versionNumber: 1
    })

    expect(
      refreshPreviewFileItemFromProjectFile(legacyItem, {
        id: 'artifact-lineage-1',
        source: 'artifact',
        sourceFileId: 'artifact-lineage-1',
        sourceVersionId: 'artifact-version-2',
        projectId: 'project-1',
        sessionId: 'session-1',
        name: 'report.md',
        path: 'artifact-version:project-1/session-1/artifact-lineage-1/artifact-version-2',
        mimeType: 'text/markdown',
        size: 24,
        mtimeMs: 2,
        sortAtMs: 2
      })
    ).toMatchObject({
      id: 'legacy-preview-id',
      artifactId: 'artifact-lineage-1',
      managedFileId: 'artifact-lineage-1',
      selectedVersionId: 'artifact-version-1',
      versionNumber: 1,
      path: 'artifact-version:project-1/session-1/artifact-lineage-1/artifact-version-1'
    })
  })

  it('does not replace an explicitly missing Artifact Version with the latest Version', () => {
    const latest = {
      id: 'artifact-version-2',
      artifactId: 'artifact-lineage-1',
      versionId: 'artifact-version-2',
      versionNumber: 2,
      checksum: 'checksum-2',
      createdAt: '2026-07-27T20:00:00.000Z',
      state: 'finalized' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      runId: 'artifact-run-2',
      name: 'result.png',
      path: '/managed/result-v2.png',
      fileUrl: 'file:///managed/result-v2.png',
      size: 20,
      mtimeMs: 2,
      updatedAt: 2
    }
    const lineage = {
      artifactId: 'artifact-lineage-1',
      filename: 'result.png',
      originSession: { sessionId: 'session-1', state: 'active' as const },
      versions: [latest]
    }

    expect(resolveArtifactVersionDescriptor(lineage, undefined)).toBe(latest)
    expect(resolveArtifactVersionDescriptor(lineage, 'missing-version')).toBeUndefined()
  })

  it('preserves a deleted origin notice on Project File previews', () => {
    expect(
      createPreviewFileItem({
        id: 'artifact-lineage-1',
        sessionId: 'session-deleted',
        path: '/managed/result.png',
        name: 'result.png',
        artifactId: 'artifact-lineage-1',
        selectedVersionId: 'artifact-version-2',
        originSession: {
          state: 'deleted',
          title: 'Retained analysis',
          deletedAt: '2026-07-27T12:00:00.000Z'
        }
      })
    ).toMatchObject({
      id: 'artifact-lineage-1',
      artifactId: 'artifact-lineage-1',
      selectedVersionId: 'artifact-version-2',
      originSession: { state: 'deleted', title: 'Retained analysis' }
    })
  })

  it('creates artifact preview items without an explicit source', () => {
    expect(createPreviewFileItemFromArtifact(createManagedArtifact(), 'session-1')).toEqual({
      id: 'artifact-1',
      sessionId: 'session-1',
      title: 'report.png',
      type: 'file',
      path: '/workspace/results/report.png',
      name: 'report.png',
      format: 'image',
      mimeType: 'image/png',
      size: 4096,
      mtimeMs: 1710000001000
    })
  })

  it('does not pin a default Artifact preview to the Version stored in an old message', () => {
    const item = createPreviewFileItemFromArtifact(
      createManagedArtifact({
        artifactId: 'artifact-lineage-1',
        versionId: 'artifact-version-2',
        versionNumber: 2
      }),
      'session-1',
      'project-1'
    )

    expect(item).toMatchObject({
      id: 'artifact-lineage-1',
      artifactId: 'artifact-lineage-1',
      path: 'artifact-version:project-1/session-1/artifact-lineage-1/artifact-version-2'
    })
    expect(item).not.toHaveProperty('selectedVersionId')
  })

  it('keeps an explicit Artifact history selection pinned', () => {
    const item = createPreviewFileItem({
      id: 'artifact-lineage-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      path: '/legacy/result.png',
      name: 'result.png',
      artifactId: 'artifact-lineage-1',
      managedFileId: 'artifact-lineage-1'
    })

    expect(
      createPreviewFileItemForArtifactVersion({
        item,
        projectId: 'project-1',
        version: {
          id: 'artifact-version-2',
          artifactId: 'artifact-lineage-1',
          versionId: 'artifact-version-2',
          versionNumber: 2,
          checksum: 'checksum-2',
          createdAt: '2026-07-27T20:00:00.000Z',
          state: 'finalized',
          projectId: 'project-1',
          sessionId: 'session-1',
          runId: 'artifact-run-2',
          name: 'result.png',
          size: 20,
          mtimeMs: 2
        }
      })
    ).toMatchObject({ selectedVersionId: 'artifact-version-2', versionNumber: 2 })
  })

  it('uses artifact mime type when the file name has no previewable extension', () => {
    expect(
      createPreviewFileItemFromArtifact(
        createManagedArtifact({
          path: '/workspace/results/model-output',
          fileUrl: 'file:///workspace/results/model-output',
          name: 'model-output',
          mimeType: 'application/json'
        }),
        'session-1'
      )
    ).toMatchObject({
      title: 'model-output',
      name: 'model-output',
      format: 'json'
    })
  })

  it('ignores artifacts that are not app-managed files', () => {
    expect(
      createPreviewFileItemFromArtifact(
        createManagedArtifact({ kind: 'workspace-file' }),
        'session-1'
      )
    ).toBeUndefined()
  })

  it('creates namespaced upload preview items that use the original upload name', () => {
    expect(createPreviewFileItemFromUpload(createUploadAttachment(), 'session-1')).toEqual({
      id: 'upload:upload-1',
      managedFileId: 'upload-1',
      sessionId: 'session-1',
      title: 'raw microscope image.png',
      type: 'file',
      source: 'upload',
      path: '/Users/example/.open-science/uploads/default-project/session-1/safe-name.png',
      name: 'raw microscope image.png',
      format: 'image',
      mimeType: 'image/png',
      size: 2048
    })
  })

  it('does not pin a default Upload preview to the Version stored in an old attachment', () => {
    const item = createPreviewFileItemFromUpload(
      createUploadAttachment({ versionId: 'upload-version-2', versionNumber: 2 }),
      'session-1',
      'project-1'
    )

    expect(item).toMatchObject({
      id: 'upload:upload-1',
      managedFileId: 'upload-1',
      versionNumber: 2,
      projectId: 'project-1',
      path: 'upload-version:project-1/session-1/upload-1/upload-version-2'
    })
    expect(item).not.toHaveProperty('selectedVersionId')
  })

  it('reopens the exact Artifact Version captured by a PDF context binding', () => {
    expect(
      createPreviewFileItemFromPdfContext(
        {
          version: 1,
          bindingId: 'binding-1',
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-lineage-1',
          sourceVersionId: 'artifact-version-2',
          sourceSessionId: 'source-session',
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 4096,
          checksum: 'checksum-2',
          linkedAt: 1
        },
        'project-1'
      )
    ).toMatchObject({
      id: 'artifact-lineage-1',
      projectId: 'project-1',
      sessionId: 'source-session',
      artifactId: 'artifact-lineage-1',
      selectedVersionId: 'artifact-version-2',
      path: 'artifact-version:project-1/source-session/artifact-lineage-1/artifact-version-2',
      format: 'pdf'
    })
  })

  it('reopens the exact Upload Version captured by a PDF context binding', () => {
    expect(
      createPreviewFileItemFromPdfContext(
        {
          version: 1,
          bindingId: 'binding-1',
          sourceKind: 'upload-version',
          sourceFileId: 'upload-1',
          sourceVersionId: 'upload-version-2',
          sourceSessionId: 'source-session',
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 4096,
          checksum: 'checksum-2',
          linkedAt: 1
        },
        'project-1'
      )
    ).toMatchObject({
      id: 'upload:upload-1',
      projectId: 'project-1',
      sessionId: 'source-session',
      source: 'upload',
      managedFileId: 'upload-1',
      selectedVersionId: 'upload-version-2',
      path: 'upload-version:project-1/source-session/upload-version-2',
      format: 'pdf'
    })
  })

  it('uses upload mime type when the original upload name has no previewable extension', () => {
    expect(
      createPreviewFileItemFromUpload(
        createUploadAttachment({
          name: 'safe-name',
          originalName: 'rendered-report',
          path: '/Users/example/.open-science/uploads/default-project/session-1/safe-name',
          mimeType: 'text/html'
        }),
        'session-1'
      )
    ).toMatchObject({
      title: 'rendered-report',
      name: 'rendered-report',
      format: 'html'
    })
  })

  it('uses the same preview format list for generated files and uploads', () => {
    const artifactItem = createPreviewFileItemFromArtifact(
      createManagedArtifact({
        path: '/workspace/results/analysis.treefile',
        fileUrl: 'file:///workspace/results/analysis.treefile',
        name: 'analysis.treefile',
        mimeType: undefined
      }),
      'session-1'
    )
    const uploadItem = createPreviewFileItemFromUpload(
      createUploadAttachment({
        name: 'analysis.treefile',
        originalName: 'analysis.treefile',
        path: '/uploads/session-1/analysis.treefile',
        mimeType: undefined
      }),
      'session-1'
    )

    expect(artifactItem?.format).toBe('text')
    expect(uploadItem.format).toBe('text')
  })

  it('creates artifact mention preview items without an explicit source', () => {
    expect(createPreviewFileItemFromMention(createMentionPart(), 'session-1')).toEqual({
      id: 'artifact-9',
      sessionId: 'session-1',
      title: 'summary.md',
      type: 'file',
      path: '/workspace/results/summary.md',
      name: 'summary.md',
      format: 'markdown'
    })
  })

  it('does not pin a default Artifact mention preview to its persisted Version', () => {
    const item = createPreviewFileItemFromMention(
      createMentionPart({
        id: 'artifact-lineage-2',
        versionId: 'artifact-version-4',
        path: 'artifact-version:project-1/source-session/artifact-lineage-2/artifact-version-4'
      }),
      'current-session',
      'project-1'
    )

    expect(item).toMatchObject({
      id: 'artifact-lineage-2',
      projectId: 'project-1',
      sessionId: 'source-session',
      artifactId: 'artifact-lineage-2'
    })
    expect(item).not.toHaveProperty('selectedVersionId')
  })

  it('preserves the mention id and marks upload-sourced mentions as uploads', () => {
    const item = createPreviewFileItemFromMention(
      createMentionPart({
        id: 'upload-mention-3',
        name: 'scan.png',
        path: '/uploads/scan.png',
        source: 'upload'
      }),
      'session-1'
    )

    expect(item).toMatchObject({
      id: 'upload-mention-3',
      source: 'upload',
      name: 'scan.png',
      format: 'image'
    })
  })

  it('recovers Upload identity without pinning a default mention preview to its Version', () => {
    const item = createPreviewFileItemFromMention(
      createMentionPart({
        id: 'upload:upload-file-3',
        sourceFileId: 'upload-file-3',
        name: 'shared.csv',
        path: 'upload-version:project-1/source-session/upload-file-3/upload-version-4',
        source: 'upload',
        versionId: 'upload-version-4'
      }),
      'current-session',
      'current-project'
    )

    expect(item).toMatchObject({
      id: 'upload:upload-file-3',
      managedFileId: 'upload-file-3',
      projectId: 'project-1',
      sessionId: 'source-session',
      source: 'upload'
    })
    expect(item).not.toHaveProperty('selectedVersionId')
  })

  it('uses mention mime type when the file name has no previewable extension', () => {
    expect(
      createPreviewFileItemFromMention(
        createMentionPart({
          id: 'extensionless-pdf',
          name: 'research-paper',
          path: '/workspace/results/research-paper',
          mimeType: 'application/pdf'
        }),
        'session-1'
      )
    ).toMatchObject({
      name: 'research-paper',
      mimeType: 'application/pdf',
      format: 'pdf'
    })
  })
})
