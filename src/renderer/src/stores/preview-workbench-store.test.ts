import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getUploadedAttachmentPath } from '../../../shared/uploads'

import { planTestProjection } from '../pages/workspace/session-plan/plan-test-fixtures'

import { useSessionStore } from './session-store'
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
    useSessionStore.setState({ sessions: [] })
  })

  it('starts with the preview panel collapsed', () => {
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      panelState: 'collapsed',
      openRequestVersion: 0,
      items: []
    })
  })

  it('owns one transient file dialog independent of preview tabs', () => {
    const item = {
      id: 'artifact-1',
      projectId: 'project-a',
      sessionId: 'session-1',
      type: 'file' as const,
      title: 'sin.png',
      path: 'artifact-version:project-a/session-1/artifact-1/version-1',
      format: 'image' as const,
      name: 'sin.png'
    }

    usePreviewWorkbenchStore.getState().openFileDialog(item)

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      fileDialogItem: item,
      items: []
    })

    usePreviewWorkbenchStore.getState().closeFileDialog()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
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

  it('collapses the panel when the last preview item is removed', () => {
    const store = usePreviewWorkbenchStore.getState()
    const item = createProjectFilesPreviewItem()

    store.upsertAndActivateItem(item)
    store.removeItem(item.id)

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      items: [],
      activeItemId: undefined,
      panelState: 'collapsed'
    })
  })

  it('does not restore an open panel state when the restored preview list is empty', () => {
    usePreviewWorkbenchStore.getState().activateProject('project-a', {
      panelState: 'open',
      items: []
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      items: [],
      panelState: 'collapsed'
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

  it('selects the first passively discovered preview without opening the panel', () => {
    const notebookItem = createNotebookPreviewItem({
      sessionId: 'session-1',
      projectId: 'default-project',
      workspaceCwd: '/workspace',
      notebookSessionRoot: '/notebooks/session-1',
      dataRoot: '/notebooks/session-1/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/notebooks/session-1/run.json'
    })

    usePreviewWorkbenchStore.getState().upsertItem(notebookItem)

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: notebookItem.id,
      panelState: 'collapsed',
      openRequestVersion: 0
    })
  })

  it('reconciles finalized upload paths across project slices without opening new tabs', () => {
    const store = usePreviewWorkbenchStore.getState()

    store.activateProject('project-a')
    store.upsertAndActivateItem({
      id: 'upload:upload-a',
      projectId: 'project-a',
      sessionId: '.pending',
      type: 'file',
      source: 'upload',
      title: 'a.csv',
      path: '/uploads/default-project/.pending/a.csv',
      format: 'csv',
      name: 'a.csv'
    })
    store.activateProject('project-b')
    store.upsertAndActivateItem({
      id: 'upload:upload-b',
      projectId: 'project-b',
      sessionId: '.pending',
      type: 'file',
      source: 'upload',
      title: 'b.csv',
      path: '/uploads/default-project/.pending/b.csv',
      format: 'csv',
      name: 'b.csv'
    })

    usePreviewWorkbenchStore.getState().reconcileFinalizedUploads([
      {
        id: 'upload-a',
        versionId: 'version-a',
        sessionId: 'session-a',
        name: 'a.csv',
        originalName: 'a.csv',
        path: '/uploads/default-project/session-a/a.csv',
        mimeType: 'text/csv',
        size: 12
      },
      {
        id: 'upload-b',
        versionId: 'version-b',
        sessionId: 'session-b',
        name: 'b.csv',
        originalName: 'b.csv',
        path: '/uploads/default-project/session-b/b.csv',
        mimeType: 'text/csv',
        size: 12
      },
      {
        id: 'upload-never-opened',
        versionId: 'version-hidden',
        sessionId: 'session-b',
        name: 'hidden.csv',
        originalName: 'hidden.csv',
        path: '/uploads/default-project/session-b/hidden.csv',
        mimeType: 'text/csv',
        size: 12
      }
    ])

    expect(usePreviewWorkbenchStore.getState().items).toMatchObject([
      {
        id: 'upload:upload-b',
        sessionId: 'session-b',
        path: getUploadedAttachmentPath(
          { versionId: 'version-b', sessionId: 'session-b' },
          'project-b'
        )
      }
    ])

    usePreviewWorkbenchStore.getState().activateProject('project-a')
    expect(usePreviewWorkbenchStore.getState().items).toMatchObject([
      {
        id: 'upload:upload-a',
        sessionId: 'session-a',
        path: getUploadedAttachmentPath(
          { versionId: 'version-a', sessionId: 'session-a' },
          'project-a'
        )
      }
    ])
    expect(
      usePreviewWorkbenchStore
        .getState()
        .items.some((item) => item.id === 'upload:upload-never-opened')
    ).toBe(false)
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
      projectId: 'default-project',
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

  it('tracks the expanded tool item and clears it when the tab is removed', () => {
    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBeNull()

    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createProjectFilesPreviewItem())
    usePreviewWorkbenchStore.getState().setToolItemExpanded(PROJECT_FILES_PREVIEW_ID)

    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBe(PROJECT_FILES_PREVIEW_ID)

    usePreviewWorkbenchStore.getState().setToolItemExpanded(null)

    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBeNull()

    usePreviewWorkbenchStore.getState().setToolItemExpanded(PROJECT_FILES_PREVIEW_ID)
    usePreviewWorkbenchStore.getState().openFileDialog({
      id: 'artifact-1',
      projectId: 'project-a',
      sessionId: 'session-1',
      type: 'file',
      title: 'result.png',
      path: 'artifact-version:project-a/session-1/artifact-1/version-1',
      format: 'image',
      name: 'result.png'
    })
    usePreviewWorkbenchStore.getState().removeItem(PROJECT_FILES_PREVIEW_ID)

    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBeNull()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
  })

  it('clears the expanded tool item when its session is removed', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'tool:session-1:notebook',
      sessionId: 'session-1',
      type: 'tool',
      toolKind: 'notebook',
      title: 'Notebook'
    })
    usePreviewWorkbenchStore.getState().setToolItemExpanded('tool:session-1:notebook')

    usePreviewWorkbenchStore.getState().removeSessionItems('session-1')

    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBeNull()
  })

  it('clears the expanded tool item when switching projects', () => {
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createProjectFilesPreviewItem())
    usePreviewWorkbenchStore.getState().setToolItemExpanded(PROJECT_FILES_PREVIEW_ID)

    usePreviewWorkbenchStore.getState().activateProject('project-2')

    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBeNull()
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
    usePreviewWorkbenchStore.getState().togglePanel()

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      panelState: 'collapsed',
      openRequestVersion: 0,
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

  it('adds the active project scope to file tabs when callers omit it', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.activateProject('project-a')
    store.upsertAndActivateItem({
      id: 'upload:upload-a',
      sessionId: 'session-a',
      type: 'file',
      source: 'upload',
      title: 'a.csv',
      path: 'upload-version:version-a',
      format: 'csv',
      name: 'a.csv'
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      projectId: 'project-a',
      sessionId: 'session-a'
    })
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
      items: [
        {
          id: 'file:session-1:/workspace/project/report.md',
          projectId: 'project-a',
          createdAt: Date.now()
        }
      ]
    })
  })

  it('replaces an active project slice when persistence resolves a conflict', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.activateProject('project-a')
    store.upsertAndActivateItem(createProjectFilesPreviewItem())

    store.activateProject('project-a', {
      panelState: 'open',
      activeItemId: 'file:session-2:/workspace/results.csv',
      items: [
        {
          id: 'file:session-2:/workspace/results.csv',
          sessionId: 'session-2',
          type: 'file',
          title: 'results.csv',
          path: '/workspace/results.csv',
          format: 'csv',
          name: 'results.csv'
        }
      ]
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-a',
      activeItemId: 'file:session-2:/workspace/results.csv',
      items: [{ id: 'file:session-2:/workspace/results.csv' }]
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

  // Single version identity shared by the file item, the stored projection, and the assertions.
  const planArtifactVersionId = 'version-1'
  const planArtifactFileItem = {
    id: 'file-plan',
    sessionId: 'session-1',
    type: 'file' as const,
    title: `plan-${planArtifactVersionId}.json`,
    path: `artifact-version:project-a/session-1/artifact-1/${planArtifactVersionId}`,
    format: 'json' as const,
    name: 'plan-cedc6ffa.json',
    selectedVersionId: planArtifactVersionId
  }
  const expectedPlanTabId = `tool:${planArtifactFileItem.sessionId}:plan:${planArtifactVersionId}`

  it('activates the Session Plan tool tab when a stored Plan artifact file is opened', () => {
    useSessionStore.setState({
      sessions: [
        {
          id: planArtifactFileItem.sessionId,
          projectId: 'project-a',
          activePlanProjection: planTestProjection(planArtifactVersionId)
        } as never
      ]
    })

    usePreviewWorkbenchStore.getState().upsertAndActivateItem(planArtifactFileItem)

    const state = usePreviewWorkbenchStore.getState()
    // One Plan, one tab: the file entry reuses the same version-scoped tab as "view plan".
    expect(state.activeItemId).toBe(expectedPlanTabId)
    expect(state.items.map((item) => item.id)).toEqual([expectedPlanTabId])
  })

  it('keeps unmatched plan-like files as ordinary file previews', () => {
    useSessionStore.setState({
      sessions: [
        {
          id: planArtifactFileItem.sessionId,
          projectId: 'project-a',
          activePlanProjection: planTestProjection('version-unrelated')
        } as never
      ]
    })

    usePreviewWorkbenchStore.getState().upsertAndActivateItem(planArtifactFileItem)

    const state = usePreviewWorkbenchStore.getState()
    expect(state.activeItemId).toBe(planArtifactFileItem.id)
    expect(state.items.map((item) => item.id)).toEqual([planArtifactFileItem.id])
  })
})
