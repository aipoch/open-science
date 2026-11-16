import { describe, expect, it } from 'vitest'

import { createArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../../../../shared/uploads'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { pptxAnnotationSourceForPreview } from './pptx-annotation-source'

const item = (overrides: Partial<PreviewFileItem> = {}): PreviewFileItem => ({
  id: 'artifact-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  title: 'deck.pptx',
  type: 'file',
  path: createArtifactVersionLocator({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'artifact-version-1'
  }),
  format: 'presentation',
  name: 'deck.pptx',
  artifactId: 'artifact-1',
  selectedVersionId: 'artifact-version-1',
  ...overrides
})

describe('pptx annotation source', () => {
  it('captures an immutable Artifact Version identity', () => {
    expect(pptxAnnotationSourceForPreview(item())).toEqual({
      kind: 'artifact-version',
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'artifact-version-1',
      name: 'deck.pptx',
      path: expect.stringMatching(/^artifact-version:/)
    })
  })

  it('captures an immutable scoped Upload Version identity', () => {
    const path = createUploadVersionReference('upload-version-1', {
      projectId: 'project-1',
      sessionId: 'session-1',
      fileId: 'upload-1'
    })
    expect(
      pptxAnnotationSourceForPreview(
        item({ managedFileId: 'upload-1', source: 'upload', path, artifactId: undefined })
      )
    ).toMatchObject({ kind: 'upload-version', versionId: 'upload-version-1', path })
  })

  it.each([
    ['mutable path', { path: '/workspace/deck.pptx' }],
    ['mismatched Artifact Version', { selectedVersionId: 'artifact-version-2' }],
    ['other file type', { name: 'deck.pdf' }],
    ['local source', { source: 'local' as const }]
  ])('fails closed for $0', (_name, overrides) => {
    expect(pptxAnnotationSourceForPreview(item(overrides))).toBeUndefined()
  })
})
