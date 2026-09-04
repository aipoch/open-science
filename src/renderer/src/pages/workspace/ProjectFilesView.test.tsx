// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  type PreviewFileItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import type { ComputeHost } from '../../../../shared/compute'
import {
  createInitialSessionState,
  type ChatMessage,
  type ChatSession
} from '@/stores/session-store'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { ProjectFilesChangedEvent, ProjectFileItem } from '../../../../shared/project-files'
import {
  createUploadVersionReference,
  getUploadedAttachmentName,
  getUploadedAttachmentPath,
  type UploadedAttachment
} from '../../../../shared/uploads'
import { createCachedImageFetchResponse } from './previews/cached-preview-image.test-support'

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

const createArtifactSessions = (count: number): ChatSession[] =>
  Array.from({ length: count }, (_, index) =>
    createSession({
      id: `session-${index + 1}`,
      title: `Session ${index + 1}`,
      artifacts: [
        {
          id: `artifact-${index + 1}`,
          kind: 'managed-file',
          path: `/workspace/file-${index + 1}.txt`,
          name: `file-${index + 1}.txt`
        }
      ]
    })
  )

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

const foldAsciiCase = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase())

type ProjectFileFixtures = {
  uploadFiles: ProjectFileItem[]
  artifactGroups: Array<{ sessionId: string; files: ProjectFileItem[] }>
}

const projectFileFixturesFromSessions = (sessions: ChatSession[]): ProjectFileFixtures => {
  const uploadFiles: ProjectFileItem[] = []
  const artifactGroups: ProjectFileFixtures['artifactGroups'] = []

  for (const session of sessions) {
    for (const message of session.messages) {
      if (message.role !== 'user') continue
      for (const attachment of message.uploads ?? []) {
        if (!attachment.path && !attachment.versionId) continue
        const timestamp = message.updatedAt || message.createdAt
        uploadFiles.push({
          id: `upload:${attachment.id}`,
          source: 'upload',
          sourceFileId: attachment.id,
          sourceVersionId: attachment.id,
          projectId: 'default',
          sessionId: session.id,
          name: getUploadedAttachmentName(attachment),
          path: getUploadedAttachmentPath(attachment, 'default'),
          mimeType: attachment.mimeType,
          size: attachment.size,
          mtimeMs: timestamp,
          sortAtMs: timestamp
        })
      }
    }

    const files = (session.artifacts ?? [])
      .filter((artifact) => artifact.kind === 'managed-file' && Boolean(artifact.path))
      .map((artifact): ProjectFileItem => ({
        id: artifact.id,
        source: 'artifact',
        sourceFileId: artifact.id,
        sourceVersionId: artifact.id,
        projectId: 'default',
        sessionId: session.id,
        name: artifact.name ?? artifact.path?.split('/').at(-1) ?? artifact.id,
        path: artifact.path!,
        mimeType: artifact.mimeType,
        size: artifact.size ?? 0,
        mtimeMs: artifact.mtimeMs,
        sortAtMs: artifact.mtimeMs ?? 0
      }))
    if (files.length > 0) artifactGroups.push({ sessionId: session.id, files })
  }

  uploadFiles.sort((left, right) => right.sortAtMs - left.sortAtMs)
  return { uploadFiles, artifactGroups }
}

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
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      setProjectFilesFilter: vi.fn()
    } as unknown as typeof useSettingsStore extends { getState: () => infer S } ? S : never)
    projectFilesChangedListener = undefined
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createCachedImageFetchResponse()))
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
      previewResources: {
        acquire: vi.fn(
          ({
            source,
            projectId,
            fileId
          }: {
            source: string
            projectId: string
            fileId: string
          }) => {
            const resourceId = `resource:${source}:${projectId}:${fileId}`
            return Promise.resolve({
              id: resourceId,
              url: `open-science-preview://resource/${encodeURIComponent(resourceId)}`,
              size: 40 * 1024 * 1024,
              mimeType: 'image/png',
              version: 1
            })
          }
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

  const renderView = async (
    sessions: ChatSession[],
    strict = false,
    beforeRender?: () => void
  ): Promise<void> => {
    const { useSessionStore } = await import('@/stores/session-store')
    const { useNavigationStore } = await import('@/stores/navigation-store')
    const { ProjectFilesView } = await import('./ProjectFilesView')

    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions
    })
    const getLibrary = (): ProjectFileFixtures =>
      projectFileFixturesFromSessions(
        useSessionStore.getState().sessions.filter((session) => session.projectId === 'default')
      )

    window.api.projectFiles = {
      searchArtifacts: vi.fn(),
      getOverview: vi.fn(async (request) => {
        const library = getLibrary()
        const query = request.search
          ? foldAsciiCase(request.search.filenameContains.trim())
          : undefined
        const matches = (name: string): boolean => !query || foldAsciiCase(name).includes(query)
        const uploadCount = library.uploadFiles.filter((file) => matches(file.name)).length
        const artifactGroups = library.artifactGroups
          .map((group) => ({ ...group, files: group.files.filter((file) => matches(file.name)) }))
          .filter((group) => group.files.length > 0)
        const artifactCount = artifactGroups.reduce((total, group) => total + group.files.length, 0)

        return {
          totalCount: uploadCount + artifactCount,
          uploadCount,
          artifactCount,
          artifactGroupCount: artifactGroups.length,
          isIndexComplete: true
        }
      }),
      listFiles: vi.fn(async (request) => {
        const library = getLibrary()
        const query = request.search
          ? foldAsciiCase(request.search.filenameContains.trim())
          : undefined
        const matches = (name: string): boolean => !query || foldAsciiCase(name).includes(query)
        const items =
          request.collection.kind === 'uploads'
            ? library.uploadFiles.filter((file) => matches(file.name))
            : (library.artifactGroups
                .find((group) => group.sessionId === request.collection.sessionId)
                ?.files.filter((file) => matches(file.name)) ?? [])

        return { items, totalCount: items.length }
      }),
      resolveFile: vi.fn().mockResolvedValue(undefined),
      listArtifactGroups: vi.fn(async (request) => {
        const groups = getLibrary().artifactGroups
        const query = request.search
          ? foldAsciiCase(request.search.filenameContains.trim())
          : undefined
        const matches = (name: string): boolean => !query || foldAsciiCase(name).includes(query)
        const matchingGroups = groups
          .map((group) => ({ ...group, files: group.files.filter((file) => matches(file.name)) }))
          .filter((group) => group.files.length > 0)
        return {
          items: matchingGroups.map((group) => ({
            sessionId: group.sessionId,
            artifactCount: group.files.length
          })),
          totalCount: matchingGroups.length
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
    beforeRender?.()
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

  it('keeps the files index stable while terminal output streams', async () => {
    await renderView([
      createSession({
        id: 'session-1',
        messages: [createMessage({ id: 'prompt-1', role: 'user' })],
        activeRun: { promptMessageId: 'prompt-1', startedAt: 1710000001000 },
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/result.txt',
            name: 'result.txt'
          }
        ]
      })
    ])
    const { useSessionStore } = await import('@/stores/session-store')
    const getOverview = vi.mocked(window.api.projectFiles.getOverview)
    const listFiles = vi.mocked(window.api.projectFiles.listFiles)
    const listArtifactGroups = vi.mocked(window.api.projectFiles.listArtifactGroups)
    const initialCallCounts = {
      overview: getOverview.mock.calls.length,
      files: listFiles.mock.calls.length,
      groups: listArtifactGroups.mock.calls.length
    }

    await act(async () => {
      useSessionStore.getState().upsertToolActivity({
        sessionId: 'session-1',
        toolCallId: 'terminal-1',
        eventId: 'terminal-output-1',
        title: 'python analysis.py',
        status: 'in_progress',
        terminalOutput: 'processing row 1\n'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect({
      overview: getOverview.mock.calls.length,
      files: listFiles.mock.calls.length,
      groups: listArtifactGroups.mock.calls.length
    }).toEqual(initialCallCounts)
    expect(
      container.querySelector('[aria-label="Preview generated file result.txt"]')
    ).not.toBeNull()
  })

  it('hides archived session artifacts and their filter option', async () => {
    await renderView([
      createSession({
        id: 'session-archived',
        title: 'Archived analysis',
        archivedAt: 2,
        artifacts: [
          {
            id: 'archived-artifact',
            kind: 'managed-file',
            path: '/workspace/archived-result.txt',
            name: 'archived-result.txt'
          }
        ]
      })
    ])

    expect(
      container.querySelector('[aria-label="Preview generated file archived-result.txt"]')
    ).toBeNull()
    expect(window.api.projectFiles.getOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        search: { filenameContains: '', excludedSessionIds: ['session-archived'] }
      })
    )
    await act(async () =>
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    )
    expect(document.body.querySelector('[data-filter-id="session:session-archived"]')).toBeNull()
  })

  it('searches within the selected source and keeps a zero-result session selected', async () => {
    await renderView([
      createSession({
        id: 'session-a',
        title: 'Session A',
        artifacts: [
          {
            id: 'timeline',
            kind: 'managed-file',
            path: '/workspace/timeline.csv',
            name: 'timeline.csv'
          }
        ]
      }),
      createSession({
        id: 'session-b',
        title: 'Session B',
        artifacts: [
          { id: 'notes', kind: 'managed-file', path: '/workspace/notes.txt', name: 'notes.txt' }
        ]
      })
    ])
    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    await act(async () => clickDropdownTrigger(filterButton))
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="session:session-b"]')
        ?.click()
    })

    const search = container.querySelector<HTMLInputElement>('[aria-label="Search project files"]')
    expect(search).not.toBeNull()
    if (!search) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(search, 'timeline')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 300))
      await Promise.resolve()
    })

    expect(filterButton?.textContent).toContain('Session B')
    expect(container.textContent).toContain('No files match “timeline”')
    expect(window.api.projectFiles.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: { kind: 'sessionArtifacts', sessionId: 'session-b' },
        search: { filenameContains: 'timeline' }
      })
    )
  })

  it('mirrors the repository ASCII-only case folding in search results', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'accented-name',
            kind: 'managed-file',
            path: '/workspace/École.txt',
            name: 'École.txt'
          }
        ]
      })
    ])
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search project files"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set

    await act(async () => {
      setter?.call(search, 'école')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 300))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('No files match “école”')
  })

  it('switches between grid and list without refetching project files', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/result.txt',
            name: 'result.txt'
          }
        ]
      })
    ])
    const getOverview = vi.mocked(window.api.projectFiles.getOverview)
    const listFiles = vi.mocked(window.api.projectFiles.listFiles)
    const overviewCalls = getOverview.mock.calls.length
    const fileCalls = listFiles.mock.calls.length

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="List view"]')?.click()
    })

    expect(container.querySelector('[data-view-mode="list"]')).not.toBeNull()
    expect(
      container.querySelector('[aria-label="Preview generated file result.txt"]')
    ).not.toBeNull()
    expect(getOverview).toHaveBeenCalledTimes(overviewCalls)
    expect(listFiles).toHaveBeenCalledTimes(fileCalls)
  })

  it('preserves the file extension when a long list-row name runs out of width', async () => {
    const name = 'very_long_experiment_analysis_result_2025.csv'
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'long-name-artifact',
            kind: 'managed-file',
            path: `/workspace/${name}`,
            name
          }
        ]
      })
    ])

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="List view"]')?.click()
    })

    const row = container.querySelector(`[aria-label="Preview generated file ${name}"]`)
    expect(row?.querySelector('[data-testid="file-name-root"]')).not.toBeNull()
    expect(row?.querySelector('[data-testid="file-name-head"]')?.textContent).toMatch(/^very/)
    expect(row?.querySelector('[data-testid="file-name-tail"]')?.textContent).toBe('_2025')
    expect(row?.querySelector('[data-testid="file-name-extension"]')?.textContent).toBe('.csv')
  })

  it('uses the requested search, list-row, and view-mode interaction styling', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/result.txt',
            name: 'result.txt'
          }
        ]
      })
    ])
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search project files"]')
    const gridControl = container.querySelector<HTMLButtonElement>('[aria-label="Grid view"]')
    const listControl = container.querySelector<HTMLButtonElement>('[aria-label="List view"]')

    expect(search?.className).toContain('h-[30px]')
    expect(search?.className).toContain('border-0')
    expect(search?.className).not.toContain('h-8')
    expect(search?.className).not.toContain('h-7')
    expect(search?.className).not.toContain('focus-visible:ring-0')
    expect(gridControl?.getAttribute('aria-checked')).toBe('true')
    expect(listControl?.getAttribute('aria-checked')).toBe('false')
    expect(gridControl?.className).toContain('hover:bg-muted')
    expect(gridControl?.className).toContain('aria-checked:bg-bg-400')
    expect(gridControl?.className).toContain('aria-checked:hover:bg-bg-400')
    expect(gridControl?.className).toContain('aria-checked:shadow-sm')
    expect(listControl?.className).toContain('aria-checked:bg-bg-400')
    expect(gridControl?.className).not.toContain('aria-checked:bg-accent')

    await act(async () => gridControl?.focus())
    expect(document.body.textContent).toContain('Grid view')
    expect(gridControl?.className).toContain('focus-visible:ring-3')
    expect(listControl?.className).toContain('focus-visible:ring-3')

    await act(async () => listControl?.click())
    expect(gridControl?.getAttribute('aria-checked')).toBe('false')
    expect(listControl?.getAttribute('aria-checked')).toBe('true')
    const listRow = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file result.txt"]'
    )?.parentElement
    expect(listRow?.className).toContain('h-9')
    expect(listRow?.className).toContain('rounded-md')
    expect(listRow?.className).toContain('hover:bg-bg-200')
    expect(listRow?.className).not.toContain('hover:bg-accent')
    expect(listRow?.className).not.toContain('hover:text-accent-foreground')
    const listRowButton = listRow?.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file result.txt"]'
    )
    expect(listRowButton?.className).toContain('focus-visible:outline-none')
    expect(listRowButton?.className).toContain('cursor-pointer')
    expect(listRow?.className).toContain('has-[:focus-visible]:ring-3')
  })

  it('uses matching two-button file actions in grid and list views', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/result.txt',
            name: 'result.txt'
          }
        ]
      })
    ])

    const expectFileActions = (): void => {
      const buttons = [
        container.querySelector<HTMLButtonElement>('[aria-label="Download result.txt"]'),
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Open result.txt in split view beside the session"]'
        )
      ]

      expect(buttons.every(Boolean)).toBe(true)
      expect(buttons.every((button) => button?.dataset.size === 'icon-sm')).toBe(true)
      expect(buttons.every((button) => button?.className.includes('cursor-pointer'))).toBe(true)
      expect(container.querySelector('[aria-label="More actions for result.txt"]')).toBeNull()
      expect(buttons[1]?.parentElement?.className).toContain('flex')
    }

    expectFileActions()
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open result.txt in split view beside the session"]'
        )
        ?.focus()
    })
    expect(document.body.textContent).toContain('Open result.txt in split view beside the session')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="List view"]')?.click()
    })
    expectFileActions()
  })

  it('removes the divider only from the first visible file group', async () => {
    await renderView([
      createSession({
        id: 'session-a',
        title: 'First generated group',
        artifacts: [
          {
            id: 'artifact-a',
            kind: 'managed-file',
            path: '/workspace/a.txt',
            name: 'a.txt'
          }
        ]
      }),
      createSession({
        id: 'session-b',
        title: 'Second generated group',
        artifacts: [
          {
            id: 'artifact-b',
            kind: 'managed-file',
            path: '/workspace/b.txt',
            name: 'b.txt'
          }
        ]
      })
    ])

    const sectionHeaders = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="project-file-section-header"]')
    )

    expect(sectionHeaders).toHaveLength(2)
    expect(sectionHeaders[0]?.className).not.toContain('border-t')
    expect(sectionHeaders[1]?.className).toContain('border-t')
  })

  it('shows the Session artifact count and update age with the default cursor in list view', async () => {
    const now = 1710061200000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await renderView([
      createSession({
        title: 'Recent analysis',
        updatedAt: now,
        artifacts: [
          {
            id: 'artifact-now',
            kind: 'managed-file',
            path: '/workspace/current.txt',
            name: 'current.txt'
          }
        ]
      }),
      createSession({
        id: 'session-older',
        title: 'Earlier analysis',
        updatedAt: now - 15 * 60 * 60 * 1000,
        artifacts: [
          {
            id: 'artifact-older',
            kind: 'managed-file',
            path: '/workspace/earlier.txt',
            name: 'earlier.txt'
          }
        ]
      })
    ])

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="List view"]')?.click()
    })

    const headers = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="project-file-section-header"]')
    )
    const recentHeader = headers.find((header) => header.textContent?.includes('Recent analysis'))
    const earlierHeader = headers.find((header) => header.textContent?.includes('Earlier analysis'))

    expect(recentHeader?.lastElementChild?.textContent).toBe('1 · now')
    expect(earlierHeader?.lastElementChild?.textContent).toBe('1 · 15h ago')
    expect(recentHeader?.className).toContain('cursor-default')
    expect(recentHeader?.getAttribute('aria-expanded')).toBe('true')
  })

  it('replaces compact list metadata with the row action on hover', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1710007202000)
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-meta',
            kind: 'managed-file',
            path: '/workspace/result.txt',
            name: 'result.txt',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="List view"]')?.click()
    })

    const previewButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file result.txt"]'
    )
    const metadata = previewButton?.querySelector('[data-testid="project-file-list-meta"]')
    const downloadWrapper = container
      .querySelector<HTMLButtonElement>('[aria-label="Download result.txt"]')
      ?.closest('[data-testid="download-tooltip-trigger"]')

    expect(metadata?.textContent).toBe('4 KB·2 hours ago')
    expect(metadata?.className).toContain('group-hover:invisible')
    expect(metadata?.className).not.toContain('w-16')
    expect(metadata?.className).not.toContain('w-20')
    expect(downloadWrapper?.parentElement?.className).toContain('absolute')
    expect(downloadWrapper?.parentElement?.className).toContain('right-2')
  })

  it('uses a dark neutral clear button with a light neutral hover surface', async () => {
    await renderView([])

    const search = container.querySelector<HTMLInputElement>('[aria-label="Search project files"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set

    expect(container.querySelector('[aria-label="Clear file search"]')).toBeNull()
    await act(async () => {
      setter?.call(search, 'result')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const clearButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Clear file search"]'
    )
    expect(search?.className).toContain('[&::-webkit-search-cancel-button]:hidden')
    expect(clearButton?.getAttribute('data-slot')).toBe('button')
    expect(clearButton?.getAttribute('data-variant')).toBe('ghost')
    expect(clearButton?.getAttribute('data-size')).toBe('icon-xs')
    expect(clearButton?.className).toContain('text-text-100')
    expect(clearButton?.className).toContain('hover:bg-bg-200')
    expect(clearButton?.className).not.toContain('hover:text-text-000')
    expect(clearButton?.className).toContain('focus-visible:ring-3')
    expect(clearButton?.className).not.toContain('focus-visible:ring-2')

    await act(async () => clearButton?.focus())
    expect(document.body.textContent).toContain('Clear file search')

    await act(async () => clearButton?.click())
    expect(search?.value).toBe('')
    expect(container.querySelector('[aria-label="Clear file search"]')).toBeNull()
  })

  it('does not read thumbnail bytes for files updated while list view is active', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/result.txt',
            name: 'result.txt',
            size: 12,
            mtimeMs: 1710000000000
          }
        ]
      })
    ])
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="List view"]')?.click()
    })
    const readPreview = vi.mocked(window.api.artifacts.readPreview)
    readPreview.mockClear()

    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.setState({
        sessions: [
          createSession({
            artifacts: [
              {
                id: 'artifact-1',
                kind: 'managed-file',
                path: '/workspace/result-v2.txt',
                name: 'result.txt',
                size: 24,
                mtimeMs: 1710000001000
              }
            ]
          })
        ]
      })
      projectFilesChangedListener?.({
        projectId: 'default',
        sessionId: 'session-1',
        sources: ['artifact'],
        kind: 'upsert'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
    })

    const thumbnailReads = readPreview.mock.calls.filter(([request]) => request.maxBytes !== 1)
    expect(thumbnailReads).toHaveLength(0)
  })

  it('keeps the catalog count when selecting a collapsed session after an index refresh', async () => {
    await renderView([
      createSession({
        id: 'session-a',
        title: 'Session A',
        artifacts: [
          {
            id: 'artifact-a',
            kind: 'managed-file',
            path: '/workspace/a.csv',
            name: 'a.csv'
          }
        ]
      })
    ])
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const sessionHeader = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Session A') && button.hasAttribute('aria-expanded')
    )
    await act(async () => sessionHeader?.click())
    expect(sessionHeader?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['artifact'],
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
        .querySelector<HTMLButtonElement>('[data-filter-id="session:session-a"]')
        ?.click()
    })

    const countLabel = container.querySelector<HTMLInputElement>(
      '[aria-label="Search project files"]'
    )?.parentElement?.nextElementSibling
    expect(countLabel?.textContent).toBe('1 file')
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

  it('wraps and announces a long file loading error while keeping retry available', async () => {
    const message =
      'Could not load project files because the remote catalog returned a detailed error that must remain readable on narrow screens.'

    await renderView([], false, () => {
      vi.mocked(window.api.projectFiles.getOverview).mockRejectedValue(new Error(message))
    })

    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(message)
    })

    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    const errorText = alert?.querySelector('span')
    expect(alert?.getAttribute('aria-atomic')).toBe('true')
    expect(errorText?.className).toContain('whitespace-pre-wrap')
    expect(errorText?.className).toContain('break-words')
    expect(errorText?.className).not.toContain('truncate')
    expect(alert?.querySelector<HTMLButtonElement>('button')?.textContent).toBe('Retry')
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
    expect(container.textContent).toContain('iso621_bridge_recombinase.fasta')
    expect(container.querySelector('[title="iso621_bridge_recombinase.fasta"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Hidden session title')
    const tileClassName = container.querySelector('[data-testid="project-file-preview"]')
      ?.parentElement?.parentElement?.className
    const tileButtonClassName = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview uploaded file iso621_bridge_recombinase.fasta"]'
    )?.className
    expect(tileClassName).toContain('has-[:focus-visible]:ring-2')
    expect(tileClassName).not.toContain('focus-within:ring')
    expect(tileButtonClassName).toContain('cursor-pointer')
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
      downloadButton?.closest('[data-testid="download-tooltip-trigger"]')?.parentElement?.className
    ).toContain('absolute')

    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'default',
      fileId: 'upload-1',
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
      projectId: 'default',
      fileId: 'artifact-download',
      suggestedName: 'report.pdf'
    })
  })

  it('uses compact soft-fill manual load controls in the all view', async () => {
    await renderView([createSession({ id: 'session-1', title: 'Session A' })])
    const createFile = (source: ProjectFileItem['source'], index: number): ProjectFileItem => ({
      id: source === 'upload' ? `upload:upload-${index}` : `artifact-${index}`,
      source,
      sourceFileId: `${source}-${index}`,
      sourceVersionId: `${source}-${index}`,
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
      nextCursor: 'groups-next',
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
    const sessionGroupsButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Load more sessions')
    for (const button of [uploadButton, sessionButton, sessionGroupsButton]) {
      expect(button?.getAttribute('data-variant')).toBe('ghost')
      expect(button?.className).toContain('bg-bg-200')
      expect(button?.className).toContain('text-text-100')
      expect(button?.className).toContain('hover:bg-bg-300')
      expect(button?.className).toContain('hover:text-text-000')
    }

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
      sourceVersionId: `${source}-${index}`,
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
      sourceVersionId: `upload-${index}`,
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

  it('advances group headers without loading their artifact pages until each section intersects', async () => {
    const intersections = new Map<string, () => void>()
    const observerOptions = new Map<string, IntersectionObserverInit | undefined>()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly callback: IntersectionObserverCallback
        private readonly options: IntersectionObserverInit | undefined

        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.callback = callback
          this.options = options
        }

        observe = (target: Element): void => {
          const testId = target.getAttribute('data-testid')
          if (!testId) return

          const observer = this as unknown as IntersectionObserver
          intersections.set(testId, () =>
            this.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer)
          )
          observerOptions.set(testId, this.options)
        }
        disconnect = vi.fn()
        unobserve = vi.fn()
        takeRecords = (): IntersectionObserverEntry[] => []
      }
    )
    const sessions = createArtifactSessions(11)
    await renderView(sessions, false, () => {
      vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
        totalCount: 11,
        uploadCount: 0,
        artifactCount: 11,
        artifactGroupCount: 11,
        isIndexComplete: true
      })
      vi.mocked(window.api.projectFiles.listArtifactGroups).mockImplementation(async (request) => ({
        items: (request.cursor ? sessions.slice(10) : sessions.slice(0, 10)).map((session) => ({
          sessionId: session.id,
          artifactCount: 1
        })),
        nextCursor: request.cursor ? undefined : 'groups-page-2',
        totalCount: 11
      }))
      vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => ({
        items:
          request.collection.kind === 'sessionArtifacts'
            ? [
                {
                  id: `artifact:${request.collection.sessionId}`,
                  source: 'artifact',
                  sourceFileId: `artifact:${request.collection.sessionId}`,
                  sourceVersionId: `artifact:${request.collection.sessionId}`,
                  projectId: request.projectId,
                  sessionId: request.collection.sessionId,
                  name: `${request.collection.sessionId}.txt`,
                  path: `managed/${request.collection.sessionId}.txt`,
                  mimeType: 'text/plain',
                  size: 10,
                  sortAtMs: 10
                }
              ]
            : [],
        totalCount: request.collection.kind === 'sessionArtifacts' ? 1 : 0
      }))
    })

    expect(intersections.has('group-page-sentinel')).toBe(true)
    expect(observerOptions.get('group-page-sentinel')).toEqual({ rootMargin: '160px 0px' })
    expect(window.api.projectFiles.listFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({
        collection: { kind: 'sessionArtifacts', sessionId: 'session-11' }
      })
    )

    await act(async () => {
      intersections.get('group-page-sentinel')?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('Session 11')
    expect(intersections.has('artifact-page-sentinel:session-11')).toBe(true)
    expect(observerOptions.get('artifact-page-sentinel:session-11')).toEqual({
      rootMargin: '160px 0px'
    })
    expect(window.api.projectFiles.listFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({
        collection: { kind: 'sessionArtifacts', sessionId: 'session-11' }
      })
    )

    await act(async () => {
      intersections.get('artifact-page-sentinel:session-11')?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(window.api.projectFiles.listFiles).toHaveBeenCalledWith({
      projectId: 'default',
      collection: { kind: 'sessionArtifacts', sessionId: 'session-11' },
      limit: 20
    })
    expect(container.textContent).toContain('session-11.txt')
  })

  it('shows a failed upload page and retries it from the visible error state', async () => {
    const upload = createUpload({
      id: 'retry-upload',
      name: 'retry.txt',
      originalName: 'retry.txt',
      mimeType: 'text/plain'
    })
    await renderView([
      createSession({
        messages: [createMessage({ uploads: [upload] })]
      })
    ])
    const uploadItem: ProjectFileItem = {
      id: 'upload:retry-upload',
      source: 'upload',
      sourceFileId: 'retry-upload',
      sourceVersionId: 'retry-upload',
      projectId: 'default',
      sessionId: 'session-1',
      name: 'retry.txt',
      path: 'managed/retry.txt',
      mimeType: 'text/plain',
      size: 10,
      sortAtMs: 10
    }
    let attempts = 0
    vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => {
      if (request.collection.kind !== 'uploads') return { items: [], totalCount: 0 }

      attempts += 1
      if (attempts === 1) throw new Error('Upload page unavailable')
      return { items: [uploadItem], totalCount: 1 }
    })

    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sessionId: 'session-1',
        sources: ['upload'],
        kind: 'upsert'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('Upload page unavailable')
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Retry'
    )
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(attempts).toBe(2)
    expect(container.textContent).not.toContain('Upload page unavailable')
    expect(container.textContent).toContain('retry.txt')
  })

  it('opens a filter menu with a "this computer" entry', async () => {
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
    // localFs is absent in this environment, so the entry falls back to its default label.
    expect(document.body.textContent).toContain('This computer')
    expect(document.body.querySelector('[data-filter-id="all"] .lucide-boxes')).not.toBeNull()
  })

  it('selects an artifact source from the filter menu with the keyboard', async () => {
    await renderView([
      createSession({
        title: 'Session A',
        messages: [createMessage({ uploads: [createUpload({ originalName: 'keyboard.txt' })] })],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: 'managed/generated.txt',
            name: 'generated.txt',
            mimeType: 'text/plain'
          }
        ]
      })
    ])
    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )

    await act(async () => {
      filterButton?.focus()
      filterButton?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
      )
      await Promise.resolve()
    })

    const uploadsOption = document.body.querySelector<HTMLElement>('[data-filter-id="uploads"]')
    expect(uploadsOption).not.toBeNull()
    await act(async () => {
      uploadsOption?.focus()
      uploadsOption?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(filterButton?.textContent).toContain('Your uploads')
    expect(container.textContent).toContain('keyboard.txt')
    expect(container.textContent).not.toContain('generated.txt')
    expect(filterButton?.getAttribute('aria-expanded')).toBe('false')
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

  it('limits session filters to five and restores that limit after Show fewer', async () => {
    const sessions = createArtifactSessions(9)
    await renderView(sessions)

    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })

    const sessionItems = (): NodeListOf<HTMLElement> =>
      document.body.querySelectorAll('[data-filter-id^="session:"]')
    expect(sessionItems()).toHaveLength(5)

    const showAll = document.body.querySelector<HTMLElement>(
      '[data-testid="session-options-toggle"]'
    )
    expect(showAll?.textContent).toBe('Show all 9 sessions')

    await act(async () => {
      showAll?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sessionItems()).toHaveLength(9)

    const showFewer = document.body.querySelector<HTMLElement>(
      '[data-testid="session-options-toggle"]'
    )
    expect(showFewer?.textContent).toBe('Show fewer')

    await act(async () => {
      showFewer?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sessionItems()).toHaveLength(5)
    expect(document.body.querySelector('[data-testid="session-options-toggle"]')?.textContent).toBe(
      'Show all 9 sessions'
    )
  })

  it('loads every remaining session page after Show all', async () => {
    const sessions = createArtifactSessions(12)
    await renderView(sessions)

    vi.mocked(window.api.projectFiles.listArtifactGroups).mockImplementation(async (request) => ({
      items: (request.cursor ? sessions.slice(10) : sessions.slice(0, 10)).map((session) => ({
        sessionId: session.id,
        artifactCount: 1
      })),
      nextCursor: request.cursor ? undefined : 'page-2',
      totalCount: 12
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
    expect(document.body.querySelectorAll('[data-filter-id^="session:"]')).toHaveLength(5)
    expect(document.body.querySelector('[data-testid="session-options-toggle"]')?.textContent).toBe(
      'Show all 12 sessions'
    )
    const fileRequestCount = vi.mocked(window.api.projectFiles.listFiles).mock.calls.length
    const thumbnailReadCount = vi
      .mocked(window.api.artifacts.readPreview)
      .mock.calls.filter(([request]) => request.maxBytes !== 1).length

    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-testid="session-options-toggle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
    })

    expect(document.body.querySelectorAll('[data-filter-id^="session:"]')).toHaveLength(12)
    expect(document.body.querySelector('[data-filter-id="session:session-12"]')).not.toBeNull()
    expect(window.api.projectFiles.listFiles).toHaveBeenCalledTimes(fileRequestCount)
    expect(
      vi
        .mocked(window.api.artifacts.readPreview)
        .mock.calls.filter(([request]) => request.maxBytes !== 1)
    ).toHaveLength(thumbnailReadCount)
  })

  it('offers a retry when loading every session option fails', async () => {
    const sessions = createArtifactSessions(12)
    await renderView(sessions)

    let continuationAttempts = 0
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockImplementation(async (request) => {
      if (!request.cursor) {
        return {
          items: sessions.slice(0, 10).map((session) => ({
            sessionId: session.id,
            artifactCount: 1
          })),
          nextCursor: 'page-2',
          totalCount: 12
        }
      }
      continuationAttempts += 1
      if (continuationAttempts === 1) throw new Error('database busy')
      return {
        items: sessions.slice(10).map((session) => ({
          sessionId: session.id,
          artifactCount: 1
        })),
        totalCount: 12
      }
    })
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
        .querySelector<HTMLElement>('[data-testid="session-options-toggle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const retry = document.body.querySelector<HTMLElement>('[data-testid="session-options-retry"]')
    expect(retry?.textContent).toBe('Retry loading sessions')

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(continuationAttempts).toBe(2)
    expect(document.body.querySelectorAll('[data-filter-id^="session:"]')).toHaveLength(12)
  })

  it('keeps the selected session visible after Show fewer', async () => {
    const sessions = createArtifactSessions(9)
    await renderView(sessions)

    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })
    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-testid="session-options-toggle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(
          '[data-slot="dropdown-menu-content"][data-state="open"] [data-filter-id="session:session-9"]'
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    if (filterButton?.getAttribute('aria-expanded') !== 'true') {
      await act(async () => {
        clickDropdownTrigger(filterButton)
      })
    }
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(
          '[data-slot="dropdown-menu-content"][data-state="open"] [data-testid="session-options-toggle"]'
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const openMenu = document.body.querySelector(
      '[data-slot="dropdown-menu-content"][data-state="open"]'
    )
    expect(openMenu?.querySelectorAll('[data-filter-id^="session:"]')).toHaveLength(5)
    expect(
      openMenu?.querySelector('[data-filter-id="session:session-9"]')?.getAttribute('aria-checked')
    ).toBe('true')
  })

  it('refreshes a collapsed selected session outside the catalog group page', async () => {
    const sessions = createArtifactSessions(12)
    await renderView(sessions)
    let selectedSessionCount = 1
    let selectedOriginState: 'active' | 'deleting' = 'active'
    const catalogListener = vi.mocked(window.api.projectFiles.onChanged).mock.calls[0]?.[0]

    vi.mocked(window.api.projectFiles.listArtifactGroups).mockImplementation(async (request) => ({
      items: (request.cursor ? sessions.slice(10) : sessions.slice(0, 10)).map((session) => ({
        sessionId: session.id,
        artifactCount: session.id === 'session-12' ? selectedSessionCount : 1
      })),
      nextCursor: request.cursor ? undefined : 'page-2',
      totalCount: 12
    }))
    vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => {
      if (
        request.collection.kind !== 'sessionArtifacts' ||
        request.collection.sessionId !== 'session-12'
      ) {
        return { items: [], totalCount: 0 }
      }

      return {
        items: Array.from({ length: selectedSessionCount }, (_, index) => ({
          id: `artifact-12-${index}`,
          source: 'artifact' as const,
          sourceFileId: `artifact-12-${index}`,
          sourceVersionId: `artifact-12-${index}`,
          projectId: 'default',
          sessionId: 'session-12',
          name: `file-12-${index}.txt`,
          path: `/workspace/file-12-${index}.txt`,
          size: 1,
          sortAtMs: 12 - index,
          originSession: { state: selectedOriginState, title: 'Session 12' }
        })),
        totalCount: selectedSessionCount
      }
    })
    await act(async () => {
      catalogListener?.({
        projectId: 'default',
        sources: ['artifact'],
        kind: 'reset'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
    })

    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })
    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-testid="session-options-toggle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-filter-id="session:session-12"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const selectedHeader = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="project-file-section-header"]')
    ).find((button) => button.textContent?.includes('Session 12'))
    await act(async () => selectedHeader?.click())
    expect(selectedHeader?.getAttribute('aria-expanded')).toBe('false')

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    if (filterButton?.getAttribute('aria-expanded') !== 'true') {
      await act(async () => clickDropdownTrigger(filterButton))
    }
    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-testid="session-options-toggle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    selectedSessionCount = 2
    selectedOriginState = 'deleting'
    await act(async () => {
      catalogListener?.({
        projectId: 'default',
        sources: ['artifact'],
        kind: 'reset'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const countLabel = container.querySelector<HTMLInputElement>(
      '[aria-label="Search project files"]'
    )?.parentElement?.nextElementSibling
    expect(countLabel?.textContent).toBe('2 files')
    expect(filterButton?.textContent).toContain('Session 12 · Source session is being deleted')
  })

  it.each([
    {
      state: 'deleted' as const,
      expectedTitle: 'Retained analysis · Source session deleted'
    },
    {
      state: 'deleting' as const,
      expectedTitle: 'Retained analysis · Source session is being deleted'
    }
  ])('preserves a $state source session title in a scoped search group', async (testCase) => {
    await renderView([])
    const catalogListener = vi.mocked(window.api.projectFiles.onChanged).mock.calls[0]?.[0]
    const originSession = {
      state: testCase.state,
      title: 'Retained analysis',
      ...(testCase.state === 'deleted' ? { deletedAt: '2026-07-27T12:00:00.000Z' } : {})
    }
    const sessionId = `${testCase.state}-session`
    const retainedFile: ProjectFileItem = {
      id: 'retained-artifact',
      source: 'artifact',
      sourceFileId: 'retained-artifact',
      sourceVersionId: 'retained-artifact',
      projectId: 'default',
      sessionId,
      name: 'result.csv',
      path: `artifact-version:default/${sessionId}/retained-artifact/version-1`,
      size: 12,
      sortAtMs: 1,
      originSession
    }

    vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
      totalCount: 1,
      uploadCount: 0,
      artifactCount: 1,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockResolvedValue({
      items: [{ sessionId, artifactCount: 1, originSession }],
      totalCount: 1
    })
    vi.mocked(window.api.projectFiles.listFiles).mockResolvedValue({
      items: [retainedFile],
      totalCount: 1
    })
    await act(async () => {
      catalogListener?.({
        projectId: 'default',
        sources: ['artifact'],
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
        .querySelector<HTMLElement>(`[data-filter-id="session:${sessionId}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const search = container.querySelector<HTMLInputElement>('[aria-label="Search project files"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(search, 'result')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 300))
      await Promise.resolve()
    })

    const selectedHeader = container.querySelector<HTMLButtonElement>(
      '[data-testid="project-file-section-header"]'
    )
    expect(selectedHeader).not.toBeNull()
    expect(selectedHeader?.textContent).toContain(testCase.expectedTitle)
  })

  it('keeps filtered content and trigger icon synchronized with the selected category', async () => {
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

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    const openFilterMenu = async (): Promise<void> => {
      await act(async () => {
        clickDropdownTrigger(filterButton)
      })
    }

    expect(filterButton?.querySelector('.lucide-boxes')).not.toBeNull()

    await openFilterMenu()
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="uploads"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('user upload.png')
    expect(filterButton?.querySelector('.lucide-paperclip')).not.toBeNull()
    expect(container.textContent).not.toContain('a.png')
    expect(container.textContent).not.toContain('Session B')

    await openFilterMenu()
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="session:session-b"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Session B')
    expect(filterButton?.querySelector('.lucide-folder')).not.toBeNull()
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
        .querySelector<HTMLElement>('[data-testid="session-options-toggle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

  it('returns to All when the selected session loses its final artifact', async () => {
    await renderView([
      createSession({
        messages: [createMessage({ role: 'agent', artifactIds: ['artifact-1'] })],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/result.png',
            fileUrl: 'file:///workspace/result.png',
            name: 'result.png',
            mimeType: 'image/png',
            size: 1024,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    await act(async () => {
      clickDropdownTrigger(
        container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')
      )
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="session:session-1"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('result.png')

    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.getState().replaceMessageArtifacts({
        sessionId: 'session-1',
        messageId: 'message-1',
        artifacts: []
      })
      projectFilesChangedListener?.({
        projectId: 'default',
        sessionId: 'session-1',
        sources: ['artifact'],
        kind: 'upsert'
      })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')?.textContent
    ).toContain('Artifacts')
    expect(container.textContent).not.toContain('Analysis session')
    expect(container.textContent).toContain('No files yet')
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
                sourceVersionId: 'orphan-artifact',
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

  it('clears an unhydrated session filter after reset confirms its index rows are gone', async () => {
    await renderView([])
    let hasOrphanGroup = true
    const orphanFile: ProjectFileItem = {
      id: 'orphan-artifact',
      source: 'artifact',
      sourceFileId: 'orphan-artifact',
      sourceVersionId: 'orphan-artifact',
      projectId: 'default',
      sessionId: 'orphan-session',
      name: 'orphan.txt',
      path: '/artifacts/orphan.txt',
      size: 10,
      sortAtMs: 10
    }
    vi.mocked(window.api.projectFiles.getOverview).mockImplementation(async () => ({
      totalCount: hasOrphanGroup ? 1 : 0,
      uploadCount: 0,
      artifactCount: hasOrphanGroup ? 1 : 0,
      artifactGroupCount: hasOrphanGroup ? 1 : 0,
      isIndexComplete: true
    }))
    vi.mocked(window.api.projectFiles.listArtifactGroups).mockImplementation(async () => ({
      items: hasOrphanGroup ? [{ sessionId: 'orphan-session', artifactCount: 1 }] : [],
      totalCount: hasOrphanGroup ? 1 : 0
    }))
    vi.mocked(window.api.projectFiles.listFiles).mockImplementation(async (request) => ({
      items: hasOrphanGroup && request.collection.kind === 'sessionArtifacts' ? [orphanFile] : [],
      totalCount: hasOrphanGroup && request.collection.kind === 'sessionArtifacts' ? 1 : 0
    }))

    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['artifact'],
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
        .querySelector<HTMLButtonElement>('[data-filter-id="session:orphan-session"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.textContent).toContain('orphan.txt')

    hasOrphanGroup = false
    await act(async () => {
      projectFilesChangedListener?.({
        projectId: 'default',
        sources: ['artifact'],
        kind: 'reset'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')?.textContent
    ).toContain('Artifacts')
    expect(container.textContent).not.toContain('Session orphan-s')
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

  it('preserves queued dialogs and clears only the one owned by the unmounting Files surface', async () => {
    const otherProjectFile: PreviewFileItem = {
      id: 'other-artifact',
      type: 'file',
      source: 'artifact',
      projectId: 'other-project',
      sessionId: 'other-session',
      title: 'other.png',
      name: 'other.png',
      path: '/workspace/other.png',
      format: 'image',
      mimeType: 'image/png',
      size: 1024
    }
    const currentProjectFile = { ...otherProjectFile, projectId: 'default' }

    await renderView([], true, () => {
      usePreviewWorkbenchStore.getState().openFileDialog(currentProjectFile)
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toEqual(currentProjectFile)

    await act(async () => {
      usePreviewWorkbenchStore.getState().openFileDialog(otherProjectFile)
    })

    const { useNavigationStore } = await import('@/stores/navigation-store')
    await act(async () => {
      useNavigationStore.setState({ activeProjectId: 'other-project' })
      await Promise.resolve()
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toEqual(otherProjectFile)

    await act(async () => {
      root.render(<div />)
      await Promise.resolve()
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
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
      sourceVersionId: 'new-upload',
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
    expect(generatedMeta?.querySelector('[data-testid="file-name-extension"]')?.textContent).toBe(
      '.png'
    )
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
      projectId: 'default',
      fileId: 'artifact-1',
      mimeType: 'image/png'
    })
    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'default',
      fileId: 'upload-1',
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
    await waitFor(() => {
      expect(
        container.querySelector('img[alt="Preview of typhoon_tracks.png"]')?.getAttribute('src')
      ).toMatch(/^blob:/)
      expect(
        container.querySelector('img[alt="Preview of uploaded_image.png"]')?.getAttribute('src')
      ).toMatch(/^blob:/)
    })
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
      resourceId: 'resource:artifact:default:artifact-1'
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
      projectId: 'default',
      fileId: 'artifact-1',
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
      resourceId: 'resource:artifact:default:artifact-1'
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
      projectId: 'default',
      sessionId: 'session-1',
      fileId: 'artifact-csv',
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
      sourceVersionId: `upload-${index}`,
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
    await waitFor(() => {
      expect(container.querySelectorAll('img[alt^="Preview of upload-"]')).toHaveLength(
        uploads.length
      )
    })
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
      expect.objectContaining({
        path: '/workspace/generated.treefile',
        fileId: 'artifact-tree',
        encoding: 'utf8'
      })
    )
    expect(window.api.uploads.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/uploads/uploaded.treefile',
        fileId: expect.any(String),
        encoding: 'utf8'
      })
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

    await vi.waitFor(() => expect(projectFilesChangedListener).toBeTypeOf('function'))
    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.getState().replaceMessageUploads({
        sessionId: 'session-1',
        messageId: 'message-1',
        uploads: [
          createUpload({
            versionId: 'upload-version-1',
            versionNumber: 1,
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
    await vi.waitFor(() =>
      expect(window.api.uploads.readPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'upload-version:default/session-1/upload-1/upload-version-1',
          encoding: 'utf8'
        })
      )
    )
    expect(container.textContent).toContain('1 rows · 2 columns')
  })

  it('reads a project upload preview with the source Session encoded by its Version locator', async () => {
    const sourceSessionId = 'source-session'
    const versionId = 'upload-version-cross-session'
    const path = createUploadVersionReference(versionId, {
      projectId: 'default',
      sessionId: sourceSessionId,
      fileId: 'upload-cross-session'
    })
    await renderView([
      createSession({
        id: 'current-session',
        messages: [
          createMessage({
            uploads: [
              createUpload({
                id: 'upload-cross-session',
                versionId,
                sessionId: sourceSessionId,
                path: undefined,
                name: 'cross-session.csv',
                originalName: 'cross-session.csv',
                mimeType: 'text/csv'
              })
            ]
          })
        ]
      })
    ])

    await vi.waitFor(() => {
      const thumbnailRequest = vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.map(([request]) => request)
        .find((request) => request.maxBytes !== 1)
      expect(thumbnailRequest).toMatchObject({
        path,
        projectId: 'default',
        sessionId: sourceSessionId
      })
    })
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

    await vi.waitFor(() => expect(projectFilesChangedListener).toBeTypeOf('function'))
    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.getState().replaceMessageUploads({
        sessionId: 'session-1',
        messageId: 'message-1',
        uploads: [
          createUpload({
            versionId: 'upload-version-1',
            versionNumber: 1,
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

    await vi.waitFor(() =>
      expect(window.api.uploads.readPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'upload-version:default/session-1/upload-1/upload-version-1',
          encoding: 'utf8'
        })
      )
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

    expect(container.textContent).toContain('denovo_design_worklist.csv')
    expect(container.querySelector('[data-testid="file-name-extension"]')?.textContent).toBe('.csv')
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

  it('queues an uploaded file dialog without adding a workbench tab', async () => {
    await renderView([
      createSession({
        id: 'session-1',
        messages: [
          createMessage({
            id: 'message-1',
            uploads: [createUpload()]
          })
        ]
      })
    ])

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Preview uploaded file user upload.png"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      projectId: 'default',
      sessionId: 'session-1',
      source: 'upload',
      name: 'user upload.png'
    })
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])

    await act(async () => {
      usePreviewWorkbenchStore.getState().closeFileDialog()
    })

    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
    expect(container.querySelector('[data-testid="files-view"]')).not.toBeNull()
  })

  it('queues a generated file dialog without adding a workbench tab', async () => {
    await renderView([
      createSession({
        id: 'session-1',
        title: 'Generated session',
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

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Preview generated file tree.png"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      projectId: 'default',
      sessionId: 'session-1',
      name: 'tree.png'
    })
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })

  it('opens a generated file directly in the preview panel', async () => {
    await renderView([
      createSession({
        id: 'session-1',
        title: 'Generated session',
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

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open tree.png in split view beside the session"]'
        )
        ?.click()
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: expect.any(String),
      panelState: 'open',
      fileDialogItem: undefined
    })
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      projectId: 'default',
      sessionId: 'session-1',
      name: 'tree.png'
    })
  })

  it('does not acquire a TIFF thumbnail until its grid tile is near the viewport', async () => {
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
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-tiff',
            kind: 'managed-file',
            path: '/workspace/chart.tiff',
            fileUrl: 'file:///workspace/chart.tiff',
            name: 'chart.tiff',
            mimeType: 'image/tiff',
            size: 152,
            mtimeMs: 1710000002000
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
    const tile = container.querySelector('[aria-label="Preview generated file chart.tiff"]')
    expect(tile).not.toBeNull()
    expect(window.api.previewResources.acquire).not.toHaveBeenCalled()

    await act(async () => {
      observed.get(tile as Element)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })

    await vi.waitFor(() =>
      expect(window.api.previewResources.acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'artifact',
          projectId: 'default',
          fileId: 'artifact-tiff'
        })
      )
    )
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

const createHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('ProjectFilesView — Remote section in source dropdown', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useComputeStore.setState({ ...createInitialComputeState(), isLoaded: true })
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      openSettings: vi.fn(),
      openSettingsToCompute: vi.fn(),
      setProjectFilesFilter: vi.fn()
    } as unknown as typeof useSettingsStore extends { getState: () => infer S } ? S : never)
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'resource:test',
          url: 'open-science-preview://resource/test',
          size: 100,
          mimeType: 'text/plain',
          version: 1
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      },
      artifacts: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'dGVzdA==',
          encoding: 'base64',
          size: 4,
          truncated: false
        })
      },
      uploads: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'dGVzdA==',
          encoding: 'base64',
          size: 4,
          truncated: false
        })
      },
      compute: {
        listDir: vi.fn().mockResolvedValue({
          entries: [],
          truncated: false,
          roots: { home: '/home/user' },
          resolvedPath: '/home/user'
        }),
        bookmarksGet: vi.fn().mockResolvedValue([]),
        bookmarksSet: vi.fn().mockResolvedValue(undefined)
      },
      localFs: {
        getRoots: vi.fn().mockResolvedValue({ home: '/Users/roxi', machineName: 'TychoStation' }),
        listDrives: vi.fn(async () => []),
        listDir: vi.fn().mockResolvedValue({
          entries: [
            { name: 'Projects', isDirectory: true, size: 0, mtimeMs: 1710000000000 },
            { name: 'notes.md', isDirectory: false, size: 2048, mtimeMs: 1710000001000 }
          ],
          resolvedPath: '/Users/roxi',
          truncated: false
        })
      },
      projectFiles: {
        getOverview: vi.fn().mockResolvedValue({
          totalCount: 0,
          uploadCount: 0,
          artifactCount: 0,
          artifactGroupCount: 0,
          isIndexComplete: true
        }),
        listFiles: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
        listArtifactGroups: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
        repairIndex: vi.fn().mockResolvedValue(undefined),
        onChanged: vi.fn(() => vi.fn())
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

  const renderFilesView = async (): Promise<void> => {
    const { useSessionStore } = await import('@/stores/session-store')
    const { useNavigationStore } = await import('@/stores/navigation-store')
    const { createInitialSessionState } = await import('@/stores/session-store')
    const { ProjectFilesView } = await import('./ProjectFilesView')

    useSessionStore.setState({ ...createInitialSessionState(), sessions: [] })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'default' })
    root = createRoot(container)
    await act(async () => {
      root.render(<ProjectFilesView />)
    })
  }

  it('shows the Remote section label in source dropdown when hosts are present', async () => {
    useComputeStore.setState({
      ...createInitialComputeState(),
      isLoaded: true,
      hosts: [
        createHost({
          probeResult: { ok: true, probedAt: '2024-01-01', exitCode: 0, errorTail: null }
        })
      ]
    })

    await renderFilesView()

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    await act(async () => {
      filterButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('Remote')
    expect(document.body.textContent).toContain('biowulf')
  })

  it('swaps the artifacts list for the local browser when the device is picked', async () => {
    await renderFilesView()

    // Starts on the artifacts container, labelled with the resolved device name in the dropdown.
    expect(container.querySelector('[data-testid="project-files-scroll"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Local file browser"]')).toBeNull()

    const openMenu = async (): Promise<void> => {
      const filterButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Filter project files"]'
      )
      await act(async () => {
        filterButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
        filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }

    await openMenu()
    const deviceItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    ).find((el) => el.textContent?.includes('TychoStation'))
    await act(async () => {
      deviceItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The local browser replaces the artifacts list inside the same Files tab.
    expect(container.querySelector('[aria-label="Local file browser"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="project-files-scroll"]')).toBeNull()
    expect(window.api.localFs.listDir).toHaveBeenCalledWith('/Users/roxi')
    expect(container.textContent).toContain('Projects')
    expect(container.textContent).toContain('notes.md')
    // Header count follows the visible container.
    expect(container.textContent).toContain('2 files')

    // Picking an artifact scope returns the body to the artifacts list.
    await openMenu()
    const allArtifacts = document.querySelector<HTMLElement>('[data-filter-id="all"]')
    await act(async () => {
      allArtifacts?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('[data-testid="project-files-scroll"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Local file browser"]')).toBeNull()
  })

  it('closes the local browser Go-to menu on an outside click', async () => {
    await renderFilesView()

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    await act(async () => {
      filterButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const deviceItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    ).find((el) => el.textContent?.includes('TychoStation'))
    await act(async () => {
      deviceItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const goTo = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((el) =>
      el.textContent?.includes('Go to')
    )
    await act(async () => {
      goTo?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      goTo?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Home')

    // Radix dismisses on pointerdown-then-click outside the content.
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('only re-lists the directory when the address bar path actually changes', async () => {
    await renderFilesView()

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    await act(async () => {
      filterButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const deviceItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    ).find((el) => el.textContent?.includes('TychoStation'))
    await act(async () => {
      deviceItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const listDir = window.api.localFs.listDir as ReturnType<typeof vi.fn>
    const callsAfterLanding = listDir.mock.calls.length
    const address = container.querySelector<HTMLInputElement>('[aria-label="Directory path"]')
    expect(address?.value).toBe('/Users/roxi')

    // React tracks the value setter, so drive it natively to make onChange fire.
    const typePath = async (next: string): Promise<void> => {
      await act(async () => {
        if (!address) return
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )?.set?.bind(address)
        setter?.(next)
        address.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    // Blurring an untouched path, and a no-op edit (trailing slash), both skip the listing call.
    await act(async () => {
      address?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(listDir.mock.calls.length).toBe(callsAfterLanding)

    await typePath('/Users/roxi/')
    await act(async () => {
      address?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(listDir.mock.calls.length).toBe(callsAfterLanding)
    // The field snaps back to the canonical path rather than keeping the equivalent spelling.
    expect(address?.value).toBe('/Users/roxi')

    // A genuinely different path does re-read.
    listDir.mockResolvedValueOnce({
      entries: [],
      resolvedPath: '/Users/roxi/Projects',
      truncated: false
    })
    await typePath('/Users/roxi/Projects')
    await act(async () => {
      address?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(listDir).toHaveBeenLastCalledWith('/Users/roxi/Projects')
    expect(listDir.mock.calls.length).toBe(callsAfterLanding + 1)
  })

  it('opens the Remote browser for an unprobed host', async () => {
    useComputeStore.setState({
      ...createInitialComputeState(),
      isLoaded: true,
      hosts: [createHost()]
    })

    await renderFilesView()

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    await act(async () => {
      filterButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const remoteHost = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((element) => element.textContent?.includes('biowulf'))
    expect(remoteHost?.hasAttribute('data-disabled')).toBe(false)
    expect(remoteHost?.textContent).toContain('Not probed')

    await act(async () => {
      remoteHost?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(document.querySelector('[aria-label="Remote file browser"]')).not.toBeNull()
    expect(window.api.compute.listDir).toHaveBeenCalledWith('ssh:biowulf', '~')
  })

  it('shows Add SSH host link that calls openSettingsToCompute', async () => {
    useComputeStore.setState({
      ...createInitialComputeState(),
      isLoaded: true,
      hosts: []
    })
    const openSettingsToCompute = vi.fn()
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      openSettings: vi.fn(),
      openSettingsToCompute
    } as unknown as typeof useSettingsStore extends { getState: () => infer S } ? S : never)

    await renderFilesView()

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    await act(async () => {
      filterButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('Add SSH host')

    const addButton = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes('Add SSH host')
    ) as HTMLElement | undefined

    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(openSettingsToCompute).toHaveBeenCalled()
  })
})

describe('ProjectFilesView — granted local folders', () => {
  let container: HTMLDivElement
  let root: Root
  let listDir: ReturnType<typeof vi.fn>
  let grantRoot: ReturnType<typeof vi.fn>
  let setGrantedRootAccess: ReturnType<typeof vi.fn>
  let removeGrantedRoot: ReturnType<typeof vi.fn>
  let setProjectFilesFilter: ReturnType<typeof vi.fn>

  const grantedRoot = {
    id: 'root-1',
    path: '/Users/roxi/Projects',
    name: 'Projects',
    access: 'ro' as const
  }

  beforeEach(() => {
    setProjectFilesFilter = vi.fn()
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useComputeStore.setState({ ...createInitialComputeState(), isLoaded: true })
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      openSettings: vi.fn(),
      openSettingsToCompute: vi.fn(),
      setProjectFilesFilter
    } as unknown as typeof useSettingsStore extends { getState: () => infer S } ? S : never)
    useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
    container = document.createElement('div')
    document.body.appendChild(container)
    listDir = vi.fn(async (path: string) => ({
      entries:
        path === '/Users/roxi'
          ? [
              { name: 'Projects', isDirectory: true, size: 0, mtimeMs: 1710000000000 },
              { name: 'notes.md', isDirectory: false, size: 2048, mtimeMs: 1710000001000 }
            ]
          : [],
      resolvedPath: path,
      truncated: false
    }))
    grantRoot = vi.fn().mockResolvedValue([grantedRoot])
    setGrantedRootAccess = vi.fn().mockResolvedValue([{ ...grantedRoot, access: 'rw' }])
    removeGrantedRoot = vi.fn().mockResolvedValue([])
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'resource:test',
          url: 'open-science-preview://resource/test',
          size: 100,
          mimeType: 'text/plain',
          version: 1
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      },
      artifacts: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'dGVzdA==',
          encoding: 'base64',
          size: 4,
          truncated: false
        })
      },
      uploads: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'dGVzdA==',
          encoding: 'base64',
          size: 4,
          truncated: false
        })
      },
      compute: {
        bookmarksGet: vi.fn().mockResolvedValue([]),
        bookmarksSet: vi.fn().mockResolvedValue(undefined)
      },
      localFs: {
        getRoots: vi.fn().mockResolvedValue({ home: '/Users/roxi', machineName: 'TychoStation' }),
        listDrives: vi.fn(async () => []),
        listDir,
        listGrantedRoots: vi.fn().mockResolvedValue([grantedRoot]),
        grantRoot,
        setGrantedRootAccess,
        removeGrantedRoot
      },
      projectFiles: {
        getOverview: vi.fn().mockResolvedValue({
          totalCount: 0,
          uploadCount: 0,
          artifactCount: 0,
          artifactGroupCount: 0,
          isIndexComplete: true
        }),
        listFiles: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
        listArtifactGroups: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
        repairIndex: vi.fn().mockResolvedValue(undefined),
        onChanged: vi.fn(() => vi.fn())
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

  const renderFilesView = async (): Promise<void> => {
    const { useSessionStore } = await import('@/stores/session-store')
    const { useNavigationStore } = await import('@/stores/navigation-store')
    const { createInitialSessionState } = await import('@/stores/session-store')
    const { ProjectFilesView } = await import('./ProjectFilesView')

    useSessionStore.setState({ ...createInitialSessionState(), sessions: [] })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'default' })
    root = createRoot(container)
    await act(async () => {
      root.render(<ProjectFilesView />)
      await flushEffects()
    })
  }

  // Lets in-flight API mock resolutions (roots fetch, granted-roots refresh) settle inside act.
  const flushEffects = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  }

  const openFilterMenu = async (): Promise<void> => {
    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )
    await act(async () => {
      filterButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })
  }

  const clickElement = async (element: Element | null | undefined): Promise<void> => {
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushEffects()
    })
  }

  const rootMutationConfirmation = (): Element | null =>
    document.body.querySelector('[data-testid="granted-root-mutation-confirmation"]')

  const confirmRootMutation = async (): Promise<void> => {
    await clickElement(rootMutationConfirmation()?.querySelector('button:last-of-type'))
  }

  const cancelRootMutation = async (): Promise<void> => {
    await clickElement(rootMutationConfirmation()?.querySelector('button:first-of-type'))
  }

  // Radix's submenu trigger opens on pointermove only when pointerType is 'mouse' (whenMouse
  // guard); jsdom has no PointerEvent, so forge one from a MouseEvent.
  const hoverElement = async (element: Element | null | undefined): Promise<void> => {
    await act(async () => {
      const event = new MouseEvent('pointermove', { bubbles: true })
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      element?.dispatchEvent(event)
      await flushEffects()
    })
  }

  it('renders granted roots with an access badge and an enabled Add folder item', async () => {
    await renderFilesView()
    await openFilterMenu()

    const row = document.body.querySelector('[data-testid="granted-root-root-1"]')
    expect(row?.textContent).toContain('Projects')
    expect(row?.textContent).toContain('/Users/roxi/Projects')
    expect(row?.textContent).toContain('ro')

    const addItem = document.body.querySelector('[data-testid="add-local-folder"]')
    expect(addItem?.textContent).toContain('Add folder…')
    expect(addItem?.getAttribute('data-disabled')).toBeNull()
    expect(document.body.textContent).not.toContain('Soon')
  })

  it('offers Allow writes and Remove access in the manage submenu', async () => {
    await renderFilesView()
    await openFilterMenu()

    // The row itself is the trigger: hovering it opens the manage submenu.
    const row = document.body.querySelector('[data-testid="granted-root-root-1"]')
    await hoverElement(row)
    await vi.waitFor(
      () => {
        expect(document.body.textContent).toContain('Allow writes')
      },
      { timeout: 1000 }
    )
    expect(document.body.textContent).toContain('Remove access')

    await clickElement(
      document.body.querySelector('[data-testid="granted-root-allow-writes-root-1"]')
    )
    expect(rootMutationConfirmation()?.textContent).toContain(
      'Changing Notebook file access will stop active Notebook kernels.'
    )
    await confirmRootMutation()
    expect(setGrantedRootAccess).toHaveBeenCalledWith({ id: 'root-1', access: 'rw' })
    expect(useGrantedFoldersStore.getState().roots[0]?.access).toBe('rw')

    // The toggle flips to "Make read-only" once the root is rw.
    await openFilterMenu()
    const rowAgain = document.body.querySelector('[data-testid="granted-root-root-1"]')
    await hoverElement(rowAgain)
    await vi.waitFor(
      () => {
        expect(document.body.textContent).toContain('Make read-only')
      },
      { timeout: 1000 }
    )

    await clickElement(document.body.querySelector('[data-testid="granted-root-remove-root-1"]'))
    await confirmRootMutation()
    expect(removeGrantedRoot).toHaveBeenCalledWith({ id: 'root-1' })
    expect(useGrantedFoldersStore.getState().roots).toEqual([])
  })

  it('keeps granted-root access unchanged when the kernel-stop confirmation is cancelled', async () => {
    await renderFilesView()
    await openFilterMenu()
    await hoverElement(document.body.querySelector('[data-testid="granted-root-root-1"]'))

    await vi.waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="granted-root-allow-writes-root-1"]')
      ).not.toBeNull()
    })
    await clickElement(
      document.body.querySelector('[data-testid="granted-root-allow-writes-root-1"]')
    )
    await cancelRootMutation()

    expect(setGrantedRootAccess).not.toHaveBeenCalled()
    expect(useGrantedFoldersStore.getState().roots[0]?.access).toBe('ro')
  })

  it('shows the failed access change and retries it from the toast', async () => {
    setGrantedRootAccess.mockRejectedValueOnce({ message: 'database unavailable' })
    await renderFilesView()
    await openFilterMenu()
    await hoverElement(document.body.querySelector('[data-testid="granted-root-root-1"]'))

    await waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="granted-root-allow-writes-root-1"]')
      ).not.toBeNull()
    })
    await clickElement(
      document.body.querySelector('[data-testid="granted-root-allow-writes-root-1"]')
    )
    await confirmRootMutation()
    expect(setGrantedRootAccess).toHaveBeenCalledWith({ id: 'root-1', access: 'rw' })

    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="granted-root-error-toast"]')).not.toBeNull()
    })
    const toast = document.body.querySelector('[data-testid="granted-root-error-toast"]')
    expect(toast?.textContent).toContain('Could not change folder access.')
    expect(toast?.textContent).toContain('database unavailable')
    expect(useGrantedFoldersStore.getState().roots[0]?.access).toBe('ro')

    await clickElement(
      Array.from(toast?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent === 'Retry'
      )
    )

    expect(setGrantedRootAccess).toHaveBeenCalledTimes(2)
    expect(useGrantedFoldersStore.getState().roots[0]?.access).toBe('rw')
    expect(document.body.querySelector('[data-testid="granted-root-error-toast"]')).toBeNull()
  })

  it('shows the failed access removal and retries it from the toast', async () => {
    removeGrantedRoot.mockRejectedValueOnce(new Error('database unavailable'))
    await renderFilesView()
    await openFilterMenu()
    await hoverElement(document.body.querySelector('[data-testid="granted-root-root-1"]'))

    await waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="granted-root-remove-root-1"]')
      ).not.toBeNull()
    })
    await clickElement(document.body.querySelector('[data-testid="granted-root-remove-root-1"]'))
    await confirmRootMutation()
    expect(removeGrantedRoot).toHaveBeenCalledWith({ id: 'root-1' })

    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="granted-root-error-toast"]')).not.toBeNull()
    })
    const toast = document.body.querySelector('[data-testid="granted-root-error-toast"]')
    expect(toast?.textContent).toContain('Could not remove folder access.')
    expect(toast?.textContent).toContain('database unavailable')
    expect(useGrantedFoldersStore.getState().roots).toEqual([grantedRoot])

    await clickElement(
      Array.from(toast?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent === 'Retry'
      )
    )

    expect(removeGrantedRoot).toHaveBeenCalledTimes(2)
    expect(useGrantedFoldersStore.getState().roots).toEqual([])
    expect(document.body.querySelector('[data-testid="granted-root-error-toast"]')).toBeNull()
  })

  it('opens the manage submenu when the row itself is hovered', async () => {
    await renderFilesView()
    await openFilterMenu()

    const row = document.body.querySelector('[data-testid="granted-root-root-1"]')
    await hoverElement(row)

    // The submenu opens after the hover-intent delay, without touching the manage button.
    await vi.waitFor(
      () => {
        expect(document.body.textContent).toContain('Allow writes')
      },
      { timeout: 1000 }
    )
  })

  it('switches to the local browser at the granted path when a folder row is clicked', async () => {
    await renderFilesView()
    await openFilterMenu()

    await clickElement(document.body.querySelector('[data-testid="granted-root-root-1"]'))

    expect(container.querySelector('[aria-label="Local file browser"]')).not.toBeNull()
    expect(listDir).toHaveBeenCalledWith('/Users/roxi/Projects')
    const address = container.querySelector<HTMLInputElement>('[aria-label="Directory path"]')
    expect(address?.value).toBe('/Users/roxi/Projects')
  })

  it('grants a folder through the dialog and browses it', async () => {
    useGrantedFoldersStore.setState({ roots: [], loaded: true })
    vi.mocked(window.api.localFs.listGrantedRoots).mockResolvedValue([])

    await renderFilesView()
    await openFilterMenu()
    await clickElement(document.body.querySelector('[data-testid="add-local-folder"]'))

    // The dialog opens at home: subfolders listed, Grant disabled with the home hint.
    expect(document.body.textContent).toContain('Grant folder access')
    expect(document.body.textContent).toContain(
      "Your home folder itself can't be granted — pick a subfolder."
    )
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-testid="grant-access-grant"]')?.disabled
    ).toBe(true)

    await clickElement(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    await clickElement(document.body.querySelector('[data-testid="grant-access-grant"]'))
    await clickElement(
      document.body
        .querySelector('[data-testid="grant-folder-access-confirmation"]')
        ?.querySelector('button:last-of-type')
    )

    expect(grantRoot).toHaveBeenCalledWith({ path: '/Users/roxi/Projects', access: 'ro' })
    // Dialog closed; the new root is selected in the local browser.
    expect(document.body.textContent).not.toContain('Grant folder access')
    expect(container.querySelector('[aria-label="Local file browser"]')).not.toBeNull()
    expect(listDir).toHaveBeenCalledWith('/Users/roxi/Projects')
    // And the store picked it up for the next menu open.
    expect(useGrantedFoldersStore.getState().roots).toEqual([grantedRoot])
  })

  const filterButton = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('[aria-label="Filter project files"]')

  const machineRow = (): HTMLElement | undefined =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).find((el) =>
      el.textContent?.includes('TychoStation')
    )

  it('moves the selected check between the machine row and a picked folder row', async () => {
    await renderFilesView()
    await openFilterMenu()

    // Artifacts mode: neither local row is checked.
    expect(machineRow()?.getAttribute('aria-checked')).toBe('false')
    expect(document.body.querySelector('[data-testid="granted-root-check-root-1"]')).toBeNull()

    // Picking the folder checks its row, unchecks the machine, and persists the choice.
    await clickElement(document.body.querySelector('[data-testid="granted-root-root-1"]'))
    expect(setProjectFilesFilter).toHaveBeenLastCalledWith({
      sourceMode: 'local',
      localRootId: 'root-1'
    })
    expect(filterButton()?.textContent).toContain('Projects')

    await openFilterMenu()
    const rootRow = document.body.querySelector('[data-testid="granted-root-root-1"]')
    expect(rootRow?.getAttribute('aria-checked')).toBe('true')
    expect(document.body.querySelector('[data-testid="granted-root-check-root-1"]')).not.toBeNull()
    expect(machineRow()?.getAttribute('aria-checked')).toBe('false')

    // Picking the machine moves the check back and persists the plain local mode.
    await clickElement(machineRow())
    expect(setProjectFilesFilter).toHaveBeenLastCalledWith({ sourceMode: 'local' })
    expect(filterButton()?.textContent).toContain('TychoStation')

    await openFilterMenu()
    expect(machineRow()?.getAttribute('aria-checked')).toBe('true')
    expect(document.body.querySelector('[data-testid="granted-root-check-root-1"]')).toBeNull()
    expect(
      document.body
        .querySelector('[data-testid="granted-root-root-1"]')
        ?.getAttribute('aria-checked')
    ).toBe('false')

    // Picking an artifact filter clears the local selection entirely.
    await clickElement(document.body.querySelector('[data-filter-id="all"]'))
    expect(setProjectFilesFilter).toHaveBeenLastCalledWith({
      sourceMode: 'artifacts',
      optionId: 'all'
    })
    expect(container.querySelector('[data-testid="project-files-scroll"]')).not.toBeNull()

    await openFilterMenu()
    expect(machineRow()?.getAttribute('aria-checked')).toBe('false')
  })

  it('restores a persisted artifact filter on mount without writing it back', async () => {
    useSettingsStore.setState({
      projectFilesFilter: { sourceMode: 'artifacts', optionId: 'uploads' }
    })

    await renderFilesView()

    expect(filterButton()?.textContent).toContain('Your uploads')
    expect(container.querySelector('[aria-label="Local file browser"]')).toBeNull()
    expect(setProjectFilesFilter).not.toHaveBeenCalled()
  })

  it('falls back to the default when a persisted artifact option no longer exists', async () => {
    useSettingsStore.setState({
      projectFilesFilter: { sourceMode: 'artifacts', optionId: 'session:gone' }
    })

    await renderFilesView()

    expect(filterButton()?.textContent).toContain('Artifacts')
    expect(container.querySelector('[data-testid="project-files-scroll"]')).not.toBeNull()
  })

  it('restores a persisted machine local mode on mount', async () => {
    useSettingsStore.setState({
      projectFilesFilter: { sourceMode: 'local' }
    })

    await renderFilesView()

    expect(container.querySelector('[aria-label="Local file browser"]')).not.toBeNull()
    expect(listDir).toHaveBeenLastCalledWith('/Users/roxi')
    expect(filterButton()?.textContent).toContain('TychoStation')

    await openFilterMenu()
    expect(machineRow()?.getAttribute('aria-checked')).toBe('true')
    expect(document.body.querySelector('[data-testid="granted-root-check-root-1"]')).toBeNull()
  })

  it('restores a persisted granted folder once the roots refresh confirms it', async () => {
    useSettingsStore.setState({
      projectFilesFilter: { sourceMode: 'local', localRootId: 'root-1' }
    })

    await renderFilesView()

    expect(container.querySelector('[aria-label="Local file browser"]')).not.toBeNull()
    expect(listDir).toHaveBeenLastCalledWith('/Users/roxi/Projects')
    const address = container.querySelector<HTMLInputElement>('[aria-label="Directory path"]')
    expect(address?.value).toBe('/Users/roxi/Projects')
    expect(filterButton()?.textContent).toContain('Projects')

    await openFilterMenu()
    expect(document.body.querySelector('[data-testid="granted-root-check-root-1"]')).not.toBeNull()
    expect(machineRow()?.getAttribute('aria-checked')).toBe('false')
  })

  it('degrades a revoked persisted folder to plain machine local mode', async () => {
    useSettingsStore.setState({
      projectFilesFilter: { sourceMode: 'local', localRootId: 'root-revoked' }
    })

    await renderFilesView()

    expect(container.querySelector('[aria-label="Local file browser"]')).not.toBeNull()
    expect(listDir).toHaveBeenLastCalledWith('/Users/roxi')
    expect(filterButton()?.textContent).toContain('TychoStation')

    await openFilterMenu()
    expect(machineRow()?.getAttribute('aria-checked')).toBe('true')
    expect(document.body.querySelector('[data-testid="granted-root-check-root-1"]')).toBeNull()
  })
})
