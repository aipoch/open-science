import { describe, expect, it, vi } from 'vitest'

import type { ProjectFileItem } from '../../../../shared/project-files'
import { listAllSessionArtifacts } from './session-artifact-download-data'

const artifact = (id: string): ProjectFileItem => ({
  id,
  source: 'artifact',
  sourceFileId: id,
  sourceVersionId: id,
  projectId: 'project-1',
  sessionId: 'session-1',
  name: `${id}.csv`,
  path: `artifact://${id}`,
  size: 1024,
  sortAtMs: 1
})

describe('Session Artifact download data', () => {
  it('loads every page in one Source Session collection', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => artifact(`artifact-${index}`))
    const finalArtifact = artifact('artifact-100')
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce({ items: firstPage, nextCursor: 'page-2', totalCount: 101 })
      .mockResolvedValueOnce({ items: [finalArtifact], totalCount: 101 })
    const getOverview = vi.fn().mockResolvedValue({
      totalCount: 101,
      uploadCount: 0,
      artifactCount: 101,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    const repairIndex = vi.fn()

    await expect(
      listAllSessionArtifacts({
        getOverview,
        listFiles,
        repairIndex,
        projectId: 'project-1',
        sessionId: 'session-1'
      })
    ).resolves.toEqual([...firstPage, finalArtifact])
    expect(repairIndex).not.toHaveBeenCalled()
    expect(listFiles).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1',
      collection: { kind: 'sessionArtifacts', sessionId: 'session-1' },
      limit: 100
    })
    expect(listFiles).toHaveBeenNthCalledWith(2, {
      projectId: 'project-1',
      collection: { kind: 'sessionArtifacts', sessionId: 'session-1' },
      cursor: 'page-2',
      limit: 100
    })
  })

  it('repairs an incomplete Project Files index before listing Session Artifacts', async () => {
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
    const listFiles = vi.fn().mockResolvedValue({ items: [artifact('artifact-1')], totalCount: 1 })

    await expect(
      listAllSessionArtifacts({
        getOverview,
        listFiles,
        repairIndex,
        projectId: 'project-1',
        sessionId: 'session-1'
      })
    ).resolves.toEqual([artifact('artifact-1')])
    expect(repairIndex).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(getOverview).toHaveBeenCalledTimes(2)
    expect(listFiles).toHaveBeenCalledTimes(1)
  })
})
