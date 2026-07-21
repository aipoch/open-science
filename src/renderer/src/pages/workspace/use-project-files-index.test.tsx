// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectFilesChangedEvent, ProjectFileItem } from '../../../../shared/project-files'
import { useProjectFilesIndex, type ProjectFilesIndexState } from './use-project-files-index'

const upload = (id: string): ProjectFileItem => ({
  id: `upload:${id}`,
  source: 'upload',
  sourceFileId: id,
  projectId: 'project-1',
  sessionId: 'session-1',
  name: `${id}.csv`,
  path: `/uploads/${id}.csv`,
  size: 10,
  sortAtMs: 10
})

const artifact = (id: string): ProjectFileItem => ({
  id,
  source: 'artifact',
  sourceFileId: id,
  projectId: 'project-1',
  sessionId: 'session-1',
  name: `${id}.png`,
  path: `/artifacts/${id}.png`,
  size: 20,
  sortAtMs: 20
})

describe('useProjectFilesIndex', () => {
  let container: HTMLDivElement
  let root: Root
  let current: ProjectFilesIndexState
  let changedListener: ((event: ProjectFilesChangedEvent) => void) | undefined
  let listFiles: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    listFiles = vi.fn(async (request: { collection: { kind: string }; cursor?: string }) => {
      if (request.collection.kind === 'uploads') {
        return request.cursor
          ? { items: [upload('upload-2')], totalCount: 2 }
          : { items: [upload('upload-1')], nextCursor: 'uploads-next', totalCount: 2 }
      }

      return request.cursor
        ? { items: [artifact('artifact-2')], totalCount: 2 }
        : { items: [artifact('artifact-1')], nextCursor: 'artifacts-next', totalCount: 2 }
    })
    window.api = {
      projectFiles: {
        getOverview: vi.fn().mockResolvedValue({
          totalCount: 4,
          uploadCount: 2,
          artifactCount: 2,
          artifactGroupCount: 1,
          isIndexComplete: true
        }),
        listFiles,
        listArtifactGroups: vi.fn().mockResolvedValue({
          items: [{ sessionId: 'session-1', artifactCount: 2 }],
          totalCount: 1
        }),
        onChanged: vi.fn((listener) => {
          changedListener = listener
          return () => undefined
        })
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const renderHook = async (): Promise<void> => {
    const Harness = (): null => {
      current = useProjectFilesIndex('project-1')
      return null
    }

    root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
    })
  }

  it('loads overview, uploads, and groups without loading session artifacts', async () => {
    await renderHook()

    expect(current.overview.totalCount).toBe(4)
    expect(current.uploads.items).toEqual([upload('upload-1')])
    expect(current.groups.items).toEqual([{ sessionId: 'session-1', artifactCount: 2 }])
    expect(listFiles).toHaveBeenCalledTimes(1)
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }))
  })

  it('advances upload and per-session artifact cursors independently', async () => {
    await renderHook()

    await act(async () => current.loadMoreUploads())
    await act(async () => current.loadMoreArtifacts('session-1'))
    await act(async () => current.loadMoreArtifacts('session-1'))

    expect(current.uploads.items.map((item) => item.sourceFileId)).toEqual(['upload-1', 'upload-2'])
    expect(current.artifactsBySession['session-1']?.items.map((item) => item.sourceFileId)).toEqual(
      ['artifact-1', 'artifact-2']
    )
    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'uploads-next', collection: { kind: 'uploads' } })
    )
    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: 'artifacts-next',
        collection: { kind: 'sessionArtifacts', sessionId: 'session-1' }
      })
    )
  })

  it('reloads the first pages when the active project index changes', async () => {
    await renderHook()
    const getOverview = vi.mocked(window.api.projectFiles.getOverview)

    await act(async () => {
      changedListener?.({
        projectId: 'project-1',
        sessionId: 'session-1',
        sources: ['artifact'],
        kind: 'upsert'
      })
      await Promise.resolve()
    })

    expect(getOverview).toHaveBeenCalledTimes(2)
  })

  it('repairs an incomplete index and reloads all first pages', async () => {
    const getOverview = vi.mocked(window.api.projectFiles.getOverview)
    getOverview
      .mockResolvedValueOnce({
        totalCount: 0,
        uploadCount: 0,
        artifactCount: 0,
        artifactGroupCount: 0,
        isIndexComplete: false
      })
      .mockResolvedValue({
        totalCount: 4,
        uploadCount: 2,
        artifactCount: 2,
        artifactGroupCount: 1,
        isIndexComplete: true
      })
    const repairIndex = vi.fn(async () => {
      changedListener?.({
        projectId: 'project-1',
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })
    })
    Object.assign(window.api.projectFiles, { repairIndex })
    await renderHook()
    expect(current.overview.isIndexComplete).toBe(false)

    const repair = (current as unknown as { repairIndex(): Promise<void> }).repairIndex
    await act(async () => repair.call(current))

    expect(repairIndex).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(getOverview).toHaveBeenCalledTimes(2)
    expect(current.overview.isIndexComplete).toBe(true)
  })

  it('keeps the repair error after the failed attempt refreshes the index', async () => {
    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: false
    })
    Object.assign(window.api.projectFiles, {
      repairIndex: vi.fn(async () => {
        changedListener?.({
          projectId: 'project-1',
          sources: ['artifact', 'upload'],
          kind: 'reset'
        })
        throw new Error('managed file is still unreadable')
      })
    })
    await renderHook()

    await act(async () => current.repairIndex())

    expect(current.overview.isIndexComplete).toBe(false)
    expect(current.repairError).toBe('managed file is still unreadable')
    expect(current.isRepairing).toBe(false)
  })

  it('preserves loaded upload pages when only one artifact session changes', async () => {
    await renderHook()
    await act(async () => current.loadMoreUploads())
    await act(async () => current.loadMoreArtifacts('session-1'))
    await act(async () => current.loadMoreArtifacts('session-1'))

    await act(async () => {
      changedListener?.({
        projectId: 'project-1',
        sessionId: 'session-1',
        sources: ['artifact'],
        kind: 'upsert'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(current.uploads.items.map((item) => item.sourceFileId)).toEqual(['upload-1', 'upload-2'])
    expect(current.artifactsBySession['session-1']?.items).toEqual([artifact('artifact-1')])
  })

  it('preserves loaded artifact pages when only uploads change', async () => {
    await renderHook()
    await act(async () => current.loadMoreArtifacts('session-1'))
    await act(async () => current.loadMoreArtifacts('session-1'))

    await act(async () => {
      changedListener?.({
        projectId: 'project-1',
        sessionId: 'session-1',
        sources: ['upload'],
        kind: 'upsert'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(current.artifactsBySession['session-1']?.items.map((item) => item.sourceFileId)).toEqual(
      ['artifact-1', 'artifact-2']
    )
    expect(current.groups.items).toEqual([{ sessionId: 'session-1', artifactCount: 2 }])
  })

  it('discards a stale group page that resolves after its session is deleted', async () => {
    const listGroups = vi.mocked(window.api.projectFiles.listArtifactGroups)
    listGroups.mockResolvedValueOnce({
      items: [{ sessionId: 'session-1', artifactCount: 2 }],
      nextCursor: 'groups-next',
      totalCount: 2
    })
    await renderHook()

    let resolveStalePage!: (page: {
      items: Array<{ sessionId: string; artifactCount: number }>
      totalCount: number
    }) => void
    listGroups.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStalePage = resolve
        })
    )
    listFiles.mockResolvedValueOnce({ items: [], totalCount: 0 })

    let staleRequest!: Promise<void>
    await act(async () => {
      staleRequest = current.loadMoreGroups()
      await Promise.resolve()
    })
    await act(async () => {
      changedListener?.({
        projectId: 'project-1',
        sessionId: 'session-deleted',
        sources: ['artifact'],
        kind: 'delete'
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      resolveStalePage({
        items: [{ sessionId: 'session-deleted', artifactCount: 4 }],
        totalCount: 2
      })
      await staleRequest
    })

    expect(current.groups.items).toEqual([{ sessionId: 'session-1', artifactCount: 2 }])
    expect(current.groups.isLoading).toBe(false)
  })

  it('rebuilds the group first page after an artifact event even when the session page fails', async () => {
    await renderHook()
    const listGroups = vi.mocked(window.api.projectFiles.listArtifactGroups)
    listGroups.mockResolvedValueOnce({
      items: [
        { sessionId: 'session-new', artifactCount: 1 },
        { sessionId: 'session-1', artifactCount: 2 }
      ],
      totalCount: 2
    })
    listFiles.mockRejectedValueOnce(new Error('artifact page unavailable'))

    await act(async () => {
      changedListener?.({
        projectId: 'project-1',
        sessionId: 'session-new',
        sources: ['artifact'],
        kind: 'upsert'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listGroups).toHaveBeenLastCalledWith({ projectId: 'project-1', limit: 10 })
    expect(current.groups.items).toEqual([
      { sessionId: 'session-new', artifactCount: 1 },
      { sessionId: 'session-1', artifactCount: 2 }
    ])
    expect(current.artifactsBySession['session-new']?.error).toBe('artifact page unavailable')
  })

  it('keeps the authoritative group order when the session page resolves later', async () => {
    await renderHook()
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValueOnce({
      items: [
        { sessionId: 'session-2', artifactCount: 3 },
        { sessionId: 'session-1', artifactCount: 2 }
      ],
      nextCursor: 'groups-next',
      totalCount: 3
    })
    let resolveSessionPage!: (page: { items: ProjectFileItem[]; totalCount: number }) => void
    listFiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSessionPage = resolve
        })
    )

    await act(async () => {
      changedListener?.({
        projectId: 'project-1',
        sessionId: 'session-1',
        sources: ['artifact'],
        kind: 'upsert'
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(current.groups.items.map((group) => group.sessionId)).toEqual(['session-2', 'session-1'])

    await act(async () => {
      resolveSessionPage({ items: [artifact('artifact-updated')], totalCount: 2 })
      await Promise.resolve()
    })

    expect(current.groups.items.map((group) => group.sessionId)).toEqual(['session-2', 'session-1'])
    expect(current.groups.nextCursor).toBe('groups-next')
  })

  it('replaces stale groups when retrying a failed event first page', async () => {
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValueOnce({
      items: [
        { sessionId: 'session-stale', artifactCount: 4 },
        { sessionId: 'session-1', artifactCount: 2 }
      ],
      totalCount: 2
    })
    await renderHook()
    const listGroups = vi.mocked(window.api.projectFiles.listArtifactGroups)
    listGroups.mockRejectedValueOnce(new Error('database busy'))
    listFiles.mockResolvedValueOnce({ items: [], totalCount: 0 })

    await act(async () => {
      changedListener?.({
        projectId: 'project-1',
        sessionId: 'session-1',
        sources: ['artifact'],
        kind: 'delete'
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(current.groups.error).toBe('database busy')

    listGroups.mockResolvedValueOnce({
      items: [{ sessionId: 'session-2', artifactCount: 1 }],
      totalCount: 1
    })
    await act(async () => current.loadMoreGroups())

    expect(current.groups.items).toEqual([{ sessionId: 'session-2', artifactCount: 1 }])
    expect(current.groups.error).toBeUndefined()
  })

  it('retries a failed first upload page without requiring a cursor', async () => {
    vi.mocked(window.api.projectFiles.listFiles).mockRejectedValueOnce(new Error('database busy'))
    await renderHook()
    expect(current.uploads.error).toBe('database busy')

    vi.mocked(window.api.projectFiles.listFiles).mockResolvedValueOnce({
      items: [upload('retry')],
      totalCount: 1
    })
    await act(async () => current.loadMoreUploads())

    expect(current.uploads.items).toEqual([upload('retry')])
    expect(current.uploads.error).toBeUndefined()
  })

  it('limits simultaneous paginated file requests to four', async () => {
    await renderHook()
    let activeRequests = 0
    let maxActiveRequests = 0
    vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => {
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      await new Promise((resolve) => setTimeout(resolve, 5))
      activeRequests -= 1
      return {
        items: [
          artifact(request.collection.kind === 'uploads' ? 'upload' : request.collection.sessionId)
        ],
        totalCount: 1
      }
    })

    await act(async () => {
      await Promise.all(
        Array.from({ length: 7 }, (_, index) => current.loadMoreArtifacts(`session-${index}`))
      )
    })

    expect(maxActiveRequests).toBe(4)
  })

  it('deduplicates same-tick upload and group pagination requests', async () => {
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValueOnce({
      items: [{ sessionId: 'session-1', artifactCount: 1 }],
      nextCursor: 'groups-next',
      totalCount: 2
    })
    await renderHook()
    const listGroups = vi.mocked(window.api.projectFiles.listArtifactGroups)

    await act(async () => {
      await Promise.all([current.loadMoreUploads(), current.loadMoreUploads()])
      await Promise.all([current.loadMoreGroups(), current.loadMoreGroups()])
    })

    expect(listFiles).toHaveBeenCalledTimes(2)
    expect(listGroups).toHaveBeenCalledTimes(2)
  })
})
