import { describe, expect, it } from 'vitest'

import { createArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../../../../shared/uploads'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import {
  imagePointAnnotationSourceForPreview,
  staticImageMimeType
} from './image-annotation-source'

const item = (overrides: Partial<PreviewFileItem> = {}): PreviewFileItem => ({
  id: 'artifact-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  title: 'figure.png',
  type: 'file',
  path: createArtifactVersionLocator({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'artifact-version-1'
  }),
  format: 'image',
  name: 'figure.png',
  mimeType: 'image/png',
  artifactId: 'artifact-1',
  selectedVersionId: 'artifact-version-1',
  ...overrides
})

describe('static image annotation source', () => {
  it.each([
    ['plot.png', undefined, 'image/png'],
    ['plot.JPEG', 'application/octet-stream', 'image/jpeg'],
    ['plot.webp', 'image/webp; charset=binary', 'image/webp'],
    ['plot.avif', undefined, 'image/avif'],
    ['plot.gif', 'image/gif', undefined],
    ['plot.svg', 'image/svg+xml', undefined],
    ['plot.png', 'image/gif', undefined]
  ])('resolves supported MIME for %s and %s', (name, mimeType, expected) => {
    expect(staticImageMimeType(name, mimeType)).toBe(expected)
  })

  it('captures an immutable Artifact Version identity', () => {
    expect(imagePointAnnotationSourceForPreview(item())).toEqual({
      kind: 'artifact-version',
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'artifact-version-1',
      name: 'figure.png',
      path: expect.stringMatching(/^artifact-version:/),
      mimeType: 'image/png'
    })
  })

  it('captures an immutable scoped Upload Version identity', () => {
    const path = createUploadVersionReference('upload-version-1', {
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(
      imagePointAnnotationSourceForPreview(
        item({
          id: 'upload:upload-1',
          source: 'upload',
          artifactId: undefined,
          selectedVersionId: undefined,
          path,
          name: 'microscopy.webp',
          mimeType: 'image/webp'
        })
      )
    ).toEqual({
      kind: 'upload-version',
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'upload-version-1',
      name: 'microscopy.webp',
      path,
      mimeType: 'image/webp'
    })
  })

  it.each([
    ['mutable artifact path', { path: '/workspace/figure.png' }],
    ['mismatched selected Artifact Version', { selectedVersionId: 'artifact-version-2' }],
    ['unsupported image kind', { name: 'figure.gif', mimeType: 'image/gif' }],
    ['local source', { source: 'local' as const }],
    [
      'unscoped upload identity',
      {
        source: 'upload' as const,
        path: createUploadVersionReference('upload-version-1'),
        artifactId: undefined,
        selectedVersionId: undefined
      }
    ]
  ])('fails closed for $0', (_name, overrides) => {
    expect(imagePointAnnotationSourceForPreview(item(overrides))).toBeUndefined()
  })
})
