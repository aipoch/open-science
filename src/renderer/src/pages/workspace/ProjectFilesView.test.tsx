// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import {
  createInitialSessionState,
  type ChatMessage,
  type ChatSession
} from '@/stores/session-store'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { ProjectFilesChangedEvent, ProjectFileItem } from '../../../../shared/project-files'
import type { UploadedAttachment } from '../../../../shared/uploads'

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createUpload = (overrides: Partial<UploadedAttachment> = {}): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: 'session-1',
  name: 'safe-name.png',
  originalName: 'user upload.png',
  path: '/Users/example/.open-science/uploads/default-project/session-1/safe-name.png',
  mimeType: 'image/png',
  size: 2048,
  ...overrides
})

const clickDropdownTrigger = (button: HTMLButtonElement | null): void => {
  button?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('buildProjectFileLibrary', () => {
  it('collects all user uploads into one flat newest-first list', async () => {
    const { buildProjectFileLibrary } = await import('./project-files-library')
    const library = buildProjectFileLibrary([
      createSession({
        id: 'session-a',
        title: 'Session A',
        messages: [
          createMessage({
            id: 'old-message',
            createdAt: 1710000000000,
            updatedAt: 1710000001000,
            uploads: [createUpload({ id: 'upload-old', originalName: 'old.fasta' })]
          })
        ]
      }),
      createSession({
        id: 'session-b',
        title: 'Session B',
        messages: [
          createMessage({
            id: 'new-message',
            createdAt: 1710000000000,
            updatedAt: 1710000003000,
            uploads: [createUpload({ id: 'upload-new', originalName: 'new.fasta' })]
          })
        ]
      })
    ])

    expect(library.uploadFiles.map((file) => file.name)).toEqual(['new.fasta', 'old.fasta'])
    expect(library.artifactGroups).toEqual([])
  })

  it('groups generated files by session and filters out non-managed artifacts', async () => {
    const { buildProjectFileLibrary } = await import('./project-files-library')
    const library = buildProjectFileLibrary([
      createSession({
        id: 'session-a',
        title: 'Phylogenetic Analysis',
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          },
          {
            id: 'artifact-2',
            kind: 'workspace-file',
            path: '/workspace/raw.txt',
            fileUrl: 'file:///workspace/raw.txt',
            name: 'raw.txt',
            mimeType: 'text/plain',
            size: 128,
            mtimeMs: 1710000002001
          }
        ]
      })
    ])

    expect(library.artifactGroups).toHaveLength(1)
    expect(library.artifactGroups[0]).toMatchObject({
      sessionId: 'session-a',
      title: 'Phylogenetic Analysis',
      files: [
        {
          id: 'artifact-1',
          name: 'tree.png'
        }
      ]
    })
  })
})

describe('project file preview reader', () => {
  it('shares a four-request limit and deduplicates in-flight reads across batches', async () => {
    const { createKeyedRequestReader } = await import('./project-file-preview-queue')
    type TestTarget = { id: string; cacheKey: string }
    let active = 0
    let maxActive = 0
    const read = vi.fn(async (target: TestTarget) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { id: target.id, cacheKey: target.cacheKey, preview: undefined }
    })
    const reader = createKeyedRequestReader(read, (target) => target.cacheKey, 4)
    const targets = Array.from({ length: 7 }, (_, index) => ({
      id: `artifact-${index}`,
      cacheKey: `artifact-${index}:v1`
    }))

    const firstBatch = targets.slice(0, 4).map(reader)
    await Promise.resolve()
    const secondBatch = [...targets.slice(4).map(reader), reader(targets[0])]
    await Promise.all([...firstBatch, ...secondBatch])

    expect(maxActive).toBe(4)
    expect(read).toHaveBeenCalledTimes(7)
  })

  it('skips stale queued work before reading the next project', async () => {
    const { createKeyedRequestReader } = await import('./project-file-preview-queue')
    type TestTarget = { id: string; projectId: string }
    const expensiveReads: string[] = []
    const reader = createKeyedRequestReader(
      async (target: TestTarget) => {
        expensiveReads.push(target.id)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return target.id
      },
      (target) => `${target.projectId}:${target.id}`,
      4,
      {
        getGenerationKey: (target) => target.projectId,
        createCanceledResult: (target) => target.id
      }
    )
    const oldRequests = Array.from({ length: 10 }, (_, index) =>
      reader({ id: `old-${index}`, projectId: 'old-project' })
    )
    await Promise.resolve()
    const newRequest = reader({ id: 'new', projectId: 'new-project' })

    await Promise.all([...oldRequests, newRequest])

    expect(expensiveReads).toEqual(['old-0', 'old-1', 'old-2', 'old-3', 'new'])
  })

  it('cancels a large inactive queue without growing the call stack', async () => {
    const { createKeyedRequestReader } = await import('./project-file-preview-queue')
    type TestTarget = { id: string; projectId: string }
    let releaseActive!: () => void
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve
    })
    const read = vi.fn(async (target: TestTarget) => {
      if (target.id === 'active') await activeGate
      return target.id
    })
    const reader = createKeyedRequestReader(read, (target) => target.id, 1, {
      getGenerationKey: (target) => target.projectId,
      createCanceledResult: (target) => target.id
    })
    reader.setActiveKeys(new Set(['active']))
    const active = reader({ id: 'active', projectId: 'project-1' })
    const queued = Array.from({ length: 5_000 }, (_, index) =>
      reader({ id: `queued-${index}`, projectId: 'project-1' })
    )
    reader.setActiveKeys(new Set())

    releaseActive()
    await expect(Promise.all([active, ...queued])).resolves.toHaveLength(5_001)
    expect(read).toHaveBeenCalledOnce()
  })
})

describe('ProjectFilesView', () => {
  let container: HTMLDivElement
  let root: Root
  let projectFilesChangedListener: ((event: ProjectFilesChangedEvent) => void) | undefined

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    projectFilesChangedListener = undefined
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
      previewResources: {
        acquire: vi.fn(({ path }: { path: string }) =>
          Promise.resolve({
            id: `resource:${path}`,
            url: `open-science-preview://resource/${encodeURIComponent(path)}`,
            size: 40 * 1024 * 1024,
            mimeType: 'image/png',
            version: 1
          })
        ),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      },
      artifacts: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'ZmFrZS1pbWFnZQ==',
          encoding: 'base64',
          size: 10,
          truncated: false
        })
      },
      uploads: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'dXBsb2FkLWltYWdl',
          encoding: 'base64',
          size: 12,
          truncated: false
        })
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const renderView = async (sessions: ChatSession[], strict = false): Promise<void> => {
    const { useSessionStore } = await import('@/stores/session-store')
    const { useNavigationStore } = await import('@/stores/navigation-store')
    const { ProjectFilesView } = await import('./ProjectFilesView')
    const { buildProjectFileLibrary } = await import('./project-files-library')

    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions
    })
    const getLibrary = (): ReturnType<typeof buildProjectFileLibrary> =>
      buildProjectFileLibrary(
        useSessionStore.getState().sessions.filter((session) => session.projectId === 'default')
      )
    const toUploadItem = (
      file: ReturnType<typeof getLibrary>['uploadFiles'][number]
    ): ProjectFileItem => ({
      id: file.id,
      source: 'upload',
      sourceFileId: file.attachment.id,
      projectId: 'default',
      sessionId: file.sessionId,
      name: file.name,
      path: file.attachment.path,
      mimeType: file.attachment.mimeType,
      size: file.size,
      mtimeMs: file.timestamp,
      sortAtMs: file.timestamp
    })
    const toArtifactItem = (
      file: ReturnType<typeof getLibrary>['artifactGroups'][number]['files'][number],
      sessionId: string
    ): ProjectFileItem => ({
      id: file.id,
      source: 'artifact',
      sourceFileId: file.id,
      projectId: 'default',
      sessionId,
      name: file.name,
      path: file.artifact.path,
      mimeType: file.artifact.mimeType,
      size: file.size ?? 0,
      mtimeMs: file.artifact.mtimeMs,
      sortAtMs: file.artifact.mtimeMs ?? 0
    })

    window.api.projectFiles = {
      getOverview: vi.fn(async () => {
        const library = getLibrary()
        const artifactCount = library.artifactGroups.reduce(
          (total, group) => total + group.files.length,
          0
        )

        return {
          totalCount: library.uploadFiles.length + artifactCount,
          uploadCount: library.uploadFiles.length,
          artifactCount,
          artifactGroupCount: library.artifactGroups.length,
          isIndexComplete: true
        }
      }),
      listFiles: vi.fn(async (request) => {
        const library = getLibrary()
        const items =
          request.collection.kind === 'uploads'
            ? library.uploadFiles.map(toUploadItem)
            : (library.artifactGroups
                .find((group) => group.sessionId === request.collection.sessionId)
                ?.files.map((file) => toArtifactItem(file, request.collection.sessionId)) ?? [])

        return { items, totalCount: items.length }
      }),
      listArtifactGroups: vi.fn(async () => {
        const groups = getLibrary().artifactGroups
        return {
          items: groups.map((group) => ({
            sessionId: group.sessionId,
            artifactCount: group.files.length
          })),
          totalCount: groups.length
        }
      }),
      repairIndex: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn((listener) => {
        projectFilesChangedListener = listener
        return () => undefined
      })
    }
    // The view lists only the active project's files; test sessions use the 'default' projectId.
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'default' })
    root = createRoot(container)
    await act(async () => {
      root.render(strict ? <StrictMode>{<ProjectFilesView />}</StrictMode> : <ProjectFilesView />)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('renders an empty state when the project has no files', async () => {
    await renderView([])

    expect(container.querySelector('[data-testid="files-view"]')).not.toBeNull()
    expect(container.textContent).toContain('No files yet')
  })

  it('shows an actionable incomplete-index state instead of an empty state', async () => {
    await renderView([])
    const repairIndex = vi.fn().mockResolvedValue(undefined)
    Object.assign(window.api.projectFiles, { repairIndex })
    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: false
    })
    vi.mocked(window.api.projectFiles.listFiles).mockResolvedValue({ items: [], totalCount: 0 })
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValue({
      items: [],
      totalCount: 0
    })

    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Some files could not be indexed yet.')
    expect(container.textContent).not.toContain('No files yet')
    const retry = container.querySelector<HTMLButtonElement>(
      '[aria-label="Retry indexing project files"]'
    )
    expect(retry?.getAttribute('data-size')).toBe('xs')

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(repairIndex).toHaveBeenCalledWith({ projectId: 'default' })
  })

  it('renders uploaded files under Your uploads without a session group', async () => {
    await renderView([
      createSession({
        title: 'Hidden session title',
        messages: [
          createMessage({
            uploads: [createUpload({ originalName: 'iso621_bridge_recombinase.fasta' })]
          })
        ]
      })
    ])

    expect(container.textContent).toContain('Your uploads')
    expect(container.textContent).toContain('iso621_bridg...inase.fasta')
    expect(container.querySelector('[title="iso621_bridge_recombinase.fasta"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Hidden session title')
    expect(
      container.querySelector('[data-testid="project-file-preview"]')?.parentElement?.parentElement
        ?.className
    ).toContain('focus-within:ring')
  })

  it('downloads an uploaded file without opening its preview', async () => {
    const upload = createUpload()
    await renderView([
      createSession({
        messages: [createMessage({ uploads: [upload] })]
      })
    ])

    const downloadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Download user upload.png"]'
    )
    expect(downloadButton).not.toBeNull()
    expect(
      downloadButton?.closest('[data-testid="download-tooltip-trigger"]')?.className
    ).toContain('absolute')

    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'upload',
      path: upload.path,
      suggestedName: 'user upload.png'
    })
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBeUndefined()
  })

  it('downloads a generated file through the artifact source', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-download',
            kind: 'managed-file',
            path: '/workspace/report.pdf',
            fileUrl: 'file:///workspace/report.pdf',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const downloadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Download report.pdf"]'
    )
    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/workspace/report.pdf',
      suggestedName: 'report.pdf'
    })
  })

  it('uses compact manual load controls for uploads and each session in the all view', async () => {
    await renderView([createSession({ id: 'session-1', title: 'Session A' })])
    const createFile = (source: ProjectFileItem['source'], index: number): ProjectFileItem => ({
      id: source === 'upload' ? `upload:upload-${index}` : `artifact-${index}`,
      source,
      sourceFileId: `${source}-${index}`,
      projectId: 'default',
      sessionId: 'session-1',
      name: `${source}-${index}.bin`,
      path: `/${source}s/${source}-${index}.bin`,
      mimeType: 'application/octet-stream',
      size: 10,
      sortAtMs: 100 - index
    })
    const uploadFiles = Array.from({ length: 40 }, (_, index) => createFile('upload', index))
    const artifactFiles = Array.from({ length: 40 }, (_, index) => createFile('artifact', index))

    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: 80,
      uploadCount: 40,
      artifactCount: 40,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValue({
      items: [{ sessionId: 'session-1', artifactCount: 40 }],
      totalCount: 1
    })
    vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => {
      const files = request.collection.kind === 'uploads' ? uploadFiles : artifactFiles
      return request.cursor
        ? { items: files.slice(20), totalCount: 40 }
        : {
            items: files.slice(0, 20),
            nextCursor: `${request.collection.kind}-next`,
            totalCount: 40
          }
    })

    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.querySelectorAll('[aria-label^="Preview uploaded file"]')).toHaveLength(20)
    expect(container.querySelectorAll('[aria-label^="Preview generated file"]')).toHaveLength(20)
    let uploadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Load more uploaded files"]'
    )
    let sessionButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Load more files from Session A"]'
    )
    expect(uploadButton?.getAttribute('data-size')).toBe('xs')
    expect(sessionButton?.getAttribute('data-size')).toBe('xs')

    const firstPageRequestCount = vi.mocked(window.api.projectFiles.listFiles).mock.calls.length
    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="uploads"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelectorAll('[aria-label^="Preview uploaded file"]')).toHaveLength(20)
    expect(window.api.projectFiles.listFiles).toHaveBeenCalledTimes(firstPageRequestCount)
    expect(container.querySelector('[aria-label="Load more uploaded files"]')).not.toBeNull()

    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="all"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    uploadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Load more uploaded files"]'
    )
    sessionButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Load more files from Session A"]'
    )

    await act(async () => {
      uploadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      sessionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.querySelectorAll('[aria-label^="Preview uploaded file"]')).toHaveLength(40)
    expect(container.querySelectorAll('[aria-label^="Preview generated file"]')).toHaveLength(40)
    expect(container.querySelectorAll('[data-testid="project-files-end"]')).toHaveLength(2)
  })

  it('uses scroll loading and shows the terminal state in upload and session filters', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly callback: IntersectionObserverCallback

        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback
        }

        observe = (): void => {
          const observer = this as unknown as IntersectionObserver
          queueMicrotask(() =>
            this.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer)
          )
        }
        disconnect = vi.fn()
        unobserve = vi.fn()
        takeRecords = (): IntersectionObserverEntry[] => []
      }
    )
    await renderView([createSession({ id: 'session-1', title: 'Session A' })])
    const createFile = (source: ProjectFileItem['source'], index: number): ProjectFileItem => ({
      id: source === 'upload' ? `upload:upload-${index}` : `artifact-${index}`,
      source,
      sourceFileId: `${source}-${index}`,
      projectId: 'default',
      sessionId: 'session-1',
      name: `${source}-${index}.bin`,
      path: `/${source}s/${source}-${index}.bin`,
      mimeType: 'application/octet-stream',
      size: 10,
      sortAtMs: 100 - index
    })
    const uploadFiles = Array.from({ length: 40 }, (_, index) => createFile('upload', index))
    const artifactFiles = Array.from({ length: 40 }, (_, index) => createFile('artifact', index))

    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: 80,
      uploadCount: 40,
      artifactCount: 40,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValue({
      items: [{ sessionId: 'session-1', artifactCount: 40 }],
      totalCount: 1
    })
    vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => {
      const files = request.collection.kind === 'uploads' ? uploadFiles : artifactFiles
      return request.cursor
        ? { items: files.slice(20), totalCount: 40 }
        : {
            items: files.slice(0, 20),
            nextCursor: `${request.collection.kind}-next`,
            totalCount: 40
          }
    })

    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const selectFilter = async (filterId: string): Promise<void> => {
      await act(async () => {
        clickDropdownTrigger(
          container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
        )
      })
      await act(async () => {
        document.body
          .querySelector<HTMLButtonElement>(`[data-filter-id="${filterId}"]`)
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    await selectFilter('uploads')
    expect(container.querySelectorAll('[aria-label^="Preview uploaded file"]')).toHaveLength(40)
    expect(container.querySelector('[aria-label="Load more uploaded files"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="project-files-end"]')).toHaveLength(1)

    await selectFilter('session:session-1')
    expect(container.querySelectorAll('[aria-label^="Preview generated file"]')).toHaveLength(40)
    expect(container.querySelector('[aria-label="Load more files from Session A"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="project-files-end"]')).toHaveLength(1)

    await selectFilter('all')
    expect(container.querySelectorAll('[aria-label^="Preview uploaded file"]')).toHaveLength(20)
    expect(container.querySelectorAll('[aria-label^="Preview generated file"]')).toHaveLength(20)
    expect(container.querySelector('[aria-label="Load more uploaded files"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Load more files from Session A"]')).not.toBeNull()

    const fileRequestCount = vi.mocked(window.api.projectFiles.listFiles).mock.calls.length
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Load more uploaded files"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      container
        .querySelector<HTMLButtonElement>('[aria-label="Load more files from Session A"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelectorAll('[aria-label^="Preview uploaded file"]')).toHaveLength(40)
    expect(container.querySelectorAll('[aria-label^="Preview generated file"]')).toHaveLength(40)
    expect(window.api.projectFiles.listFiles).toHaveBeenCalledTimes(fileRequestCount)
    expect(container.querySelectorAll('[data-testid="project-files-end"]')).toHaveLength(2)
  })

  it('loads the next upload page when the filtered sentinel intersects', async () => {
    let triggerIntersection: (() => void) | undefined
    const observedTargets: Element[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly callback: IntersectionObserverCallback

        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback
        }

        observe = (target: Element): void => {
          observedTargets.push(target)
          if (target.getAttribute('data-testid') === 'upload-page-sentinel') {
            const observer = this as unknown as IntersectionObserver
            triggerIntersection = () =>
              this.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer)
          }
        }
        disconnect = vi.fn()
        unobserve = vi.fn()
        takeRecords = (): IntersectionObserverEntry[] => []
      }
    )
    await renderView([])
    const uploadFiles: ProjectFileItem[] = Array.from({ length: 60 }, (_, index) => ({
      id: `upload:upload-${index}`,
      source: 'upload',
      sourceFileId: `upload-${index}`,
      projectId: 'default',
      sessionId: 'session-1',
      name: `upload-${index}.bin`,
      path: `/uploads/upload-${index}.bin`,
      mimeType: 'application/octet-stream',
      size: 10,
      sortAtMs: 100 - index
    }))
    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: 60,
      uploadCount: 60,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    })
    vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => {
      if (!request.cursor) {
        return { items: uploadFiles.slice(0, 20), nextCursor: 'uploads-next-1', totalCount: 60 }
      }
      if (request.cursor === 'uploads-next-1') {
        return { items: uploadFiles.slice(20, 40), nextCursor: 'uploads-next-2', totalCount: 60 }
      }
      return { items: uploadFiles.slice(40), totalCount: 60 }
    })

    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['upload'],
        kind: 'reset'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const firstPageRequestCount = vi.mocked(window.api.projectFiles.listFiles).mock.calls.length
    const selectFilter = async (filterId: string): Promise<void> => {
      await act(async () => {
        clickDropdownTrigger(
          container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
        )
      })
      await act(async () => {
        document.body
          .querySelector<HTMLButtonElement>(`[data-filter-id="${filterId}"]`)
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }
    await selectFilter('uploads')

    expect(container.querySelectorAll('[aria-label^="Preview uploaded file"]')).toHaveLength(20)
    expect(window.api.projectFiles.listFiles).toHaveBeenCalledTimes(firstPageRequestCount)
    expect(triggerIntersection).toBeTypeOf('function')
    expect(observedTargets).toContain(
      container.querySelector('[data-testid="upload-page-sentinel"]')
    )

    const staleIntersection = triggerIntersection
    await selectFilter('all')
    await act(async () => {
      staleIntersection?.()
      await Promise.resolve()
    })
    expect(window.api.projectFiles.listFiles).toHaveBeenCalledTimes(firstPageRequestCount)

    await selectFilter('uploads')
    await act(async () => {
      triggerIntersection?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.querySelectorAll('[aria-label^="Preview uploaded file"]')).toHaveLength(40)
    expect(window.api.projectFiles.listFiles).toHaveBeenCalledTimes(firstPageRequestCount + 1)
    expect(container.querySelectorAll('[data-testid="project-files-end"]')).toHaveLength(0)

    await act(async () => {
      triggerIntersection?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.querySelectorAll('[aria-label^="Preview uploaded file"]')).toHaveLength(60)
    expect(window.api.projectFiles.listFiles).toHaveBeenCalledTimes(firstPageRequestCount + 2)
    expect(container.querySelectorAll('[data-testid="project-files-end"]')).toHaveLength(1)
  })

  it('opens a filter menu without This computer entries', async () => {
    await renderView([
      createSession({
        title: 'Session A',
        messages: [
          createMessage({
            uploads: [createUpload()]
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )

    await act(async () => {
      clickDropdownTrigger(filterButton)
    })

    expect(document.body.textContent).toContain('All artifacts')
    expect(document.body.textContent).toContain('Your uploads')
    expect(document.body.textContent).toContain('Session A')
    expect(document.body.textContent).not.toContain('This computer')
  })

  it('uses the global semantic menu surface and hover feedback for filter items', async () => {
    await renderView([
      createSession({
        title: 'Session A',
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )

    await act(async () => {
      clickDropdownTrigger(filterButton)
    })

    expect(filterButton?.getAttribute('data-slot')).toBe('button')
    expect(filterButton?.getAttribute('data-variant')).toBe('outline')
    expect(filterButton?.className).toContain('rounded-lg')
    expect(filterButton?.className).toContain('border-border')
    expect(filterButton?.className).toContain('bg-card')
    expect(filterButton?.className).toContain('hover:bg-muted')
    expect(filterButton?.className).not.toContain('rounded-md')
    expect(filterButton?.className).not.toContain('border-border-300')
    expect(filterButton?.className).not.toContain('shadow-sm')
    expect(filterButton?.className).not.toContain('hover:bg-bg-100')
    expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')?.className).toContain(
      'bg-popover'
    )
    expect(document.body.querySelector('[data-filter-id="all"]')?.className).toContain(
      'data-[highlighted]:bg-muted'
    )
  })

  it('filters to uploads or a single session from the menu', async () => {
    await renderView([
      createSession({
        id: 'session-a',
        title: 'Session A',
        messages: [
          createMessage({
            uploads: [createUpload()]
          })
        ],
        artifacts: [
          {
            id: 'artifact-a',
            kind: 'managed-file',
            path: '/workspace/a.png',
            fileUrl: 'file:///workspace/a.png',
            name: 'a.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      }),
      createSession({
        id: 'session-b',
        title: 'Session B',
        artifacts: [
          {
            id: 'artifact-b',
            kind: 'managed-file',
            path: '/workspace/b.png',
            fileUrl: 'file:///workspace/b.png',
            name: 'b.png',
            mimeType: 'image/png',
            size: 2048,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const openFilterMenu = async (): Promise<void> => {
      const filterButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Filter project files"]'
      )

      await act(async () => {
        clickDropdownTrigger(filterButton)
      })
    }

    await openFilterMenu()
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="uploads"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('user upload.png')
    expect(container.textContent).not.toContain('a.png')
    expect(container.textContent).not.toContain('Session B')

    await openFilterMenu()
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="session:session-b"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Session B')
    expect(container.textContent).toContain('b.png')
    expect(container.textContent).not.toContain('Your uploads')
    expect(container.textContent).not.toContain('a.png')
  })

  it('keeps a later-page session filter active across an index refresh', async () => {
    const sessions = Array.from({ length: 11 }, (_, index) =>
      createSession({
        id: `session-${index + 1}`,
        title: `Session ${index + 1}`,
        artifacts: [
          {
            id: `artifact-${index + 1}`,
            kind: 'managed-file',
            path: `/workspace/file-${index + 1}.png`,
            fileUrl: `file:///workspace/file-${index + 1}.png`,
            name: `file-${index + 1}.png`,
            mimeType: 'image/png',
            size: 1024,
            mtimeMs: 1710000002000 + index
          }
        ]
      })
    )
    await renderView(sessions)

    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="session:session-11"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('file-11.png')

    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValue({
      items: sessions.slice(0, 10).map((session) => ({
        sessionId: session.id,
        artifactCount: 1
      })),
      totalCount: 11
    })
    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sessionId: 'session-11',
        sources: ['artifact'],
        kind: 'upsert'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Session 11')
    expect(container.textContent).toContain('file-11.png')
    expect(container.textContent).not.toContain('file-1.png')
  })

  it('allows filtering a DB group whose session title is not hydrated', async () => {
    await renderView([])
    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: 1,
      uploadCount: 0,
      artifactCount: 1,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValue({
      items: [{ sessionId: 'orphan-session', artifactCount: 1 }],
      totalCount: 1
    })
    vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => ({
      items:
        request.collection.kind === 'sessionArtifacts'
          ? [
              {
                id: 'orphan-artifact',
                source: 'artifact',
                sourceFileId: 'orphan-artifact',
                projectId: 'default',
                sessionId: 'orphan-session',
                name: 'orphan.txt',
                path: '/artifacts/orphan.txt',
                size: 10,
                sortAtMs: 10
              }
            ]
          : [],
      totalCount: request.collection.kind === 'sessionArtifacts' ? 1 : 0
    }))
    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['artifact'],
        kind: 'reset'
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="session:orphan-session"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Session orphan-s')
    expect(container.textContent).toContain('orphan.txt')

    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    })
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValue({
      items: [],
      totalCount: 0
    })
    vi.mocked(window.api.projectFiles.listFiles).mockResolvedValue({ items: [], totalCount: 0 })
    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sessionId: 'orphan-session',
        sources: ['artifact'],
        kind: 'delete'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')?.textContent
    ).toContain('Artifacts')
  })

  it('resets filter and scroll position when the active project changes', async () => {
    await renderView([
      createSession({
        messages: [createMessage({ uploads: [createUpload()] })]
      })
    ])
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-testid="project-files-scroll"]'
    )
    if (scrollContainer) scrollContainer.scrollTop = 240

    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="uploads"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const { useNavigationStore } = await import('@/stores/navigation-store')
    await act(async () => {
      useNavigationStore.setState({ activeProjectId: 'other-project' })
      await Promise.resolve()
    })

    const nextScrollContainer = container.querySelector<HTMLElement>(
      '[data-testid="project-files-scroll"]'
    )
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')?.textContent
    ).toContain('Artifacts')
    expect(nextScrollContainer).not.toBe(scrollContainer)
    expect(nextScrollContainer?.scrollTop).toBe(0)
  })

  it('drops queued thumbnail reads from the previous project during a project switch', async () => {
    const oldReadResolvers: Array<() => void> = []
    vi.mocked(window.api.uploads.readPreview).mockImplementation(
      ({ path }) =>
        new Promise((resolve) => {
          if (path.startsWith('/uploads/old-')) {
            oldReadResolvers.push(() =>
              resolve({
                content: 'old',
                encoding: 'utf8',
                size: 3,
                truncated: false
              })
            )
            return
          }

          resolve({
            content: 'new',
            encoding: 'utf8',
            size: 3,
            truncated: false
          })
        })
    )
    const oldUploads = Array.from({ length: 10 }, (_, index) =>
      createUpload({
        id: `old-${index}`,
        name: `old-${index}.txt`,
        originalName: `old-${index}.txt`,
        path: `/uploads/old-${index}.txt`,
        mimeType: 'text/plain'
      })
    )
    await renderView([createSession({ messages: [createMessage({ uploads: oldUploads })] })])

    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.filter(([request]) => request.maxBytes !== 1)
    ).toHaveLength(4)
    const newFile: ProjectFileItem = {
      id: 'new-upload',
      source: 'upload',
      sourceFileId: 'new-upload',
      projectId: 'other-project',
      sessionId: 'other-session',
      name: 'new.txt',
      path: '/uploads/new.txt',
      mimeType: 'text/plain',
      size: 3,
      sortAtMs: 10
    }
    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: 1,
      uploadCount: 1,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    })
    vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => ({
      items: request.projectId === 'other-project' ? [newFile] : [],
      totalCount: request.projectId === 'other-project' ? 1 : 0
    }))
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValue({
      items: [],
      totalCount: 0
    })

    const { useNavigationStore } = await import('@/stores/navigation-store')
    await act(async () => {
      useNavigationStore.setState({ activeProjectId: 'other-project' })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('new.txt')
    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.filter(([request]) => request.maxBytes !== 1)
    ).toHaveLength(4)

    await act(async () => {
      oldReadResolvers.forEach((resolve) => resolve())
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.filter(([request]) => request.maxBytes !== 1)
    ).toHaveLength(5)
    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.filter(([request]) => request.maxBytes !== 1)
        .at(-1)?.[0]
    ).toEqual(expect.objectContaining({ path: '/uploads/new.txt' }))
  })

  it('shows wrapped size metadata and relative file timestamps', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1710007202000)

    await renderView([
      createSession({
        title: 'Generated session',
        messages: [
          createMessage({
            updatedAt: 1710000002000,
            uploads: [createUpload()]
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const generatedButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file tree.png"]'
    )
    const generatedMeta = generatedButton?.querySelector('[data-testid="project-file-meta"]')

    expect(generatedMeta?.className).toContain('flex-col')
    expect(generatedButton?.textContent).toContain('4 KB')
    expect(generatedButton?.textContent).toContain('2 hours ago')
  })

  it('streams image bodies without loading them into base64 preview content', async () => {
    await renderView([
      createSession({
        messages: [
          createMessage({
            uploads: [
              createUpload({
                originalName: 'uploaded_image.png',
                mimeType: 'image/png',
                path: '/uploads/uploaded_image.png'
              })
            ]
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/typhoon_tracks.png',
            fileUrl: 'file:///workspace/typhoon_tracks.png',
            name: 'typhoon_tracks.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/workspace/typhoon_tracks.png',
      mimeType: 'image/png'
    })
    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'upload',
      path: '/uploads/uploaded_image.png',
      mimeType: 'image/png'
    })
    expect(
      vi
        .mocked(window.api.artifacts.readPreview)
        .mock.calls.every(([request]) => request.maxBytes === 1)
    ).toBe(true)
    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.every(([request]) => request.maxBytes === 1)
    ).toBe(true)
    expect(
      container.querySelector('img[alt="Preview of typhoon_tracks.png"]')?.getAttribute('src')
    ).toContain('open-science-preview://')
    expect(
      container.querySelector('img[alt="Preview of uploaded_image.png"]')?.getAttribute('src')
    ).toContain('open-science-preview://')
  })

  it('reacquires an image thumbnail when the file changes at the same path', async () => {
    const createImageSession = (size: number, mtimeMs: number): ChatSession =>
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/changing.png',
            fileUrl: 'file:///workspace/changing.png',
            name: 'changing.png',
            mimeType: 'image/png',
            size,
            mtimeMs
          }
        ]
      })
    await renderView([createImageSession(4096, 1710000002000)])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.setState({ sessions: [createImageSession(8192, 1710000003000)] })
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['artifact'],
        kind: 'reset'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource:/workspace/changing.png'
    })
  })

  it('passes MIME metadata when an extensionless image acquires its resource', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/generated-image',
            fileUrl: 'file:///workspace/generated-image',
            name: 'generated-image',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/workspace/generated-image',
      mimeType: 'image/png'
    })
  })

  it('releases a thumbnail resource when the managed image cannot be decoded', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/broken.png',
            fileUrl: 'file:///workspace/broken.png',
            name: 'broken.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      container.querySelector('img[alt="Preview of broken.png"]')?.dispatchEvent(new Event('error'))
      await Promise.resolve()
    })

    expect(container.querySelector('img[alt="Preview of broken.png"]')).toBeNull()
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource:/workspace/broken.png'
    })
  })

  it('waits until a text thumbnail is near the viewport before reading its first chunk', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
      }
    )

    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-csv',
            kind: 'managed-file',
            path: '/workspace/results.csv',
            fileUrl: 'file:///workspace/results.csv',
            name: 'results.csv',
            mimeType: 'text/csv',
            size: 10 * 1024 * 1024,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.artifacts.readPreview).toHaveBeenCalledWith({
      path: '/workspace/results.csv',
      maxBytes: 32768,
      encoding: 'utf8'
    })
  })

  it('badges a file whose source is missing on disk', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT'
    })
    ;(window.api.artifacts.readPreview as ReturnType<typeof vi.fn>).mockRejectedValue(enoent)

    // Rendered under StrictMode: the existence probe must survive the dev double-invoke (its first
    // effect pass is canceled), which a synchronous path-claim would break.
    await renderView(
      [
        createSession({
          artifacts: [
            {
              id: 'artifact-gone',
              kind: 'managed-file',
              path: '/workspace/gone.png',
              fileUrl: 'file:///workspace/gone.png',
              name: 'gone.png',
              mimeType: 'image/png',
              size: 4096,
              mtimeMs: 1710000002000
            }
          ]
        })
      ],
      true
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // The existence probe rejected with ENOENT, so the tile carries the "Missing" tag.
    expect(container.textContent).toContain('Missing')
  })

  it('keeps previews for every currently rendered file beyond the hidden cache limit', async () => {
    await renderView([])
    const uploads: ProjectFileItem[] = Array.from({ length: 97 }, (_, index) => ({
      id: `upload:upload-${index}`,
      source: 'upload',
      sourceFileId: `upload-${index}`,
      projectId: 'default',
      sessionId: 'session-1',
      name: `upload-${index}.png`,
      path: `/uploads/upload-${index}.png`,
      mimeType: 'image/png',
      size: 10,
      sortAtMs: 100 - index
    }))
    let readCount = 0
    vi.mocked(window.api.uploads.readPreview).mockImplementation(() => {
      readCount += 1
      if (readCount > uploads.length) return new Promise(() => undefined)
      return Promise.resolve({
        content: 'aW1hZ2U=',
        encoding: 'base64',
        size: 5,
        truncated: false
      })
    })
    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: uploads.length,
      uploadCount: uploads.length,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    })
    vi.mocked(window.api.projectFiles.listFiles).mockResolvedValue({
      items: uploads,
      totalCount: uploads.length
    })

    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['upload'],
        kind: 'reset'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="uploads"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(window.api.uploads.readPreview).toHaveBeenCalledTimes(uploads.length)
    expect(container.querySelectorAll('img[alt^="Preview of upload-"]')).toHaveLength(
      uploads.length
    )
  })

  it('uses the same text preview capability for generated files and uploads', async () => {
    const treePreview = {
      content: '(sample_a:0.1,sample_b:0.2);',
      encoding: 'utf8' as const,
      size: 30,
      truncated: false
    }
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue(treePreview)
    vi.mocked(window.api.uploads.readPreview).mockResolvedValue(treePreview)

    await renderView([
      createSession({
        messages: [
          createMessage({
            uploads: [
              createUpload({
                name: 'uploaded.treefile',
                originalName: 'uploaded.treefile',
                path: '/uploads/uploaded.treefile',
                mimeType: undefined,
                size: 30
              })
            ]
          })
        ],
        artifacts: [
          {
            id: 'artifact-tree',
            kind: 'managed-file',
            path: '/workspace/generated.treefile',
            fileUrl: 'file:///workspace/generated.treefile',
            name: 'generated.treefile',
            mimeType: undefined,
            size: 30,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.artifacts.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/generated.treefile', encoding: 'utf8' })
    )
    expect(window.api.uploads.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/uploads/uploaded.treefile', encoding: 'utf8' })
    )
    expect(container.querySelectorAll('[data-testid="artifact-skeleton-preview"]')).toHaveLength(2)
  })

  it('retries an uploaded CSV thumbnail after its pending path is finalized', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // The existence probe issues a 1-byte read per file; key the mock on maxBytes so it neither
    // consumes the thumbnail-read sequence below nor badges the pending upload as missing.
    let thumbnailReads = 0
    vi.mocked(window.api.uploads.readPreview).mockImplementation((request) => {
      if (request.maxBytes === 1) {
        return Promise.resolve({ content: '', encoding: 'base64', size: 0, truncated: false })
      }
      thumbnailReads += 1
      if (thumbnailReads === 1) {
        return Promise.reject(new Error('ENOENT: pending upload moved'))
      }
      return Promise.resolve({
        content: 'sample,value\nalpha,1\n',
        encoding: 'utf8',
        size: 21,
        truncated: false
      })
    })

    await renderView([
      createSession({
        messages: [
          createMessage({
            uploads: [
              createUpload({
                sessionId: '.pending',
                name: 'results.csv',
                originalName: 'results.csv',
                path: '/uploads/.pending/results.csv',
                mimeType: 'text/csv',
                size: 21
              })
            ]
          })
        ]
      })
    ])

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.getState().replaceMessageUploads({
        sessionId: 'session-1',
        messageId: 'message-1',
        uploads: [
          createUpload({
            name: 'results.csv',
            originalName: 'results.csv',
            path: '/uploads/session-1/results.csv',
            mimeType: 'text/csv',
            size: 21
          })
        ]
      })
      projectFilesChangedListener?.({
        projectId: 'default',
        sessionId: 'session-1',
        sources: ['upload'],
        kind: 'upsert'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    // The pending-path read failed with ENOENT, which is an expected unavailable-file error and is
    // deliberately not logged; only the successful retry should surface the finalized content.
    expect(consoleError).not.toHaveBeenCalledWith(
      'Failed to read project file preview',
      expect.any(Error)
    )
    expect(window.api.uploads.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/uploads/session-1/results.csv', encoding: 'utf8' })
    )
    expect(container.textContent).toContain('1 rows · 2 columns')
  })

  it('hides a stale thumbnail while a new file version is loading', async () => {
    // Key the mock on maxBytes so the existence probe's 1-byte read never consumes the versioned
    // thumbnail-read sequence (legacy resolves, the next version hangs while loading).
    let thumbnailReads = 0
    vi.mocked(window.api.uploads.readPreview).mockImplementation((request) => {
      if (request.maxBytes === 1) {
        return Promise.resolve({ content: '', encoding: 'base64', size: 0, truncated: false })
      }
      thumbnailReads += 1
      if (thumbnailReads === 1) {
        return Promise.resolve({
          content: 'legacy_column,value\nold,1\n',
          encoding: 'utf8',
          size: 26,
          truncated: false
        })
      }
      return new Promise(() => undefined)
    })

    await renderView([
      createSession({
        messages: [
          createMessage({
            uploads: [
              createUpload({
                name: 'results.csv',
                originalName: 'results.csv',
                path: '/uploads/.pending/results.csv',
                mimeType: 'text/csv',
                size: 26
              })
            ]
          })
        ]
      })
    ])

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('legacy_column')

    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.getState().replaceMessageUploads({
        sessionId: 'session-1',
        messageId: 'message-1',
        uploads: [
          createUpload({
            name: 'results.csv',
            originalName: 'results.csv',
            path: '/uploads/session-1/results.csv',
            mimeType: 'text/csv',
            size: 27
          })
        ]
      })
      projectFilesChangedListener?.({
        projectId: 'default',
        sessionId: 'session-1',
        sources: ['upload'],
        kind: 'upsert'
      })
      await Promise.resolve()
    })

    expect(window.api.uploads.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/uploads/session-1/results.csv', encoding: 'utf8' })
    )
    expect(container.textContent).not.toContain('legacy_column')
  })

  it('does not read a changed upload preview while its section is collapsed', async () => {
    await renderView([
      createSession({
        messages: [
          createMessage({
            uploads: [
              createUpload({
                name: 'results.csv',
                originalName: 'results.csv',
                path: '/uploads/session-1/results.csv',
                mimeType: 'text/csv',
                size: 21
              })
            ]
          })
        ]
      })
    ])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.filter(([request]) => request.maxBytes !== 1)
    ).toHaveLength(1)

    const uploadsHeader = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.textContent?.includes('Your uploads') && button.hasAttribute('aria-expanded')
    )
    expect(uploadsHeader).toBeDefined()
    await act(async () => uploadsHeader?.click())

    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.getState().replaceMessageUploads({
        sessionId: 'session-1',
        messageId: 'message-1',
        uploads: [
          createUpload({
            name: 'results.csv',
            originalName: 'results.csv',
            path: '/uploads/session-1/results-v2.csv',
            mimeType: 'text/csv',
            size: 22
          })
        ]
      })
      projectFilesChangedListener?.({
        projectId: 'default',
        sessionId: 'session-1',
        sources: ['upload'],
        kind: 'upsert'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.filter(([request]) => request.maxBytes !== 1)
    ).toHaveLength(1)
  })

  it('cancels queued upload preview reads after the section is collapsed', async () => {
    const previewResolvers: Array<(preview: ArtifactPreviewResult) => void> = []
    vi.mocked(window.api.uploads.readPreview).mockImplementation(
      () =>
        new Promise((resolve) => {
          previewResolvers.push(resolve)
        })
    )
    const uploads = Array.from({ length: 6 }, (_, index) =>
      createUpload({
        id: `upload-${index}`,
        name: `result-${index}.txt`,
        originalName: `result-${index}.txt`,
        path: `/uploads/session-1/result-${index}.txt`,
        mimeType: 'text/plain',
        size: 12
      })
    )
    await renderView([createSession({ messages: [createMessage({ uploads })] })])
    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.filter(([request]) => request.maxBytes !== 1)
    ).toHaveLength(4)

    const uploadsHeader = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.textContent?.includes('Your uploads') && button.hasAttribute('aria-expanded')
    )
    await act(async () => uploadsHeader?.click())
    await act(async () => {
      for (const resolve of previewResolvers) {
        resolve({
          content: 'dXBsb2FkLWltYWdl',
          encoding: 'base64',
          size: 12,
          truncated: false
        })
      }
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.filter(([request]) => request.maxBytes !== 1)
    ).toHaveLength(4)
  })

  it('middle-truncates file names in the card style while preserving the extension', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/denovo_design_worklist.csv',
            fileUrl: 'file:///workspace/denovo_design_worklist.csv',
            name: 'denovo_design_worklist.csv',
            mimeType: 'text/csv',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    expect(container.textContent).toContain('denovo_desig...orklist.csv')
    expect(container.textContent).not.toContain('denovo_design_worklist.csv')
  })

  it('uses taller file cards and preview thumbnails', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const generatedButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file tree.png"]'
    )
    const previewSurface = generatedButton?.querySelector('[data-testid="project-file-preview"]')

    expect(generatedButton?.className).toContain('h-[128px]')
    expect(previewSurface?.className).toContain('h-[82px]')
  })

  it('opens upload and generated file preview items from their tiles', async () => {
    await renderView([
      createSession({
        id: 'session-1',
        title: 'Generated session',
        messages: [
          createMessage({
            id: 'message-1',
            uploads: [createUpload()]
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const uploadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview uploaded file user upload.png"]'
    )
    const generatedButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file tree.png"]'
    )

    await act(async () => {
      uploadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      generatedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().items).toMatchObject([
      {
        id: 'upload:upload-1',
        source: 'upload',
        name: 'user upload.png'
      },
      {
        id: 'artifact-1',
        name: 'tree.png'
      }
    ])
  })

  it('does not restart a pending thumbnail read when another tile becomes visible', async () => {
    const observed = new Map<Element, IntersectionObserverCallback>()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn((element: Element) => observed.set(element, this.callback))
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(private readonly callback: IntersectionObserverCallback) {}
      }
    )
    vi.mocked(window.api.artifacts.readPreview).mockImplementation(
      () => new Promise(() => undefined)
    )
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/first.txt',
            fileUrl: 'file:///workspace/first.txt',
            name: 'first.txt',
            mimeType: 'text/plain',
            size: 128,
            mtimeMs: 1710000000100
          },
          {
            id: 'artifact-2',
            kind: 'managed-file',
            path: '/workspace/second.txt',
            fileUrl: 'file:///workspace/second.txt',
            name: 'second.txt',
            mimeType: 'text/plain',
            size: 128,
            mtimeMs: 1710000000200
          }
        ]
      })
    ])
    const artifactSentinel = container.querySelector(
      '[data-testid="artifact-page-sentinel:session-1"]'
    )
    await act(async () => {
      observed.get(artifactSentinel as Element)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const first = container.querySelector('[aria-label="Preview generated file first.txt"]')
    const second = container.querySelector('[aria-label="Preview generated file second.txt"]')

    await act(async () => {
      observed.get(first as Element)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })
    await act(async () => {
      observed.get(second as Element)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })

    const thumbnailReads = vi
      .mocked(window.api.artifacts.readPreview)
      .mock.calls.filter(([request]) => request.maxBytes !== 1)
    expect(thumbnailReads).toHaveLength(2)
    expect(thumbnailReads[0]?.[0]).toEqual(
      expect.objectContaining({ path: '/workspace/first.txt' })
    )
    expect(thumbnailReads[1]?.[0]).toEqual(
      expect.objectContaining({ path: '/workspace/second.txt' })
    )
  })
})
