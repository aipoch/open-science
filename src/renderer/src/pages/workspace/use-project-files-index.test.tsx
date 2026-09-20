// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ProjectFilesChangedEvent,
  ProjectFileItem,
  ProjectFilesSearch
} from '../../../../shared/project-files'
import { useProjectFilesIndex, type ProjectFilesIndexState } from './use-project-files-index'

const upload = (id: string): ProjectFileItem => ({
  id: `upload:${id}`,
  source: 'upload',
  sourceFileId: id,
  sourceVersionId: id,
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
  sourceVersionId: id,
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

  const renderHook = async (
    search?: ProjectFilesSearch,
    scope?: { kind: 'all' } | { kind: 'uploads' } | { kind: 'sessionArtifacts'; sessionId: string }
  ): Promise<void> => {
    const Harness = (): null => {
      current = useProjectFilesIndex('project-1', undefined, search, scope)
      return null
    }

    root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
    })
  }

  it.each([
    { count: 40, kind: 'upsert' },
    { count: 60, kind: 'upsert' },
    { count: 40, kind: 'reset' }
  ] as const)('retains $count loaded session artifacts after $kind', async ({ count, kind }) => {
    const files = Array.from({ length: count }, (_, index) => artifact(`artifact-${index}`))
    listFiles.mockImplementation(async (request) => {
      if (request.collection.kind === 'uploads') return { items: [], totalCount: 0 }
      const offset = Number(request.cursor ?? 0)
      const end = offset + request.limit
      return {
        items: files.slice(offset, end),
        totalCount: files.length,
        nextCursor: end < files.length ? String(end) : undefined
      }
    })
    await renderHook()
    for (let offset = 0; offset < count; offset += 20) {
      await act(async () => current.loadMoreArtifacts('session-1'))
    }
    expect(current.artifactsBySession['session-1']?.items).toHaveLength(count)
    await act(async () =>
      changedListener?.({
        projectId: 'project-1',
        sessionId: 'session-1',
        sources: ['artifact'],
        kind
      })
    )
    expect(current.artifactsBySession['session-1']?.items).toHaveLength(count)
  })

  it('retains expanded session groups after an artifact refresh', async () => {
    const groups = Array.from({ length: 20 }, (_, index) => ({
      sessionId: `session-${index + 1}`,
      artifactCount: 1
    }))
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockImplementation(async (request) => {
      const offset = Number(request.cursor ?? 0)
      const end = offset + request.limit!
      return {
        items: groups.slice(offset, end),
        totalCount: groups.length,
        nextCursor: end < groups.length ? String(end) : undefined
      }
    })
    await renderHook()
    await act(async () => current.loadMoreGroups())
    expect(current.groups.items).toHaveLength(20)
    await act(async () =>
      changedListener?.({
        projectId: 'project-1',
        sessionId: 'session-1',
        sources: ['artifact'],
        kind: 'upsert'
      })
    )
    expect(current.groups.items).toHaveLength(20)
    expect(current.groups.items.at(-1)?.sessionId).toBe('session-20')
  })

  it.each(['uploads', 'groups', 'artifacts'] as const)(
    'keeps the previous %s range on second-page refresh failure and retries with fresh cursors',
    async (collection) => {
      const pageSize = collection === 'groups' ? 10 : 20
      let ids = Array.from({ length: pageSize * 2 }, (_, index) => String(index))
      let failTail = false
      const query = vi.fn(async (request: { cursor?: string; limit?: number }) => {
        if (request.cursor && failTail) throw new Error('Refresh tail unavailable')
        const offset = Number(request.cursor ?? 0)
        const end = offset + request.limit!
        return {
          items: ids.slice(offset, end),
          totalCount: ids.length,
          nextCursor: end < ids.length ? String(end) : undefined
        }
      })
      listFiles.mockImplementation(async (request) => {
        const page = await query(request)
        return { ...page, items: page.items.map(collection === 'uploads' ? upload : artifact) }
      })
      vi.mocked(window.api.projectFiles.listArtifactGroups).mockImplementation(async (request) => {
        const page = await query(request)
        return { ...page, items: page.items.map((id) => ({ sessionId: id, artifactCount: 1 })) }
      })
      const read = (): string[] =>
        collection === 'groups'
          ? current.groups.items.map((group) => group.sessionId)
          : (collection === 'uploads'
              ? current.uploads
              : current.artifactsBySession['session-1'])!.items.map((file) => file.sourceFileId)
      const state = (): {
        isLoading: boolean
        error?: string
        totalCount: number
        nextCursor?: string
      } =>
        collection === 'groups'
          ? current.groups
          : collection === 'uploads'
            ? current.uploads
            : current.artifactsBySession['session-1']!
      const load = (): Promise<void> =>
        collection === 'groups'
          ? current.loadMoreGroups()
          : collection === 'uploads'
            ? current.loadMoreUploads()
            : current.loadMoreArtifacts('session-1')
      await renderHook()
      if (collection === 'artifacts') await act(async () => load())
      await act(async () => load())
      const previous = [...ids]
      expect(read()).toEqual(previous)
      // Remove the old tail and move the next newest file to the front; no stale tail may survive.
      ids = [ids.at(-2)!, ...ids.slice(0, -2)]
      failTail = true
      await act(async () =>
        changedListener?.({
          projectId: 'project-1',
          sessionId: 'session-1',
          sources: [collection === 'uploads' ? 'upload' : 'artifact'],
          kind: 'upsert'
        })
      )
      expect(state().isLoading).toBe(false)
      expect(state().error).toBe('Refresh tail unavailable')
      expect(read()).toEqual(previous)
      failTail = false
      query.mockClear()
      await act(async () => load())
      expect(query.mock.calls.map(([request]) => request.cursor)).toEqual([
        undefined,
        String(pageSize)
      ])
      expect(state().error).toBeUndefined()
      expect(read()).toEqual(ids)
      expect(state().totalCount).toBe(ids.length)
      expect(state().nextCursor).toBeUndefined()
    }
  )

  it.each(['reset', 'upsert'] as const)(
    'invalidates a first artifact request before its loading state renders on %s',
    async (kind) => {
      await renderHook()
      let releaseStale: (() => void) | undefined
      let artifactReads = 0
      listFiles.mockImplementation(async (request) => {
        if (request.collection.kind === 'uploads') return { items: [], totalCount: 0 }
        artifactReads += 1
        if (artifactReads === 1) {
          await new Promise<void>((resolve) => {
            releaseStale = resolve
          })
          return { items: [artifact('deleted-artifact')], totalCount: 1 }
        }
        return { items: [], totalCount: 0 }
      })

      await act(async () => {
        const pending = current.loadMoreArtifacts('session-1')
        expect(releaseStale).toBeTypeOf('function')
        // React has not committed the loading page yet; the public request is already in flight.
        expect(current.artifactsBySession['session-1']).toBeUndefined()
        changedListener?.({ projectId: 'project-1', sources: ['artifact'], kind })
        releaseStale!()
        await pending
      })

      expect(current.artifactsBySession['session-1']?.items).toEqual([])
      expect(current.artifactsBySession['session-1']?.isLoading).toBe(false)
      expect(artifactReads).toBe(2)
    }
  )

  it('discards an older refresh tail after a second notification', async () => {
    let files = Array.from({ length: 60 }, (_, index) => upload(String(index)))
    let releaseTail: (() => void) | undefined
    let holdTail = false
    listFiles.mockImplementation(async (request) => {
      const snapshot = files
      const offset = Number(request.cursor ?? 0)
      const end = offset + request.limit
      if (holdTail && request.cursor) {
        holdTail = false
        await new Promise<void>((resolve) => {
          releaseTail = resolve
        })
      }
      return {
        items: snapshot.slice(offset, end),
        totalCount: snapshot.length,
        nextCursor: end < snapshot.length ? String(end) : undefined
      }
    })
    await renderHook(undefined, { kind: 'uploads' })
    await act(async () => current.loadMoreUploads())
    await act(async () => current.loadMoreUploads())
    const previous = current.uploads.items
    holdTail = true
    await act(async () =>
      changedListener?.({ projectId: 'project-1', sources: ['upload'], kind: 'upsert' })
    )
    expect(releaseTail).toBeTypeOf('function')
    expect(current.uploads.isLoading).toBe(true)
    expect(current.uploads.items).toEqual(previous)
    files = files.slice(0, 59).reverse()
    await act(async () =>
      changedListener?.({ projectId: 'project-1', sources: ['upload'], kind: 'upsert' })
    )
    expect(current.uploads.items).toEqual(files)
    await act(async () => releaseTail!())
    expect(current.uploads.items).toEqual(files)
  })

  it('ignores an in-flight refresh when the filename search changes', async () => {
    let search: ProjectFilesSearch = { filenameContains: 'old' }
    let releaseTail: (() => void) | undefined
    let holdTail = false
    listFiles.mockImplementation(async (request) => {
      if (request.search.filenameContains === 'new')
        return { items: [upload('new')], totalCount: 1 }
      if (holdTail && request.cursor)
        await new Promise<void>((resolve) => {
          releaseTail = resolve
        })
      const offset = Number(request.cursor ?? 0)
      return {
        items: Array.from({ length: 20 }, (_, index) => upload(`old-${index + offset}`)),
        totalCount: 40,
        nextCursor: offset === 0 ? '20' : undefined
      }
    })
    const Harness = (): null => {
      current = useProjectFilesIndex('project-1', undefined, search, { kind: 'uploads' })
      return null
    }
    root = createRoot(container)
    await act(async () => root.render(<Harness />))
    await act(async () => current.loadMoreUploads())
    holdTail = true
    await act(async () =>
      changedListener?.({ projectId: 'project-1', sources: ['upload'], kind: 'upsert' })
    )
    expect(releaseTail).toBeTypeOf('function')
    search = { filenameContains: 'new' }
    await act(async () => root.render(<Harness />))
    expect(current.uploads.items).toEqual([upload('new')])
    await act(async () => releaseTail!())
    expect(current.uploads.items).toEqual([upload('new')])
  })

  it('loads overview, uploads, and groups without loading session artifacts', async () => {
    await renderHook()

    expect(current.overview.totalCount).toBe(4)
    expect(current.uploads.items).toEqual([upload('upload-1')])
    expect(current.groups.items).toEqual([{ sessionId: 'session-1', artifactCount: 2 }])
    expect(listFiles).toHaveBeenCalledTimes(1)
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }))
  })

  it('applies one filename search to every independent cursor layer', async () => {
    const search = { filenameContains: 'timeline' }
    await renderHook(search)

    expect(window.api.projectFiles.getOverview).toHaveBeenCalledWith({
      projectId: 'project-1',
      search
    })
    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ collection: { kind: 'uploads' }, search })
    )
    expect(window.api.projectFiles.listArtifactGroups).toHaveBeenCalledWith(
      expect.objectContaining({ search })
    )

    await act(async () => current.loadMoreArtifacts('session-1'))

    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: { kind: 'sessionArtifacts', sessionId: 'session-1' },
        search
      })
    )
  })

  it('loads only uploads for an uploads-scoped search', async () => {
    const search = { filenameContains: 'timeline' }
    await renderHook(search, { kind: 'uploads' })

    expect(window.api.projectFiles.getOverview).not.toHaveBeenCalled()
    expect(window.api.projectFiles.listArtifactGroups).not.toHaveBeenCalled()
    expect(listFiles).toHaveBeenCalledOnce()
    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ collection: { kind: 'uploads' }, search })
    )
    expect(current.uploads.totalCount).toBe(2)
    expect(current.overview.totalCount).toBe(0)
    expect(current.isOverviewLoaded).toBe(false)
  })

  it('loads the selected session even when presentation may be collapsed', async () => {
    const search = { filenameContains: 'timeline' }
    await renderHook(search, { kind: 'sessionArtifacts', sessionId: 'session-1' })

    expect(window.api.projectFiles.getOverview).not.toHaveBeenCalled()
    expect(window.api.projectFiles.listArtifactGroups).not.toHaveBeenCalled()
    expect(listFiles).toHaveBeenCalledOnce()
    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: { kind: 'sessionArtifacts', sessionId: 'session-1' },
        search
      })
    )
    expect(current.artifactsBySession['session-1']?.totalCount).toBe(2)
    expect(current.overview.totalCount).toBe(0)
    expect(current.isOverviewLoaded).toBe(false)
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
    expect(current.artifactsBySession['session-1']?.items).toEqual([
      artifact('artifact-1'),
      artifact('artifact-2')
    ])
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
          artifact(
            request.collection.kind === 'sessionArtifacts'
              ? request.collection.sessionId
              : request.collection.kind
          )
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
