// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  type PreviewFileItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { i18next } from '@/i18n'
import {
  createInitialSessionState,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'

const provenancePanelSpy = vi.hoisted(() => vi.fn())
const previewContentSpy = vi.hoisted(() => vi.fn())
const markdownSpy = vi.hoisted(() => vi.fn())
const downloadButtonSpy = vi.hoisted(() => vi.fn())

vi.mock('./ArtifactProvenancePanel', () => ({
  ArtifactProvenancePanel: (props: {
    item: PreviewFileItem
    onClose: () => void
    onVersionChange?: (item: PreviewFileItem) => boolean
  }) => {
    provenancePanelSpy(props)
    return (
      <div data-testid="provenance-panel">
        <button type="button" onClick={props.onClose}>
          Close Provenance
        </button>
      </div>
    )
  }
}))

vi.mock('./ManagedFileDownloadButton', () => ({
  ManagedFileDownloadButton: (props: Record<string, unknown>) => {
    downloadButtonSpy(props)
    return <button type="button">Download file</button>
  }
}))

vi.mock('./previews/PreviewFileContent', () => ({
  PreviewFileContent: (props: { item: PreviewFileItem }) => {
    previewContentSpy(props)
    return (
      <div data-testid="preview-content" data-path={props.item.path}>
        Preview content
      </div>
    )
  }
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: (props: { content: string; allowMedia?: boolean }) => {
    markdownSpy(props)
    return <div data-testid="safe-markdown">{props.content}</div>
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

const item: PreviewFileItem = {
  id: 'artifact-1',
  artifactId: 'artifact-1',
  selectedVersionId: 'version-1',
  sessionId: 'session-1',
  type: 'file',
  title: 'sin.png',
  name: 'sin.png',
  path: '/data/sin.png',
  format: 'image',
  source: 'artifact'
}

const descriptor = {
  id: 'version-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  versionNumber: 1,
  checksum: 'checksum-1',
  createdAt: '2026-07-27T20:00:00.000Z',
  state: 'finalized' as const,
  projectId: 'project-1',
  sessionId: 'session-1',
  runId: 'artifact-run-1',
  name: 'sin.png',
  size: 12,
  mtimeMs: 1
}

const secondDescriptor = {
  ...descriptor,
  id: 'version-2',
  versionId: 'version-2',
  versionNumber: 2,
  checksum: 'checksum-2',
  size: 18,
  mtimeMs: 2
}

const thirdDescriptor = {
  ...descriptor,
  id: 'version-3',
  versionId: 'version-3',
  versionNumber: 3,
  checksum: 'checksum-3',
  size: 24,
  mtimeMs: 3
}

let container: HTMLDivElement
let root: Root

const click = async (element: HTMLElement | null): Promise<void> => {
  if (!element) throw new Error('element not found')
  await act(async () => element.click())
}

const changeTextarea = async (textarea: HTMLTextAreaElement, value: string): Promise<void> => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const openMenu = async (trigger: Element | null): Promise<void> => {
  if (!trigger) throw new Error('menu trigger not found')
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const zIndexFromClassName = (element: Element): number => {
  const match = element.className.match(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/)
  return Number(match?.[1] ?? match?.[2] ?? Number.NaN)
}

beforeEach(() => {
  previewLeaveGuards.clear()
  provenancePanelSpy.mockClear()
  previewContentSpy.mockClear()
  markdownSpy.mockClear()
  downloadButtonSpy.mockClear()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  usePreviewWorkbenchStore.getState().activateProject('project-1')
  useSessionStore.setState(createInitialSessionState())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      artifacts: {
        getLineage: vi.fn().mockResolvedValue({
          artifactId: 'artifact-1',
          filename: 'sin.png',
          originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
          versions: [descriptor, secondDescriptor]
        })
      },
      managedFileVersions: {
        inspect: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'not managed' }
        }),
        diffText: vi.fn(),
        cancelDiff: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }),
        saveTextEdit: vi.fn()
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

const managedUploadItem: PreviewFileItem = {
  id: 'upload:upload-file-1',
  managedFileId: 'upload-file-1',
  selectedVersionId: 'upload-v2',
  projectId: 'project-1',
  sessionId: 'session-1',
  type: 'file',
  title: 'README.md',
  name: 'README.md',
  path: 'upload-version:project-1/session-1/upload-v2',
  format: 'markdown',
  source: 'upload'
}

const managedInspect = {
  source: 'upload' as const,
  projectId: 'project-1',
  fileId: 'upload-file-1',
  sessionId: 'session-1',
  displayName: 'README.md',
  headVersionId: 'upload-v2',
  selectedVersionId: 'upload-v2',
  versions: [
    {
      id: 'upload-v1',
      source: 'upload' as const,
      fileId: 'upload-file-1',
      versionNumber: 1,
      displayName: 'README.md',
      originKind: 'user_upload' as const,
      basedOnVersionId: null,
      contentType: 'text/markdown',
      sizeBytes: 8,
      checksum: '1',
      createdAt: '2026-08-11T00:00:00.000Z'
    },
    {
      id: 'upload-v2',
      source: 'upload' as const,
      fileId: 'upload-file-1',
      versionNumber: 2,
      displayName: 'README.md',
      originKind: 'user_edit' as const,
      basedOnVersionId: 'upload-v1',
      contentType: 'text/markdown',
      sizeBytes: 9,
      checksum: '2',
      createdAt: '2026-08-12T00:00:00.000Z'
    }
  ],
  canEdit: true,
  canDiff: true,
  text: '# Current\n',
  textFormat: { hasUtf8Bom: false, newline: 'lf' as const, hasTrailingNewline: true }
}

describe('PreviewFileSurface managed text versions', () => {
  beforeEach(() => {
    window.api.managedFileVersions.inspect = vi
      .fn()
      .mockResolvedValue({ ok: true, value: managedInspect })
  })

  it('stays read-only when the Web runtime exposes capability detection without managed operations', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        artifacts: window.api.artifacts,
        managedFileVersions: {
          getCapability: vi.fn(() => ({
            available: false,
            reason: 'STORAGE_UNAVAILABLE'
          }))
        }
      }
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Edit README.md"]')).toBeNull()
    expect(
      container.querySelector('[aria-label="Compare README.md with its source version"]')
    ).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
  })

  it('uses the exact item passed to an independent surface instead of a same-id workbench tab', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      ...managedUploadItem,
      projectId: 'project-1',
      managedFileId: 'workbench-file',
      selectedVersionId: 'workbench-v2',
      path: 'upload-version:project-1/session-1/workbench-v2'
    })
    const dialogItem = {
      ...managedUploadItem,
      projectId: 'project-2',
      managedFileId: 'dialog-file',
      selectedVersionId: 'dialog-v3',
      path: 'upload-version:project-2/session-2/dialog-v3'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={dialogItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })

    expect(window.api.managedFileVersions.inspect).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'project-2',
      fileId: 'dialog-file',
      versionId: 'dialog-v3'
    })
  })

  it('inspects uploads with the database file id and edits raw Markdown in a plain textarea', async () => {
    window.api.managedFileVersions.saveTextEdit = vi.fn().mockResolvedValue({
      ok: true,
      value: { kind: 'noop', version: managedInspect.versions[1], headVersionId: 'upload-v2' }
    })
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    expect(window.api.managedFileVersions.inspect).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'project-1',
      fileId: 'upload-file-1',
      versionId: 'upload-v2'
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit README.md source"]'
    )
    expect(textarea?.value).toBe('# Current\n')
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Save changes"]')?.disabled
    ).toBe(true)
  })

  it('gives the download control both the viewed and latest managed versions', async () => {
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...managedInspect, selectedVersionId: 'upload-v1', text: '# Original\n' }
    })
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...managedUploadItem, selectedVersionId: 'upload-v1', versionNumber: 1 }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    expect(downloadButtonSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        versionId: 'upload-v1',
        versionNumber: 1,
        latestVersionId: 'upload-v2',
        latestVersionNumber: 2
      })
    )
  })

  it('replaces preview actions with text-only Cancel and Save controls while editing', async () => {
    const managedArtifactItem: PreviewFileItem = {
      ...managedUploadItem,
      id: 'artifact-1',
      artifactId: 'artifact-1',
      managedFileId: 'artifact-file-1',
      source: 'artifact'
    }
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={managedArtifactItem}
          onClose={vi.fn()}
          onOpenFullScreen={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="File actions for README.md"]')).not.toBeNull()
    await click(container.querySelector('[aria-label="Edit README.md"]'))

    const saveButton = container.querySelector<HTMLButtonElement>('[aria-label="Save changes"]')
    expect(saveButton?.textContent).toBe('Save')
    expect(saveButton?.querySelector('svg')).toBeNull()
    expect(container.textContent).toContain('Cancel')
    expect(container.textContent).not.toContain('Download file')
    expect(container.querySelector('[aria-label="Close preview of README.md"]')).toBeNull()
    expect(
      container.querySelector('[aria-label="Open full screen preview of README.md"]')
    ).toBeNull()
    expect(container.querySelector('[aria-label="File actions for README.md"]')).toBeNull()
  })

  it('uses stronger header action colors and keeps disabled actions only slightly lighter', async () => {
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...managedInspect, canDiff: false }
    })
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })

    const editButton = container.querySelector<HTMLButtonElement>('[aria-label="Edit README.md"]')
    const diffButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Compare README.md with its source version"]'
    )
    expect(editButton?.className).toContain('text-text-000')
    expect(diffButton?.disabled).toBe(true)
    expect(diffButton?.className).toContain('disabled:opacity-50')
    expect(diffButton?.className).not.toContain('disabled:opacity-100')
  })

  it('keeps read-only diff and version navigation for eligible text when writes are unavailable', async () => {
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ...managedInspect,
        canEdit: false,
        canDiff: true,
        unavailableReason: 'PROJECT_NOT_WRITABLE' as const
      }
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Edit README.md"]')).toBeNull()
    expect(
      container.querySelector('[aria-label="Compare README.md with its source version"]')
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="managed-preview-version-navigation"]')
    ).not.toBeNull()
  })

  it('localizes the dirty-draft confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const leaveAction = vi.fn()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={managedUploadItem}
          leaveGuardScope="localized-dirty-draft"
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Draft\n')
    await act(async () => i18next.changeLanguage('zh-Hans'))

    expect(previewLeaveGuards.request('localized-dirty-draft', leaveAction)).toBe(false)
    expect(confirm).toHaveBeenCalledWith('要放弃未保存的更改吗？')
    expect(leaveAction).not.toHaveBeenCalled()

    await act(async () => i18next.changeLanguage('en'))
  })

  it('localizes a managed edit save failure', async () => {
    window.api.managedFileVersions.saveTextEdit = vi
      .fn()
      .mockRejectedValue(new Error('save unavailable'))

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Draft\n')
    const saveButton = container.querySelector<HTMLButtonElement>('[aria-label="Save changes"]')
    await act(async () => i18next.changeLanguage('zh-Hans'))
    await click(saveButton)

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法保存更改。')

    await act(async () => i18next.changeLanguage('en'))
  })

  it.each([
    {
      code: 'STORAGE_UNAVAILABLE' as const,
      message: 'File storage is unavailable. Check the storage location and try again.'
    },
    {
      code: 'PERMISSION_DENIED' as const,
      message: 'Open Science does not have permission to save this file.'
    },
    {
      code: 'OUT_OF_SPACE' as const,
      message: 'There is not enough storage space to save this file.'
    },
    {
      code: 'INTEGRITY_FAILED' as const,
      message: 'The file could not be verified after saving. Reopen it and try again.'
    },
    {
      code: 'CONTENT_INTEGRITY_FAILED' as const,
      message: 'The file could not be verified after saving. Reopen it and try again.'
    },
    {
      code: 'VERSION_CONFLICT' as const,
      message: 'The file changed before your edit could be saved. Reopen it and try again.'
    }
  ])('explains a $code save failure and preserves the draft', async ({ code, message }) => {
    window.api.managedFileVersions.saveTextEdit = vi.fn().mockResolvedValue({
      ok: false,
      error: { code, message: 'Internal storage detail.' }
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await changeTextarea(textarea, '# Unsaved draft\n')
    await click(container.querySelector('[aria-label="Save changes"]'))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message)
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain(
      'Internal storage detail.'
    )
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      '# Unsaved draft\n'
    )
  })

  it('uses the generic save failure for an unknown error code and preserves the draft', async () => {
    window.api.managedFileVersions.saveTextEdit = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'Unexpected backend detail.' }
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await changeTextarea(textarea, '# Unsaved draft\n')
    await click(container.querySelector('[aria-label="Save changes"]'))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Changes could not be saved.'
    )
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain(
      'Unexpected backend detail.'
    )
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      '# Unsaved draft\n'
    )
  })

  it('preserves a dirty draft on conflict and offers the latest version', async () => {
    window.api.managedFileVersions.saveTextEdit = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        kind: 'conflict',
        expectedHeadVersionId: 'upload-v2',
        actualHead: { ...managedInspect.versions[1], id: 'upload-v3', versionNumber: 3 }
      }
    })
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await changeTextarea(textarea, '# Draft\n')
    await click(container.querySelector('[aria-label="Save changes"]'))
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('# Draft\n')
    expect(container.textContent).toContain('View latest version')
    expect(window.api.managedFileVersions.saveTextEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'upload-file-1',
        basedOnVersionId: 'upload-v2',
        expectedHeadVersionId: 'upload-v2',
        content: '# Draft\n',
        operationId: expect.any(String)
      })
    )
  })

  it('ignores a save result that arrives after the surface moves to another file', async () => {
    let resolveSave!: (value: unknown) => void
    window.api.managedFileVersions.saveTextEdit = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve
      })
    )
    const otherItem: PreviewFileItem = {
      ...managedUploadItem,
      id: 'upload:upload-file-2',
      managedFileId: 'upload-file-2',
      selectedVersionId: 'other-v1',
      name: 'OTHER.md',
      title: 'OTHER.md',
      path: 'upload-version:project-1/session-1/other-v1'
    }
    const otherInspect = {
      ...managedInspect,
      fileId: 'upload-file-2',
      displayName: 'OTHER.md',
      headVersionId: 'other-v1',
      selectedVersionId: 'other-v1',
      versions: [
        {
          ...managedInspect.versions[0],
          id: 'other-v1',
          fileId: 'upload-file-2',
          displayName: 'OTHER.md',
          basedOnVersionId: null
        }
      ],
      canDiff: false,
      text: '# Other\n'
    }
    window.api.managedFileVersions.inspect = vi.fn(async (request) => ({
      ok: true as const,
      value: request.fileId === 'upload-file-2' ? otherInspect : managedInspect
    }))

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# A draft\n')
    await click(container.querySelector('[aria-label="Save changes"]'))

    await act(async () => {
      root.render(<PreviewFileSurface item={otherItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit OTHER.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# B draft\n')

    await act(async () => {
      resolveSave({
        ok: true,
        value: {
          kind: 'created',
          replayed: false,
          version: { ...managedInspect.versions[1], id: 'upload-v3', versionNumber: 3 },
          headVersionId: 'upload-v3'
        }
      })
      await Promise.resolve()
    })

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('# B draft\n')
  })

  it('ignores a save result that arrives after the surface unmounts', async () => {
    let resolveSave!: (value: unknown) => void
    window.api.managedFileVersions.saveTextEdit = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve
      })
    )
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(managedUploadItem)
    const upsertItem = vi.spyOn(usePreviewWorkbenchStore.getState(), 'upsertItem')

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Draft\n')
    await click(container.querySelector('[aria-label="Save changes"]'))
    await act(async () => root.unmount())

    await act(async () => {
      resolveSave({
        ok: true,
        value: {
          kind: 'created',
          replayed: false,
          version: { ...managedInspect.versions[1], id: 'upload-v3', versionNumber: 3 },
          headVersionId: 'upload-v3'
        }
      })
      await Promise.resolve()
    })

    expect(upsertItem).not.toHaveBeenCalled()
    root = createRoot(container)
  })

  it('does not let a late save replace the Version selected while that save was pending', async () => {
    let resolveSave!: (value: unknown) => void
    window.api.managedFileVersions.saveTextEdit = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve
      })
    )
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Draft\n')
    await click(container.querySelector('[aria-label="Save changes"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))
    expect(confirm).toHaveBeenCalledOnce()

    await act(async () => {
      resolveSave({
        ok: true,
        value: {
          kind: 'created',
          replayed: false,
          version: { ...managedInspect.versions[1], id: 'upload-v3', versionNumber: 3 },
          headVersionId: 'upload-v3'
        }
      })
      await Promise.resolve()
    })

    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ selectedVersionId: 'upload-v1' })
      })
    )
  })

  it('renders diff through restricted Markdown and cancels the task when toggled off', async () => {
    let resolveDiff!: (value: unknown) => void
    window.api.managedFileVersions.diffText = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveDiff = resolve
      })
    )
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    expect(window.api.managedFileVersions.diffText).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'upload-file-1',
        versionId: 'upload-v2',
        requestId: expect.any(String)
      })
    )
    await click(container.querySelector('[aria-label="Stop comparing README.md"]'))
    expect(window.api.managedFileVersions.cancelDiff).toHaveBeenCalledWith({
      requestId: expect.any(String)
    })
    await act(async () => {
      resolveDiff({
        ok: true,
        value: { baseVersionId: 'upload-v1', selectedVersionId: 'upload-v2', lines: [] }
      })
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Stop comparing README.md"]')).toBeNull()
    expect(
      container.querySelector('[aria-label="Compare README.md with its source version"]')
    ).not.toBeNull()
  })

  it('keeps diff mode active on the source version without requesting an unavailable diff', async () => {
    let resolveDiff!: (value: unknown) => void
    window.api.managedFileVersions.diffText = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveDiff = resolve
      })
    )
    window.api.managedFileVersions.inspect = vi.fn(async (request) => ({
      ok: true as const,
      value:
        request.versionId === 'upload-v1'
          ? {
              ...managedInspect,
              headVersionId: 'upload-v2',
              selectedVersionId: 'upload-v1',
              canDiff: false,
              text: '# Original\n'
            }
          : managedInspect
    }))
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(window.api.managedFileVersions.cancelDiff).toHaveBeenCalledWith({
      requestId: expect.any(String)
    })
    expect(container.textContent).not.toContain('Comparing versions...')
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    const stopComparing = container.querySelector<HTMLButtonElement>(
      '[aria-label="Stop comparing README.md"]'
    )
    expect(stopComparing).not.toBeNull()
    expect(stopComparing?.disabled).toBe(false)
    expect(window.api.managedFileVersions.diffText).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveDiff({
        ok: true,
        value: { baseVersionId: 'upload-v1', selectedVersionId: 'upload-v2', lines: [] }
      })
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Stop comparing README.md"]')).not.toBeNull()
  })

  it('keeps Stop comparing available while the source version inspect is pending', async () => {
    type InspectResult = Awaited<ReturnType<typeof window.api.managedFileVersions.inspect>>
    let resolveSourceInspect!: (value: InspectResult) => void
    window.api.managedFileVersions.inspect = vi.fn((request) =>
      request.versionId === 'upload-v1'
        ? new Promise<InspectResult>((resolve) => {
            resolveSourceInspect = resolve
          })
        : Promise.resolve({ ok: true as const, value: managedInspect })
    )
    window.api.managedFileVersions.diffText = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.api.managedFileVersions.diffText>>>(
          () => undefined
        )
    )

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))

    const stopComparing = container.querySelector<HTMLButtonElement>(
      '[aria-label="Stop comparing README.md"]'
    )
    expect(stopComparing).not.toBeNull()
    expect(stopComparing?.disabled).toBe(false)
    await click(stopComparing)

    await act(async () => {
      resolveSourceInspect({
        ok: true,
        value: {
          ...managedInspect,
          selectedVersionId: 'upload-v1',
          canDiff: false,
          text: '# Original\n'
        }
      })
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Stop comparing README.md"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
  })

  it('leaves diff mode when the source version itself has no text preview', async () => {
    window.api.managedFileVersions.inspect = vi.fn(async (request) => ({
      ok: true as const,
      value:
        request.versionId === 'upload-v1'
          ? {
              ...managedInspect,
              headVersionId: 'upload-v2',
              selectedVersionId: 'upload-v1',
              canEdit: false,
              canDiff: false,
              text: undefined,
              textFormat: undefined,
              unavailableReason: 'INVALID_UTF8' as const
            }
          : managedInspect
    }))
    window.api.managedFileVersions.diffText = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.api.managedFileVersions.diffText>>>(
          () => undefined
        )
    )

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Stop comparing README.md"]')).toBeNull()
    expect(container.textContent).not.toContain('Comparing versions...')
  })

  it('leaves diff mode when the selected historical version has a base but is not diff-eligible', async () => {
    const thirdVersion = {
      ...managedInspect.versions[1],
      id: 'upload-v3',
      versionNumber: 3,
      basedOnVersionId: 'upload-v2'
    }
    const inspectV3 = {
      ...managedInspect,
      headVersionId: 'upload-v3',
      selectedVersionId: 'upload-v3',
      versions: [...managedInspect.versions, thirdVersion],
      text: '# Third\n'
    }
    window.api.managedFileVersions.inspect = vi.fn(async (request) => ({
      ok: true as const,
      value:
        request.versionId === 'upload-v2'
          ? {
              ...inspectV3,
              selectedVersionId: 'upload-v2',
              canEdit: false,
              canDiff: false,
              text: undefined,
              textFormat: undefined,
              unavailableReason: 'INVALID_UTF8' as const
            }
          : inspectV3
    }))
    window.api.managedFileVersions.diffText = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.api.managedFileVersions.diffText>>>(
          () => undefined
        )
    )
    const versionThreeItem = {
      ...managedUploadItem,
      selectedVersionId: 'upload-v3',
      versionNumber: 3,
      path: 'upload-version:project-1/session-1/upload-v3'
    }
    await act(async () => {
      root.render(<PreviewFileSurface item={versionThreeItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })

    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Comparing versions...')
    expect(container.querySelector('[aria-label="Stop comparing README.md"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
  })

  it.each([
    {
      label: 'returns an error result',
      inspectFailure: () =>
        Promise.resolve({
          ok: false as const,
          error: { code: 'VERSION_NOT_FOUND' as const, message: 'Version not found.' }
        })
    },
    {
      label: 'rejects',
      inspectFailure: () => Promise.reject(new Error('inspect failed'))
    }
  ])('leaves diff mode when the selected version inspect $label', async ({ inspectFailure }) => {
    const thirdVersion = {
      ...managedInspect.versions[1],
      id: 'upload-v3',
      versionNumber: 3,
      basedOnVersionId: 'upload-v2'
    }
    const inspectV3 = {
      ...managedInspect,
      headVersionId: 'upload-v3',
      selectedVersionId: 'upload-v3',
      versions: [...managedInspect.versions, thirdVersion],
      text: '# Third\n'
    }
    window.api.managedFileVersions.inspect = vi.fn((request) =>
      request.versionId === 'upload-v2'
        ? inspectFailure()
        : Promise.resolve({
            ok: true as const,
            value:
              request.versionId === 'upload-v1'
                ? {
                    ...inspectV3,
                    selectedVersionId: 'upload-v1',
                    canDiff: false,
                    text: '# Original\n'
                  }
                : inspectV3
          })
    )
    window.api.managedFileVersions.diffText = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.api.managedFileVersions.diffText>>>(
          () => undefined
        )
    )
    const versionThreeItem = {
      ...managedUploadItem,
      selectedVersionId: 'upload-v3',
      versionNumber: 3,
      path: 'upload-version:project-1/session-1/upload-v3'
    }
    await act(async () => {
      root.render(<PreviewFileSurface item={versionThreeItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })

    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Comparing versions...')
    expect(container.querySelector('[aria-label="Stop comparing README.md"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="managed-preview-version-navigation"]')?.textContent
    ).toBe('v2')

    await click(container.querySelector('[aria-label="Previous file version"]'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      container.querySelector('[data-testid="managed-preview-version-navigation"]')?.textContent
    ).toBe('v1')
  })

  it('keeps diff mode and reloads it when switching to another version with a base', async () => {
    const thirdVersion = {
      ...managedInspect.versions[1],
      id: 'upload-v3',
      versionNumber: 3,
      basedOnVersionId: 'upload-v2'
    }
    const inspectV3 = {
      ...managedInspect,
      headVersionId: 'upload-v3',
      selectedVersionId: 'upload-v3',
      versions: [...managedInspect.versions, thirdVersion],
      text: '# Third\n'
    }
    window.api.managedFileVersions.inspect = vi.fn(async (request) => ({
      ok: true as const,
      value:
        request.versionId === 'upload-v2'
          ? { ...inspectV3, selectedVersionId: 'upload-v2', text: '# Current\n' }
          : inspectV3
    }))
    type DiffResult = Awaited<ReturnType<typeof window.api.managedFileVersions.diffText>>
    const pending: Array<(value: DiffResult) => void> = []
    window.api.managedFileVersions.diffText = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.api.managedFileVersions.diffText>>>(
          (resolve) => {
            pending.push(resolve)
          }
        )
    )
    const versionThreeItem = {
      ...managedUploadItem,
      selectedVersionId: 'upload-v3',
      versionNumber: 3,
      path: 'upload-version:project-1/session-1/upload-v3'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={versionThreeItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.managedFileVersions.cancelDiff).toHaveBeenCalledWith({
      requestId: expect.any(String)
    })
    expect(window.api.managedFileVersions.diffText).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: 'upload-v2' })
    )
    expect(container.querySelector('[aria-label="Stop comparing README.md"]')).not.toBeNull()
    expect(pending).toHaveLength(2)
    await act(async () => {
      pending[1]?.({
        ok: true,
        value: {
          baseVersionId: 'upload-v1',
          selectedVersionId: 'upload-v2',
          lines: [
            {
              kind: 'added',
              newLineNumber: 1,
              segments: [{ kind: 'added', text: 'Current v2 diff' }]
            }
          ]
        }
      })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Current v2 diff')
    await act(async () => {
      pending[0]?.({
        ok: true,
        value: {
          baseVersionId: 'upload-v2',
          selectedVersionId: 'upload-v3',
          lines: [
            {
              kind: 'added',
              newLineNumber: 1,
              segments: [{ kind: 'added', text: 'Stale v3 diff' }]
            }
          ]
        }
      })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Current v2 diff')
    expect(container.textContent).not.toContain('Stale v3 diff')
  })

  it('keeps diff mode through a connected store switch to another version with a base', async () => {
    const thirdVersion = {
      ...managedInspect.versions[1],
      id: 'upload-v3',
      versionNumber: 3,
      basedOnVersionId: 'upload-v2'
    }
    const inspectV3 = {
      ...managedInspect,
      headVersionId: 'upload-v3',
      selectedVersionId: 'upload-v3',
      versions: [...managedInspect.versions, thirdVersion],
      text: '# Third\n'
    }
    window.api.managedFileVersions.inspect = vi.fn(async (request) => ({
      ok: true as const,
      value:
        request.versionId === 'upload-v2'
          ? { ...inspectV3, selectedVersionId: 'upload-v2', text: '# Current\n' }
          : inspectV3
    }))
    type DiffResult = Awaited<ReturnType<typeof window.api.managedFileVersions.diffText>>
    const pending: Array<(value: DiffResult) => void> = []
    window.api.managedFileVersions.diffText = vi.fn(
      () =>
        new Promise<DiffResult>((resolve) => {
          pending.push(resolve)
        })
    )
    const versionThreeItem: PreviewFileItem = {
      ...managedUploadItem,
      selectedVersionId: 'upload-v3',
      versionNumber: 3,
      path: 'upload-version:project-1/session-1/upload-v3'
    }
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(versionThreeItem)

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={versionThreeItem}
          onClose={vi.fn()}
          leaveGuardScope="workbench:project-1:upload:upload-file-1"
          workbenchConnected
        />
      )
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'upload-v2'
    })
    expect(window.api.managedFileVersions.cancelDiff).toHaveBeenCalledWith({
      requestId: expect.any(String)
    })
    expect(window.api.managedFileVersions.diffText).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: 'upload-v2' })
    )
    expect(container.querySelector('[aria-label="Stop comparing README.md"]')).not.toBeNull()
    expect(pending).toHaveLength(2)
    await act(async () => {
      pending[1]?.({
        ok: true,
        value: {
          baseVersionId: 'upload-v1',
          selectedVersionId: 'upload-v2',
          lines: [
            {
              kind: 'added',
              newLineNumber: 1,
              segments: [{ kind: 'added', text: 'Connected v2 diff' }]
            }
          ]
        }
      })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Connected v2 diff')
    await act(async () => {
      pending[0]?.({
        ok: true,
        value: {
          baseVersionId: 'upload-v2',
          selectedVersionId: 'upload-v3',
          lines: [
            {
              kind: 'added',
              newLineNumber: 1,
              segments: [{ kind: 'added', text: 'Stale connected v3 diff' }]
            }
          ]
        }
      })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Connected v2 diff')
    expect(container.textContent).not.toContain('Stale connected v3 diff')
  })

  it('keeps diff mode through a connected store switch to the source version', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(managedUploadItem)
    window.api.managedFileVersions.inspect = vi.fn(async (request) => ({
      ok: true as const,
      value:
        request.versionId === 'upload-v1'
          ? {
              ...managedInspect,
              selectedVersionId: 'upload-v1',
              canDiff: false,
              text: '# Original\n'
            }
          : managedInspect
    }))
    window.api.managedFileVersions.diffText = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.api.managedFileVersions.diffText>>>(
          () => undefined
        )
    )
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={managedUploadItem}
          onClose={vi.fn()}
          leaveGuardScope="workbench:project-1:upload:upload-file-1"
          workbenchConnected
        />
      )
      await Promise.resolve()
    })

    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'upload-v1'
    })
    expect(window.api.managedFileVersions.cancelDiff).toHaveBeenCalledWith({
      requestId: expect.any(String)
    })
    const stopComparing = container.querySelector<HTMLButtonElement>(
      '[aria-label="Stop comparing README.md"]'
    )
    expect(stopComparing).not.toBeNull()
    expect(stopComparing?.disabled).toBe(false)
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
  })

  it('uses one workbench guard for an atomic connected version switch', async () => {
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(managedUploadItem)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false)
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={managedUploadItem}
          onClose={vi.fn()}
          leaveGuardScope="workbench:project-1:upload:upload-file-1"
          workbenchConnected
        />
      )
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Draft\n')
    await click(container.querySelector('[aria-label="Previous file version"]'))

    expect(confirm).toHaveBeenCalledOnce()
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'upload-v1'
    })
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('keeps a dirty draft when a version switch is rejected', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Draft\n')

    await click(container.querySelector('[aria-label="Previous file version"]'))

    expect(confirm).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('# Draft\n')
    expect(
      container.querySelector('[data-testid="managed-preview-version-navigation"]')?.textContent
    ).toBe('v2')
  })

  it('does not guard again when a connected save publishes its new version', async () => {
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(managedUploadItem)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const version = { ...managedInspect.versions[1], id: 'upload-v3', versionNumber: 3 }
    window.api.managedFileVersions.saveTextEdit = vi.fn().mockResolvedValue({
      ok: true,
      value: { kind: 'created', replayed: false, version, headVersionId: version.id }
    })
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={managedUploadItem}
          onClose={vi.fn()}
          leaveGuardScope="workbench:project-1:upload:upload-file-1"
          workbenchConnected
        />
      )
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Saved\n')
    await click(container.querySelector('[aria-label="Save changes"]'))

    expect(confirm).not.toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'upload-v3'
    })
  })

  it('uses safe Markdown with media disabled for changed Markdown blocks', async () => {
    window.api.managedFileVersions.diffText = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        baseVersionId: 'upload-v1',
        selectedVersionId: 'upload-v2',
        lines: [
          {
            kind: 'added',
            newLineNumber: 1,
            segments: [
              { kind: 'added', text: '<script>bad()</script> ![x](https://bad.invalid/x.png)' }
            ]
          }
        ]
      }
    })
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(markdownSpy).toHaveBeenCalledWith(expect.objectContaining({ allowMedia: false }))
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders adjacent list item replacements as one safe document fragment', async () => {
    window.api.managedFileVersions.diffText = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        baseVersionId: 'upload-v1',
        selectedVersionId: 'upload-v2',
        lines: [
          {
            kind: 'removed',
            oldLineNumber: 1,
            segments: [
              { kind: 'context', text: '- ' },
              { kind: 'removed', text: 'old one' }
            ]
          },
          {
            kind: 'added',
            newLineNumber: 1,
            segments: [
              { kind: 'context', text: '- ' },
              { kind: 'added', text: 'new one' }
            ]
          },
          {
            kind: 'removed',
            oldLineNumber: 2,
            segments: [
              { kind: 'context', text: '- ' },
              { kind: 'removed', text: 'old two' }
            ]
          },
          {
            kind: 'added',
            newLineNumber: 2,
            segments: [
              { kind: 'context', text: '- ' },
              { kind: 'added', text: 'new two' }
            ]
          }
        ]
      }
    })
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(markdownSpy).toHaveBeenCalledTimes(1)
    expect(markdownSpy.mock.calls[0]?.[0].content).toMatch(
      /^- <managed-diff-removed-[a-z0-9]+>old one<\/managed-diff-removed-[a-z0-9]+><managed-diff-added-[a-z0-9]+>new one<\/managed-diff-added-[a-z0-9]+>\n- <managed-diff-removed-[a-z0-9]+>old two<\/managed-diff-removed-[a-z0-9]+><managed-diff-added-[a-z0-9]+>new two<\/managed-diff-added-[a-z0-9]+>$/u
    )
    const mixedBlock = container.querySelector('[data-diff-kind="mixed"]')
    expect(mixedBlock?.className).toContain(
      '[&_[data-managed-diff=removed]]:bg-diff-removed-highlight'
    )
    expect(mixedBlock?.className).toContain('[&_[data-managed-diff=added]]:bg-diff-added-highlight')
    expect(mixedBlock?.className).not.toContain('grid')
  })

  it('keeps an entire fenced Markdown diff block together across plain code lines', async () => {
    window.api.managedFileVersions.diffText = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        baseVersionId: 'upload-v1',
        selectedVersionId: 'upload-v2',
        lines: [
          {
            kind: 'added',
            newLineNumber: 1,
            segments: [{ kind: 'added', text: '```ts' }]
          },
          {
            kind: 'added',
            newLineNumber: 2,
            segments: [{ kind: 'added', text: 'const safe = true' }]
          },
          {
            kind: 'added',
            newLineNumber: 3,
            segments: [{ kind: 'added', text: '```' }]
          }
        ]
      }
    })
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(markdownSpy.mock.calls.map(([props]) => props.content)).toEqual([
      '```ts\nconst safe = true\n```'
    ])
  })

  it('clears a dirty baseline when the same logical item is externally replaced by another locator', async () => {
    const replacement = {
      ...managedUploadItem,
      selectedVersionId: 'upload-v1',
      path: 'upload-version:project-1/session-1/upload-v1'
    }
    window.api.managedFileVersions.inspect = vi.fn(async (request) => ({
      ok: true as const,
      value:
        request.versionId === 'upload-v1'
          ? {
              ...managedInspect,
              selectedVersionId: 'upload-v1',
              canDiff: false,
              text: '# Original\n'
            }
          : managedInspect
    }))
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Draft\n')

    await act(async () => {
      root.render(<PreviewFileSurface item={replacement} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('textarea')).toBeNull()
    expect(window.api.managedFileVersions.inspect).toHaveBeenLastCalledWith({
      source: 'upload',
      projectId: 'project-1',
      fileId: 'upload-file-1',
      versionId: 'upload-v1'
    })
  })

  it('renders simple Markdown replacements with inline deletion and insertion semantics', async () => {
    window.api.managedFileVersions.diffText = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        baseVersionId: 'upload-v1',
        selectedVersionId: 'upload-v2',
        lines: [
          {
            kind: 'removed',
            oldLineNumber: 1,
            segments: [
              { kind: 'context', text: 'Sub title ' },
              { kind: 'removed', text: 'two' }
            ]
          },
          {
            kind: 'added',
            newLineNumber: 1,
            segments: [
              { kind: 'context', text: 'Sub title ' },
              { kind: 'added', text: 'three' }
            ]
          }
        ]
      }
    })
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare README.md with its source version"]'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(markdownSpy).toHaveBeenCalledWith(expect.objectContaining({ allowMedia: false }))
    expect(markdownSpy.mock.calls.at(-1)?.[0].content).toMatch(
      /^Sub title <managed-diff-removed-[a-z0-9]+>two<\/managed-diff-removed-[a-z0-9]+><managed-diff-added-[a-z0-9]+>three<\/managed-diff-added-[a-z0-9]+>$/u
    )
    expect(container.querySelector('[data-diff-inline="true"]')).toBeNull()
  })

  it('keeps txt replacements inline while preserving whitespace', async () => {
    window.api.managedFileVersions.diffText = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        baseVersionId: 'upload-v1',
        selectedVersionId: 'upload-v2',
        lines: [
          {
            kind: 'removed',
            oldLineNumber: 1,
            segments: [
              { kind: 'context', text: 'Hello ' },
              { kind: 'removed', text: 'old' },
              { kind: 'context', text: '  world' }
            ]
          },
          {
            kind: 'added',
            newLineNumber: 1,
            segments: [
              { kind: 'context', text: 'Hello ' },
              { kind: 'added', text: 'new' },
              { kind: 'context', text: '  world' }
            ]
          }
        ]
      }
    })
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...managedUploadItem, name: 'notes.txt', title: 'notes.txt', format: 'text' }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Compare notes.txt with its source version"]'))
    await act(async () => {
      await Promise.resolve()
    })

    const mixed = container.querySelector('[data-diff-kind="mixed"]')
    expect(mixed?.querySelector('pre')?.textContent).toContain('Hello ')
    expect(mixed?.querySelector('pre')?.textContent).toContain('  world')
    expect(mixed?.querySelector('del [data-managed-diff-content]')?.textContent).toBe('old')
    expect(mixed?.querySelector('ins [data-managed-diff-content]')?.textContent).toBe('new')
    expect(container.querySelectorAll('[data-diff-kind="removed"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-diff-kind="added"]')).toHaveLength(0)
  })

  it('renders structured replacements with only changed characters highlighted', async () => {
    window.api.managedFileVersions.diffText = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        baseVersionId: 'upload-v1',
        selectedVersionId: 'upload-v2',
        lines: [
          {
            kind: 'removed',
            oldLineNumber: 1,
            segments: [
              { kind: 'context', text: 'Sub title ' },
              { kind: 'removed', text: 'two' }
            ]
          },
          {
            kind: 'added',
            newLineNumber: 1,
            segments: [
              { kind: 'context', text: 'Sub title ' },
              { kind: 'added', text: 'three' }
            ]
          }
        ]
      }
    })
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...managedUploadItem, name: 'analysis.sh', title: 'analysis.sh', format: 'code' }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
    })
    await click(
      container.querySelector('[aria-label="Compare analysis.sh with its source version"]')
    )
    await act(async () => {
      await Promise.resolve()
    })

    const mixedLine = container.querySelector('[data-diff-kind="mixed"]')
    const stableText = mixedLine?.querySelector('pre > span')
    const removed = mixedLine?.querySelector('del')
    const added = mixedLine?.querySelector('ins')
    expect(stableText?.textContent).toBe('Sub title ')
    expect(removed?.querySelector('[data-managed-diff-content]')?.textContent).toBe('two')
    expect(removed?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-diff-removed-highlight', 'text-text-000', 'line-through'])
    )
    expect(added?.querySelector('[data-managed-diff-content]')?.textContent).toBe('three')
    expect(added?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-diff-added-highlight', 'text-text-000', 'no-underline'])
    )
    expect(container.querySelector('[data-diff-kind="removed"]')).toBeNull()
    expect(container.querySelector('[data-diff-kind="added"]')).toBeNull()
    expect(container.querySelector('[aria-label="Removed line"]')).toBeNull()
    expect(container.querySelector('[aria-label="Added line"]')).toBeNull()
    expect(container.querySelector('[class*="grid-cols-[2rem"]')).toBeNull()
  })
})

afterEach(() => {
  act(() => root.unmount())
  previewLeaveGuards.clear()
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('PreviewFileSurface Provenance entry', () => {
  it('keeps a default managed Artifact preview on its logical DB head', async () => {
    const managedArtifact = {
      ...item,
      managedFileId: 'artifact-1',
      projectId: 'project-1',
      selectedVersionId: undefined,
      versionNumber: undefined,
      path: '/stale/managed-file-projection.png'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={managedArtifact} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          managedFileId: 'artifact-1',
          path: '/stale/managed-file-projection.png',
          selectedVersionId: undefined
        })
      })
    )
    expect(container.querySelector('[aria-label="Next Artifact version"]')).toBeNull()
  })

  it('opens and closes Provenance from the full-screen preview header', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={item} provenanceEntry="leading" onClose={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    await click(container.querySelector('[aria-label="Open Provenance for sin.png"]'))

    expect(container.querySelector('[data-testid="provenance-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()
    expect(provenancePanelSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'artifact-1',
          selectedVersionId: 'version-1',
          versionNumber: 1
        }),
        projectId: 'project-1'
      })
    )

    await click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Close Provenance'
      ) ?? null
    )

    expect(container.querySelector('[data-testid="provenance-panel"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
  })

  it('does not offer Provenance for uploaded inputs', async () => {
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, id: 'upload-1', artifactId: undefined, source: 'upload' }}
          provenanceEntry="leading"
          onClose={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[aria-label^="Open Provenance"]')).toBeNull()
  })

  it('keeps Provenance open when the selected Artifact version changes', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={item} provenanceEntry="leading" onClose={vi.fn()} />)
    })
    await click(container.querySelector('[aria-label="Open Provenance for sin.png"]'))

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, selectedVersionId: 'version-2', versionNumber: 2 }}
          provenanceEntry="leading"
          onClose={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-testid="provenance-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()
  })

  it('hides managed text actions and version navigation for a non-editable image', async () => {
    const managedArtifact = {
      ...item,
      managedFileId: 'artifact-1',
      projectId: 'project-1',
      path: 'artifact-version:project-1/session-1/artifact-1/version-1'
    }
    window.api.managedFileVersions.inspect = vi.fn(async (request) => ({
      ok: true as const,
      value: {
        source: 'artifact' as const,
        projectId: 'project-1',
        fileId: 'artifact-1',
        sessionId: 'session-1',
        displayName: 'sin.png',
        headVersionId: 'version-2',
        selectedVersionId: request.versionId ?? 'version-1',
        versions: [
          {
            id: 'version-1',
            source: 'artifact' as const,
            fileId: 'artifact-1',
            versionNumber: 1,
            displayName: 'sin.png',
            originKind: 'agent_generated' as const,
            basedOnVersionId: null,
            contentType: 'image/png',
            sizeBytes: 12,
            checksum: 'checksum-1',
            createdAt: descriptor.createdAt
          },
          {
            id: 'version-2',
            source: 'artifact' as const,
            fileId: 'artifact-1',
            versionNumber: 2,
            displayName: 'sin.png',
            originKind: 'user_edit' as const,
            basedOnVersionId: 'version-1',
            contentType: 'image/png',
            sizeBytes: 18,
            checksum: 'checksum-2',
            createdAt: secondDescriptor.createdAt
          }
        ],
        canEdit: false,
        canDiff: true
      }
    }))

    await act(async () => {
      root.render(<PreviewFileSurface item={managedArtifact} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Edit sin.png"]')).toBeNull()
    expect(
      container.querySelector('[aria-label="Compare sin.png with its source version"]')
    ).toBeNull()
    expect(container.querySelector('[data-testid="managed-preview-version-navigation"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(container.textContent).toContain('Download file')
    expect(container.querySelector('[aria-label="Close preview of sin.png"]')).not.toBeNull()
  })

  it('hides legacy Artifact version navigation for a non-editable image', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      container.querySelector('[data-testid="artifact-preview-version-navigation"]')
    ).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(container.textContent).toContain('Download file')
    expect(container.querySelector('[aria-label="Close preview of sin.png"]')).not.toBeNull()
  })

  it('keeps legacy Artifact version navigation for an editable Markdown file', async () => {
    const markdownDescriptor = { ...descriptor, name: 'report.md' }
    window.api.artifacts.getLineage = vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'report.md',
      originSession: { sessionId: 'session-1', state: 'active', title: 'Report' },
      versions: [markdownDescriptor, { ...secondDescriptor, name: 'report.md' }]
    })

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, title: 'report.md', name: 'report.md', format: 'markdown' }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      container.querySelector('[data-testid="artifact-preview-version-navigation"]')
    ).not.toBeNull()
    expect(container.querySelector('[aria-label="Edit report.md"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
  })

  it('refreshes a stale lineage when a GENERATED click selects a newly finalized version', async () => {
    const getLineage = vi
      .fn()
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor]
      })
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor, thirdDescriptor]
      })
    window.api.artifacts.getLineage = getLineage
    const versionTwoItem = {
      ...item,
      selectedVersionId: 'version-2',
      versionNumber: 2,
      path: 'artifact-version:project-1/session-1/artifact-1/version-2'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={versionTwoItem} onClose={vi.fn()} workbenchConnected />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      container.querySelector('[data-testid="artifact-preview-version-navigation"]')
    ).toBeNull()

    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertAndActivateItem({
        ...versionTwoItem,
        selectedVersionId: 'version-3',
        versionNumber: 3,
        path: 'artifact-version:project-1/session-1/artifact-1/version-3'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'version-3',
      versionNumber: 3
    })
    expect(getLineage).toHaveBeenCalledTimes(2)
    expect(
      container.querySelector('[data-testid="artifact-preview-version-navigation"]')
    ).toBeNull()
    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          selectedVersionId: 'version-3',
          versionNumber: 3,
          path: 'artifact-version:project-1/session-1/artifact-1/version-3'
        })
      })
    )
  })

  it('refreshes image lineage without exposing non-editable version navigation', async () => {
    const getLineage = vi
      .fn()
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor]
      })
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor, thirdDescriptor]
      })
    window.api.artifacts.getLineage = getLineage
    const session: ChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Sine',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      artifacts: [],
      filesRevision: 1,
      createdAt: 1,
      updatedAt: 1
    }
    useSessionStore.setState({ sessions: [session], selectedSessionId: session.id })
    const versionTwoItem = {
      ...item,
      selectedVersionId: 'version-2',
      versionNumber: 2,
      path: 'artifact-version:project-1/session-1/artifact-1/version-2'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={versionTwoItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      container.querySelector('[data-testid="artifact-preview-version-navigation"]')
    ).toBeNull()

    await act(async () => {
      useSessionStore.setState({
        sessions: [{ ...session, filesRevision: 2, updatedAt: 2 }]
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getLineage).toHaveBeenCalledTimes(2)
    expect(
      container.querySelector('[data-testid="artifact-preview-version-navigation"]')
    ).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
  })

  it('opens its menu above an expanded preview modal', async () => {
    await act(async () => {
      root.render(
        <section role="dialog" className="z-[61]">
          <PreviewFileSurface item={item} onClose={vi.fn()} />
        </section>
      )
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    const dialog = container.querySelector('[role="dialog"]')
    const menu = document.body.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(menu?.textContent).toContain('Provenance')
    expect(zIndexFromClassName(menu!)).toBeGreaterThan(zIndexFromClassName(dialog!))
  })
})

const localItem: PreviewFileItem = {
  id: 'local:/Users/example/logs/proxy.log',
  sessionId: '__local_files__',
  type: 'file',
  title: 'proxy.log',
  name: 'proxy.log',
  path: '/Users/example/logs/proxy.log',
  format: 'text',
  source: 'local'
}

const setupLocalApi = (): void => {
  window.api.localFs = {
    reveal: vi.fn(),
    openPath: vi.fn()
  } as unknown as typeof window.api.localFs
  window.api.saveManagedFile = vi.fn().mockResolvedValue({ saved: true })
  window.api.uploads = {
    stageLocalPath: vi
      .fn()
      .mockResolvedValue({ id: 'attachment-1', path: '/managed/.pending/proxy.log' })
  } as unknown as typeof window.api.uploads
}

const clickMenuItem = async (label: string): Promise<void> => {
  const menuItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent?.includes(label)
  )
  if (!menuItem) throw new Error(`menu item not found: ${label}`)
  await click(menuItem)
}

describe('PreviewFileSurface local file header', () => {
  beforeEach(() => {
    setupLocalApi()
  })

  it('shows a This computer pill before the file path in a light style', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })

    const pathLine = container.querySelector('[data-testid="local-file-path"]')
    expect(pathLine?.textContent).toBe('This computer/Users/example/logs/proxy.log')
    expect(pathLine?.className).toContain('text-text-100')
    expect(pathLine?.querySelector('span')?.className).toContain('rounded-full')
  })

  it('offers a reload button instead of a standalone reveal button', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Reveal in Finder"]')).toBeNull()
    previewContentSpy.mockClear()

    await click(container.querySelector('[aria-label="Reload file"]'))

    // Reload remounts the content tree so the preview is re-read from disk.
    expect(previewContentSpy).toHaveBeenCalled()
  })

  it('uses the stronger preview-header tone for local file actions', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Reload file"]')?.className.split(/\s+/)).toContain(
      'text-text-000'
    )
    expect(
      container.querySelector('[aria-label="More actions"]')?.className.split(/\s+/)
    ).toContain('text-text-000')
  })

  it('groups the menu per the local-file design: identity header, Copy path, On this machine', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    await openMenu(container.querySelector('[aria-label="More actions"]'))

    const menu = document.body.querySelector('[role="menu"]')
    // The menu opens with the file identity: name above the full path in a light tone.
    expect(menu?.textContent).toContain('proxy.log')
    expect(menu?.textContent).toContain('/Users/example/logs/proxy.log')
    expect(menu?.textContent).toContain('Copy path')
    expect(menu?.textContent).toContain('On this machine')
    expect(menu?.textContent).toContain('Download')
    expect(menu?.textContent).toContain('Save as artifact')
    expect(menu?.textContent).not.toContain('Reveal in Finder')
    expect(menu?.textContent).not.toContain('Open with default app')
    expect(menu?.textContent).not.toContain('Annotate')
    expect(menu?.textContent).not.toContain('Delete')

    await clickMenuItem('Download')

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'local',
      path: '/Users/example/logs/proxy.log',
      suggestedName: 'proxy.log'
    })
  })

  it('opens its menu above an expanded preview modal', async () => {
    await act(async () => {
      root.render(
        <section role="dialog" className="z-[61]">
          <PreviewFileSurface item={localItem} onClose={vi.fn()} />
        </section>
      )
    })

    await openMenu(container.querySelector('[aria-label="More actions"]'))

    const dialog = container.querySelector('[role="dialog"]')
    const menu = document.body.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(menu?.textContent).toContain('Save as artifact')
    expect(zIndexFromClassName(menu!)).toBeGreaterThan(zIndexFromClassName(dialog!))
  })

  it('shows no tooltip for the More actions trigger', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    const trigger = container.querySelector('[aria-label="More actions"]')!

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    // Tooltip content carries bg-text-000; the dropdown menu content (bg-popover) must not match.
    expect(
      document.body.querySelector('[data-radix-popper-content-wrapper] .bg-text-000')
    ).toBeNull()
  })

  it('saves as artifact, then swaps the menu item for a saved chip', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    await openMenu(container.querySelector('[aria-label="More actions"]'))
    await clickMenuItem('Save as artifact')

    expect(window.api.uploads.stageLocalPath).toHaveBeenCalledWith({
      transferId: expect.any(String),
      name: 'proxy.log',
      sourcePath: '/Users/example/logs/proxy.log'
    })
    const chip = container.querySelector('[data-testid="saved-as-artifact"]')
    expect(chip).not.toBeNull()
    // The Saved chip leads the local action cluster, ahead of the reload button.
    const reload = container.querySelector('[aria-label="Reload file"]')
    expect(chip!.compareDocumentPosition(reload!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await openMenu(container.querySelector('[aria-label="More actions"]'))
    expect(document.body.querySelector('[role="menu"]')?.textContent).not.toContain(
      'Save as artifact'
    )
  })
})

const originSession: ChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Sine',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  artifacts: [],
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 1
}

const otherSession: ChatSession = {
  ...originSession,
  id: 'session-2',
  title: 'Other',
  updatedAt: 2
}

const seedWorkspaceStores = (): void => {
  useProjectStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'Project One',
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    isLoaded: true
  })
  useSessionStore.setState({
    sessions: [originSession, otherSession],
    selectedSessionId: 'session-2'
  })
  useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })
}

describe('PreviewFileSurface View in context entry', () => {
  it('switches the conversation to the artifact origin session from the panel menu', async () => {
    seedWorkspaceStores()

    await act(async () => {
      root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))
    await clickMenuItem('View in context')

    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
  })

  it('does not offer View in context for uploaded inputs', async () => {
    seedWorkspaceStores()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, id: 'upload-1', artifactId: undefined, source: 'upload' }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label^="File actions for"]')).toBeNull()
  })

  it('hides View in context but keeps Provenance when the origin session is deleted', async () => {
    seedWorkspaceStores()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'deleted', deletedAt: '2026-08-01' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    const menu = document.body.querySelector('[role="menu"]')
    expect(menu?.textContent).toContain('Provenance')
    expect(menu?.textContent).not.toContain('View in context')
  })

  it('lets the lineage report of a deleted origin session override the stale item snapshot', async () => {
    seedWorkspaceStores()
    // The preview tab still carries its creation-time snapshot; the refetched lineage is the
    // authority once it resolves with the post-deletion state.
    window.api.artifacts.getLineage = vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'deleted', title: 'Sine' },
      versions: [descriptor, secondDescriptor]
    })

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'active' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    const menu = document.body.querySelector('[role="menu"]')
    expect(menu?.textContent).toContain('Provenance')
    expect(menu?.textContent).not.toContain('View in context')
  })

  it('does not notify View in context consumers when the guard rejects the navigation', async () => {
    seedWorkspaceStores()
    // The origin session vanished after render (deleted mid-flight): the guard must reject the
    // open, and the full-screen dialog must stay open on the un-navigated surface.
    useSessionStore.setState({ sessions: [otherSession], selectedSessionId: 'session-2' })
    const onViewInContextNavigate = vi.fn()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={item}
          provenanceEntry="trailing"
          onViewInContextNavigate={onViewInContextNavigate}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await click(container.querySelector('[aria-label="View in context for sin.png"]'))

    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')
    expect(onViewInContextNavigate).not.toHaveBeenCalled()
  })

  it('keeps View in context visible but inert when the origin session is archived', async () => {
    seedWorkspaceStores()
    useSessionStore.setState({
      sessions: [{ ...originSession, archivedAt: 5 }, otherSession],
      selectedSessionId: 'session-2'
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))
    const menuItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.includes('View in context')
    )
    expect(menuItem?.getAttribute('aria-disabled')).toBe('true')
    // The reason reads inline, matching the disabled-item precedent in AgentInstallSourceMenu.
    expect(menuItem?.textContent).toContain('Source conversation is archived')

    await click(menuItem ?? null)

    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')
  })

  it('navigates and notifies from the full-screen trailing entry', async () => {
    seedWorkspaceStores()
    const onViewInContextNavigate = vi.fn()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={item}
          provenanceEntry="trailing"
          onViewInContextNavigate={onViewInContextNavigate}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await click(container.querySelector('[aria-label="View in context for sin.png"]'))

    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
    expect(onViewInContextNavigate).toHaveBeenCalledOnce()
  })
})
