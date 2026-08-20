// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  type PreviewFileItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@radix-ui/react-focus-scope', () => ({
  FocusScope: ({ children }: PropsWithChildren) => <>{children}</>
}))

vi.mock('radix-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('radix-ui')>()
  return {
    ...actual,
    Dialog: {
      Root: ({ children }: PropsWithChildren) => <>{children}</>,
      Portal: ({ children }: PropsWithChildren) => <>{children}</>,
      Content: ({ children, className }: PropsWithChildren<{ className?: string }>) => (
        <div role="dialog" className={className}>
          {children}
        </div>
      ),
      Title: ({ children }: PropsWithChildren) => <h2>{children}</h2>
    }
  }
})

vi.mock('./ManagedFileDownloadButton', () => ({
  ManagedFileDownloadButton: () => <button type="button">Download file</button>
}))

vi.mock('./previews/PreviewFileContent', () => ({
  PreviewFileContent: ({ item }: { item: PreviewFileItem }) => (
    <div data-testid="preview-content">{item.path}</div>
  )
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

import { FilePreviewDialog } from './FilePreviewDialog'

const versions = [
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
    checksum: 'one',
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
    checksum: 'two',
    createdAt: '2026-08-12T00:00:00.000Z'
  },
  {
    id: 'upload-v3',
    source: 'upload' as const,
    fileId: 'upload-file-1',
    versionNumber: 3,
    displayName: 'README.md',
    originKind: 'user_edit' as const,
    basedOnVersionId: 'upload-v2',
    contentType: 'text/markdown',
    sizeBytes: 10,
    checksum: 'three',
    createdAt: '2026-08-13T00:00:00.000Z'
  }
]

const versionThreeItem: PreviewFileItem = {
  id: 'upload:upload-file-1',
  managedFileId: 'upload-file-1',
  selectedVersionId: 'upload-v3',
  versionNumber: 3,
  projectId: 'project-1',
  sessionId: 'session-1',
  type: 'file',
  title: 'README.md',
  name: 'README.md',
  path: 'upload-version:project-1/session-1/upload-v3',
  format: 'markdown',
  source: 'upload'
}

const StoreConnectedDialog = (): React.JSX.Element => {
  const item = usePreviewWorkbenchStore((state) => state.fileDialogItem)
  return (
    <FilePreviewDialog
      item={item}
      onClose={usePreviewWorkbenchStore.getState().closeFileDialog}
      onItemChange={usePreviewWorkbenchStore.getState().openFileDialog}
    />
  )
}

let container: HTMLDivElement
let root: Root

const click = async (selector: string): Promise<void> => {
  const element = document.body.querySelector<HTMLElement>(selector)
  if (!element) throw new Error(`element not found: ${selector}`)
  await act(async () => element.click())
}

beforeEach(() => {
  previewLeaveGuards.clear()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  usePreviewWorkbenchStore.getState().activateProject('project-1')
  usePreviewWorkbenchStore.getState().openFileDialog(versionThreeItem)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      artifacts: { getLineage: vi.fn() },
      managedFileVersions: {
        inspect: vi.fn(async (request) => ({
          ok: true as const,
          value: {
            source: 'upload' as const,
            projectId: 'project-1',
            fileId: 'upload-file-1',
            sessionId: 'session-1',
            displayName: 'README.md',
            headVersionId: 'upload-v3',
            selectedVersionId: request.versionId ?? 'upload-v3',
            versions,
            canEdit: true,
            canDiff: request.versionId !== 'upload-v1',
            text: `# ${request.versionId ?? 'upload-v3'}\n`,
            textFormat: {
              hasUtf8Bom: false,
              newline: 'lf' as const,
              hasTrailingNewline: true
            }
          }
        })),
        diffText: vi.fn().mockReturnValue(new Promise(() => undefined)),
        cancelDiff: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }),
        saveTextEdit: vi.fn()
      }
    }
  })
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  previewLeaveGuards.clear()
  vi.restoreAllMocks()
})

describe('FilePreviewDialog managed version transitions', () => {
  it('hides managed text actions and version navigation for a non-editable file', async () => {
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        source: 'upload',
        projectId: 'project-1',
        fileId: 'upload-file-1',
        sessionId: 'session-1',
        displayName: 'README.md',
        headVersionId: 'upload-v3',
        selectedVersionId: 'upload-v3',
        versions,
        canEdit: false,
        canDiff: true
      }
    })

    await act(async () => {
      root.render(<FilePreviewDialog item={versionThreeItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[aria-label="Edit README.md"]')).toBeNull()
    expect(
      document.body.querySelector('[aria-label="Compare README.md with its source version"]')
    ).toBeNull()
    expect(
      document.body.querySelector('[data-testid="managed-preview-version-navigation"]')
    ).toBeNull()
    expect(document.body.textContent).toContain('Download file')
    expect(document.body.querySelector('[aria-label="Close preview of README.md"]')).not.toBeNull()
  })

  it('keeps version navigation working when onItemChange is omitted', async () => {
    await act(async () => {
      root.render(<FilePreviewDialog item={versionThreeItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    await click('[aria-label="Previous file version"]')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[data-testid="preview-content"]')?.textContent).toContain(
      'upload-v2'
    )
    expect(
      document.body.querySelector('[data-testid="managed-preview-version-navigation"]')?.textContent
    ).toBe('v2')
  })

  it('does not reuse a stale internal override after the controlled Dialog returns to its original version', async () => {
    await act(async () => {
      root.render(<StoreConnectedDialog />)
      await Promise.resolve()
      await Promise.resolve()
    })

    await click('[aria-label="Previous file version"]')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-testid="preview-content"]')?.textContent).toContain(
      'upload-v2'
    )

    await act(async () => {
      usePreviewWorkbenchStore.getState().openFileDialog(versionThreeItem, true)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      selectedVersionId: 'upload-v3'
    })
    expect(document.body.querySelector('[data-testid="preview-content"]')?.textContent).toContain(
      'upload-v3'
    )
    expect(
      document.body.querySelector('[data-testid="managed-preview-version-navigation"]')?.textContent
    ).toBe('v3')
  })

  it('keeps diff mode through the controlled Dialog from v3 to v1 and back to v2', async () => {
    await act(async () => {
      root.render(<StoreConnectedDialog />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await click('[aria-label="Compare README.md with its source version"]')
    await click('[aria-label="Previous file version"]')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      selectedVersionId: 'upload-v2',
      versionNumber: 2
    })
    expect(window.api.managedFileVersions.cancelDiff).toHaveBeenCalledWith({
      requestId: expect.any(String)
    })
    expect(window.api.managedFileVersions.diffText).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: 'upload-v2' })
    )
    expect(document.body.querySelector('[aria-label="Stop comparing README.md"]')).not.toBeNull()

    await click('[aria-label="Previous file version"]')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      selectedVersionId: 'upload-v1',
      versionNumber: 1
    })
    expect(window.api.managedFileVersions.cancelDiff).toHaveBeenCalledTimes(2)
    const stopComparing = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Stop comparing README.md"]'
    )
    expect(stopComparing).not.toBeNull()
    expect(stopComparing?.disabled).toBe(false)
    expect(document.body.querySelector('[data-testid="preview-content"]')?.textContent).toContain(
      'upload-v1'
    )
    expect(window.api.managedFileVersions.diffText).not.toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'upload-v1' })
    )

    await click('[aria-label="Next file version"]')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      selectedVersionId: 'upload-v2',
      versionNumber: 2
    })
    expect(window.api.managedFileVersions.diffText).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: 'upload-v2' })
    )
    expect(document.body.querySelector('[aria-label="Stop comparing README.md"]')).not.toBeNull()
  })
})
