// @vitest-environment jsdom
import { waitFor } from '@testing-library/react'
import JSZip from 'jszip'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlateEditor } from 'platejs/react'

import { i18next } from '@/i18n'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import {
  createInitialPreviewWorkbenchState,
  type PreviewFileItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import type {
  ManagedFileVersionDescriptor,
  ManagedFileVersionInspectResult
} from '../../../../shared/managed-file-versions'
import {
  convertDocxBytesToMarkdown,
  convertMarkdownToDocxBytes
} from './markdown-document/docx-codec'
import { parseMarkdownDocument } from './markdown-document/markdown-codec'

const markdownEditors = vi.hoisted(() => [] as unknown[])
const previewContentSpy = vi.hoisted(() => vi.fn())

vi.mock('platejs/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('platejs/react')>()
  const createPlateEditor = vi.fn(actual.createPlateEditor)
  createPlateEditor.mockImplementation((options) => {
    const editor = actual.createPlateEditor(options)
    if (editor.plugins.markdownLiveInput) markdownEditors.push(editor)
    return editor
  })
  return { ...actual, createPlateEditor }
})

vi.mock('./ArtifactProvenancePanel', () => ({
  ArtifactProvenancePanel: (props: { onClose: () => void }) => (
    <div data-testid="provenance-panel">
      <button type="button" onClick={props.onClose}>
        Close Provenance
      </button>
    </div>
  )
}))

vi.mock('./previews/PreviewFileContent', () => ({
  PreviewFileContent: (props: {
    item: PreviewFileItem
    docxVersionNavigation?: ReactNode
  }) => {
    previewContentSpy(props)
    return (
      <div data-testid="preview-content" data-path={props.item.path}>
        {props.docxVersionNavigation}
        Word preview content
      </div>
    )
  }
}))

import { PreviewFileSurface } from './PreviewFileSurface'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
}
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {
      /* no-op shim for Radix layout measurement in jsdom */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
}

const docxItem: PreviewFileItem = {
  id: 'artifact-docx-1',
  artifactId: 'artifact-docx-1',
  managedFileId: 'artifact-docx-1',
  selectedVersionId: 'docx-v2',
  projectId: 'project-1',
  sessionId: 'session-1',
  type: 'file',
  title: 'report.docx',
  name: 'report.docx',
  path: '/managed/report.docx',
  format: 'word',
  source: 'artifact'
}

const createDocxVersionSummary = (
  id: string,
  versionNumber: number,
  basedOnVersionId: string | null = null
): ManagedFileVersionDescriptor => ({
  id,
  source: 'artifact' as const,
  fileId: 'artifact-docx-1',
  versionNumber,
  displayName: 'report.docx',
  originKind: versionNumber === 1 ? ('agent_generated' as const) : ('user_edit' as const),
  basedOnVersionId,
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sizeBytes: 4096,
  checksum: `checksum-${versionNumber}`,
  createdAt: `2026-08-1${versionNumber}T00:00:00.000Z`
})

const createDocxInspect = (
  overrides: Partial<ManagedFileVersionInspectResult> = {}
): ManagedFileVersionInspectResult => ({
  source: 'artifact' as const,
  projectId: 'project-1',
  fileId: 'artifact-docx-1',
  sessionId: 'session-1',
  displayName: 'report.docx',
  headVersionId: 'docx-v2',
  selectedVersionId: 'docx-v2',
  versions: [
    createDocxVersionSummary('docx-v1', 1, null),
    createDocxVersionSummary('docx-v2', 2, 'docx-v1')
  ],
  canEdit: false,
  canDiff: false,
  unavailableReason: 'NOT_EDITABLE_EXTENSION' as const,
  ...overrides
})

describe('PreviewFileSurface DOCX rich-text editing', () => {
  let container: HTMLDivElement
  let root: Root
  let currentDocxBytes: Uint8Array
  let inspectMock: ReturnType<typeof vi.fn>
  let saveBinaryEditMock: ReturnType<typeof vi.fn>
  let acquireMock: ReturnType<typeof vi.fn>
  let readRangeMock: ReturnType<typeof vi.fn>
  let releaseMock: ReturnType<typeof vi.fn>
  let clipboardWriteTextMock: ReturnType<typeof vi.fn>

  const click = async (element: HTMLElement | null): Promise<void> => {
    if (!element) throw new Error('Target element not found')
    await act(async () => {
      element.click()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const findButtonByLabel = (label: string): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

  const findButtonByText = (textContent: string): HTMLButtonElement | null =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === textContent
    ) ?? null

  const replaceRichEditorMarkdown = async (markdown: string): Promise<void> => {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="markdown-plate-editor"]')).not.toBeNull()
    })
    const parsed = parseMarkdownDocument(markdown)
    if (parsed.mode !== 'rich') throw new Error('Expected rich Markdown input')
    const editor = markdownEditors.at(-1) as PlateEditor | undefined
    if (!editor) throw new Error('Plate editor instance not found')
    await act(async () => {
      editor.tf.withoutNormalizing(() => {
        for (let index = editor.children.length - 1; index >= 0; index -= 1) {
          editor.tf.removeNodes({ at: [index] })
        }
        editor.tf.insertNodes(parsed.value, { at: [0], select: true })
      })
    })
  }

  const discardDialog = (): HTMLElement | null =>
    document.body.querySelector('[data-testid="discard-preview-changes-confirmation"]')

  beforeEach(async () => {
    await i18next.changeLanguage('en')
    markdownEditors.length = 0
    previewLeaveGuards.clear()
    previewContentSpy.mockClear()
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    useSessionStore.setState(createInitialSessionState())

    currentDocxBytes = await convertMarkdownToDocxBytes(
      '# Agent Report\n\nInitial findings from run 1.'
    )

    inspectMock = vi.fn().mockResolvedValue({
      ok: true,
      value: createDocxInspect()
    })
    saveBinaryEditMock = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        kind: 'created',
        version: createDocxVersionSummary('docx-v3', 3, 'docx-v2')
      }
    })
    acquireMock = vi.fn().mockImplementation(async () => ({
      id: 'preview-res-docx',
      size: currentDocxBytes.byteLength,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }))
    readRangeMock = vi.fn().mockImplementation(async ({ begin, end }) => ({
      resourceId: 'preview-res-docx',
      begin,
      end,
      data: currentDocxBytes.slice(begin, end)
    }))
    releaseMock = vi.fn().mockResolvedValue(undefined)
    clipboardWriteTextMock = vi.fn().mockResolvedValue(undefined)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteTextMock }
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
        artifacts: {
          getLineage: vi.fn().mockResolvedValue({
            artifactId: 'artifact-docx-1',
            filename: 'report.docx',
            originSession: { sessionId: 'session-1', state: 'active', title: 'Analysis' },
            versions: []
          })
        },
        previewResources: {
          acquire: acquireMock,
          readRange: readRangeMock,
          release: releaseMock
        },
        managedFileVersions: {
          inspect: inspectMock,
          diffText: vi.fn(),
          cancelDiff: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }),
          saveTextEdit: vi.fn(),
          saveBinaryEdit: saveBinaryEditMock
        }
      }
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    document.body.innerHTML = ''
    previewLeaveGuards.clear()
  })

  it('shows read-only Word preview with Edit button and version navigation when writable, and hides Edit when read-only or binary save is unavailable', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={docxItem} onClose={vi.fn()} />)
    })

    await waitFor(() => {
      expect(findButtonByLabel('Edit report.docx')).not.toBeNull()
    })
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="managed-preview-version-navigation"]')?.textContent
    ).toContain('v2')

    // Read-only project hides Edit
    inspectMock.mockResolvedValueOnce({
      ok: true,
      value: createDocxInspect({ unavailableReason: 'PROJECT_NOT_WRITABLE' })
    })
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{
            ...docxItem,
            id: 'artifact-docx-ro',
            artifactId: 'artifact-docx-ro',
            managedFileId: 'artifact-docx-ro'
          }}
          onClose={vi.fn()}
        />
      )
    })
    await waitFor(() => {
      expect(inspectMock).toHaveBeenCalledTimes(2)
    })
    expect(findButtonByLabel('Edit report.docx')).toBeNull()

    // Web surface without saveBinaryEdit hides Edit
    ;(window.api.managedFileVersions as { saveBinaryEdit?: unknown }).saveBinaryEdit = undefined
    inspectMock.mockResolvedValueOnce({
      ok: true,
      value: createDocxInspect()
    })
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{
            ...docxItem,
            id: 'artifact-docx-web',
            artifactId: 'artifact-docx-web',
            managedFileId: 'artifact-docx-web'
          }}
          onClose={vi.fn()}
        />
      )
    })
    await waitFor(() => {
      expect(inspectMock).toHaveBeenCalledTimes(3)
    })
    expect(findButtonByLabel('Edit report.docx')).toBeNull()
  })

  it('converts DOCX -> Markdown into MarkdownEditorSurface, edits rich text, and saves back as a valid DOCX binary version', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={docxItem} onClose={vi.fn()} />)
    })

    const editButton = await waitFor(() => {
      const btn = findButtonByLabel('Edit report.docx')
      expect(btn).not.toBeNull()
      return btn!
    })

    await click(editButton)

    await waitFor(() => {
      expect(container.querySelector('[data-testid="markdown-plate-editor"]')).not.toBeNull()
    })
    expect(acquireMock).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-docx-1',
      versionId: 'docx-v2'
    })
    expect(releaseMock).toHaveBeenCalledWith({ resourceId: 'preview-res-docx' })
    expect(container.textContent).toContain('Agent Report')
    expect(container.textContent).toContain('Initial findings from run 1.')

    const saveButton = findButtonByLabel('Save changes')
    expect(saveButton).not.toBeNull()
    expect(saveButton?.disabled).toBe(true)

    await replaceRichEditorMarkdown('# Agent Report\n\nUpdated conclusion verified in rich editor.')

    await waitFor(() => {
      expect(findButtonByLabel('Save changes')?.disabled).toBe(false)
    })

    inspectMock.mockResolvedValueOnce({
      ok: true,
      value: createDocxInspect({
        headVersionId: 'docx-v3',
        selectedVersionId: 'docx-v3',
        versions: [
          createDocxVersionSummary('docx-v1', 1, null),
          createDocxVersionSummary('docx-v2', 2, 'docx-v1'),
          createDocxVersionSummary('docx-v3', 3, 'docx-v2')
        ]
      })
    })

    await click(findButtonByLabel('Save changes'))

    await waitFor(() => {
      expect(saveBinaryEditMock).toHaveBeenCalledTimes(1)
    })

    const savedRequest = saveBinaryEditMock.mock.calls[0]?.[0] as {
      source: string
      projectId: string
      fileId: string
      basedOnVersionId: string
      expectedHeadVersionId: string
      operationId: string
      content: Uint8Array
      actor: string
      summary: string
      opCount: number
    }
    expect(savedRequest.source).toBe('artifact')
    expect(savedRequest.projectId).toBe('project-1')
    expect(savedRequest.fileId).toBe('artifact-docx-1')
    expect(savedRequest.basedOnVersionId).toBe('docx-v2')
    expect(savedRequest.expectedHeadVersionId).toBe('docx-v2')
    expect(savedRequest.actor).toBe('user')
    expect(savedRequest.summary).toBe('Edited document')
    expect(savedRequest.opCount).toBe(1)
    expect(savedRequest.content).toBeInstanceOf(Uint8Array)

    // Verify persisted payload is a genuine Word .docx containing the user's rich-text edit
    const savedZip = await JSZip.loadAsync(savedRequest.content)
    expect(savedZip.file('word/document.xml')).not.toBeNull()
    const roundTrippedMarkdown = await convertDocxBytesToMarkdown(savedRequest.content)
    expect(roundTrippedMarkdown).toContain('# Agent Report')
    expect(roundTrippedMarkdown).toContain('Updated conclusion verified in rich editor.')

    // Returns to read-only preview mode after saving
    await waitFor(() => {
      expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-testid="markdown-plate-editor"]')).toBeNull()
    expect(findButtonByLabel('Edit report.docx')).not.toBeNull()
  })

  it('reuses exact operationId and DOCX bytes on transient retry, and mints a fresh operationId after OPERATION_FAILED', async () => {
    saveBinaryEditMock
      .mockRejectedValueOnce(new Error('IPC timeout'))
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'OPERATION_FAILED', message: 'disk write failed' }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'created',
          version: createDocxVersionSummary('docx-v3', 3, 'docx-v2')
        }
      })

    await act(async () => {
      root.render(<PreviewFileSurface item={docxItem} onClose={vi.fn()} />)
    })

    await click(
      await waitFor(() => {
        const btn = findButtonByLabel('Edit report.docx')
        expect(btn).not.toBeNull()
        return btn!
      })
    )

    await replaceRichEditorMarkdown('# Agent Report\n\nRetryable edit.')
    await waitFor(() => {
      expect(findButtonByLabel('Save changes')?.disabled).toBe(false)
    })

    // First attempt: transient IPC rejection
    await click(findButtonByLabel('Save changes'))
    await waitFor(() => {
      expect(container.textContent).toContain('Changes could not be saved.')
    })

    // Second attempt: reuses exact operationId & identical Uint8Array bytes, hits OPERATION_FAILED
    await click(findButtonByLabel('Save changes'))
    await waitFor(() => {
      expect(saveBinaryEditMock).toHaveBeenCalledTimes(2)
    })
    const firstReq = saveBinaryEditMock.mock.calls[0]?.[0]
    const secondReq = saveBinaryEditMock.mock.calls[1]?.[0]
    expect(secondReq.operationId).toBe(firstReq.operationId)
    expect(secondReq.content).toBe(firstReq.content)

    // Third attempt after OPERATION_FAILED: mints a new operationId and succeeds
    await click(findButtonByLabel('Save changes'))
    await waitFor(() => {
      expect(saveBinaryEditMock).toHaveBeenCalledTimes(3)
    })
    const thirdReq = saveBinaryEditMock.mock.calls[2]?.[0]
    expect(thirdReq.operationId).not.toBe(firstReq.operationId)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    })
  })

  it('handles version conflicts with Copy draft and View latest version, and guards unsaved Cancel with confirmation', async () => {
    const newerHead = createDocxVersionSummary('docx-v3', 3, 'docx-v2')
    saveBinaryEditMock.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: 'conflict',
        actualHead: newerHead
      }
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={docxItem} onClose={vi.fn()} />)
    })

    await click(
      await waitFor(() => {
        const btn = findButtonByLabel('Edit report.docx')
        expect(btn).not.toBeNull()
        return btn!
      })
    )

    await replaceRichEditorMarkdown('# Agent Report\n\nConflicting draft text.')
    await waitFor(() => {
      expect(findButtonByLabel('Save changes')?.disabled).toBe(false)
    })

    // Trigger Cancel while dirty -> opens Discard confirmation; canceling keeps editor open
    await click(findButtonByText('Cancel'))
    await waitFor(() => {
      expect(discardDialog()).not.toBeNull()
    })
    await click(discardDialog()?.querySelector<HTMLButtonElement>('button:first-of-type') ?? null)
    expect(discardDialog()).toBeNull()
    expect(container.querySelector('[data-testid="markdown-plate-editor"]')).not.toBeNull()

    // Save triggers conflict
    await click(findButtonByLabel('Save changes'))
    await waitFor(() => {
      expect(container.textContent).toContain('This file has a newer version.')
    })

    // Copy draft copies the flushed Markdown draft
    await click(findButtonByText('Copy draft'))
    await waitFor(() => {
      expect(clipboardWriteTextMock).toHaveBeenCalledTimes(1)
    })
    expect(clipboardWriteTextMock.mock.calls[0]?.[0]).toContain('Conflicting draft text.')

    // View latest version asks to discard dirty draft, then switches to view mode
    await click(findButtonByText('View latest version'))
    await waitFor(() => {
      expect(discardDialog()).not.toBeNull()
    })
    await click(discardDialog()?.querySelector<HTMLButtonElement>('button:last-of-type') ?? null)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    })
  })

  it('restores exact historical DOCX bytes when saving an unedited historical version, and recovers from corrupt DOCX open errors via Retry', async () => {
    const historicalBytes = await convertMarkdownToDocxBytes(
      '# Historical v1\n\nOriginal baseline.'
    )
    // First test corrupt DOCX open error + Retry recovery
    currentDocxBytes = new Uint8Array([1, 2, 3, 4])
    inspectMock.mockResolvedValue({
      ok: true,
      value: createDocxInspect({
        headVersionId: 'docx-v2',
        selectedVersionId: 'docx-v1'
      })
    })

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...docxItem, selectedVersionId: 'docx-v1' }}
          onClose={vi.fn()}
        />
      )
    })

    await click(
      await waitFor(() => {
        const btn = findButtonByLabel('Edit report.docx')
        expect(btn).not.toBeNull()
        return btn!
      })
    )

    // Corrupt bytes keep view mode active and show retryable ErrorNotice
    await waitFor(() => {
      expect(container.textContent).toContain('Could not open this document for editing.')
    })
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()

    // Fix underlying bytes and click Retry
    currentDocxBytes = historicalBytes
    await click(findButtonByText('Retry'))

    await waitFor(() => {
      expect(container.querySelector('[data-testid="markdown-plate-editor"]')).not.toBeNull()
    })
    expect(container.textContent).not.toContain('Could not open this document for editing.')

    // Unedited historical version enables 'Restore as new version' immediately and preserves exact original bytes
    const restoreButton = findButtonByLabel('Save changes')
    expect(restoreButton?.textContent?.trim()).toBe('Restore as new version')
    expect(restoreButton?.disabled).toBe(false)

    await click(restoreButton)
    await waitFor(() => {
      expect(saveBinaryEditMock).toHaveBeenCalledTimes(1)
    })
    const restoreReq = saveBinaryEditMock.mock.calls[0]?.[0]
    expect(restoreReq.restore).toBe(true)
    expect(restoreReq.basedOnVersionId).toBe('docx-v1')
    expect(restoreReq.expectedHeadVersionId).toBe('docx-v2')
    expect(restoreReq.summary).toBe('restore')
    expect(restoreReq.opCount).toBe(0)
    expect(Array.from(restoreReq.content as Uint8Array)).toEqual(Array.from(historicalBytes))
  })
})
