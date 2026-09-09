// @vitest-environment jsdom
import { act } from 'react'
import { WebEventRecoveryDialog } from '@/components/WebEventRecoveryDialog'
import { completeQuitPersistenceFlush } from '@/hooks/useQuitPersistenceFlush'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore,
  type PreviewFileItem
} from '@/stores/preview-workbench-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import {
  flushPreviewPersistence,
  toPersistedPreviewState,
  usePreviewPersistence
} from '@/lib/preview-persistence/preview-persistence'
import type { SavePreviewStateResult } from '../../../../shared/preview-state'

const viewport = vi.hoisted(() => ({ mobile: false }))
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => viewport.mobile }))
// jsdom supplies no panel geometry; keep the real workspace/preview/editor lifecycle beneath it.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />
}))
// Read-only rendering is irrelevant to editing: the real editor loads its baseline through inspect.
vi.mock('./previews/PreviewFileContent', () => ({ PreviewFileContent: () => <div /> }))

import { PreviewPanelSurface } from './PreviewPanel'
import { WorkspacePanelLayout } from './workspace-panel-layout'

let root: Root
let container: HTMLDivElement
let projectId: string
let nextProject = 0
const draft = '# Unsaved work\n'
const file: PreviewFileItem = {
  id: 'upload:readme',
  type: 'file',
  source: 'upload',
  managedFileId: 'readme',
  selectedVersionId: 'v1',
  sessionId: 'session-1',
  title: 'README.md',
  name: 'README.md',
  path: 'upload-version:project/session-1/readme/v1',
  format: 'markdown'
}

const editor = (): HTMLTextAreaElement | null => document.body.querySelector('textarea')
const confirmation = (): HTMLElement | null =>
  document.body.querySelector('[data-testid="discard-preview-changes-confirmation"]')

const startEditing = async (): Promise<void> => {
  const button = document.body.querySelector<HTMLButtonElement>('[aria-label="Edit README.md"]')
  expect(button).not.toBeNull()
  await act(async () => button!.click())
  expect(editor()?.value).toBe('# Current\n')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      editor(),
      draft
    )
    editor()!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(editor()?.value).toBe(draft)
}

const PersistentPreview = (): React.JSX.Element => {
  usePreviewPersistence(projectId, true)
  return <PreviewPanelSurface />
}

const ResponsivePreview = (): React.JSX.Element => {
  const store = usePreviewWorkbenchStore()
  return (
    <WorkspacePanelLayout
      hasPreviewItems={store.items.length > 0}
      preview={{
        state: store.panelState,
        openRequestVersion: store.openRequestVersion,
        toggle: store.togglePanel,
        syncState: store.syncPanelState
      }}
      renderDesktopSidebar={() => null}
      renderMobileSidebar={() => null}
      renderConversation={() => <div />}
    />
  )
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  viewport.mobile = false
  projectId = `draft-lifecycle-${++nextProject}`
  previewLeaveGuards.clear()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  useSessionStore.setState(createInitialSessionState())
  useNavigationStore.setState({ activeProjectId: projectId })
  usePreviewWorkbenchStore.getState().activateProject(projectId)
  usePreviewWorkbenchStore.getState().upsertAndActivateItem({ ...file, projectId })
  const state = toPersistedPreviewState(usePreviewWorkbenchStore.getState())
  window.api = {
    preview: {
      load: vi.fn().mockResolvedValue({ state, revision: 1 }),
      save: vi.fn().mockResolvedValue({ status: 'saved', revision: 2 })
    },
    artifacts: { getLineage: vi.fn().mockResolvedValue(undefined) },
    managedFileVersions: {
      inspect: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          source: 'upload',
          projectId,
          fileId: 'readme',
          sessionId: 'session-1',
          displayName: 'README.md',
          headVersionId: 'v1',
          selectedVersionId: 'v1',
          versions: [
            {
              id: 'v1',
              source: 'upload',
              fileId: 'readme',
              versionNumber: 1,
              displayName: 'README.md',
              originKind: 'user_upload',
              basedOnVersionId: null,
              contentType: 'text/markdown',
              sizeBytes: 10,
              checksum: '1',
              createdAt: '2026-09-07T00:00:00.000Z'
            }
          ],
          canEdit: true,
          canDiff: true,
          text: '# Current\n',
          textFormat: { hasUtf8Bom: false, newline: 'lf', hasTrailingNewline: true }
        }
      }),
      saveTextEdit: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'VERSION_CONFLICT', message: 'test save conflict' }
      })
    }
  } as unknown as Window['api']
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  await flushPreviewPersistence()
  container.remove()
  previewLeaveGuards.clear()
  vi.unstubAllGlobals()
})

describe('preview draft lifecycle', () => {
  it('protects dirty text when the active tab is closed normally', async () => {
    await act(async () => root.render(<PreviewPanelSurface />))
    await startEditing()
    await act(async () => {
      expect(usePreviewWorkbenchStore.getState().removeItem(file.id)).toBe(false)
    })
    expect(confirmation()).not.toBeNull()
    expect.soft(editor()?.value).toBe(draft)
    expect(window.api.managedFileVersions.saveTextEdit).not.toHaveBeenCalled()
  })

  it('retains dirty text when a same-project restore removes the active file', async () => {
    await act(async () => root.render(<PreviewPanelSurface />))
    await startEditing()
    await act(async () => {
      usePreviewWorkbenchStore.getState().activateProject(projectId, { items: [] })
    })
    expect.soft(editor()?.value).toBe(draft)
    expect(window.api.managedFileVersions.saveTextEdit).not.toHaveBeenCalled()
  })

  it('retains dirty text when a background tab save conflicts with a remote close', async () => {
    await act(async () => root.render(<PersistentPreview />))
    await act(async () => flushPreviewPersistence())
    await startEditing()
    let resolveSave!: (result: SavePreviewStateResult) => void
    const save = vi.mocked(window.api.preview.save)
    save.mockClear()
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )
    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertItem({
        ...file,
        id: 'upload:background',
        managedFileId: 'background',
        title: 'other.md',
        name: 'other.md',
        projectId
      })
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(editor()?.value).toBe(draft)
    await act(async () => {
      resolveSave({
        status: 'conflict',
        snapshot: { revision: 3, state: { version: 1, panelState: 'open', items: [] } }
      })
      await flushPreviewPersistence()
    })
    expect.soft(editor()?.value).toBe(draft)
    expect(window.api.managedFileVersions.saveTextEdit).not.toHaveBeenCalled()
  })

  it('retains the newly opened tab from a conflicting save alongside remote tabs', async () => {
    await act(async () => root.render(<PersistentPreview />))
    await act(async () => flushPreviewPersistence())
    const baseline = toPersistedPreviewState(usePreviewWorkbenchStore.getState())
    let resolveSave!: (result: SavePreviewStateResult) => void
    vi.mocked(window.api.preview.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )
    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertItem({
        ...file,
        id: 'local-file',
        managedFileId: 'local-file',
        projectId
      })
    })
    await act(async () => {
      resolveSave({
        status: 'conflict',
        snapshot: {
          revision: 3,
          state: {
            ...baseline,
            items: [...baseline.items, { ...baseline.items[0]!, id: 'remote-file' }]
          }
        }
      })
      await flushPreviewPersistence()
    })
    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toEqual(
      expect.arrayContaining([file.id, 'local-file', 'remote-file'])
    )
  })

  it.each(['remove', 'selection', 'version', 'collapse'] as const)(
    'confirms a restore that changes the active file through %s',
    async (change) => {
      await act(async () => root.render(<PreviewPanelSurface />))
      await startEditing()
      const restoredFile = { ...file, projectId }
      const other = { ...restoredFile, id: 'other', managedFileId: 'other' }
      await act(async () => {
        usePreviewWorkbenchStore.getState().activateProject(projectId, {
          items:
            change === 'remove'
              ? [other]
              : [{ ...restoredFile, selectedVersionId: change === 'version' ? 'v2' : 'v1' }, other],
          activeItemId: change === 'selection' || change === 'remove' ? other.id : file.id,
          panelState: change === 'collapse' ? 'collapsed' : 'open'
        })
      })
      expect(editor()?.value).toBe(draft)
      expect(confirmation()).not.toBeNull()
      expect(usePreviewWorkbenchStore.getState().items.some((item) => item.id === 'other')).toBe(
        true
      )
      await act(async () =>
        confirmation()!.querySelector<HTMLButtonElement>('button:last-of-type')!.click()
      )
      expect(editor()).toBeNull()
      const store = usePreviewWorkbenchStore.getState()
      if (change === 'remove') expect(store.items.map((item) => item.id)).toEqual(['other'])
      if (change === 'selection') expect(store.activeItemId).toBe('other')
      if (change === 'version')
        expect(store.items.find((item) => item.id === file.id)).toMatchObject({
          selectedVersionId: 'v2'
        })
      if (change === 'collapse') expect(store.panelState).toBe('collapsed')
    }
  )

  it.each(['Cancel', 'Discard changes'])(
    'does not write a delayed restore back when choosing %s',
    async (label) => {
      await act(async () => root.render(<PersistentPreview />))
      await act(async () => flushPreviewPersistence())
      await startEditing()
      const save = vi.mocked(window.api.preview.save)
      save.mockClear()
      save.mockResolvedValueOnce({
        status: 'conflict',
        snapshot: { revision: 3, state: { version: 1, panelState: 'open', items: [] } }
      })
      await act(async () => {
        usePreviewWorkbenchStore.getState().upsertItem({ ...file, id: 'background', projectId })
        await flushPreviewPersistence()
      })
      expect(confirmation()).not.toBeNull()
      const calls = save.mock.calls.length
      await act(async () => {
        Array.from(confirmation()!.querySelectorAll('button'))
          .find((button) => button.textContent === label)!
          .click()
        await flushPreviewPersistence()
      })
      expect(save).toHaveBeenCalledTimes(calls)
      expect(label === 'Cancel' ? editor()?.value : editor()).toBe(
        label === 'Cancel' ? draft : null
      )
    }
  )

  it('applies an approved restore after unrelated composer state changes', async () => {
    await act(async () => root.render(<PreviewPanelSurface />))
    await startEditing()
    await act(async () =>
      usePreviewWorkbenchStore.getState().activateProject(projectId, { items: [] })
    )
    expect(confirmation()).not.toBeNull()
    await act(async () =>
      usePreviewWorkbenchStore.getState().setDraftStagedUploadIds(['new-attachment'])
    )
    await act(async () =>
      confirmation()!.querySelector<HTMLButtonElement>('button:last-of-type')!.click()
    )
    expect(editor()).toBeNull()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
    expect(usePreviewWorkbenchStore.getState().draftStagedUploadIds).toEqual(['new-attachment'])
    expect(window.api.managedFileVersions.saveTextEdit).not.toHaveBeenCalled()
  })

  it('does not discard a draft for an obsolete restore after a newer tab action', async () => {
    await act(async () => root.render(<PreviewPanelSurface />))
    await startEditing()
    await act(async () =>
      usePreviewWorkbenchStore.getState().activateProject(projectId, { items: [] })
    )
    await act(async () =>
      usePreviewWorkbenchStore.getState().upsertItem({ ...file, id: 'later', projectId })
    )
    await act(async () =>
      confirmation()!.querySelector<HTMLButtonElement>('button:last-of-type')!.click()
    )
    expect(editor()?.value).toBe(draft)
    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toContain('later')
  })

  it('rebases the same local action across successive conflicts without resurrecting a remote close', async () => {
    await act(async () => root.render(<PersistentPreview />))
    await act(async () => flushPreviewPersistence())
    const baseline = toPersistedPreviewState(usePreviewWorkbenchStore.getState())
    const save = vi.mocked(window.api.preview.save)
    save.mockClear()
    for (const revision of [3, 4])
      save.mockResolvedValueOnce({
        status: 'conflict',
        snapshot: {
          revision,
          state: {
            ...baseline,
            activeItemId: undefined,
            items: [{ ...baseline.items[0]!, id: `remote-${revision}` }]
          }
        }
      })
    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertItem({ ...file, id: 'local', projectId })
      await flushPreviewPersistence()
    })
    expect(save.mock.calls.map(([request]) => request.expectedRevision)).toEqual([1, 3, 4])
    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toEqual([
      'remote-4',
      'local'
    ])
  })

  it('keeps the draft across a render within the same layout', async () => {
    await act(async () => root.render(<ResponsivePreview />))
    await startEditing()
    await act(async () => root.render(<ResponsivePreview />))
    expect.soft(editor()?.value).toBe(draft)
    expect(confirmation()).toBeNull()
  })

  it('allows the workspace navigation shortcut when the mobile preview is closed', async () => {
    viewport.mobile = true
    usePreviewWorkbenchStore.getState().syncPanelState('collapsed')
    await act(async () => root.render(<ResponsivePreview />))
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))
    )
    expect(
      document.querySelector('[role="dialog"][aria-label="Workspace navigation"]')
    ).not.toBeNull()
  })

  it('isolates the mobile background, guards Escape, and preserves a nested confirmation across resizing', async () => {
    await act(async () =>
      root.render(
        <>
          <button data-testid="background">Background</button>
          <ResponsivePreview />
        </>
      )
    )
    await startEditing()
    viewport.mobile = true
    await act(async () =>
      root.render(
        <>
          <button data-testid="background">Background</button>
          <ResponsivePreview />
        </>
      )
    )
    expect(container.querySelector('[data-testid="background"]')!.hasAttribute('inert')).toBe(true)
    await act(async () =>
      editor()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(confirmation()).not.toBeNull()
    expect(editor()?.value).toBe(draft)
    viewport.mobile = false
    await act(async () =>
      root.render(
        <>
          <button data-testid="background">Background</button>
          <ResponsivePreview />
        </>
      )
    )
    expect(container.querySelector('[data-testid="background"]')!.hasAttribute('inert')).toBe(false)
    viewport.mobile = true
    await act(async () =>
      root.render(
        <>
          <button data-testid="background">Background</button>
          <ResponsivePreview />
        </>
      )
    )
    expect(confirmation()!.closest('[inert]')).toBeNull()
    await act(async () =>
      confirmation()!.querySelector<HTMLButtonElement>('button:first-of-type')!.click()
    )
    expect(editor()?.value).toBe(draft)
    expect(confirmation()).toBeNull()
  })

  it.each([false, true])(
    'keeps editing across a viewport breakpoint (starts mobile: %s)',
    async (mobile) => {
      viewport.mobile = mobile
      await act(async () => root.render(<ResponsivePreview />))
      await startEditing()
      viewport.mobile = !mobile
      await act(async () => root.render(<ResponsivePreview />))
      expect(document.body.querySelector('[data-testid="mobile-preview-sheet"]') !== null).toBe(
        !mobile
      )
      expect.soft(editor()?.value).toBe(draft)
      expect(confirmation()).toBeNull()
      expect(window.api.managedFileVersions.saveTextEdit).not.toHaveBeenCalled()
      await act(async () =>
        document.body.querySelector<HTMLButtonElement>('[aria-label="Save changes"]')!.click()
      )
      expect(window.api.managedFileVersions.saveTextEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          content: draft,
          basedOnVersionId: 'v1',
          expectedHeadVersionId: 'v1',
          projectId,
          fileId: 'readme'
        })
      )
    }
  )
})

it('refuses a successful quit acknowledgement while preview text is unsaved', async () => {
  await act(async () => root.render(<PersistentPreview />))
  await startEditing()
  const acknowledge = vi.fn()
  await expect(
    completeQuitPersistenceFlush(
      { requestId: 'dirty-preview' },
      {
        suppressAutoReviews: vi.fn(),
        drainRuntimeEvents: async () => undefined,
        flushPersistence: async () => undefined,
        flushPreviewPersistence,
        acknowledge
      }
    )
  ).rejects.toThrow()
  expect(acknowledge).toHaveBeenCalledWith({ requestId: 'dirty-preview', status: 'failed' })
  expect(editor()?.value).toBe(draft)
  expect(window.api.managedFileVersions.saveTextEdit).not.toHaveBeenCalled()
})

it('protects dirty preview text from browser unload', async () => {
  await act(async () => root.render(<PersistentPreview />))
  await startEditing()
  const event = new Event('beforeunload', { cancelable: true })
  expect(window.dispatchEvent(event)).toBe(false)
  expect(event.defaultPrevented).toBe(true)
  expect(confirmation()).toBeNull()
  expect(editor()?.value).toBe(draft)
})

it('keeps the editor readonly until its save resolves successfully', async () => {
  await act(async () => root.render(<PersistentPreview />))
  await startEditing()
  let complete!: (
    value: Awaited<ReturnType<Window['api']['managedFileVersions']['saveTextEdit']>>
  ) => void
  vi.mocked(window.api.managedFileVersions.saveTextEdit).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  await act(async () =>
    document.body.querySelector<HTMLButtonElement>('[aria-label="Save changes"]')!.click()
  )
  expect(window.api.managedFileVersions.saveTextEdit).toHaveBeenCalledWith(
    expect.objectContaining({ content: draft })
  )
  expect(editor()?.readOnly).toBe(true)
  expect(editor()?.value).toBe(draft)
  const inspection = await window.api.managedFileVersions.inspect({
    source: 'upload',
    projectId,
    fileId: 'readme'
  })
  if (!inspection.ok) throw new Error('Fixture inspection failed')
  const selected = inspection.value
  await act(async () =>
    complete({
      ok: true,
      value: {
        kind: 'created',
        version: { ...selected.versions[0], id: 'v2', versionNumber: 2 },
        headVersionId: 'v2',
        replayed: false
      }
    })
  )
  expect(editor()).toBeNull()
  expect(window.api.managedFileVersions.saveTextEdit).toHaveBeenCalledTimes(1)
})

it('restores editing after a save failure and releases unload protection after discard', async () => {
  await act(async () => root.render(<PersistentPreview />))
  const cleanUnload = new Event('beforeunload', { cancelable: true })
  expect(window.dispatchEvent(cleanUnload)).toBe(true)
  await startEditing()
  await act(async () =>
    document.body.querySelector<HTMLButtonElement>('[aria-label="Save changes"]')!.click()
  )
  expect(editor()?.readOnly).toBe(false)
  expect(editor()?.value).toBe(draft)
  expect(previewLeaveGuards.hasUnsavedChanges()).toBe(true)
  // Existing close protection owns the discard decision.
  await act(async () => usePreviewWorkbenchStore.getState().removeItem(file.id))
  const discard = [...confirmation()!.querySelectorAll('button')].find(
    (button) => button.textContent === 'Discard changes'
  )
  await act(async () => discard!.click())
  expect(previewLeaveGuards.hasUnsavedChanges()).toBe(false)
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)
})

it('asks before the Web recovery action reloads a dirty preview and keeps text on cancel', async () => {
  await act(async () => root.render(<PersistentPreview />))
  await startEditing()
  await act(async () =>
    root.render(
      <>
        <PersistentPreview />
        <WebEventRecoveryDialog active phase="reload-required" />
      </>
    )
  )
  const reload = [...document.body.querySelectorAll('button')].find(
    (button) => button.textContent === 'Reload'
  )!
  await act(async () => reload.click())
  expect(confirmation()).not.toBeNull()
  const cancel = [...confirmation()!.querySelectorAll('button')].find(
    (button) => button.textContent === 'Cancel'
  )!
  await act(async () => cancel.click())
  expect(confirmation()).toBeNull()
  expect(editor()?.value).toBe(draft)
})
