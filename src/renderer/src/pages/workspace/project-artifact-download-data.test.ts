import { describe, expect, it, vi } from 'vitest'

import type { ProjectFileItem } from '../../../../shared/project-files'
import { listAllProjectFiles } from './project-artifact-download-data'

const file = (id: string, source: ProjectFileItem['source'] = 'artifact'): ProjectFileItem => ({
  id,
  source,
  sourceFileId: id,
  sourceVersionId: id,
  projectId: 'project-1',
  sessionId: 'session-1',
  name: `${id}.csv`,
  path: `${source}://${id}`,
  size: 1024,
  sortAtMs: 1
})

describe('Project Artifact download data', () => {
  it('loads every page of the flat all-files collection', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => file(`file-${index}`))
    const lastPage = [file('file-100'), file('upload-1', 'upload')]
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce({ items: firstPage, nextCursor: 'page-2', totalCount: 102 })
      .mockResolvedValueOnce({ items: lastPage, totalCount: 102 })
    const getOverview = vi.fn().mockResolvedValue({
      totalCount: 102,
      uploadCount: 1,
      artifactCount: 101,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    const repairIndex = vi.fn()

    await expect(
      listAllProjectFiles({ getOverview, listFiles, repairIndex, projectId: 'project-1' })
    ).resolves.toEqual([...firstPage, ...lastPage])
    expect(repairIndex).not.toHaveBeenCalled()
    expect(listFiles).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1',
      collection: { kind: 'all' },
      limit: 100
    })
    expect(listFiles).toHaveBeenNthCalledWith(2, {
      projectId: 'project-1',
      collection: { kind: 'all' },
      cursor: 'page-2',
      limit: 100
    })
  })

  it('repairs an incomplete Project Files index before listing', async () => {
    const getOverview = vi
      .fn()
      .mockResolvedValueOnce({
        totalCount: 0,
        uploadCount: 0,
        artifactCount: 0,
        artifactGroupCount: 0,
        isIndexComplete: false
      })
      .mockResolvedValueOnce({
        totalCount: 1,
        uploadCount: 0,
        artifactCount: 1,
        artifactGroupCount: 1,
        isIndexComplete: true
      })
    const repairIndex = vi.fn().mockResolvedValue(undefined)
    const listFiles = vi.fn().mockResolvedValue({ items: [file('file-1')], totalCount: 1 })

    await expect(
      listAllProjectFiles({ getOverview, listFiles, repairIndex, projectId: 'project-1' })
    ).resolves.toEqual([file('file-1')])
    expect(repairIndex).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(getOverview).toHaveBeenCalledTimes(2)
  })

  it('throws when the index stays incomplete after repair', async () => {
    const incomplete = {
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: false
    }
    const getOverview = vi.fn().mockResolvedValue(incomplete)
    const repairIndex = vi.fn().mockResolvedValue(undefined)
    const listFiles = vi.fn()

    await expect(
      listAllProjectFiles({ getOverview, listFiles, repairIndex, projectId: 'project-1' })
    ).rejects.toThrow('Some Project Files could not be indexed yet.')
    expect(listFiles).not.toHaveBeenCalled()
  })
})
