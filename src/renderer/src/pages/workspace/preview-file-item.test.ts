import { describe, expect, it } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import type { MessagePart } from '../../../../shared/session-persistence'

import {
  createPreviewFileItem,
  createPreviewFileItemFromArtifact,
  createPreviewFileItemFromMention,
  createPreviewFileItemFromUpload
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

  it('uses a relocatable Version locator instead of an absolute path for native Artifacts', () => {
    expect(
      createPreviewFileItemFromArtifact(
        createManagedArtifact({
          artifactId: 'artifact-lineage-1',
          versionId: 'artifact-version-2',
          versionNumber: 2
        }),
        'session-1',
        'project-1'
      )
    ).toMatchObject({
      id: 'artifact-lineage-1',
      artifactId: 'artifact-lineage-1',
      selectedVersionId: 'artifact-version-2',
      path: 'artifact-version:project-1/session-1/artifact-lineage-1/artifact-version-2'
    })
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
