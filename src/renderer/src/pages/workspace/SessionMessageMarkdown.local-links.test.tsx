// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, getByRole } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookSessionReference } from '../../../../shared/notebook'
import type { UploadedAttachment } from '../../../../shared/uploads'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import type { MessageArtifact } from './session-message-artifact-reference'

vi.mock('./artifact-preview', () => ({ ArtifactPreview: () => null }))

const { SessionMessageMarkdown } = await import('./SessionMessageMarkdown')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const notebookReference: NotebookSessionReference = {
  projectId: 'project-1',
  sessionId: 'session-1',
  workspaceCwd: '/workspace',
  notebookSessionRoot: '/workspace/sessions/session-1',
  dataRoot: '/workspace/sessions/session-1/data',
  runtimeRoot: '/workspace/sessions/session-1/runtime',
  runJsonPath: '/workspace/sessions/session-1/run.json'
}

describe('SessionMessageMarkdown local file links', () => {
  let container: HTMLDivElement
  let root: Root
  let stageLocalPath: ReturnType<typeof vi.fn>
  let reveal: ReturnType<typeof vi.fn>

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSettingsStore.setState({ ...createInitialSettingsState(), isLoaded: true })
    stageLocalPath = vi.fn()
    reveal = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', {
      platform: 'darwin',
      uploads: { stageLocalPath },
      localFs: { reveal }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const clickMessageLink = async (): Promise<void> => {
    const link = container.querySelector<HTMLElement>('[data-session-message-link]')
    expect(link).not.toBeNull()
    await act(async () => link?.click())
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
  }

  const getImportDialog = (): HTMLElement =>
    getByRole(document.body, 'dialog', { name: 'Import file for preview' })

  const clickDialogButton = async (name: string): Promise<void> => {
    const button = getByRole(getImportDialog(), 'button', { name })
    await act(async () => button.click())
  }

  const createUpload = (name = '研究报告.docx'): UploadedAttachment => ({
    id: 'upload-1',
    versionId: 'upload-version-1',
    versionNumber: 1,
    sessionId: 'standalone-uploads',
    name,
    originalName: name,
    path: `/managed/uploads/${name}`,
    size: 1024
  })

  const renderFileLink = async (name = '研究报告.docx'): Promise<void> => {
    await act(async () =>
      root.render(
        <SessionMessageMarkdown
          content={`[${name}](${notebookReference.dataRoot}/${name})`}
          artifacts={[]}
          notebookReference={notebookReference}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    )
  }

  it.each([
    ['研究报告.docx', 'word'],
    ['研究笔记.md', 'markdown']
  ])(
    'imports an unregistered session-data file only after confirming: %s',
    async (name, format) => {
      const path = `${notebookReference.dataRoot}/${name}`
      stageLocalPath.mockResolvedValue(createUpload(name))
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      const props = {
        content: `[${name}](${path})`,
        artifacts: [],
        notebookReference,
        onPreviewArtifact: vi.fn(),
        onPreviewArtifactModal: vi.fn()
      }

      // Keep the real Markdown parser and SessionMessageLink safety path: a raw Unicode path is
      // URI-encoded by Markdown before reaching the link component.
      await act(async () => root.render(<SessionMessageMarkdown {...props} />))
      expect(container.textContent).toContain(name)
      await clickMessageLink()

      expect(getImportDialog().textContent).toContain(
        'This link points to a file in this conversation. Importing saves a copy in the project.'
      )
      expect(getImportDialog().textContent).toContain(name)
      expect(stageLocalPath).not.toHaveBeenCalled()
      expect(usePreviewWorkbenchStore.getState().items).toEqual([])
      await clickDialogButton('Import and preview')

      expect(
        document.body.querySelector('[role="dialog"][aria-label="Open external link?"]')
      ).toBeNull()
      expect(stageLocalPath).toHaveBeenCalledWith({
        transferId: expect.any(String),
        projectId: 'project-1',
        notebookSessionId: 'session-1',
        sourcePath: path,
        name
      })
      expect(usePreviewWorkbenchStore.getState()).toMatchObject({
        panelState: 'open',
        activeItemId: 'upload:upload-1',
        items: [
          expect.objectContaining({
            sessionId: 'standalone-uploads',
            type: 'file',
            source: 'upload',
            path: 'upload-version:project-1/standalone-uploads/upload-1/upload-version-1',
            name,
            format
          })
        ]
      })
      await clickMessageLink()
      expect(stageLocalPath).toHaveBeenCalledTimes(1)
      expect(document.body.querySelector('[data-session-data-file-dialog]')).toBeNull()
      expect(open).not.toHaveBeenCalled()
    }
  )

  it('offers import for a file in the active frame dataRoot', async () => {
    const frameRoot = `${notebookReference.notebookSessionRoot}/frames/frame-one`
    const frameReference: NotebookSessionReference = {
      ...notebookReference,
      notebookSessionRoot: frameRoot,
      dataRoot: `${frameRoot}/data`
    }
    const name = '子会话报告.docx'
    const sourcePath = `${frameReference.dataRoot}/${name}`
    stageLocalPath.mockResolvedValue(createUpload(name))
    await act(async () =>
      root.render(
        <SessionMessageMarkdown
          content={`[${name}](${sourcePath})`}
          artifacts={[]}
          notebookReference={frameReference}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    )
    await clickMessageLink()
    expect(getImportDialog()).not.toBeNull()
    expect(stageLocalPath).not.toHaveBeenCalled()
    await clickDialogButton('Import and preview')
    expect(stageLocalPath).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath,
        projectId: 'project-1',
        notebookSessionId: 'session-1'
      })
    )
    expect(usePreviewWorkbenchStore.getState().items).toEqual([
      expect.objectContaining({ source: 'upload', name, format: 'word' })
    ])
  })

  it.each([
    '/workspace/sessions/session-2/data/研究报告.docx',
    '/workspace/sessions/session-1/data-copy/研究报告.docx',
    '/workspace/sessions/session-1/data/../private/研究报告.docx',
    'https://tracking.example/研究报告.docx'
  ])('retains external-link confirmation outside the session data root: %s', async (href) => {
    const props = {
      content: `[研究报告](${href})`,
      artifacts: [],
      notebookReference,
      onPreviewArtifact: vi.fn(),
      onPreviewArtifactModal: vi.fn()
    }
    await act(async () => root.render(<SessionMessageMarkdown {...props} />))
    await clickMessageLink()

    expect(
      document.body.querySelector('[role="dialog"][aria-label="Open external link?"]')
    ).not.toBeNull()
    expect(stageLocalPath).not.toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })

  it.each(['Cancel', 'Close'])('dismisses %s without importing or previewing', async (label) => {
    await renderFileLink()
    await clickMessageLink()
    await clickDialogButton(label)

    expect(document.body.querySelector('[data-session-data-file-dialog]')).toBeNull()
    expect(stageLocalPath).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })

  it('dismisses Escape without importing or previewing', async () => {
    await renderFileLink()
    await clickMessageLink()
    await act(async () => fireEvent.keyDown(getImportDialog(), { key: 'Escape' }))

    expect(document.body.querySelector('[data-session-data-file-dialog]')).toBeNull()
    expect(stageLocalPath).not.toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })

  it('reveals the file without importing or activating a preview', async () => {
    await renderFileLink()
    await clickMessageLink()
    await clickDialogButton('Show in folder')

    expect(reveal).toHaveBeenCalledExactlyOnceWith(`${notebookReference.dataRoot}/研究报告.docx`)
    expect(stageLocalPath).not.toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })

  it('does not start a second import when confirmation is clicked twice', async () => {
    const upload = Promise.withResolvers<UploadedAttachment>()
    stageLocalPath.mockReturnValue(upload.promise)
    await renderFileLink()
    await clickMessageLink()
    const button = getByRole(getImportDialog(), 'button', { name: 'Import and preview' })
    await act(async () => {
      button.click()
      button.click()
    })

    expect(stageLocalPath).toHaveBeenCalledTimes(1)
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
    await act(async () => upload.resolve(createUpload()))
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
  })

  it('keeps an import failure in the dialog and allows a successful retry', async () => {
    stageLocalPath
      .mockRejectedValueOnce(new Error('File not found'))
      .mockResolvedValueOnce(createUpload())
    await renderFileLink()
    await clickMessageLink()
    await clickDialogButton('Import and preview')

    expect(getByRole(getImportDialog(), 'alert').textContent).toContain('File not found')
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
    await clickDialogButton('Import and preview')

    expect(stageLocalPath).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[data-session-data-file-dialog]')).toBeNull()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
  })

  it('does not activate an import that finishes after the message is unmounted', async () => {
    const upload = Promise.withResolvers<UploadedAttachment>()
    stageLocalPath.mockReturnValue(upload.promise)
    await renderFileLink()
    await clickMessageLink()
    await clickDialogButton('Import and preview')
    await act(async () => root.render(null))
    await act(async () => upload.resolve(createUpload()))

    expect(stageLocalPath).toHaveBeenCalledTimes(1)
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })

  it('keeps a registered managed artifact on its existing preview path', async () => {
    const artifact: MessageArtifact = {
      id: 'version-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      isPublished: true,
      kind: 'managed-file',
      path: `${notebookReference.dataRoot}/研究报告.docx`,
      name: '研究报告.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 1024,
      mtimeMs: 1710000000000,
      resolvedProjectId: 'project-1',
      resolvedSessionId: 'session-1'
    }
    const onPreviewArtifact = vi.fn()
    const props = {
      content: `[研究报告](${artifact.path})`,
      artifacts: [artifact],
      notebookReference,
      onPreviewArtifact,
      onPreviewArtifactModal: vi.fn()
    }
    await act(async () => root.render(<SessionMessageMarkdown {...props} />))
    await clickMessageLink()

    expect(onPreviewArtifact).toHaveBeenCalledWith(artifact)
    expect(stageLocalPath).not.toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
    expect(
      document.body.querySelector('[role="dialog"][aria-label="Open external link?"]')
    ).toBeNull()
  })
})
