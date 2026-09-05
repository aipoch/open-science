// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PREVIEW_STATE_VERSION,
  type PersistedPreviewState,
  type PreviewStateSnapshot,
  type SavePreviewStateResult
} from '../../../../shared/preview-state'
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
  flushPreviewPersistence,
  toPersistedPreviewState,
  toRestoredSlice,
  usePreviewPersistence
} from './preview-persistence'

type StoreState = ReturnType<typeof usePreviewWorkbenchStore.getState>

type Deferred<Value> = {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (reason?: unknown) => void
}

const createDeferred = <Value,>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, resolve, reject }
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

  it('keeps source preview URLs and identifiers out of the durable projection', () => {
    usePreviewWorkbenchStore.setState({
      panelState: 'open',
      activeItemId: 'source:https://example.com/private-paper',
      items: [
        {
          id: 'source:https://example.com/private-paper',
          sessionId: '__sources__',
          type: 'source',
          title: 'Private paper',
          url: 'https://example.com/private-paper',
          createdAt: 1,
          updatedAt: 2
        }
      ]
    })

    const persisted = toPersistedPreviewState(usePreviewWorkbenchStore.getState())

    expect(persisted.activeItemId).toBeUndefined()
    expect(persisted.items).toEqual([])
    expect(JSON.stringify(persisted)).not.toContain('https://example.com/private-paper')
  })

  it('persists the 100 most recently used file tabs in their display order', () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      createStoredFileItem({
        id: `file-${index}`,
        path: `/workspace/project/file-${index}.md`,
        name: `file-${index}.md`,
        title: `file-${index}.md`,
        updatedAt: index === 50 ? 0 : index + 1
      })
    )
    usePreviewWorkbenchStore.setState({
      panelState: 'open',
      activeItemId: 'file-100',
      items
    })

    const persisted = toPersistedPreviewState(usePreviewWorkbenchStore.getState())

    expect(persisted.items).toHaveLength(100)
    expect(persisted.items.map((item) => item.id)).toEqual(
      items.filter((item) => item.id !== 'file-50').map((item) => item.id)
    )
    expect(persisted.activeItemId).toBe('file-100')
  })

  it('round-trips the one durable Session Subagents Preview and selected Frame', () => {
    usePreviewWorkbenchStore.setState({
      panelState: 'collapsed',
      activeItemId: 'tool:session-1:subagents',
      items: [
        {
          id: 'tool:session-1:subagents',
          sessionId: 'session-1',
          projectId: 'project-a',
          type: 'tool',
          toolKind: 'subagents',
          title: 'Subagents',
          selectedAgentFrameId: 'child-21',
          createdAt: 1,
          updatedAt: 2
        }
      ]
    })

    const persisted = toPersistedPreviewState(usePreviewWorkbenchStore.getState())
    const restored = toRestoredSlice(persisted)

    expect(restored).toMatchObject({
      panelState: 'collapsed',
      activeItemId: 'tool:session-1:subagents',
      items: [
        {
          id: 'tool:session-1:subagents',
          type: 'tool',
          toolKind: 'subagents',
          sessionId: 'session-1',
          selectedAgentFrameId: 'child-21'
        }
      ]
    })
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
      items: [
        createStoredFileItem({
          size: 4096,
          mtimeMs: 1710000001000,
          artifactId: 'artifact-1',
          managedFileId: 'managed-file-1',
          selectedVersionId: 'artifact-version-2',
          versionNumber: 2,
          originSession: {
            state: 'deleted',
            title: 'Original analysis',
            deletedAt: '2026-07-28T12:00:00.000Z'
          }
        })
      ]
    })

    const restored = toRestoredSlice(toPersistedPreviewState(usePreviewWorkbenchStore.getState()))

    expect(restored.items?.[0]).toMatchObject({
      size: 4096,
      mtimeMs: 1710000001000,
      artifactId: 'artifact-1',
      managedFileId: 'managed-file-1',
      selectedVersionId: 'artifact-version-2',
      versionNumber: 2,
      originSession: {
        state: 'deleted',
        title: 'Original analysis',
        deletedAt: '2026-07-28T12:00:00.000Z'
      }
    })
  })

  it('recovers managed identity from a persisted authoritative artifact id', () => {
    const restored = toRestoredSlice({
      version: PREVIEW_STATE_VERSION,
      panelState: 'open',
      items: [
        {
          id: 'legacy-artifact-version',
          sessionId: 'session-1',
          title: 'report.html',
          source: 'artifact',
          path: '/workspace/project/report.html',
          format: 'html',
          name: 'report.html',
          artifactId: 'artifact-lineage-1'
        }
      ]
    })

    expect(restored.items?.[0]).toMatchObject({
      artifactId: 'artifact-lineage-1',
      managedFileId: 'artifact-lineage-1'
    })
  })

  it('recovers managed identity from an exact hydrated Upload record', () => {
    const upload = createUpload({ id: 'upload-authority' })
    const restored = toRestoredSlice(
      {
        version: PREVIEW_STATE_VERSION,
        panelState: 'open',
        items: [
          {
            id: 'upload:upload-authority',
            sessionId: '.pending',
            title: 'data.csv',
            source: 'upload',
            path: '/workspace/uploads/.pending/data.csv',
            format: 'csv',
            name: 'data.csv'
          }
        ]
      },
      [createSession(upload)]
    )

    expect(restored.items?.[0]).toMatchObject({
      sessionId: 'session-final',
      managedFileId: 'upload-authority'
    })
  })

  it('does not promote artifact identity into an unmatched Upload item', () => {
    const session = createSession(createUpload({ id: 'different-upload' }), {
      artifacts: [
        {
          id: 'upload:missing-upload',
          artifactId: 'hydrated-artifact-lineage',
          kind: 'managed-file',
          path: '/workspace/uploads/session-final/data.csv',
          name: 'data.csv'
        }
      ]
    })
    const restored = toRestoredSlice(
      {
        version: PREVIEW_STATE_VERSION,
        panelState: 'open',
        items: [
          {
            id: 'upload:missing-upload',
            sessionId: 'session-final',
            title: 'data.csv',
            source: 'upload',
            path: '/workspace/uploads/session-final/data.csv',
            format: 'csv',
            name: 'data.csv',
            artifactId: 'persisted-artifact-lineage'
          }
        ]
      },
      [session]
    )

    expect(restored.items?.[0]).not.toHaveProperty('artifactId')
    expect(restored.items?.[0]).not.toHaveProperty('managedFileId')
  })

  it('preserves a persisted Upload identity while discarding artifact metadata', () => {
    const restored = toRestoredSlice({
      version: PREVIEW_STATE_VERSION,
      panelState: 'open',
      items: [
        {
          id: 'upload:legacy-upload',
          sessionId: 'session-final',
          title: 'data.csv',
          source: 'upload',
          path: '/workspace/uploads/session-final/data.csv',
          format: 'csv',
          name: 'data.csv',
          artifactId: 'artifact-from-wrong-source',
          managedFileId: 'persisted-upload-authority'
        }
      ]
    })

    expect(restored.items?.[0]).toMatchObject({
      managedFileId: 'persisted-upload-authority'
    })
    expect(restored.items?.[0]).not.toHaveProperty('artifactId')
  })

  it('recovers compatibility artifact identity from a persisted artifact id', () => {
    const restored = toRestoredSlice({
      version: PREVIEW_STATE_VERSION,
      panelState: 'open',
      items: [
        {
          id: 'legacy-artifact-version',
          sessionId: 'session-final',
          title: 'report.html',
          path: '/workspace/project/report.html',
          format: 'html',
          name: 'report.html',
          artifactId: 'persisted-artifact-lineage'
        }
      ]
    })

    expect(restored.items?.[0]).toMatchObject({
      artifactId: 'persisted-artifact-lineage',
      managedFileId: 'persisted-artifact-lineage'
    })
  })

  it('recovers compatibility artifact identity from an exact hydrated Artifact record', () => {
    const session = createSession(createUpload(), {
      artifacts: [
        {
          id: 'legacy-artifact-version',
          artifactId: 'hydrated-artifact-lineage',
          kind: 'managed-file',
          path: '/workspace/project/report.html',
          name: 'report.html'
        }
      ]
    })
    const restored = toRestoredSlice(
      {
        version: PREVIEW_STATE_VERSION,
        panelState: 'open',
        items: [
          {
            id: 'legacy-artifact-version',
            sessionId: 'session-final',
            title: 'report.html',
            path: '/workspace/project/report.html',
            format: 'html',
            name: 'report.html'
          }
        ]
      },
      [session]
    )

    expect(restored.items?.[0]).toMatchObject({
      artifactId: 'hydrated-artifact-lineage',
      managedFileId: 'hydrated-artifact-lineage'
    })
  })

  it('recovers artifact identity only from an exact hydrated Artifact record', () => {
    const session = createSession(createUpload(), {
      artifacts: [
        {
          id: 'legacy-artifact-version',
          artifactId: 'artifact-lineage-2',
          kind: 'managed-file',
          path: '/workspace/project/report.html',
          name: 'report.html'
        }
      ]
    })
    const restored = toRestoredSlice(
      {
        version: PREVIEW_STATE_VERSION,
        panelState: 'open',
        items: [
          {
            id: 'legacy-artifact-version',
            sessionId: 'session-final',
            title: 'report.html',
            source: 'artifact',
            path: '/workspace/project/report.html',
            format: 'html',
            name: 'report.html'
          }
        ]
      },
      [session]
    )

    expect(restored.items?.[0]).toMatchObject({
      artifactId: 'artifact-lineage-2',
      managedFileId: 'artifact-lineage-2'
    })
  })

  it('does not infer managed identity from a path or a compatibility item id', () => {
    const session = createSession(createUpload(), {
      artifacts: [
        {
          id: 'different-artifact-version',
          artifactId: 'artifact-lineage-3',
          kind: 'managed-file',
          path: '/workspace/project/report.html',
          name: 'report.html'
        }
      ]
    })
    const restored = toRestoredSlice(
      {
        version: PREVIEW_STATE_VERSION,
        panelState: 'open',
        items: [
          {
            id: 'legacy-artifact-version',
            sessionId: 'session-final',
            title: 'report.html',
            path: '/workspace/project/report.html',
            format: 'html',
            name: 'report.html'
          }
        ]
      },
      [session]
    )

    expect(restored.items?.[0]).not.toHaveProperty('artifactId')
    expect(restored.items?.[0]).not.toHaveProperty('managedFileId')
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

  it('updates and removes Upload index entries when a Session is replaced or deleted', () => {
    const persisted: PersistedPreviewState = {
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
    }
    const originalSession = createSession(createUpload())
    const replacementSession = createSession(
      createUpload({ path: '/workspace/uploads/session-final/replaced.csv', size: 256 })
    )

    expect(toRestoredSlice(persisted, [originalSession]).items?.[0]).toMatchObject({
      path: '/workspace/uploads/session-final/data.csv',
      size: 128
    })
    expect(toRestoredSlice(persisted, [replacementSession]).items?.[0]).toMatchObject({
      path: '/workspace/uploads/session-final/replaced.csv',
      size: 256
    })
    expect(toRestoredSlice(persisted, []).items?.[0]).toMatchObject({
      path: '/workspace/uploads/.pending/data.csv'
    })
  })

  it('evicts the oldest Upload index after eight Projects', () => {
    let oldestProjectMessageReads = 0
    let oldestProject: { persisted: PersistedPreviewState; session: ChatSession } | undefined

    for (let index = 0; index < 9; index += 1) {
      const projectId = `indexed-project-${index}`
      const sessionId = `indexed-session-${index}`
      const upload = createUpload({ id: `indexed-upload-${index}`, sessionId })
      const session = createSession(upload, { id: sessionId, projectId })
      const messages = session.messages
      if (index === 0) {
        Object.defineProperty(session, 'messages', {
          configurable: true,
          get: () => {
            oldestProjectMessageReads += 1
            return messages
          }
        })
      }
      const persisted: PersistedPreviewState = {
        version: PREVIEW_STATE_VERSION,
        panelState: 'open',
        activeItemId: `upload:${upload.id}`,
        items: [
          {
            id: `upload:${upload.id}`,
            sessionId: '.pending',
            title: upload.name,
            source: 'upload',
            path: `/workspace/uploads/.pending/${upload.name}`,
            format: 'csv',
            name: upload.name
          }
        ]
      }

      toRestoredSlice(persisted, [session])
      if (index === 0) oldestProject = { persisted, session }
    }

    expect(oldestProject).toBeDefined()
    toRestoredSlice(oldestProject!.persisted, [oldestProject!.session])

    expect(oldestProjectMessageReads).toBe(2)
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
    load = vi.fn(() => Promise.resolve(null))
    save = vi.fn(({ expectedRevision }: { expectedRevision: number }) =>
      Promise.resolve({ status: 'saved' as const, revision: expectedRevision + 1 })
    )
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
    load.mockResolvedValueOnce({ state: persisted, revision: 7 })

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
      revision: 7,
      state: {
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
      }
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
      revision: 7,
      state: {
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
      }
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
      expectedRevision: expect.any(Number),
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
    const pendingLoad = createDeferred<PreviewStateSnapshot | null>()
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

  it('writes through the selected Subagent Frame before a process restart', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })
    save.mockClear()

    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: 'tool:session-1:subagents',
        items: [
          {
            id: 'tool:session-1:subagents',
            sessionId: 'session-1',
            projectId: 'project-a',
            type: 'tool',
            toolKind: 'subagents',
            title: 'Subagents',
            selectedAgentFrameId: 'child-05',
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    })

    expect(save).toHaveBeenCalledWith({
      projectId: 'project-a',
      expectedRevision: expect.any(Number),
      state: {
        version: PREVIEW_STATE_VERSION,
        panelState: 'open',
        activeItemId: 'tool:session-1:subagents',
        items: [],
        subagents: {
          id: 'tool:session-1:subagents',
          sessionId: 'session-1',
          title: 'Subagents',
          type: 'tool',
          toolKind: 'subagents',
          selectedAgentFrameId: 'child-05'
        }
      }
    })
  })

  it('does not save when a runtime-only tool tab changes without changing the durable projection', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
      await flushPreviewPersistence()
    })

    const fileItem = createStoredFileItem()
    const toolItem = createStoredToolItem()
    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: fileItem.id,
        items: [fileItem, toolItem]
      })
    })
    await flushPreviewPersistence()
    save.mockClear()

    act(() => {
      usePreviewWorkbenchStore.setState({
        items: [{ ...toolItem, title: 'Notebook runtime updated' }, fileItem]
      })
    })
    await flushPreviewPersistence()

    expect(save).not.toHaveBeenCalled()
  })

  it('does not rescan unchanged hydrated Session messages when returning to a Project', async () => {
    const finalizedUpload = createUpload()
    const session = createSession(finalizedUpload)
    const messages = session.messages
    let messageReads = 0
    Object.defineProperty(session, 'messages', {
      configurable: true,
      get: () => {
        messageReads += 1
        return messages
      }
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [session]
    })
    const persistedUpload: PreviewStateSnapshot = {
      revision: 7,
      state: {
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
      }
    }
    load.mockImplementation(({ projectId }: { projectId: string }) =>
      Promise.resolve(projectId === 'project-a' ? persistedUpload : null)
    )

    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-b" />)
    })
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    expect(messageReads).toBe(1)
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      id: 'upload:upload-1',
      sessionId: 'session-final',
      path: '/workspace/uploads/session-final/data.csv'
    })
  })

  it('restores the authoritative snapshot and advances after a save conflict', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
      await flushPreviewPersistence()
    })
    save.mockClear()

    const serverItem = createStoredFileItem({
      id: 'file:session-2:/workspace/project/results.csv',
      sessionId: 'session-2',
      title: 'results.csv',
      path: '/workspace/project/results.csv',
      format: 'csv',
      name: 'results.csv'
    })
    const serverState = toPersistedPreviewState({
      ...usePreviewWorkbenchStore.getState(),
      panelState: 'open',
      activeItemId: serverItem.id,
      items: [serverItem]
    })
    save.mockResolvedValueOnce({
      status: 'conflict',
      snapshot: { state: serverState, revision: 10 }
    })

    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: 'file:session-1:/workspace/project/report.md',
        items: [createStoredFileItem()]
      })
    })
    await flushPreviewPersistence()

    expect(save).toHaveBeenCalledTimes(1)
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: serverItem.id,
      items: [expect.objectContaining({ id: serverItem.id })]
    })

    save.mockResolvedValueOnce({ status: 'saved', revision: 11 })
    act(() => usePreviewWorkbenchStore.getState().collapsePanel())
    await flushPreviewPersistence()

    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 10 }))
  })

  it('rebases a user change queued after the conflicting snapshot', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
      await flushPreviewPersistence()
    })
    save.mockClear()

    const submittedItem = createStoredFileItem()
    const queuedItem = createStoredFileItem({
      id: 'file:session-1:/workspace/project/notes.md',
      title: 'notes.md',
      path: '/workspace/project/notes.md',
      name: 'notes.md'
    })
    const serverItem = createStoredFileItem({
      id: 'file:session-2:/workspace/project/results.csv',
      sessionId: 'session-2',
      title: 'results.csv',
      path: '/workspace/project/results.csv',
      format: 'csv',
      name: 'results.csv'
    })
    const serverState = toPersistedPreviewState({
      ...usePreviewWorkbenchStore.getState(),
      panelState: 'open',
      activeItemId: serverItem.id,
      items: [serverItem]
    })
    const pendingSave = createDeferred<SavePreviewStateResult>()
    save
      .mockReturnValueOnce(pendingSave.promise)
      .mockResolvedValueOnce({ status: 'saved', revision: 11 })

    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: submittedItem.id,
        items: [submittedItem]
      })
      usePreviewWorkbenchStore.setState({
        activeItemId: queuedItem.id,
        items: [submittedItem, queuedItem]
      })
    })

    await act(async () => {
      pendingSave.resolve({
        status: 'conflict',
        snapshot: { state: serverState, revision: 10 }
      })
      await pendingSave.promise
      await flushPreviewPersistence()
    })

    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith({
      projectId: 'project-a',
      expectedRevision: 10,
      state: expect.objectContaining({
        activeItemId: queuedItem.id,
        items: [
          expect.objectContaining({ id: serverItem.id }),
          expect.objectContaining({ id: queuedItem.id })
        ]
      })
    })
  })

  it('does not reuse an inactive project cache after its save conflicts', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
      await flushPreviewPersistence()
    })
    save.mockClear()

    const staleItem = createStoredFileItem()
    const serverItem = createStoredFileItem({
      id: 'file:session-2:/workspace/project/results.csv',
      sessionId: 'session-2',
      title: 'results.csv',
      path: '/workspace/project/results.csv',
      format: 'csv',
      name: 'results.csv'
    })
    const serverState = toPersistedPreviewState({
      ...usePreviewWorkbenchStore.getState(),
      panelState: 'open',
      activeItemId: serverItem.id,
      items: [serverItem]
    })
    const pendingSave = createDeferred<SavePreviewStateResult>()
    save.mockReturnValueOnce(pendingSave.promise)

    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: createStoredToolItem().id,
        items: [staleItem, createStoredToolItem()]
      })
    })
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-b" />)
    })
    expect(usePreviewWorkbenchStore.getState().byProject['project-a']?.items).toEqual([
      expect.objectContaining({ id: staleItem.id }),
      expect.objectContaining({ id: createStoredToolItem().id })
    ])

    await act(async () => {
      pendingSave.resolve({
        status: 'conflict',
        snapshot: { state: serverState, revision: 10 }
      })
      await pendingSave.promise
      await flushPreviewPersistence()
    })

    load.mockResolvedValueOnce({ state: serverState, revision: 10 })
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-a',
      activeItemId: createStoredToolItem().id,
      items: [
        expect.objectContaining({ id: serverItem.id }),
        expect.objectContaining({ id: createStoredToolItem().id })
      ]
    })
  })

  it('saves the first user change after an unmounted conflict restore', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
      await flushPreviewPersistence()
    })
    save.mockClear()

    const pendingSave = createDeferred<SavePreviewStateResult>()
    save.mockReturnValueOnce(pendingSave.promise)
    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: createStoredFileItem().id,
        items: [createStoredFileItem()]
      })
      root.unmount()
    })

    const serverState = toPersistedPreviewState({
      ...usePreviewWorkbenchStore.getState(),
      panelState: 'open',
      items: [createStoredFileItem()]
    })
    await act(async () => {
      pendingSave.resolve({
        status: 'conflict',
        snapshot: { state: serverState, revision: 10 }
      })
      await pendingSave.promise
      await flushPreviewPersistence()
    })
    save.mockClear()

    const pendingLoad = createDeferred<PreviewStateSnapshot | null>()
    load.mockReturnValueOnce(pendingLoad.promise)
    root = createRoot(container)
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    act(() => usePreviewWorkbenchStore.getState().collapsePanel())

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        expectedRevision: expect.any(Number),
        state: expect.objectContaining({ panelState: 'collapsed' })
      })
    )
    expect(save.mock.calls[0]?.[0].expectedRevision).toBeGreaterThanOrEqual(10)
  })

  it('keeps the latest state durable when an earlier save completes last', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    const firstItem = createStoredFileItem()
    const secondItem = createStoredFileItem({
      id: 'file:session-1:/workspace/project/results.csv',
      title: 'results.csv',
      path: '/workspace/project/results.csv',
      format: 'csv',
      name: 'results.csv'
    })
    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: undefined,
        items: [firstItem, secondItem]
      })
    })
    await act(async () => Promise.resolve())

    const delayedFirstSave = createDeferred<void>()
    let durableState: PersistedPreviewState | undefined
    save.mockClear()
    save
      .mockImplementationOnce(({ expectedRevision, state }) =>
        delayedFirstSave.promise.then(() => {
          durableState = state
          return { status: 'saved' as const, revision: expectedRevision + 1 }
        })
      )
      .mockImplementationOnce(({ expectedRevision, state }) => {
        durableState = state
        return Promise.resolve({ status: 'saved' as const, revision: expectedRevision + 1 })
      })

    act(() => {
      usePreviewWorkbenchStore.setState({ activeItemId: firstItem.id })
      usePreviewWorkbenchStore.setState({ activeItemId: secondItem.id })
    })

    const flushing = flushPreviewPersistence()
    await act(async () => {
      delayedFirstSave.resolve()
      await flushing
    })

    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[0].expectedRevision).toBe(
      save.mock.calls[0]?.[0].expectedRevision + 1
    )
    expect(durableState?.activeItemId).toBe(secondItem.id)
  })

  it('keeps the latest state durable across a remount while an earlier save is in flight', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    const firstItem = createStoredFileItem()
    const secondItem = createStoredFileItem({
      id: 'file:session-1:/workspace/project/results.csv',
      title: 'results.csv',
      path: '/workspace/project/results.csv',
      format: 'csv',
      name: 'results.csv'
    })
    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: undefined,
        items: [firstItem, secondItem]
      })
    })
    await act(async () => Promise.resolve())

    const delayedFirstSave = createDeferred<void>()
    const pendingRemountLoad = createDeferred<PreviewStateSnapshot | null>()
    let durableState: PersistedPreviewState | undefined
    load.mockReturnValueOnce(pendingRemountLoad.promise)
    save.mockClear()
    save
      .mockImplementationOnce(({ expectedRevision, state }) =>
        delayedFirstSave.promise.then(() => {
          durableState = state
          return { status: 'saved' as const, revision: expectedRevision + 1 }
        })
      )
      .mockImplementationOnce(({ expectedRevision, state }) => {
        durableState = state
        return Promise.resolve({ status: 'saved' as const, revision: expectedRevision + 1 })
      })

    act(() => {
      usePreviewWorkbenchStore.setState({ activeItemId: firstItem.id })
    })
    await act(async () => {
      root.unmount()
    })
    root = createRoot(container)
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })
    act(() => {
      usePreviewWorkbenchStore.setState({ activeItemId: secondItem.id })
    })

    const flushing = flushPreviewPersistence()
    await act(async () => {
      delayedFirstSave.resolve()
      await flushing
    })

    expect(durableState?.activeItemId).toBe(secondItem.id)
  })

  it('ignores a stale load that returns after an in-flight save completes', async () => {
    const item = createStoredFileItem()
    load.mockResolvedValueOnce({
      revision: 5,
      state: toPersistedPreviewState({
        ...usePreviewWorkbenchStore.getState(),
        panelState: 'collapsed',
        items: [item]
      })
    })
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
      await flushPreviewPersistence()
    })
    save.mockClear()

    const pendingSave = createDeferred<SavePreviewStateResult>()
    const pendingLoad = createDeferred<PreviewStateSnapshot | null>()
    save.mockReturnValueOnce(pendingSave.promise)
    load.mockReturnValueOnce(pendingLoad.promise)

    act(() => usePreviewWorkbenchStore.setState({ panelState: 'open' }))
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    await act(async () => {
      pendingSave.resolve({ status: 'saved', revision: 6 })
      await pendingSave.promise
      await flushPreviewPersistence()
    })
    save.mockClear()

    await act(async () => {
      pendingLoad.resolve({
        revision: 5,
        state: toPersistedPreviewState({
          ...usePreviewWorkbenchStore.getState(),
          panelState: 'collapsed',
          activeItemId: undefined,
          items: [item]
        })
      })
      await pendingLoad.promise
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: item.id,
      panelState: 'open'
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('retries the latest failed state on a later flush', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    const item = createStoredFileItem()
    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: undefined,
        items: [item]
      })
    })
    await act(async () => Promise.resolve())

    const failedSave = createDeferred<void>()
    let durableState: PersistedPreviewState | undefined
    save.mockClear()
    save
      .mockImplementationOnce(() => failedSave.promise)
      .mockImplementationOnce(({ expectedRevision, state }) => {
        durableState = state
        return Promise.resolve({ status: 'saved' as const, revision: expectedRevision + 1 })
      })

    act(() => {
      usePreviewWorkbenchStore.setState({ activeItemId: item.id })
    })

    const firstFlush = flushPreviewPersistence()
    failedSave.reject(new Error('transient save failure'))
    await expect(firstFlush).rejects.toThrow('transient save failure')

    await flushPreviewPersistence()

    expect(save).toHaveBeenCalledTimes(2)
    expect(durableState?.activeItemId).toBe(item.id)
  })

  it('does not duplicate an accepted active-project snapshot on unmount', async () => {
    await act(async () => {
      root.render(<PersistenceHarness projectId="project-a" />)
    })

    const fileDialogItem = createStoredFileItem()
    if (fileDialogItem.type !== 'file') throw new Error('expected a file preview fixture')
    act(() => {
      usePreviewWorkbenchStore.setState({
        panelState: 'open',
        activeItemId: 'file:session-1:/workspace/project/report.md',
        items: [fileDialogItem]
      })
      usePreviewWorkbenchStore
        .getState()
        .openFileDialog({ ...fileDialogItem, projectId: 'project-a' })
    })

    save.mockClear()

    await act(async () => {
      root.unmount()
    })

    expect(save).not.toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
  })
})
