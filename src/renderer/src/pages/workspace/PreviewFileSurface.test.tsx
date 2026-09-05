// @vitest-environment jsdom
import { act, createRef } from 'react'
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
import { createNotebookInputPreviewKey } from '../../../../shared/notebook'
import {
  createInitialSessionState,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'

const provenancePanelSpy = vi.hoisted(() => vi.fn())
const previewContentSpy = vi.hoisted(() => vi.fn())
const diffContentSpy = vi.hoisted(() => vi.fn())
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

vi.mock('./ManagedFileDownloadButton', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ManagedFileDownloadButton')>()
  return {
    ManagedFileDownloadButton: (
      props: React.ComponentProps<typeof actual.ManagedFileDownloadButton>
    ) => {
      downloadButtonSpy(props)
      return <actual.ManagedFileDownloadButton {...props} />
    }
  }
})

vi.mock('./previews/PreviewFileContent', () => ({
  PreviewFileContent: (props: {
    item: PreviewFileItem
    annotationVersionId?: string
    annotationBlockedByHistoricalVersion?: boolean
    annotationVersionPending?: boolean
    onRetry?: () => Promise<void>
    onPdfReadingPositionChange?: (position: { pageNumber: number; pageCount: number }) => void
  }) => {
    previewContentSpy(props)
    return (
      <div data-testid="preview-content" data-path={props.item.path}>
        Preview content
        {props.onRetry ? (
          <button type="button" onClick={() => void props.onRetry?.()}>
            Retry managed preview
          </button>
        ) : null}
      </div>
    )
  }
}))

vi.mock('./ManagedVersionDiffContent', () => ({
  ManagedVersionDiffContent: (props: { result: unknown; format: string; name: string }) => {
    diffContentSpy(props)
    return <div data-testid="managed-version-diff-content" />
  }
}))

import { PreviewFileSurface } from './PreviewFileSurface'
import { FOCUS_COMPOSER_EVENT } from './composer-focus-events'

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

const discardConfirmation = (): HTMLElement | null =>
  document.body.querySelector('[data-testid="discard-preview-changes-confirmation"]')

const confirmDiscard = async (): Promise<void> => {
  await click(
    discardConfirmation()?.querySelector<HTMLButtonElement>('button:last-of-type') ?? null
  )
}

const cancelDiscard = async (): Promise<void> => {
  await click(
    discardConfirmation()?.querySelector<HTMLButtonElement>('button:first-of-type') ?? null
  )
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

const installPdfContextApi = (): {
  linkPdfContext: ReturnType<typeof vi.fn>
  unlinkPdfContext: ReturnType<typeof vi.fn>
} => {
  const linkPdfContext = vi.fn().mockResolvedValue({ version: 1, revision: 4 })
  const unlinkPdfContext = vi.fn().mockResolvedValue({ version: 1, revision: 4 })
  window.api.sessions = {
    ...window.api.sessions,
    linkPdfContext,
    unlinkPdfContext
  } as typeof window.api.sessions
  return { linkPdfContext, unlinkPdfContext }
}

const selectPdfContextSession = (
  pdfContext?: NonNullable<NonNullable<ChatSession['runtimeContext']>['pdfContext']>
): void => {
  useSessionStore.setState({
    selectedSessionId: 'active-session',
    sessions: [
      {
        id: 'active-session',
        projectId: 'project-1',
        title: 'Active',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        runtimeContext: {
          version: 1,
          revision: 3,
          ...(pdfContext ? { pdfContext } : {})
        },
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
}

beforeEach(() => {
  previewLeaveGuards.clear()
  provenancePanelSpy.mockClear()
  previewContentSpy.mockClear()
  diffContentSpy.mockClear()
  downloadButtonSpy.mockClear()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  usePreviewWorkbenchStore.getState().activateProject('project-1')
  useSessionStore.setState(createInitialSessionState())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
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

  it.each(['plot.png', 'report.pdf', 'README.md'])(
    'offers older history for %s only alongside a version navigator',
    async (name) => {
      const isText = name.endsWith('.md')
      window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          ...managedInspect,
          displayName: name,
          nextCursor: '1',
          text: isText ? managedInspect.text : undefined,
          canEdit: isText,
          canDiff: isText
        }
      })
      await act(async () =>
        root.render(<PreviewFileSurface item={{ ...managedUploadItem, name }} onClose={vi.fn()} />)
      )
      expect(
        container.querySelector('[data-testid="managed-preview-version-navigation"]') !== null
      ).toBe(isText)
      const loader = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Load earlier versions'
      )
      expect(loader !== undefined).toBe(isText)
    }
  )

  it('keeps the selected download target while inspection is pending and after failure', async () => {
    type Result = Awaited<ReturnType<typeof window.api.managedFileVersions.inspect>>
    let rejectInspect!: (error: Error) => void
    window.api.managedFileVersions.inspect = vi.fn((request) =>
      request.versionId === 'upload-v1'
        ? new Promise<Result>((_resolve, reject) => {
            rejectInspect = reject
          })
        : Promise.resolve({
            ok: true as const,
            value: {
              ...managedInspect,
              selectedVersion: managedInspect.versions[1],
              headVersion: managedInspect.versions[1]
            }
          })
    )
    await act(async () =>
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
    )
    await click(container.querySelector('[aria-label="Previous file version"]'))
    const expectSelectedDownload = (): void => {
      expect(downloadButtonSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          versionId: 'upload-v1',
          versionNumber: 1,
          latestVersionId: 'upload-v2'
        })
      )
      expect(
        container.querySelector('[data-testid="managed-preview-version-navigation"]')?.textContent
      ).toContain('v1')
    }
    expectSelectedDownload()
    await act(async () => rejectInspect(new Error('inspection temporarily unavailable')))
    expectSelectedDownload()
  })

  it('navigates to the previous managed version outside the loaded history page', async () => {
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ...managedInspect,
        versions: [],
        selectedVersion: managedInspect.versions[1],
        headVersion: managedInspect.versions[1],
        previousVersion: managedInspect.versions[0]
      }
    })
    await act(async () =>
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
    )
    const previous = container.querySelector<HTMLButtonElement>(
      '[aria-label="Previous file version"]'
    )
    expect(previous?.disabled).toBe(false)
    await click(previous)
    expect(window.api.managedFileVersions.inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: 'upload-v1' })
    )
  })

  it('stays read-only when the Web runtime omits the managed-file namespace', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        artifacts: window.api.artifacts
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

  it('blocks annotation when an editable managed file is not on its head Version', async () => {
    const historicalItem = {
      ...managedUploadItem,
      selectedVersionId: 'upload-v1',
      versionNumber: 1,
      path: 'upload-version:project-1/session-1/upload-v1'
    }
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...managedInspect, selectedVersionId: 'upload-v1', text: '# Original\n' }
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={historicalItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        annotationBlockedByHistoricalVersion: true,
        annotationVersionPending: false
      })
    )
  })

  it('keeps managed annotation blocked until Version inspection confirms the head', async () => {
    window.api.managedFileVersions.inspect = vi.fn().mockReturnValue(new Promise(() => undefined))

    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })

    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ annotationVersionPending: true })
    )
  })

  it('blocks historical managed files independently of text editing eligibility', async () => {
    const historicalItem = {
      ...managedUploadItem,
      name: 'alignment.fasta',
      title: 'alignment.fasta',
      format: 'fasta' as const,
      selectedVersionId: 'upload-v1',
      versionNumber: 1,
      path: 'upload-version:project-1/session-1/upload-v1'
    }
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ...managedInspect,
        displayName: 'alignment.fasta',
        selectedVersionId: 'upload-v1',
        canEdit: false,
        canDiff: false,
        text: undefined,
        textFormat: undefined,
        unavailableReason: 'NOT_EDITABLE_EXTENSION' as const
      }
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={historicalItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ annotationBlockedByHistoricalVersion: true })
    )
  })

  it('supplies the exact head Version when annotating a default managed Artifact', async () => {
    const managedArtifactItem: PreviewFileItem = {
      ...managedUploadItem,
      id: 'artifact-1',
      artifactId: 'artifact-1',
      managedFileId: 'artifact-1',
      selectedVersionId: undefined,
      source: 'artifact',
      path: '/stale/managed-file-projection.md'
    }
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ...managedInspect,
        source: 'artifact',
        fileId: 'artifact-1',
        headVersionId: 'artifact-v2',
        selectedVersionId: 'artifact-v2',
        versions: managedInspect.versions.map((version, index) => ({
          ...version,
          id: `artifact-v${index + 1}`,
          source: 'artifact' as const,
          fileId: 'artifact-1'
        }))
      }
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={managedArtifactItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        annotationVersionId: 'artifact-v2',
        item: expect.objectContaining({
          path: '/stale/managed-file-projection.md',
          selectedVersionId: undefined
        })
      })
    )
  })

  it('retains the last confirmed annotation Version while its managed inspect refreshes', async () => {
    const managedArtifactItem: PreviewFileItem = {
      ...managedUploadItem,
      id: 'artifact-1',
      artifactId: 'artifact-1',
      managedFileId: 'artifact-1',
      selectedVersionId: undefined,
      source: 'artifact',
      path: '/stale/managed-file-projection.md'
    }
    const artifactInspect = {
      ...managedInspect,
      source: 'artifact' as const,
      fileId: 'artifact-1',
      headVersionId: 'artifact-v2',
      selectedVersionId: 'artifact-v2',
      versions: managedInspect.versions.map((version, index) => ({
        ...version,
        id: `artifact-v${index + 1}`,
        source: 'artifact' as const,
        fileId: 'artifact-1'
      }))
    }
    window.api.managedFileVersions.inspect = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: artifactInspect })
      .mockReturnValueOnce(new Promise(() => undefined))
    window.api.managedFileVersions.saveTextEdit = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        kind: 'noop',
        version: artifactInspect.versions[1],
        headVersionId: 'artifact-v2'
      }
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={managedArtifactItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Revised\n')
    await click(container.querySelector('[aria-label="Save changes"]'))

    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        annotationVersionId: 'artifact-v2',
        annotationVersionPending: true
      })
    )
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

    await act(async () => {
      expect(previewLeaveGuards.request('localized-dirty-draft', leaveAction)).toBe(false)
    })
    expect(discardConfirmation()?.textContent).toContain('要放弃未保存的更改吗？')
    expect(discardConfirmation()?.textContent).toContain('对此文件的未保存编辑将丢失。')
    expect(leaveAction).not.toHaveBeenCalled()
    await cancelDiscard()

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
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Draft\n')
    await click(container.querySelector('[aria-label="Save changes"]'))
    await click(container.querySelector('[aria-label="Previous file version"]'))
    expect(discardConfirmation()).not.toBeNull()
    await confirmDiscard()

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
    const currentDiff = {
      baseVersionId: 'upload-v1',
      selectedVersionId: 'upload-v2',
      lines: [
        {
          kind: 'added' as const,
          newLineNumber: 1,
          segments: [{ kind: 'added' as const, text: 'Current v2 diff' }]
        }
      ]
    }
    await act(async () => {
      pending[1]?.({ ok: true, value: currentDiff })
      await Promise.resolve()
    })
    expect(diffContentSpy).toHaveBeenLastCalledWith({
      result: currentDiff,
      format: 'markdown',
      name: 'README.md'
    })
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
    expect(diffContentSpy).toHaveBeenLastCalledWith({
      result: currentDiff,
      format: 'markdown',
      name: 'README.md'
    })
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
    const currentDiff = {
      baseVersionId: 'upload-v1',
      selectedVersionId: 'upload-v2',
      lines: [
        {
          kind: 'added' as const,
          newLineNumber: 1,
          segments: [{ kind: 'added' as const, text: 'Connected v2 diff' }]
        }
      ]
    }
    await act(async () => {
      pending[1]?.({ ok: true, value: currentDiff })
      await Promise.resolve()
    })
    expect(diffContentSpy).toHaveBeenLastCalledWith({
      result: currentDiff,
      format: 'markdown',
      name: 'README.md'
    })
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
    expect(diffContentSpy).toHaveBeenLastCalledWith({
      result: currentDiff,
      format: 'markdown',
      name: 'README.md'
    })
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
    expect(discardConfirmation()).not.toBeNull()
    await confirmDiscard()

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'upload-v1'
    })
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('runs an approved deferred workbench mutation without a second confirmation', async () => {
    const store = usePreviewWorkbenchStore.getState()
    store.activateProject('project-1')
    store.upsertAndActivateItem(managedUploadItem)
    const surfaceRef = createRef<{
      requestLeave: (action: () => boolean | void) => boolean
    }>()
    await act(async () => {
      root.render(
        <PreviewFileSurface
          ref={surfaceRef}
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

    await act(async () => {
      surfaceRef.current?.requestLeave(() =>
        usePreviewWorkbenchStore.getState().removeItem(managedUploadItem.id)
      )
    })
    expect(discardConfirmation()).not.toBeNull()
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)

    await confirmDiscard()

    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(0)
    expect(discardConfirmation()).toBeNull()
  })

  it('keeps a dirty draft when a version switch is rejected', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={managedUploadItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await click(container.querySelector('[aria-label="Edit README.md"]'))
    await changeTextarea(container.querySelector<HTMLTextAreaElement>('textarea')!, '# Draft\n')

    await click(container.querySelector('[aria-label="Previous file version"]'))
    expect(discardConfirmation()).not.toBeNull()
    await cancelDiscard()

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('# Draft\n')
    expect(
      container.querySelector('[data-testid="managed-preview-version-navigation"]')?.textContent
    ).toBe('v2')
  })

  it('does not guard again when a connected save publishes its new version', async () => {
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(managedUploadItem)
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

    expect(discardConfirmation()).toBeNull()
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'upload-v3'
    })
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

  it.each([
    { name: 'README.md', format: 'markdown' as const },
    { name: 'notes.txt', format: 'text' as const },
    { name: 'analysis.sh', format: 'code' as const }
  ])('forwards the managed diff DTO and $format file metadata', async ({ name, format }) => {
    const result = {
      baseVersionId: 'upload-v1',
      selectedVersionId: 'upload-v2',
      lines: [
        {
          kind: 'removed' as const,
          oldLineNumber: 1,
          segments: [
            { kind: 'context' as const, text: 'Sub title ' },
            { kind: 'removed' as const, text: 'two' }
          ]
        },
        {
          kind: 'added' as const,
          newLineNumber: 1,
          segments: [
            { kind: 'context' as const, text: 'Sub title ' },
            { kind: 'added' as const, text: 'three' }
          ]
        }
      ]
    }
    window.api.managedFileVersions.diffText = vi.fn().mockResolvedValue({ ok: true, value: result })

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...managedUploadItem, name, title: name, format }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
    })
    await click(container.querySelector(`[aria-label="Compare ${name} with its source version"]`))
    await act(async () => {
      await Promise.resolve()
    })

    expect(diffContentSpy).toHaveBeenLastCalledWith({ result, format, name })
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
  it('refreshes a restored path-only Artifact identity before retrying its preview', async () => {
    const legacyPath = String.raw`C:\stale\report.md`
    const legacyItem: PreviewFileItem = {
      id: 'legacy-artifact-id',
      projectId: 'project-1',
      sessionId: 'session-1',
      type: 'file',
      title: legacyPath,
      name: legacyPath,
      path: legacyPath,
      format: 'markdown',
      source: 'artifact'
    }
    const resolveFile = vi.fn().mockResolvedValue({
      id: 'canonical-artifact-id',
      source: 'artifact',
      sourceFileId: 'canonical-artifact-id',
      sourceVersionId: 'version-3',
      projectId: 'project-1',
      sessionId: 'session-1',
      name: 'report.md',
      path: 'artifact-version:project-1/session-1/canonical-artifact-id/version-3',
      mimeType: 'text/markdown',
      size: 42,
      mtimeMs: 3,
      sortAtMs: 3
    })
    window.api.projectFiles = { resolveFile } as unknown as typeof window.api.projectFiles
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(legacyItem)

    await act(async () => {
      root.render(<PreviewFileSurface item={legacyItem} onClose={vi.fn()} workbenchConnected />)
      await Promise.resolve()
    })

    await click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry managed preview'
      ) ?? null
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(resolveFile).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      source: 'artifact',
      fileIdHint: 'legacy-artifact-id',
      identityHint: 'legacy',
      name: 'report.md'
    })
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      id: 'legacy-artifact-id',
      artifactId: 'canonical-artifact-id',
      managedFileId: 'canonical-artifact-id',
      path: 'artifact-version:project-1/session-1/canonical-artifact-id/version-3'
    })
  })

  it('does not pin a lineage-derived head while refreshing an unpinned Artifact', async () => {
    const legacyItem: PreviewFileItem = {
      ...item,
      id: 'legacy-preview-id',
      projectId: 'project-1',
      managedFileId: undefined,
      selectedVersionId: undefined,
      versionNumber: undefined
    }
    const resolveFile = vi.fn().mockResolvedValue({
      id: 'artifact-1',
      source: 'artifact',
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-3',
      projectId: 'project-1',
      sessionId: 'session-1',
      name: 'sin.png',
      path: 'artifact-version:project-1/session-1/artifact-1/version-3',
      mimeType: 'image/png',
      size: 24,
      mtimeMs: 3,
      sortAtMs: 3
    })
    window.api.projectFiles = { resolveFile } as unknown as typeof window.api.projectFiles
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(legacyItem)

    await act(async () => {
      root.render(<PreviewFileSurface item={legacyItem} onClose={vi.fn()} workbenchConnected />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(previewContentSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          item: expect.objectContaining({ selectedVersionId: 'version-2' })
        })
      )
    )

    await click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry managed preview'
      ) ?? null
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      id: 'legacy-preview-id',
      managedFileId: 'artifact-1',
      path: 'artifact-version:project-1/session-1/artifact-1/version-3'
    })
    expect(usePreviewWorkbenchStore.getState().items[0]).not.toHaveProperty('selectedVersionId')
    expect(usePreviewWorkbenchStore.getState().items[0]).not.toHaveProperty('versionNumber')
  })

  it('ignores a stale retry lookup after the user selects another Artifact version', async () => {
    const legacyItem: PreviewFileItem = {
      id: 'legacy-artifact-id',
      projectId: 'project-1',
      sessionId: 'session-1',
      type: 'file',
      title: 'report.md',
      name: 'report.md',
      path: '/stale/report.md',
      format: 'markdown',
      source: 'artifact'
    }
    const resolvedFile = {
      id: 'canonical-artifact-id',
      source: 'artifact' as const,
      sourceFileId: 'canonical-artifact-id',
      sourceVersionId: 'version-3',
      projectId: 'project-1',
      sessionId: 'session-1',
      name: 'report.md',
      path: 'artifact-version:project-1/session-1/canonical-artifact-id/version-3',
      mimeType: 'text/markdown',
      size: 42,
      mtimeMs: 3,
      sortAtMs: 3
    }
    let finishResolve: ((value: typeof resolvedFile) => void) | undefined
    const resolveFile = vi.fn(
      () =>
        new Promise<typeof resolvedFile>((resolve) => {
          finishResolve = resolve
        })
    )
    window.api.projectFiles = { resolveFile } as unknown as typeof window.api.projectFiles
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(legacyItem)

    await act(async () => {
      root.render(<PreviewFileSurface item={legacyItem} onClose={vi.fn()} workbenchConnected />)
      await Promise.resolve()
    })
    await click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry managed preview'
      ) ?? null
    )
    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertItem(
        {
          ...legacyItem,
          artifactId: 'canonical-artifact-id',
          managedFileId: 'canonical-artifact-id',
          selectedVersionId: 'version-2',
          versionNumber: 2,
          path: 'artifact-version:project-1/session-1/canonical-artifact-id/version-2'
        },
        true
      )
      await Promise.resolve()
    })
    await act(async () => {
      finishResolve?.(resolvedFile)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'version-2',
      versionNumber: 2,
      path: 'artifact-version:project-1/session-1/canonical-artifact-id/version-2'
    })
  })

  it('ignores a stale retry lookup after the preview identity changes and returns', async () => {
    const legacyItem: PreviewFileItem = {
      id: 'legacy-artifact-id',
      projectId: 'project-1',
      sessionId: 'session-1',
      type: 'file',
      title: 'report.md',
      name: 'report.md',
      path: '/stale/report.md',
      format: 'markdown',
      source: 'artifact'
    }
    const resolvedFile = {
      id: 'canonical-artifact-id',
      source: 'artifact' as const,
      sourceFileId: 'canonical-artifact-id',
      sourceVersionId: 'version-3',
      projectId: 'project-1',
      sessionId: 'session-1',
      name: 'report.md',
      path: 'artifact-version:project-1/session-1/canonical-artifact-id/version-3',
      size: 42,
      sortAtMs: 3
    }
    let finishResolve: ((value: typeof resolvedFile) => void) | undefined
    const resolveFile = vi.fn(
      () =>
        new Promise<typeof resolvedFile>((resolve) => {
          finishResolve = resolve
        })
    )
    window.api.projectFiles = { resolveFile } as unknown as typeof window.api.projectFiles
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(legacyItem)

    await act(async () => {
      root.render(<PreviewFileSurface item={legacyItem} onClose={vi.fn()} workbenchConnected />)
      await Promise.resolve()
    })
    await click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry managed preview'
      ) ?? null
    )
    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertItem(
        {
          ...legacyItem,
          artifactId: 'canonical-artifact-id',
          managedFileId: 'canonical-artifact-id',
          selectedVersionId: 'version-2',
          versionNumber: 2,
          path: 'artifact-version:project-1/session-1/canonical-artifact-id/version-2'
        },
        true
      )
      await Promise.resolve()
    })
    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertItem(legacyItem, true)
      await Promise.resolve()
    })
    await act(async () => {
      finishResolve?.(resolvedFile)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject(legacyItem)
    expect(usePreviewWorkbenchStore.getState().items[0]).not.toHaveProperty('artifactId')
    expect(usePreviewWorkbenchStore.getState().items[0]).not.toHaveProperty('managedFileId')
  })

  it('ignores a retry lookup started before a retained preview closes and reopens', async () => {
    const legacyItem: PreviewFileItem = {
      id: 'legacy-artifact-id',
      projectId: 'project-1',
      sessionId: 'session-1',
      type: 'file',
      title: 'report.md',
      name: 'report.md',
      path: '/stale/report.md',
      format: 'markdown',
      source: 'artifact'
    }
    const resolvedFile = {
      id: 'canonical-artifact-id',
      source: 'artifact' as const,
      sourceFileId: 'canonical-artifact-id',
      sourceVersionId: 'version-3',
      projectId: 'project-1',
      sessionId: 'session-1',
      name: 'report.md',
      path: 'artifact-version:project-1/session-1/canonical-artifact-id/version-3',
      size: 42,
      sortAtMs: 3
    }
    let finishResolve: ((value: typeof resolvedFile) => void) | undefined
    const resolveFile = vi.fn(
      () =>
        new Promise<typeof resolvedFile>((resolve) => {
          finishResolve = resolve
        })
    )
    window.api.projectFiles = { resolveFile } as unknown as typeof window.api.projectFiles
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(legacyItem)

    await act(async () => {
      root.render(<PreviewFileSurface item={legacyItem} onClose={vi.fn()} workbenchConnected />)
      await Promise.resolve()
    })
    await click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry managed preview'
      ) ?? null
    )
    await act(async () => {
      usePreviewWorkbenchStore.getState().removeItem(legacyItem.id)
      root.render(
        <PreviewFileSurface
          item={legacyItem}
          onClose={vi.fn()}
          workbenchConnected
          retryResolutionEnabled={false}
        />
      )
      await Promise.resolve()
    })
    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertAndActivateItem(legacyItem)
      root.render(
        <PreviewFileSurface
          item={legacyItem}
          onClose={vi.fn()}
          workbenchConnected
          retryResolutionEnabled
        />
      )
      await Promise.resolve()
    })
    await act(async () => {
      finishResolve?.(resolvedFile)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject(legacyItem)
    expect(usePreviewWorkbenchStore.getState().items[0]).not.toHaveProperty('artifactId')
    expect(usePreviewWorkbenchStore.getState().items[0]).not.toHaveProperty('managedFileId')
  })

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
    expect(container.querySelector('[aria-label="Download options for sin.png"]')).not.toBeNull()
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
    expect(container.querySelector('[aria-label="Download sin.png"]')).not.toBeNull()
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

  it('keeps a failed lineage load visible and retryable without hiding the preview', async () => {
    const markdownItem = {
      ...item,
      title: 'report.md',
      name: 'report.md',
      format: 'markdown' as const
    }
    window.api.artifacts.getLineage = vi
      .fn()
      .mockRejectedValueOnce(new Error('lineage unavailable'))
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'report.md',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [
          { ...descriptor, name: 'report.md' },
          { ...secondDescriptor, name: 'report.md' }
        ]
      })

    await act(async () => {
      root.render(<PreviewFileSurface item={markdownItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    const retry = [...(alert?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Retry'
    )
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Next Artifact version"]')).toBeNull()
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('Could not load version history.')
    expect(retry).not.toBeUndefined()

    await click(retry ?? null)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Next Artifact version"]')).not.toBeNull()
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

describe('PreviewFileSurface PDF context action matrix', () => {
  const pdfItem: PreviewFileItem = {
    ...item,
    projectId: 'project-1',
    managedFileId: 'artifact-1',
    title: 'paper.pdf',
    name: 'paper.pdf',
    path: 'artifact-version:project-1/session-1/artifact-1/version-1',
    format: 'pdf'
  }

  const linkedPdfContext = {
    version: 1 as const,
    bindings: [
      {
        version: 1 as const,
        bindingId: 'binding-1',
        sourceKind: 'artifact-version' as const,
        sourceFileId: 'artifact-1',
        sourceVersionId: 'version-1',
        sourceSessionId: 'session-1',
        name: 'paper.pdf',
        mimeType: 'application/pdf' as const,
        sizeBytes: 12,
        checksum: 'checksum-1',
        linkedAt: 1
      }
    ]
  }

  it('adds an Artifact PDF Version to the active Session context from the header action', async () => {
    selectPdfContextSession()
    const { linkPdfContext } = installPdfContextApi()
    const focusListener = vi.fn()
    window.addEventListener(FOCUS_COMPOSER_EVENT, focusListener)

    await act(async () => {
      root.render(<PreviewFileSurface item={pdfItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="pdf-context-status"]')).toBeNull()
    await clickHeaderAction('Read with agent')

    expect(linkPdfContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'active-session',
      expectedRevision: 3,
      sources: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1'
        }
      ]
    })
    // Linking is "Read with agent": the composer takes focus so the user can ask immediately.
    expect(focusListener).toHaveBeenCalled()
    window.removeEventListener(FOCUS_COMPOSER_EVENT, focusListener)
  })

  it('routes active-Session link and unlink actions through the Composer Reading history port', async () => {
    selectPdfContextSession()
    const direct = installPdfContextApi()
    const onLinkReadingContext = vi.fn().mockResolvedValue(undefined)
    const onUnlinkReadingContext = vi.fn()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={pdfItem}
          onClose={vi.fn()}
          onLinkReadingContext={onLinkReadingContext}
          onUnlinkReadingContext={onUnlinkReadingContext}
        />
      )
      await Promise.resolve()
    })
    await clickHeaderAction('Read with agent')

    expect(onLinkReadingContext).toHaveBeenCalledWith({
      sourceKind: 'artifact-version',
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-1'
    })
    expect(direct.linkPdfContext).not.toHaveBeenCalled()

    selectPdfContextSession(linkedPdfContext)
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={pdfItem}
          onClose={vi.fn()}
          onLinkReadingContext={onLinkReadingContext}
          onUnlinkReadingContext={onUnlinkReadingContext}
        />
      )
      await Promise.resolve()
    })
    await openMenu(container.querySelector('[data-testid="pdf-context-status"]'))
    await clickMenuItem('Remove PDF from context')

    expect(onUnlinkReadingContext).toHaveBeenCalledWith('binding-1')
    expect(direct.unlinkPdfContext).not.toHaveBeenCalled()
  })

  it('puts the PDF-only action above the ordered shared preview actions', async () => {
    selectPdfContextSession()
    const { linkPdfContext } = installPdfContextApi()
    const onOpenFullScreen = vi.fn()

    await act(async () => {
      root.render(
        <PreviewFileSurface item={pdfItem} onClose={vi.fn()} onOpenFullScreen={onOpenFullScreen} />
      )
      await Promise.resolve()
    })
    const surface = container.querySelector('[data-testid="preview-file-content-surface"]')
    act(() => {
      surface?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 120 })
      )
    })
    await act(async () => Promise.resolve())

    const menu = document.body.querySelector('[data-testid="preview-content-context-menu"]')
    const labels = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].map(
      (entry) => entry.textContent
    )
    expect(labels).toEqual([
      'Read with agent',
      'Provenance',
      'View in context',
      'Open full screen preview',
      'Download',
      'Close'
    ])
    expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(1)
    expect(menu?.className).toContain('min-w-[9.5rem]')
    expect(menu?.querySelector('[role="menuitem"]')?.className).toContain('h-6')
    await clickMenuItem('Read with agent')

    expect(linkPdfContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'active-session',
      expectedRevision: 3,
      sources: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1'
        }
      ]
    })
  })

  it('does not restore preview focus after linking a PDF from the content menu', async () => {
    selectPdfContextSession()
    installPdfContextApi()
    const previousFocusTarget = document.createElement('button')
    document.body.appendChild(previousFocusTarget)
    const focusComposer = vi.fn()
    window.addEventListener(FOCUS_COMPOSER_EVENT, focusComposer)

    await act(async () => {
      root.render(<PreviewFileSurface item={pdfItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    previousFocusTarget.focus()
    await act(async () => {
      container
        .querySelector('[data-testid="preview-content"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await clickMenuItem('Read with agent')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const activeElement = document.activeElement
    window.removeEventListener(FOCUS_COMPOSER_EVENT, focusComposer)
    previousFocusTarget.remove()
    expect(focusComposer).toHaveBeenCalledOnce()
    expect(activeElement).not.toBe(previousFocusTarget)
  })

  it('opens the large preview and closes the surface from the PDF context menu', async () => {
    selectPdfContextSession()
    installPdfContextApi()
    const onOpenFullScreen = vi.fn()
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <PreviewFileSurface item={pdfItem} onClose={onClose} onOpenFullScreen={onOpenFullScreen} />
      )
      await Promise.resolve()
    })
    const surface = container.querySelector('[data-testid="preview-file-content-surface"]')
    const openContextMenu = async (): Promise<void> => {
      act(() => {
        surface?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 120 })
        )
      })
      await act(async () => Promise.resolve())
    }

    await openContextMenu()
    await clickMenuItem('Open full screen preview')
    expect(onOpenFullScreen).toHaveBeenCalledOnce()

    await openContextMenu()
    await clickMenuItem('Close')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('downloads the PDF from its preview context menu', async () => {
    selectPdfContextSession()
    installPdfContextApi()
    window.api.saveManagedFile = vi.fn().mockResolvedValue({ saved: true })
    window.api.artifacts.getLineage = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(<PreviewFileSurface item={pdfItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    act(() => {
      container
        .querySelector('[data-testid="preview-file-content-surface"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 120 }))
    })
    await act(async () => Promise.resolve())
    await clickMenuItem('Download')

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1',
      versionId: 'version-1',
      suggestedName: 'paper.pdf'
    })
  })

  it('keeps the overflow menu for provenance, without the PDF context entry', async () => {
    selectPdfContextSession()
    installPdfContextApi()

    await act(async () => {
      root.render(<PreviewFileSurface item={pdfItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await openMenu(container.querySelector('[aria-label^="File actions for"]'))

    const menu = document.body.querySelector('[role="menu"]')
    expect(
      [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"]') ?? [])].map(
        (entry) => (entry.getAttribute('role') === 'separator' ? 'separator' : entry.textContent)
      )
    ).toEqual(['Provenance', 'separator', 'View in context'])
  })

  it('keeps the Session context action visible but disabled when an Upload PDF has no immutable Version', async () => {
    selectPdfContextSession()
    installPdfContextApi()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{
            ...pdfItem,
            id: 'upload:legacy-upload-1',
            source: 'upload',
            path: 'legacy/uploads/paper.pdf',
            selectedVersionId: undefined
          }}
          onClose={vi.fn()}
        />
      )
    })

    const action = container.querySelector<HTMLButtonElement>('[data-testid="pdf-context-action"]')
    expect(action?.textContent).toContain('Read with agent')
    expect(action?.disabled).toBe(true)
  })

  it('offers an immutable PDF Version as context before a new Session is created', async () => {
    installPdfContextApi()

    await act(async () => {
      root.render(<PreviewFileSurface item={pdfItem} onClose={vi.fn()} />)
    })
    await clickHeaderAction('Read with agent')

    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['project-1']).toEqual({
      kind: 'version',
      sourceKind: 'artifact-version',
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-1',
      previewItemId: 'artifact-1'
    })
  })

  it('links from the modal to the visible project instead of a stale selected Session', async () => {
    installPdfContextApi()
    useSessionStore.setState({
      selectedSessionId: 'stale-session',
      sessions: [
        {
          id: 'stale-session',
          projectId: 'project-2',
          title: 'Other project',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          runtimeContext: { version: 1, revision: 3, pdfContext: linkedPdfContext },
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={pdfItem} onClose={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="pdf-context-status"]')).toBeNull()
    await clickHeaderAction('Read with agent')
    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['project-1']).toEqual({
      kind: 'version',
      sourceKind: 'artifact-version',
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-1',
      previewItemId: 'artifact-1'
    })
  })

  it('adds another uploaded PDF Version to the reading context', async () => {
    selectPdfContextSession(linkedPdfContext)
    const { linkPdfContext } = installPdfContextApi()
    const uploadPdf: PreviewFileItem = {
      ...pdfItem,
      id: 'upload-1',
      artifactId: undefined,
      managedFileId: 'upload-1',
      selectedVersionId: undefined,
      source: 'upload',
      path: 'upload-version:project-1/source-session/upload-version-1'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={uploadPdf} onClose={vi.fn()} />)
    })
    await clickHeaderAction('Read with agent')

    expect(linkPdfContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          {
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceVersionId: 'upload-version-1'
          }
        ]
      })
    )
  })

  it('offers a PDF context action for a staged upload in a new Session', async () => {
    installPdfContextApi()
    // The composer's new-conversation draft currently holds this attachment.
    usePreviewWorkbenchStore.setState({ draftStagedUploadIds: ['staged-pdf'] })
    const stagedPdf: PreviewFileItem = {
      ...pdfItem,
      id: 'upload:staged-pdf',
      artifactId: undefined,
      selectedVersionId: undefined,
      sessionId: '.pending',
      source: 'upload',
      path: '/managed/.pending/staged-pdf/paper.pdf'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={stagedPdf} onClose={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="pdf-context-action"]')?.textContent).toContain(
      'Read with agent'
    )
    await clickHeaderAction('Read with agent')
    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject['project-1']).toEqual({
      kind: 'staged-upload',
      attachmentId: 'staged-pdf',
      previewItemId: 'upload:staged-pdf'
    })
    expect(container.querySelector('[data-testid="pdf-context-status"]')?.textContent).toContain(
      'In session context'
    )
  })

  it('refuses a staged upload whose attachment is no longer in the draft', async () => {
    installPdfContextApi()
    // The preview tab outlived its composer attachment: the draft's staged id list stays empty,
    // so a pending selection would point at an upload no send could finalize.
    const stagedPdf: PreviewFileItem = {
      ...pdfItem,
      id: 'upload:staged-pdf',
      artifactId: undefined,
      selectedVersionId: undefined,
      sessionId: '.pending',
      source: 'upload',
      path: '/managed/.pending/staged-pdf/paper.pdf'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={stagedPdf} onClose={vi.fn()} />)
    })

    const action = container.querySelector<HTMLButtonElement>('[data-testid="pdf-context-action"]')
    expect(action?.textContent).toContain('Read with agent')
    expect(action?.disabled).toBe(true)
    await click(action ?? null)
    expect(
      usePreviewWorkbenchStore.getState().pendingPdfContextByProject['project-1']
    ).toBeUndefined()
  })

  it('removes the PDF context from the linked status pill menu', async () => {
    selectPdfContextSession(linkedPdfContext)
    const { unlinkPdfContext } = installPdfContextApi()
    const focusListener = vi.fn()
    window.addEventListener(FOCUS_COMPOSER_EVENT, focusListener)

    await act(async () => {
      root.render(<PreviewFileSurface item={pdfItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    const statusPill = container.querySelector('[data-testid="pdf-context-status"]')
    expect(statusPill?.textContent).toContain('In session context')
    await openMenu(statusPill)
    await clickMenuItem('Remove PDF from context')

    expect(unlinkPdfContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'active-session',
      expectedRevision: 3,
      bindingId: 'binding-1'
    })
    // Removing the context is not a reading entry point, so the composer is not focused.
    expect(focusListener).not.toHaveBeenCalled()
    window.removeEventListener(FOCUS_COMPOSER_EVENT, focusListener)
  })

  it('keeps the linked PDF viewport position in transient renderer state', async () => {
    selectPdfContextSession(linkedPdfContext)

    await act(async () => {
      root.render(<PreviewFileSurface item={pdfItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    const props = previewContentSpy.mock.calls.at(-1)?.[0] as {
      onPdfReadingPositionChange?: (position: { pageNumber: number; pageCount: number }) => void
    }
    act(() => props.onPdfReadingPositionChange?.({ pageNumber: 7, pageCount: 14 }))

    expect(usePreviewWorkbenchStore.getState().pdfReadingPositionByBindingId).toEqual({
      'binding-1': { pageNumber: 7, pageCount: 14 }
    })
  })

  it('disables the PDF context action while its command is pending', async () => {
    selectPdfContextSession()
    let resolveLink: ((value: { version: 1; revision: number }) => void) | undefined
    const { linkPdfContext } = installPdfContextApi()
    linkPdfContext.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLink = resolve
      })
    )

    await act(async () => {
      root.render(<PreviewFileSurface item={pdfItem} onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await clickHeaderAction('Read with agent')

    const pendingButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="pdf-context-action"]'
    )
    expect(pendingButton?.disabled).toBe(true)
    expect(linkPdfContext).toHaveBeenCalledOnce()

    await act(async () => {
      resolveLink?.({ version: 1, revision: 4 })
      await Promise.resolve()
    })
  })

  it('uses a Notebook input only when its immutable Version identity parses', async () => {
    selectPdfContextSession()
    installPdfContextApi()
    const notebookPdf: PreviewFileItem = {
      ...pdfItem,
      id: 'notebook-input-1',
      artifactId: undefined,
      selectedVersionId: undefined,
      source: 'notebook-input',
      path: createNotebookInputPreviewKey({
        projectId: 'project-1',
        sourceKind: 'upload-version',
        sourceFileId: 'upload-1',
        inputFileVersionId: 'notebook-upload-version-1'
      })
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={notebookPdf} onClose={vi.fn()} />)
    })
    await clickHeaderAction('Read with agent')
    expect(window.api.sessions.linkPdfContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          {
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceVersionId: 'notebook-upload-version-1'
          }
        ]
      })
    )

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...notebookPdf, path: 'notebook-input:invalid' }}
          onClose={vi.fn()}
        />
      )
    })
    const unavailableAction = container.querySelector<HTMLButtonElement>(
      '[data-testid="pdf-context-action"]'
    )
    expect(unavailableAction?.textContent).toContain('Read with agent')
    expect(unavailableAction?.disabled).toBe(true)
  })

  it('does not offer PDF context actions for local files', async () => {
    selectPdfContextSession()
    installPdfContextApi()
    setupLocalApi()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...pdfItem, id: 'local-pdf', source: 'local', path: '/tmp/paper.pdf' }}
          onClose={vi.fn()}
        />
      )
    })
    await openMenu(container.querySelector('[aria-label="More actions"]'))

    expect(document.body.querySelector('[role="menu"]')?.textContent).not.toContain('PDF context')
  })

  it('reports command failures through the workspace error callback', async () => {
    selectPdfContextSession()
    const { linkPdfContext } = installPdfContextApi()
    const onPdfContextError = vi.fn()
    linkPdfContext.mockRejectedValueOnce(new Error('revision conflict'))

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={pdfItem}
          onClose={vi.fn()}
          onPdfContextError={onPdfContextError}
        />
      )
    })
    await clickHeaderAction('Read with agent')

    expect(onPdfContextError).toHaveBeenNthCalledWith(1, null)
    expect(onPdfContextError).toHaveBeenLastCalledWith('revision conflict')
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
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  })
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

const clickHeaderAction = async (label: string): Promise<void> => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    element.textContent?.includes(label)
  )
  if (!button) throw new Error(`header action not found: ${label}`)
  await click(button)
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
    expect(
      [...(menu?.querySelectorAll<HTMLElement>('[data-action-id]') ?? [])].map(
        (item) => item.dataset.actionId
      )
    ).toEqual(['copy-path', 'download', 'save-as-artifact'])

    await clickMenuItem('Download')

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'local',
      path: '/Users/example/logs/proxy.log',
      suggestedName: 'proxy.log'
    })
  })

  it('opens the local file capabilities from the preview content context menu', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 96
    })

    await act(async () => {
      container.querySelector('[data-testid="preview-content"]')?.dispatchEvent(event)
      await Promise.resolve()
    })

    expect(event.defaultPrevented).toBe(true)
    const menu = document.body.querySelector('[data-testid="preview-content-context-menu"]')
    expect(menu?.textContent).toContain('Copy path')
    expect(menu?.textContent).toContain('Download')
    expect(menu?.textContent).toContain('Save as artifact')
    expect(menu?.textContent).not.toContain('On this machine')
  })

  it('leaves context-menu events outside the preview content region untouched', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 96
    })

    await act(async () => {
      container.querySelector('[data-testid="preview-card-header"]')?.dispatchEvent(event)
      await Promise.resolve()
    })

    expect(event.defaultPrevented).toBe(false)
    expect(document.body.querySelector('[data-testid="preview-content-context-menu"]')).toBeNull()
  })

  it('shares Save as artifact execution and state between the context menu and header', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    await act(async () => {
      container
        .querySelector('[data-testid="preview-content"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await clickMenuItem('Save as artifact')

    expect(window.api.uploads.stageLocalPath).toHaveBeenCalledWith({
      transferId: expect.any(String),
      name: 'proxy.log',
      sourcePath: '/Users/example/logs/proxy.log'
    })
    expect(container.querySelector('[data-testid="saved-as-artifact"]')).not.toBeNull()
  })

  it('shares Copy path execution and transient presentation with the header menu', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    await act(async () => {
      container
        .querySelector('[data-testid="preview-content"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await clickMenuItem('Copy path')

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/Users/example/logs/proxy.log')
    await openMenu(container.querySelector('[aria-label="More actions"]'))
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('Copied')
  })

  it('restores focus after dismissing the content context menu', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    const closeButton = container.querySelector<HTMLButtonElement>('[aria-label^="Close preview"]')!
    closeButton.focus()
    await act(async () => {
      container
        .querySelector('[data-testid="preview-content"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await act(async () => {
      document.body
        .querySelector('[role="menu"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    expect(document.activeElement).toBe(closeButton)
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

  it('shows a retryable toast when a local file download fails', async () => {
    const saveManagedFile = vi.mocked(window.api.saveManagedFile)
    saveManagedFile.mockRejectedValueOnce(new Error('destination denied'))
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    await openMenu(container.querySelector('[aria-label="More actions"]'))
    await clickMenuItem('Download')

    await vi.waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="local-file-action-error-toast"]')
      ).not.toBeNull()
    })
    const toast = document.body.querySelector('[data-testid="local-file-action-error-toast"]')
    expect(toast?.textContent).toContain('Could not download this file.')
    expect(toast?.textContent).toContain('destination denied')

    await click(
      [...(toast?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) => button.textContent === 'Retry'
      ) ?? null
    )
    expect(saveManagedFile).toHaveBeenCalledTimes(2)
  })

  it('shows a retryable toast when saving a local file as an artifact fails', async () => {
    const stageLocalPath = vi.mocked(window.api.uploads.stageLocalPath!)
    stageLocalPath.mockRejectedValueOnce(new Error('source disappeared'))
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    await openMenu(container.querySelector('[aria-label="More actions"]'))
    await clickMenuItem('Save as artifact')

    await vi.waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="local-file-action-error-toast"]')
      ).not.toBeNull()
    })
    const toast = document.body.querySelector('[data-testid="local-file-action-error-toast"]')
    expect(toast?.textContent).toContain('Could not save this file as an artifact.')
    expect(toast?.textContent).toContain('source disappeared')

    await click(
      [...(toast?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) => button.textContent === 'Retry'
      ) ?? null
    )
    expect(stageLocalPath).toHaveBeenCalledTimes(2)
  })

  it('shows a retryable toast when copying a local file path fails', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('clipboard unavailable'))
      .mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })

    try {
      await act(async () => {
        root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
      })
      await openMenu(container.querySelector('[aria-label="More actions"]'))
      await clickMenuItem('Copy path')

      await vi.waitFor(() => {
        expect(
          document.body.querySelector('[data-testid="local-file-action-error-toast"]')
        ).not.toBeNull()
      })
      const toast = document.body.querySelector('[data-testid="local-file-action-error-toast"]')
      expect(toast?.textContent).toContain('Could not copy the file path.')
      expect(toast?.textContent).toContain('clipboard unavailable')

      await click(
        [...(toast?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
          (button) => button.textContent === 'Retry'
        ) ?? null
      )
      expect(writeText).toHaveBeenCalledTimes(2)
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard)
      } else {
        Reflect.deleteProperty(navigator, 'clipboard')
      }
    }
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
  it('opens managed Artifact capabilities from the preview content context menu', async () => {
    seedWorkspaceStores()
    const onOpenFullScreen = vi.fn()

    await act(async () => {
      root.render(
        <PreviewFileSurface item={item} onClose={vi.fn()} onOpenFullScreen={onOpenFullScreen} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 48,
      clientY: 64
    })
    await act(async () => {
      container.querySelector('[data-testid="preview-content"]')?.dispatchEvent(event)
      await Promise.resolve()
    })

    expect(event.defaultPrevented).toBe(true)
    const menu = document.body.querySelector('[data-testid="preview-content-context-menu"]')
    expect(
      [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].map(
        (entry) => entry.textContent
      )
    ).toEqual(['Provenance', 'View in context', 'Open full screen preview', 'Download', 'Close'])
  })

  it('shares managed download execution, pending protection, and failure state across actions', async () => {
    seedWorkspaceStores()
    let rejectSave: ((error: Error) => void) | undefined
    const error = new Error('destination denied')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const saveManagedFile = vi.fn(
      () =>
        new Promise<{ saved: boolean }>((_resolve, reject) => {
          rejectSave = reject
        })
    )
    window.api.saveManagedFile = saveManagedFile

    await act(async () => {
      root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      container
        .querySelector('[data-testid="preview-content"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await clickMenuItem('Download')

    const headerDownload = container.querySelector<HTMLButtonElement>(
      '[aria-label="Saving sin.png"]'
    )
    expect(headerDownload?.disabled).toBe(true)

    await act(async () => {
      container
        .querySelector('[data-testid="preview-content"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await clickMenuItem('Download')
    expect(saveManagedFile).toHaveBeenCalledOnce()

    await act(async () => rejectSave?.(error))
    await vi.waitFor(() => {
      expect(container.querySelector('[aria-label="Download failed for sin.png"]')).not.toBeNull()
    })
    expect(consoleError).toHaveBeenCalledWith('Failed to download managed file: sin.png', error)
  })

  it('opens Provenance from the preview content context menu', async () => {
    seedWorkspaceStores()
    await act(async () => {
      root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      container
        .querySelector('[data-testid="preview-content"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await clickMenuItem('Provenance')

    expect(container.querySelector('[data-testid="provenance-panel"]')).not.toBeNull()
  })

  it('switches conversation from View in context in the preview content context menu', async () => {
    seedWorkspaceStores()
    await act(async () => {
      root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      container
        .querySelector('[data-testid="preview-content"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await clickMenuItem('View in context')

    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
  })

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

  it('keeps shared actions but does not offer View in context for uploaded inputs', async () => {
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
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => {
      container.querySelector('[data-testid="preview-content"]')?.dispatchEvent(event)
      await Promise.resolve()
    })
    expect(event.defaultPrevented).toBe(true)
    const menu = document.body.querySelector('[data-testid="preview-content-context-menu"]')
    expect(menu?.textContent).toContain('Download')
    expect(menu?.textContent).toContain('Close')
    expect(menu?.textContent).not.toContain('Provenance')
    expect(menu?.textContent).not.toContain('View in context')
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

  it('hides View in context while the origin session is deleting', async () => {
    seedWorkspaceStores()
    // Until a newer lineage projection resolves, the item snapshot is the only lifecycle signal.
    window.api.artifacts.getLineage = vi.fn().mockRejectedValue(new Error('lineage unavailable'))

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'deleting' } }}
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

  it('lets the lineage report of a deleting origin session override the stale item snapshot', async () => {
    seedWorkspaceStores()
    window.api.artifacts.getLineage = vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'deleting', title: 'Sine' },
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

  it('lets active lineage restore View in context after a deleting item snapshot is compensated', async () => {
    seedWorkspaceStores()
    window.api.artifacts.getLineage = vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
      versions: [descriptor, secondDescriptor]
    })

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'deleting' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('View in context')
  })

  it('stops using active lineage while a newer deleting item snapshot is refreshing', async () => {
    seedWorkspaceStores()
    const getLineage = vi
      .fn()
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor]
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
    window.api.artifacts.getLineage = getLineage

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

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'deleting' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    expect(getLineage).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[role="menu"]')?.textContent).not.toContain(
      'View in context'
    )
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

  it('passes the View in context notification as a navigation continuation', async () => {
    seedWorkspaceStores()
    const openSession = vi
      .spyOn(useNavigationStore.getState(), 'openSession')
      .mockReturnValue(false)
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

    expect(openSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      'user',
      onViewInContextNavigate
    )
    expect(onViewInContextNavigate).not.toHaveBeenCalled()
    openSession.mock.calls[0]?.[3]?.()
    expect(onViewInContextNavigate).toHaveBeenCalledOnce()
  })
})
