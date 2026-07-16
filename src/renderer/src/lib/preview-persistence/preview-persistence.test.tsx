// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PREVIEW_STATE_VERSION, type PersistedPreviewState } from '../../../../shared/preview-state'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '../../stores/preview-workbench-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '../../stores/session-store'
import type { UploadedAttachment } from '../../../../shared/uploads'
import {
  toPersistedPreviewState,
  toRestoredSlice,
  usePreviewPersistence
} from './preview-persistence'

type StoreState = ReturnType<typeof usePreviewWorkbenchStore.getState>

type Deferred<Value> = {
  promise: Promise<Value>
  resolve: (value: Value) => void
}

const createDeferred = <Value,>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve
  })

  return { promise, resolve }
}

// A stored file item as it lives in the workbench store (timestamps + type included).
const createStoredFileItem = (
  overrides: Partial<StoreState['items'][number]> = {}
): StoreState['items'][number] =>
  ({
    id: 'file:session-1:/workspace/project/report.md',
    sessionId: 'session-1',
    type: 'file',
    title: 'report.md',
    source: 'artifact',
    path: '/workspace/project/report.md',
    format: 'markdown',
    name: 'report.md',
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }) as StoreState['items'][number]

// A runtime-only tool tab that must be dropped from the durable subset.
const createStoredToolItem = (): StoreState['items'][number] =>
  ({
    id: 'tool:session-1:notebook',
    sessionId: 'session-1',
    type: 'tool',
    toolKind: 'notebook',
    title: 'Notebook',
    createdAt: 1,
    updatedAt: 2
  }) as StoreState['items'][number]

const createUpload = (overrides: Partial<UploadedAttachment> = {}): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: 'session-final',
  name: 'data.csv',
  originalName: 'data.csv',
  path: '/workspace/uploads/session-final/data.csv',
  mimeType: 'text/csv',
  size: 128,
  ...overrides
})

const createSession = (
  upload: UploadedAttachment,
  overrides: Partial<ChatSession> = {}
): ChatSession => ({
  id: upload.sessionId,
  projectId: 'project-a',
  title: 'Analysis',
  cwd: '/workspace/project',
  status: 'idle',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'Analyze this file',
      status: 'complete',
      eventIds: [],
      uploads: [upload],
      createdAt: 1,
      updatedAt: 2
    }
  ],
  createdAt: 1,
  updatedAt: 2,
  ...overrides
})

describe('preview persistence projections', () => {
  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSessionStore.setState(createInitialSessionState())
  })

  it('keeps only file items and stamps the current preview state version', () => {
    usePreviewWorkbenchStore.setState({
      panelState: 'open',
      activeItemId: 'file:session-1:/workspace/project/report.md',
      items: [createStoredFileItem(), createStoredToolItem()]
    })

    const persisted = toPersistedPreviewState(usePreviewWorkbenchStore.getState())

    expect(persisted).toEqual({
      version: PREVIEW_STATE_VERSION,
      panelState: 'open',
      activeItemId: 'file:session-1:/workspace/project/report.md',
      items: [
        {
          id: 'file:session-1:/workspace/project/report.md',
          sessionId: 'session-1',
          title: 'report.md',
          source: 'artifact',
          path: '/workspace/project/report.md',
          format: 'markdown',
          name: 'report.md'
        }
      ]
    })
    // Runtime-only timestamps and tab type are dropped from the durable projection.
    expect(persisted.items[0]).not.toHaveProperty('createdAt')
    expect(persisted.items[0]).not.toHaveProperty('type')
  })

  it('round-trips durable file fields through persist then restore', () => {
    usePreviewWorkbenchStore.setState({
      panelState: 'open',
      activeItemId: 'file:session-1:/workspace/project/report.md',
      items: [createStoredFileItem({ source: 'upload', format: 'csv', name: 'data.csv' })]
    })

    const restored = toRestoredSlice(toPersistedPreviewState(usePreviewWorkbenchStore.getState()))

    expect(restored).toEqual({
      panelState: 'open',
      activeItemId: 'file:session-1:/workspace/project/report.md',
      items: [
        {
          id: 'file:session-1:/workspace/project/report.md',
          sessionId: 'session-1',
          title: 'report.md',
          type: 'file',
          source: 'upload',
          path: '/workspace/project/report.md',
          format: 'csv',
          name: 'data.csv'
        }
      ]
    })
  })

  it('round-trips file version metadata used by preview resource identity', () => {
    usePreviewWorkbenchStore.setState({
      panelState: 'open',
      items: [createStoredFileItem({ size: 4096, mtimeMs: 1710000001000 })]
    })

    const restored = toRestoredSlice(toPersistedPreviewState(usePreviewWorkbenchStore.getState()))

    expect(restored.items?.[0]).toMatchObject({ size: 4096, mtimeMs: 1710000001000 })
  })

  it('re-evaluates persisted formats against current preview support', () => {
    const restored = toRestoredSlice({
      version: PREVIEW_STATE_VERSION,
      panelState: 'open',
      activeItemId: 'upload:treefile',
      items: [
        {
          id: 'upload:treefile',
          sessionId: 'session-1',
          title: 'analysis.treefile',
          source: 'upload',
          path: '/workspace/uploads/session-1/analysis.treefile',
          format: 'unknown',
          name: 'analysis.treefile'
        },
        {
          id: 'upload:extensionless-json',
          sessionId: 'session-1',
          title: 'model-output',
          source: 'upload',
          path: '/workspace/uploads/session-1/model-output',
          format: 'json',
          name: 'model-output'
        }
      ]
    })

    expect(restored.items).toMatchObject([{ format: 'text' }, { format: 'json' }])
  })
})

// Minimal wrapper so the effect-only hook can be mounted/rerendered/unmounted.
const PersistenceHarness = ({
  projectId,
  isReady = true
}: {
  projectId: string | undefined
  isReady?: boolean
}): null => {
  usePreviewPersistence(projectId, isReady)
  return null
}

describe('usePreviewPersistence per-project save/restore', () => {
  let container: HTMLDivElement
  let root: Root
  let load: ReturnType<typeof vi.fn>
  let save: ReturnType<typeof vi.fn>

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSessionStore.setState(createInitialSessionState())
    load = vi.fn(() => Promise.resolve(undefined))
    save = vi.fn(() => Promise.resolve())
    window.api = { preview: { load, save } } as never
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
  })

  it('loads the incoming project and activates it from restored persistence', async () => {
    const persisted: PersistedPreviewState = {
      version: PREVIEW_STATE_VERSION,
      panelState: 'open',
      activeItemId: 'file:session-1:/workspace/project/report.md',
      items: [
        {
          id: 'file:session-1:/workspace/project/report.md',
          sessionId: 'session-1',
          title: 'report.md',
          source: 'artifact',
          path: '/workspace/project/report.md',
          format: 'markdown',
          name: 'report.md'
        }
      ]
    }
    load.mockResolvedValueOnce(persisted)

    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    expect(load).toHaveBeenCalledWith({ projectId: 'project-a' })
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-a',
      panelState: 'open',
      activeItemId: 'file:session-1:/workspace/project/report.md',
      items: [{ id: 'file:session-1:/workspace/project/report.md', type: 'file' }]
    })
  })

  it('restores uploaded previews with the finalized path from hydrated sessions', async () => {
    const finalizedUpload = createUpload()
    const unopenedUpload = createUpload({
      id: 'upload-2',
      sessionId: 'session-other',
      name: 'other.csv'
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession(finalizedUpload), createSession(unopenedUpload)]
    })
    load.mockResolvedValueOnce({
      version: PREVIEW_STATE_VERSION,
      panelState: 'open',
      activeItemId: 'upload:upload-1',
      items: [
        {
          id: 'upload:upload-1',
          sessionId: '.pending',
          title: 'data.csv',
          source: 'upload',
          path: '/workspace/uploads/.pending/data.csv',
          format: 'csv',
          name: 'data.csv'
        }
      ]
    })

    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    const restoredItems = usePreviewWorkbenchStore.getState().items

    expect(restoredItems).toHaveLength(1)
    expect(restoredItems[0]).toMatchObject({
      id: 'upload:upload-1',
      sessionId: 'session-final',
      path: '/workspace/uploads/session-final/data.csv'
    })
  })

  it('waits for session hydration before restoring uploaded preview paths', async () => {
    const finalizedUpload = createUpload()
    load.mockResolvedValueOnce({
      version: PREVIEW_STATE_VERSION,
      panelState: 'open',
      activeItemId: 'upload:upload-1',
      items: [
        {
          id: 'upload:upload-1',
          sessionId: '.pending',
          title: 'data.csv',
          source: 'upload',
          path: '/workspace/uploads/.pending/data.csv',
          format: 'csv',
          name: 'data.csv'
        }
      ]
    })

    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" isReady={false} />)
    })

    expect(load).not.toHaveBeenCalled()

    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession(finalizedUpload)]
    })
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" isReady />)
    })

    expect(load).toHaveBeenCalledWith({ projectId: 'project-a' })
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      id: 'upload:upload-1',
      sessionId: 'session-final',
      path: '/workspace/uploads/session-final/data.csv'
    })
  })

  it('saves the outgoing project before switching when the live slice still belongs to it', async () => {
    // Mount on project-a and let its (empty) restore apply so the live slice belongs to project-a.
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })
    expect(usePreviewWorkbenchStore.getState().activeProjectId).toBe('project-a')

    // A file preview opened for project-a; this is what must be flushed on switch.
    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: 'file:session-1:/workspace/project/report.md',
        items: [createStoredFileItem()]
      })
    })

    await act(async () => {
      root.render(<PersistenceHarness projectId="project-b" />)
    })

    expect(save).toHaveBeenCalledWith({
      projectId: 'project-a',
      state: {
        version: PREVIEW_STATE_VERSION,
        panelState: 'open',
        activeItemId: 'file:session-1:/workspace/project/report.md',
        items: [
          {
            id: 'file:session-1:/workspace/project/report.md',
            sessionId: 'session-1',
            title: 'report.md',
            source: 'artifact',
            path: '/workspace/project/report.md',
            format: 'markdown',
            name: 'report.md'
          }
        ]
      }
    })
    // The incoming project is still loaded after the outgoing save.
    expect(load).toHaveBeenCalledWith({ projectId: 'project-b' })
  })

  it('skips the outgoing save when a pending load left the live slice on another project', async () => {
    // project-a's load never resolves, so activateProject never runs: the top-level slice does not
    // belong to project-a when the rapid switch to project-b happens.
    const pendingLoad = createDeferred<PersistedPreviewState | undefined>()
    load.mockReturnValueOnce(pendingLoad.promise)

    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })
    expect(usePreviewWorkbenchStore.getState().activeProjectId).toBeUndefined()

    await act(async () => {
      root.render(<PersistenceHarness projectId="project-b" />)
    })

    // Nothing was saved for project-a: its last persisted state must stand, not be overwritten.
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-a' }))
    // The switch still loads the incoming project.
    expect(load).toHaveBeenCalledWith({ projectId: 'project-b' })
  })

  it('flushes the active project on unmount', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: 'file:session-1:/workspace/project/report.md',
        items: [createStoredFileItem()]
      })
    })

    save.mockClear()

    await act(async () => {
      root.unmount()
    })

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({
      projectId: 'project-a',
      state: {
        version: PREVIEW_STATE_VERSION,
        panelState: 'open',
        activeItemId: 'file:session-1:/workspace/project/report.md',
        items: [
          {
            id: 'file:session-1:/workspace/project/report.md',
            sessionId: 'session-1',
            title: 'report.md',
            source: 'artifact',
            path: '/workspace/project/report.md',
            format: 'markdown',
            name: 'report.md'
          }
        ]
      }
    })
  })
})
