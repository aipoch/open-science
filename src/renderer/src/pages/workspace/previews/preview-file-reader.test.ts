import { describe, expect, it } from 'vitest'

import { createManagedPreviewRequest } from './preview-file-reader'

describe('createManagedPreviewRequest', () => {
  it('builds a managed request from logical identity without forwarding the projection path', () => {
    expect(
      createManagedPreviewRequest({
        source: 'artifact',
        path: 'artifact-version:stale',
        projectId: 'project-1',
        managedFileId: 'artifact-1',
        selectedVersionId: 'version-2',
        mimeType: 'application/pdf'
      })
    ).toEqual({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1',
      versionId: 'version-2',
      mimeType: 'application/pdf'
    })
  })

  it('keeps the validated path for a local preview', () => {
    expect(createManagedPreviewRequest({ source: 'local', path: '/allowed/report.pdf' })).toEqual({
      source: 'local',
      path: '/allowed/report.pdf'
    })
  })

  it('rejects an ordinary managed preview without a complete logical identity', () => {
    expect(() =>
      createManagedPreviewRequest({
        source: 'upload',
        path: '/managed/stale.pdf',
        projectId: 'project-1'
      })
    ).toThrow(/logical identity/i)
  })
})
