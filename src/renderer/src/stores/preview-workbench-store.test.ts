import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createNotebookPreviewItem,
  createProjectFilesPreviewItem,
  createInitialPreviewWorkbenchState,
  PROJECT_FILES_PREVIEW_ID,
  usePreviewWorkbenchStore
} from './preview-workbench-store'

type PreviewItemInput = Parameters<
  ReturnType<typeof usePreviewWorkbenchStore.getState>['upsertAndActivateItem']
>[0]

describe('preview workbench store', () => {
  // Reset transient preview state so each assertion starts from an empty workbench.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-04T08:00:00.000Z'))
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  })

  it('starts with the preview panel collapsed', () => {
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      panelState: 'collapsed',
      openRequestVersion: 0,
      items: []
    })
  })

  it('stores file preview items in one ordered list', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-1:/workspace/project/report.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'report.md',
      path: '/workspace/project/report.md',
      format: 'markdown',
      name: 'report.md'
    })
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-2:/workspace/project/summary.json',
      sessionId: 'session-2',
      type: 'file',
      title: 'summary.json',
      path: '/workspace/project/summary.json',
      format: 'json',
      name: 'summary.json'
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: 'file:session-2:/workspace/project/summary.json',
      panelState: 'open',
      openRequestVersion: 2,
      items: [
        {
          id: 'file:session-1:/workspace/project/report.md',
          type: 'file',
          sessionId: 'session-1',
          path: '/workspace/project/report.md',
          format: 'markdown',
          name: 'report.md',
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          id: 'file:session-2:/workspace/project/summary.json',
          type: 'file',
          sessionId: 'session-2',
          path: '/workspace/project/summary.json',
          format: 'json',
          name: 'summary.json',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ]
    })
  })

  it('updates an existing item without duplicating it', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-1:/workspace/project/report.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'report.md',
      path: '/workspace/project/report.md',
      format: 'markdown',
      name: 'report.md'
    })

    vi.advanceTimersByTime(1000)
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-1:/workspace/project/report.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'Report',
      path: '/workspace/project/report.md',
      format: 'markdown',
      name: 'report.md'
    })

    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      id: 'file:session-1:/workspace/project/report.md',
      title: 'Report',
      createdAt: new Date('2026-07-04T08:00:00.000Z').getTime(),
      updatedAt: Date.now()
    })
  })

  it('owns preview item timestamps instead of trusting caller input', () => {
    const itemWithCallerTimestamps = {
      id: 'file:session-1:/workspace/project/report.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'report.md',
      path: '/workspace/project/report.md',
      format: 'markdown',
      name: 'report.md',
      createdAt: 1,
      updatedAt: 2
    } as unknown as PreviewItemInput

    usePreviewWorkbenchStore.getState().upsertAndActivateItem(itemWithCallerTimestamps)

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  })

  it('allows a generic tool preview item without assuming tool-specific fields', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'tool:session-1:tool-1',
      sessionId: 'session-1',
      type: 'tool',
      title: 'Tool preview'
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      id: 'tool:session-1:tool-1',
      sessionId: 'session-1',
      type: 'tool',
      title: 'Tool preview',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  })

  it('creates a stable notebook preview item from a notebook session reference', () => {
    const notebookItem = createNotebookPreviewItem({
      sessionId: 'session-1',
      projectName: 'default-project',
      workspaceCwd: '/workspace',
      notebookSessionRoot: '/home/.open-science/notebooks/default-project/session-1',
      dataRoot: '/home/.open-science/notebooks/default-project/session-1/data',
      runtimeRoot: '/home/.open-science/runtime',
      runJsonPath: '/home/.open-science/notebooks/default-project/session-1/run.json'
    })

    usePreviewWorkbenchStore.getState().upsertAndActivateItem(notebookItem)

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: 'tool:session-1:notebook',
      panelState: 'open',
      items: [
        {
          id: 'tool:session-1:notebook',
          sessionId: 'session-1',
          type: 'tool',
          toolKind: 'notebook',
          title: 'Notebook',
          notebook: {
            runJsonPath: '/home/.open-science/notebooks/default-project/session-1/run.json'
          }
        }
      ]
    })
  })

  it('creates a stable project files preview item that survives session cleanup', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-1:/workspace/project/report.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'report.md',
      path: '/workspace/project/report.md',
      format: 'markdown',
      name: 'report.md'
    })
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createProjectFilesPreviewItem())

    usePreviewWorkbenchStore.getState().removeSessionItems('session-1')

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: PROJECT_FILES_PREVIEW_ID,
      items: [
        {
          id: PROJECT_FILES_PREVIEW_ID,
          sessionId: '__project_files__',
          type: 'tool',
          toolKind: 'files',
          title: 'Files'
        }
      ]
    })
  })

  it('repairs the active item when the current preview is removed', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-1:/workspace/project/a.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'a.md',
      path: '/workspace/project/a.md',
      format: 'markdown',
      name: 'a.md'
    })
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-1:/workspace/project/b.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'b.md',
      path: '/workspace/project/b.md',
      format: 'markdown',
      name: 'b.md'
    })

    usePreviewWorkbenchStore.getState().removeItem('file:session-1:/workspace/project/b.md')

    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'file:session-1:/workspace/project/a.md'
    )

    usePreviewWorkbenchStore.getState().removeItem('file:session-1:/workspace/project/a.md')

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      items: [],
      activeItemId: undefined
    })
  })

  it('removes all preview items for a deleted session', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-1:/workspace/project/report.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'report.md',
      path: '/workspace/project/report.md',
      format: 'markdown',
      name: 'report.md'
    })
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-2:/workspace/project/summary.json',
      sessionId: 'session-2',
      type: 'file',
      title: 'summary.json',
      path: '/workspace/project/summary.json',
      format: 'json',
      name: 'summary.json'
    })

    usePreviewWorkbenchStore.getState().removeSessionItems('session-2')

    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.sessionId)).toEqual([
      'session-1'
    ])
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'file:session-1:/workspace/project/report.md'
    )
  })

  it('tracks manual panel state separately from preview item data', () => {
    usePreviewWorkbenchStore.getState().openPanel()
    usePreviewWorkbenchStore.getState().collapsePanel()
    usePreviewWorkbenchStore.getState().togglePanel()

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      panelState: 'open',
      openRequestVersion: 2,
      items: []
    })
  })

  it('stashes and restores each project preview slice when switching projects', () => {
    const store = usePreviewWorkbenchStore.getState()

    store.activateProject('project-a')
    store.upsertAndActivateItem(createProjectFilesPreviewItem())
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)

    // Switching to another project hides project-a's tabs entirely.
    store.activateProject('project-b')
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-b',
      items: [],
      activeItemId: undefined,
      panelState: 'collapsed'
    })

    // Switching back restores project-a's stashed slice.
    store.activateProject('project-a')
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-a',
      activeItemId: PROJECT_FILES_PREVIEW_ID,
      panelState: 'open'
    })
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
  })

  it('seeds a project slice from restored persistence on first activation', () => {
    usePreviewWorkbenchStore.getState().activateProject('project-a', {
      panelState: 'open',
      activeItemId: 'file:session-1:/workspace/project/report.md',
      items: [
        {
          id: 'file:session-1:/workspace/project/report.md',
          sessionId: 'session-1',
          type: 'file',
          title: 'report.md',
          path: '/workspace/project/report.md',
          format: 'markdown',
          name: 'report.md'
        }
      ]
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-a',
      panelState: 'open',
      activeItemId: 'file:session-1:/workspace/project/report.md',
      items: [{ id: 'file:session-1:/workspace/project/report.md', createdAt: Date.now() }]
    })
  })

  it('repairs a dangling restored active item to the first surviving tab', () => {
    usePreviewWorkbenchStore.getState().activateProject('project-a', {
      panelState: 'open',
      activeItemId: 'tool:gone:notebook',
      items: [
        {
          id: 'file:session-1:/workspace/project/report.md',
          sessionId: 'session-1',
          type: 'file',
          title: 'report.md',
          path: '/workspace/project/report.md',
          format: 'markdown',
          name: 'report.md'
        }
      ]
    })

    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'file:session-1:/workspace/project/report.md'
    )
  })
})
