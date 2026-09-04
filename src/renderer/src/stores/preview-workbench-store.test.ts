import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getUploadedAttachmentPath } from '../../../shared/uploads'
import { planTestProjection } from '../pages/workspace/session-plan/plan-test-fixtures'
import { previewLeaveGuards } from './preview-leave-guard'
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
    previewLeaveGuards.clear()
    useSessionStore.setState({ sessions: [] })
  })

  it('refreshes a file tab recency timestamp when it becomes active', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.upsertAndActivateItem({
      id: 'file-1',
      sessionId: 'session-1',
      type: 'file',
      title: 'one.md',
      path: '/one.md',
      format: 'markdown',
      name: 'one.md'
    })
    store.upsertAndActivateItem({
      id: 'file-2',
      sessionId: 'session-1',
      type: 'file',
      title: 'two.md',
      path: '/two.md',
      format: 'markdown',
      name: 'two.md'
    })
    const previousTimestamp = usePreviewWorkbenchStore
      .getState()
      .items.find((item) => item.id === 'file-1')?.updatedAt
    vi.advanceTimersByTime(1_000)

    store.activateItem('file-1')

    expect(
      usePreviewWorkbenchStore.getState().items.find((item) => item.id === 'file-1')?.updatedAt
    ).toBe(Date.now())
    expect(Date.now()).toBeGreaterThan(previousTimestamp ?? 0)
  })

  it('does not switch, remove, collapse, or close a dialog when its active draft rejects leaving', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.activateProject('project-a')
    store.upsertAndActivateItem({
      id: 'file-1',
      sessionId: 'session-1',
      type: 'file',
      title: 'one.md',
      path: '/one.md',
      format: 'markdown',
      name: 'one.md'
    })
    store.upsertItem({
      id: 'file-2',
      sessionId: 'session-1',
      type: 'file',
      title: 'two.md',
      path: '/two.md',
      format: 'markdown',
      name: 'two.md'
    })
    const unregisterWorkbench = previewLeaveGuards.register(
      'workbench:project-a:file-1',
      () => false
    )

    store.activateItem('file-2')
    store.upsertAndActivateItem({
      id: 'file-3',
      sessionId: 'session-1',
      type: 'file',
      title: 'three.md',
      path: '/three.md',
      format: 'markdown',
      name: 'three.md'
    })
    store.upsertAndActivateItem({
      id: 'file-1',
      sessionId: 'session-1',
      type: 'file',
      title: 'one.md',
      path: '/one-v2.md',
      format: 'markdown',
      name: 'one.md',
      selectedVersionId: 'version-2'
    })
    store.removeItem('file-1')
    store.collapsePanel()
    store.syncPanelState('collapsed')
    store.removeSessionItems('session-1')
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: 'file-1',
      panelState: 'open'
    })
    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toContain('file-1')
    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).not.toContain('file-3')
    const retainedFile = usePreviewWorkbenchStore
      .getState()
      .items.find((item) => item.id === 'file-1')
    expect(retainedFile).toMatchObject({ path: '/one.md' })
    expect(retainedFile).not.toHaveProperty('selectedVersionId')

    unregisterWorkbench()
    const dialogItem = {
      id: 'dialog-1',
      projectId: 'project-a',
      sessionId: 'session-1',
      type: 'file' as const,
      title: 'dialog.md',
      path: '/dialog.md',
      format: 'markdown' as const,
      name: 'dialog.md'
    }
    store.openFileDialog(dialogItem)
    previewLeaveGuards.register('dialog:project-a:dialog-1', () => false)
    store.openFileDialog({ ...dialogItem, id: 'dialog-2', name: 'other.md', title: 'other.md' })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem?.id).toBe('dialog-1')
    store.closeFileDialog()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem?.id).toBe('dialog-1')
    store.removeSessionItems('session-1')
    expect(usePreviewWorkbenchStore.getState().fileDialogItem?.id).toBe('dialog-1')
  })

  it('guards same-id workbench and dialog locator replacements and applies them only after acceptance', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.activateProject('project-a')
    const workbenchItem = {
      id: 'upload:file-1',
      projectId: 'project-a',
      sessionId: 'session-1',
      type: 'file' as const,
      source: 'upload' as const,
      managedFileId: 'file-1',
      selectedVersionId: 'version-1',
      title: 'README.md',
      path: 'upload-version:project-a/session-1/version-1',
      format: 'markdown' as const,
      name: 'README.md'
    }
    store.upsertAndActivateItem(workbenchItem)
    const rejectWorkbench = previewLeaveGuards.register(
      'workbench:project-a:upload:file-1',
      () => false
    )

    store.upsertItem({
      ...workbenchItem,
      selectedVersionId: 'version-2',
      path: 'upload-version:project-a/session-1/version-2'
    })
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'version-1',
      path: 'upload-version:project-a/session-1/version-1'
    })
    rejectWorkbench()
    previewLeaveGuards.register('workbench:project-a:upload:file-1', () => true)
    store.upsertItem({
      ...workbenchItem,
      selectedVersionId: 'version-2',
      path: 'upload-version:project-a/session-1/version-2'
    })
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'version-2',
      path: 'upload-version:project-a/session-1/version-2'
    })

    store.openFileDialog(workbenchItem)
    const rejectDialog = previewLeaveGuards.register('dialog:project-a:upload:file-1', () => false)
    store.openFileDialog({
      ...workbenchItem,
      selectedVersionId: 'version-3',
      path: 'upload-version:project-a/session-1/version-3'
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      selectedVersionId: 'version-1',
      path: 'upload-version:project-a/session-1/version-1'
    })
    rejectDialog()
    previewLeaveGuards.register('dialog:project-a:upload:file-1', () => true)
    store.openFileDialog({
      ...workbenchItem,
      selectedVersionId: 'version-3',
      path: 'upload-version:project-a/session-1/version-3'
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      selectedVersionId: 'version-3',
      path: 'upload-version:project-a/session-1/version-3'
    })
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
          { id: 'upload-b', versionId: 'version-b', sessionId: 'session-b' },
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
          { id: 'upload-a', versionId: 'version-a', sessionId: 'session-a' },
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

  it('preserves a rejected active upload while reconciling other finalized tabs', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.activateProject('project-b')
    store.upsertAndActivateItem({
      id: 'upload:upload-c',
      projectId: 'project-b',
      sessionId: '.pending',
      type: 'file',
      source: 'upload',
      managedFileId: 'upload-c',
      title: 'c.md',
      path: '/uploads/default-project/.pending/c.md',
      format: 'markdown',
      name: 'c.md'
    })
    store.activateProject('project-a')
    store.upsertAndActivateItem({
      id: 'upload:upload-a',
      projectId: 'project-a',
      sessionId: '.pending',
      type: 'file',
      source: 'upload',
      managedFileId: 'upload-a',
      title: 'a.md',
      path: '/uploads/default-project/.pending/a.md',
      format: 'markdown',
      name: 'a.md'
    })
    store.upsertItem({
      id: 'upload:upload-b',
      projectId: 'project-a',
      sessionId: '.pending',
      type: 'file',
      source: 'upload',
      managedFileId: 'upload-b',
      title: 'b.md',
      path: '/uploads/default-project/.pending/b.md',
      format: 'markdown',
      name: 'b.md'
    })
    previewLeaveGuards.register('workbench:project-a:upload:upload-a', () => false)

    store.reconcileFinalizedUploads([
      {
        id: 'upload-a',
        versionId: 'version-a',
        sessionId: 'session-a',
        name: 'a.md',
        originalName: 'a.md',
        path: '/uploads/default-project/session-a/a.md',
        mimeType: 'text/markdown',
        size: 12
      },
      {
        id: 'upload-b',
        versionId: 'version-b',
        sessionId: 'session-b',
        name: 'b.md',
        originalName: 'b.md',
        path: '/uploads/default-project/session-b/b.md',
        mimeType: 'text/markdown',
        size: 12
      },
      {
        id: 'upload-c',
        versionId: 'version-c',
        sessionId: 'session-c',
        name: 'c.md',
        originalName: 'c.md',
        path: '/uploads/default-project/session-c/c.md',
        mimeType: 'text/markdown',
        size: 12
      }
    ])

    const state = usePreviewWorkbenchStore.getState()
    expect(state.items.find((item) => item.id === 'upload:upload-a')).toMatchObject({
      sessionId: '.pending',
      path: '/uploads/default-project/.pending/a.md'
    })
    expect(state.items.find((item) => item.id === 'upload:upload-b')).toMatchObject({
      sessionId: 'session-b',
      path: getUploadedAttachmentPath(
        { id: 'upload-b', versionId: 'version-b', sessionId: 'session-b' },
        'project-a'
      )
    })
    expect(state.byProject['project-b']?.items[0]).toMatchObject({
      sessionId: 'session-c',
      path: getUploadedAttachmentPath(
        { id: 'upload-c', versionId: 'version-c', sessionId: 'session-c' },
        'project-b'
      )
    })
  })

  it('keeps a staged PDF selection until its Session context link succeeds', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.setPendingPdfContext('project-a', {
      kind: 'staged-upload',
      attachmentId: 'upload-a',
      previewItemId: 'upload:upload-a'
    })

    store.reconcileFinalizedUploads([
      {
        id: 'upload-a',
        versionId: 'version-a',
        sessionId: 'session-a',
        name: 'paper.pdf',
        originalName: 'paper.pdf',
        path: '/uploads/project-a/session-a/paper.pdf',
        mimeType: 'application/pdf',
        size: 12
      }
    ])

    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['project-a']).toEqual({
      kind: 'staged-upload',
      attachmentId: 'upload-a',
      previewItemId: 'upload:upload-a'
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

  it('closes every other tab and activates the kept one', () => {
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
    usePreviewWorkbenchStore.getState().upsertItem({
      id: 'tool:session-1:notebook',
      sessionId: 'session-1',
      type: 'tool',
      toolKind: 'notebook',
      title: 'Notebook'
    })

    usePreviewWorkbenchStore.getState().removeOtherItems('file:session-1:/workspace/project/b.md')

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      items: [expect.objectContaining({ id: 'file:session-1:/workspace/project/b.md' })],
      activeItemId: 'file:session-1:/workspace/project/b.md',
      panelState: 'open'
    })
  })

  it('keeps all tabs when the active preview rejects close-others', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.activateProject('project-a')
    store.upsertAndActivateItem({
      id: 'file-a',
      sessionId: 'session-1',
      type: 'file',
      title: 'a.md',
      path: '/workspace/project/a.md',
      format: 'markdown',
      name: 'a.md'
    })
    store.upsertItem({
      id: 'file-b',
      sessionId: 'session-1',
      type: 'file',
      title: 'b.md',
      path: '/workspace/project/b.md',
      format: 'markdown',
      name: 'b.md'
    })
    previewLeaveGuards.register('workbench:project-a:file-a', () => false)

    expect(store.removeOtherItems('file-b')).toBe(false)
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: 'file-a',
      items: [expect.objectContaining({ id: 'file-a' }), expect.objectContaining({ id: 'file-b' })]
    })
  })

  it('closing others clears the expanded surface only when its tab is closed', () => {
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createProjectFilesPreviewItem())
    usePreviewWorkbenchStore.getState().upsertItem({
      id: 'file:session-1:/workspace/project/a.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'a.md',
      path: '/workspace/project/a.md',
      format: 'markdown',
      name: 'a.md'
    })
    usePreviewWorkbenchStore.getState().setToolItemExpanded(PROJECT_FILES_PREVIEW_ID)
    usePreviewWorkbenchStore.getState().openFileDialog({
      id: 'artifact-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      type: 'file',
      title: 'result.png',
      path: 'artifact-version:project-1/session-1/artifact-1/version-1',
      format: 'image',
      name: 'result.png'
    })

    // Keeping the Files tab preserves both the expanded surface and the file dialog.
    usePreviewWorkbenchStore.getState().removeOtherItems(PROJECT_FILES_PREVIEW_ID)

    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBe(PROJECT_FILES_PREVIEW_ID)
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({ id: 'artifact-1' })

    // Reopen the closed tab, then keep the file tab instead: the Files-owned state must drop.
    usePreviewWorkbenchStore.getState().upsertItem({
      id: 'file:session-1:/workspace/project/a.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'a.md',
      path: '/workspace/project/a.md',
      format: 'markdown',
      name: 'a.md'
    })
    usePreviewWorkbenchStore.getState().setToolItemExpanded(PROJECT_FILES_PREVIEW_ID)

    usePreviewWorkbenchStore.getState().removeOtherItems('file:session-1:/workspace/project/a.md')

    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBeNull()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
  })

  it('ignores close-others for a tab that is not open', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'file:session-1:/workspace/project/a.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'a.md',
      path: '/workspace/project/a.md',
      format: 'markdown',
      name: 'a.md'
    })

    usePreviewWorkbenchStore.getState().removeOtherItems('missing-item')

    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'file:session-1:/workspace/project/a.md'
    )
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

  it('hydrates a persisted slice after navigation has atomically activated an empty project scope', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.activateProject('project-a')

    store.activateProject('project-a', {
      panelState: 'open',
      activeItemId: 'restored-file',
      items: [
        {
          id: 'restored-file',
          sessionId: 'session-a',
          type: 'file',
          title: 'restored.md',
          path: '/restored.md',
          format: 'markdown',
          name: 'restored.md'
        }
      ]
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-a',
      activeItemId: 'restored-file',
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

  it('replaces durable tabs without dropping active runtime-only tabs', () => {
    const store = usePreviewWorkbenchStore.getState()
    store.activateProject('project-a')
    store.upsertAndActivateItem(createProjectFilesPreviewItem())
    store.setToolItemExpanded(PROJECT_FILES_PREVIEW_ID)

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
      activeItemId: PROJECT_FILES_PREVIEW_ID,
      expandedToolItemId: PROJECT_FILES_PREVIEW_ID,
      items: [{ id: 'file:session-2:/workspace/results.csv' }, { id: PROJECT_FILES_PREVIEW_ID }]
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
