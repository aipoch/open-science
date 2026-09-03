// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../../../shared/uploads'
import type { TextAnnotation } from '../../../../shared/annotations'
import type { CustomizePrefillIntent } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'

import type { UploadStagingApi } from './composer-upload-transfer'
import {
  docToText,
  emptyDoc,
  type ComposerDoc,
  type ComposerPastedTextNode
} from './composer/composer-doc'
import { useWorkspaceComposerController } from './workspace-composer-controller'
import type { ComposerHistoryEntry } from './composer/composer-history'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

const annotation = (id = 'annotation-1'): TextAnnotation => ({
  id,
  kind: 'text',
  target: 'agent',
  quote: 'Quoted Agent response',
  source: { kind: 'agent-message', sessionId: 'session-a', messageId: 'message-a' }
})

const pastedDoc = (node: ComposerPastedTextNode): ComposerDoc => ({
  nodes: [{ type: 'text', text: 'before ' }, node, { type: 'text', text: ' after' }]
})

const deferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: unknown) => void
} => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

const flushAsyncWork = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

const uploads = (
  stageLocalFile: UploadStagingApi['stageLocalFile'] = vi.fn().mockResolvedValue(null)
): UploadStagingApi & { claimLocalFile: () => Promise<void> } => ({
  stageLocalFile,
  beginTransfer: vi.fn(),
  appendTransfer: vi.fn(),
  getTransferStatus: vi.fn(),
  finishTransfer: vi.fn(),
  abortTransfer: vi.fn().mockResolvedValue(undefined),
  deleteUpload: vi.fn().mockResolvedValue(undefined),
  onTransferProgress: vi.fn(() => () => undefined),
  claimLocalFile: vi.fn().mockResolvedValue(undefined)
})

type ControllerHook = {
  result: { current: ReturnType<typeof useWorkspaceComposerController> }
  selectDraft: (draftKey: string) => void
  selectSession: (
    session: Parameters<typeof useWorkspaceComposerController>[0]['activeSession']
  ) => void
  setCustomizePrefill: (prefill: CustomizePrefillIntent) => void
  unmount: () => void
}

const renderController = (
  uploadApi = uploads(),
  loadSkills = vi.fn().mockResolvedValue(undefined),
  historyEntries: ComposerHistoryEntry[] = [],
  // Pass null to exercise the new-conversation draft (no active Session); undefined selects the
  // default Session.
  activeSession: Parameters<typeof useWorkspaceComposerController>[0]['activeSession'] | null = {
    id: 'session-a',
    projectId: 'project'
  }
): ControllerHook => {
  let currentDraftKey = 'session-a'
  let selectedActiveSession = activeSession ?? undefined
  let pendingCustomizePrefill: CustomizePrefillIntent | undefined
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = {
    current: undefined as unknown as ReturnType<typeof useWorkspaceComposerController>
  }
  const Harness = (): null => {
    result.current = useWorkspaceComposerController({
      currentDraftKey,
      newConversationDraftKey: 'new:project',
      activeProjectId: 'project',
      pendingCustomizePrefill,
      onCustomizePrefillApplied: vi.fn(),
      historyEntries,
      activeSession: selectedActiveSession,
      historyPolicy: {
        catalogSkillIds: new Set(),
        allowedSkillIds: undefined,
        skillCatalogReady: true,
        refreshSkillCatalog: Boolean(window.api?.settings?.listSkills),
        specialistCatalogReady: true,
        specialistId: undefined,
        loadSkills,
        loadSpecialists: vi.fn().mockResolvedValue(undefined)
      },
      canStageAttachments: true,
      supportsImageInput: true,
      uploads: uploadApi
    })
    return null
  }
  const render = (): void => {
    act(() => root.render(createElement(Harness)))
  }
  render()
  return {
    result,
    selectDraft: (draftKey: string): void => {
      currentDraftKey = draftKey
      render()
    },
    selectSession: (session): void => {
      selectedActiveSession = session
      currentDraftKey = session?.id ?? 'new:project'
      render()
    },
    setCustomizePrefill: (prefill: CustomizePrefillIntent): void => {
      pendingCustomizePrefill = prefill
      currentDraftKey = 'new:project'
      render()
    },
    unmount: (): void => act(() => root.unmount())
  }
}

const mounted: Array<ReturnType<typeof renderController>> = []
const originalApi = window.api

afterEach(() => {
  for (const hook of mounted.splice(0)) hook.unmount()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  window.api = originalApi
})

describe('workspace composer controller', () => {
  it('starts a Reading mutation for a newly selected Session after the previous Session settles', async () => {
    const sourceA = {
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-a',
      sourceVersionId: 'version-a'
    }
    const sourceB = {
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-b',
      sourceVersionId: 'version-b'
    }
    const bindingB = {
      version: 1 as const,
      bindingId: 'binding-b',
      ...sourceB,
      sourceFileId: 'upload-b',
      sourceSessionId: 'source-session',
      name: 'paper-b.pdf',
      mimeType: 'application/pdf' as const,
      sizeBytes: 42,
      checksum: 'b'.repeat(64),
      linkedAt: 1
    }
    const firstLink = deferred<{ version: 1; revision: number }>()
    const linkPdfContext = vi
      .fn()
      .mockImplementationOnce(() => firstLink.promise)
      .mockResolvedValueOnce({
        version: 1,
        revision: 1,
        pdfContext: { version: 1, bindings: [bindingB] }
      })
    window.api = {
      sessions: { linkPdfContext, unlinkPdfContext: vi.fn() }
    } as unknown as Window['api']
    const hook = renderController(uploads(), undefined, [], {
      id: 'session-a',
      projectId: 'project',
      runtimeContext: { revision: 0 }
    })
    mounted.push(hook)

    let linkA!: Promise<void>
    act(() => {
      linkA = hook.result.current.actions.linkReadingContext(sourceA)
    })
    act(() =>
      hook.selectSession({
        id: 'session-b',
        projectId: 'project',
        runtimeContext: { revision: 0 }
      })
    )
    let linkB!: Promise<void>
    act(() => {
      linkB = hook.result.current.actions.linkReadingContext(sourceB)
    })

    await act(async () => {
      firstLink.resolve({ version: 1, revision: 1 })
      await Promise.all([linkA, linkB])
    })

    expect(linkPdfContext).toHaveBeenLastCalledWith({
      projectId: 'project',
      sessionId: 'session-b',
      expectedRevision: 0,
      sources: [sourceB]
    })
  })

  it('undoes and redoes Reading changes while coalescing rapid async mutations', async () => {
    const source = {
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-1',
      sourceVersionId: 'version-1'
    }
    const binding = {
      version: 1 as const,
      bindingId: 'binding-1',
      ...source,
      sourceFileId: 'upload-1',
      sourceSessionId: 'source-session',
      name: 'paper.pdf',
      mimeType: 'application/pdf' as const,
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      linkedAt: 1
    }
    const firstLink = deferred<{
      version: 1
      revision: number
      pdfContext: { version: 1; bindings: [typeof binding] }
    }>()
    const linkPdfContext = vi
      .fn()
      .mockImplementationOnce(() => firstLink.promise)
      .mockResolvedValueOnce({
        version: 1,
        revision: 3,
        pdfContext: { version: 1, bindings: [binding] }
      })
    const unlinkPdfContext = vi.fn().mockResolvedValue({
      version: 1,
      revision: 2,
      pdfContext: { version: 1, bindings: [] }
    })
    window.api = {
      sessions: { linkPdfContext, unlinkPdfContext }
    } as unknown as Window['api']
    const hook = renderController(uploads(), undefined, [], {
      id: 'session-a',
      projectId: 'project',
      runtimeContext: { revision: 0 }
    })
    mounted.push(hook)

    let linking!: Promise<void>
    act(() => {
      linking = hook.result.current.actions.linkReadingContext(source)
    })
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(linkPdfContext).toHaveBeenCalledOnce()
    expect(unlinkPdfContext).not.toHaveBeenCalled()

    await act(async () => {
      firstLink.resolve({
        version: 1,
        revision: 1,
        pdfContext: { version: 1, bindings: [binding] }
      })
      await linking
    })
    expect(unlinkPdfContext).toHaveBeenCalledWith({
      projectId: 'project',
      sessionId: 'session-a',
      expectedRevision: 1,
      bindingId: 'binding-1'
    })

    act(() => expect(hook.result.current.actions.redo()).toBe(true))
    await flushAsyncWork()
    expect(linkPdfContext).toHaveBeenLastCalledWith({
      projectId: 'project',
      sessionId: 'session-a',
      expectedRevision: 2,
      sources: [source]
    })
  })

  it('does not retain Reading undo entries when a coalesced link mutation fails', async () => {
    const sourceA = {
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-a',
      sourceVersionId: 'version-a'
    }
    const sourceB = {
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-b',
      sourceVersionId: 'version-b'
    }
    const failedLink = deferred<never>()
    const linkPdfContext = vi.fn().mockImplementation(() => failedLink.promise)
    window.api = {
      sessions: { linkPdfContext, unlinkPdfContext: vi.fn() }
    } as unknown as Window['api']
    const hook = renderController(uploads(), undefined, [], {
      id: 'session-a',
      projectId: 'project',
      runtimeContext: { revision: 0 }
    })
    mounted.push(hook)

    let links!: Promise<unknown>
    act(() => {
      links = Promise.allSettled([
        hook.result.current.actions.linkReadingContext(sourceA),
        hook.result.current.actions.linkReadingContext(sourceB)
      ])
    })
    await act(async () => {
      failedLink.reject(new Error('link failed'))
      await links
    })

    expect(hook.result.current.actions.undo()).toBe(false)
    await flushAsyncWork()
    expect(linkPdfContext).toHaveBeenCalledOnce()
  })

  it('removes the Reading redo entry when a link fails after an in-flight undo', async () => {
    const source = {
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-a',
      sourceVersionId: 'version-a'
    }
    const failedLink = deferred<never>()
    const linkPdfContext = vi.fn().mockImplementation(() => failedLink.promise)
    window.api = {
      sessions: { linkPdfContext, unlinkPdfContext: vi.fn() }
    } as unknown as Window['api']
    const hook = renderController(uploads(), undefined, [], {
      id: 'session-a',
      projectId: 'project',
      runtimeContext: { revision: 0 }
    })
    mounted.push(hook)

    let linking!: Promise<void>
    act(() => {
      linking = hook.result.current.actions.linkReadingContext(source)
    })
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await act(async () => {
      failedLink.reject(new Error('link failed'))
      await expect(linking).rejects.toThrow('link failed')
    })

    expect(hook.result.current.actions.redo()).toBe(false)
    expect(linkPdfContext).toHaveBeenCalledOnce()
  })

  it('does not retain a Reading undo entry when unlink fails', async () => {
    const source = {
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-a',
      sourceVersionId: 'version-a'
    }
    const binding = {
      version: 1 as const,
      bindingId: 'binding-a',
      ...source,
      sourceFileId: 'upload-a',
      sourceSessionId: 'source-session',
      name: 'paper-a.pdf',
      mimeType: 'application/pdf' as const,
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      linkedAt: 1
    }
    const unlinkPdfContext = vi.fn().mockRejectedValue(new Error('unlink failed'))
    window.api = {
      sessions: { linkPdfContext: vi.fn(), unlinkPdfContext }
    } as unknown as Window['api']
    const hook = renderController(uploads(), undefined, [], {
      id: 'session-a',
      projectId: 'project',
      runtimeContext: {
        revision: 1,
        pdfContext: { version: 1, bindings: [binding] }
      }
    })
    mounted.push(hook)

    act(() => hook.result.current.actions.unlinkReadingContext('binding-a'))
    await flushAsyncWork()

    expect(unlinkPdfContext).toHaveBeenCalledOnce()
    expect(hook.result.current.actions.undo()).toBe(false)
  })

  it('copies the transient PDF viewport position only when capturing a send snapshot', () => {
    const pdfContext = {
      version: 1 as const,
      bindings: [
        {
          version: 1 as const,
          bindingId: 'binding-1',
          sourceKind: 'artifact-version' as const,
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'source-session-1',
          name: 'paper.pdf',
          mimeType: 'application/pdf' as const,
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          linkedAt: 1
        }
      ]
    }
    usePreviewWorkbenchStore.setState({
      pdfReadingPositionByBindingId: {
        'binding-1': { pageNumber: 7, pageCount: 14 }
      }
    })
    const hook = renderController(uploads(), undefined, [], {
      id: 'session-a',
      projectId: 'project',
      runtimeContext: { revision: 1, pdfContext }
    })
    mounted.push(hook)

    // The view projection no longer exposes the live position (the chip dropped the page line);
    // captureSend still snapshots it straight from the store.
    expect(hook.result.current.view.readingContext).not.toHaveProperty('readingPosition')
    expect(hook.result.current.view.readingContext.bindings[0]).toMatchObject({
      bindingId: 'binding-1'
    })
    expect(hook.result.current.lifecycle.captureSend()).toMatchObject({
      pdfReadingPosition: { pageNumber: 7, pageCount: 14 },
      pdfContext: {
        activeBindingId: 'binding-1',
        readingPosition: { pageNumber: 7, pageCount: 14 }
      }
    })
    expect(pdfContext).not.toHaveProperty('readingPosition')
  })

  it('shows a staged-upload draft selection while its attachment is in the draft', async () => {
    const stageLocalFile = vi.fn().mockResolvedValue({
      id: 'upload-pdf-1',
      sessionId: '.pending',
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      path: '/uploads/.pending/paper.pdf',
      mimeType: 'application/pdf',
      size: 3
    } satisfies UploadedAttachment)
    const hook = renderController(uploads(stageLocalFile), undefined, [], null)
    mounted.push(hook)

    act(() =>
      hook.result.current.actions.stageFiles([
        new File(['pdf'], 'paper.pdf', { type: 'application/pdf' })
      ])
    )
    await flushAsyncWork()
    expect(hook.result.current.view.attachments).toHaveLength(1)
    // The composer mirrors the draft's staged upload ids so preview surfaces can gate linking.
    expect(usePreviewWorkbenchStore.getState().draftStagedUploadIds).toEqual(['upload-pdf-1'])

    act(() =>
      usePreviewWorkbenchStore.getState().setPendingPdfContext('project', {
        kind: 'staged-upload',
        attachmentId: 'upload-pdf-1',
        previewItemId: 'upload:upload-pdf-1'
      })
    )

    expect(hook.result.current.view.readingContext.bindings[0]).toMatchObject({
      name: 'paper.pdf',
      draftSelection: true
    })
    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject.project).toBeDefined()
  })

  it('does not expose a staged attachment until its local writer is claimed', async () => {
    const claimed = deferred<void>()
    const uploadApi = uploads(
      vi.fn().mockResolvedValue({
        id: 'upload-notes-1',
        sessionId: '.pending',
        name: 'research-notes.md',
        originalName: 'research-notes.md',
        path: '/uploads/.pending/research-notes.md',
        mimeType: 'text/markdown',
        size: 5
      } satisfies UploadedAttachment)
    )
    uploadApi.claimLocalFile = vi.fn(() => claimed.promise)
    const hook = renderController(uploadApi, undefined, [], null)
    mounted.push(hook)

    act(() =>
      hook.result.current.actions.stageFiles([
        new File(['notes'], 'research-notes.md', { type: 'text/markdown' })
      ])
    )
    await flushAsyncWork()

    expect(uploadApi.claimLocalFile).toHaveBeenCalledWith({ transferId: expect.any(String) })
    expect(hook.result.current.view.attachments).toEqual([])
    expect(hook.result.current.view.transfers).toHaveLength(1)

    await act(async () => {
      claimed.resolve()
      await claimed.promise
      await Promise.resolve()
    })

    expect(hook.result.current.view.attachments).toHaveLength(1)
    expect(hook.result.current.view.transfers).toEqual([])
  })

  it('keeps a staged attachment unavailable when claiming its local writer fails', async () => {
    const uploadApi = uploads(
      vi.fn().mockResolvedValue({
        id: 'upload-notes-1',
        sessionId: '.pending',
        name: 'research-notes.md',
        originalName: 'research-notes.md',
        path: '/uploads/.pending/research-notes.md',
        mimeType: 'text/markdown',
        size: 5
      } satisfies UploadedAttachment)
    )
    uploadApi.claimLocalFile = vi.fn().mockRejectedValue(new Error('claim failed'))
    const hook = renderController(uploadApi, undefined, [], null)
    mounted.push(hook)

    act(() =>
      hook.result.current.actions.stageFiles([
        new File(['notes'], 'research-notes.md', { type: 'text/markdown' })
      ])
    )
    await flushAsyncWork()

    expect(hook.result.current.view.attachments).toEqual([])
    expect(hook.result.current.view.transfers).toEqual([
      expect.objectContaining({ status: 'error', error: 'claim failed' })
    ])
    expect(uploadApi.abortTransfer).toHaveBeenCalledWith({ transferId: expect.any(String) })
  })

  it('captures the pending PDF viewport position on the first send', async () => {
    const stageLocalFile = vi.fn().mockResolvedValue({
      id: 'upload-pdf-1',
      sessionId: '.pending',
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      path: '/uploads/.pending/paper.pdf',
      mimeType: 'application/pdf',
      size: 3
    } satisfies UploadedAttachment)
    const hook = renderController(uploads(stageLocalFile), undefined, [], null)
    mounted.push(hook)

    act(() =>
      hook.result.current.actions.stageFiles([
        new File(['pdf'], 'paper.pdf', { type: 'application/pdf' })
      ])
    )
    await flushAsyncWork()
    act(() => {
      usePreviewWorkbenchStore.getState().setPendingPdfContext('project', {
        kind: 'staged-upload',
        attachmentId: 'upload-pdf-1',
        previewItemId: 'upload:upload-pdf-1'
      })
      usePreviewWorkbenchStore
        .getState()
        .setPdfReadingPosition('staged:upload-pdf-1', { pageNumber: 7, pageCount: 14 })
    })

    expect(hook.result.current.lifecycle.captureSend()).toMatchObject({
      pendingPdfContextAttachmentIds: ['upload-pdf-1'],
      pdfReadingPosition: { pageNumber: 7, pageCount: 14 }
    })
  })

  it('captures a PDF-only new-conversation reading intent without showing draft context', async () => {
    const staged = ['paper-a.pdf', 'paper-b.pdf'].map((name, index) => ({
      id: `upload-pdf-${index + 1}`,
      sessionId: '.pending',
      name,
      originalName: name,
      path: `/uploads/.pending/${name}`,
      mimeType: 'application/pdf',
      size: 3
    })) satisfies UploadedAttachment[]
    const stageLocalFile = vi.fn().mockResolvedValueOnce(staged[0]).mockResolvedValueOnce(staged[1])
    const filterPdfContextCandidates = vi.fn().mockResolvedValue({
      sources: [],
      pendingAttachmentIds: ['upload-pdf-1', 'upload-pdf-2']
    })
    window.api = {
      sessions: {
        filterPdfContextCandidates
      }
    } as unknown as Window['api']
    const hook = renderController(uploads(stageLocalFile), undefined, [], null)
    mounted.push(hook)

    act(() =>
      hook.result.current.actions.stageFiles([
        new File(['pdf'], 'paper-a.pdf', { type: 'application/pdf' }),
        new File(['pdf'], 'paper-b.pdf', { type: 'application/pdf' })
      ])
    )
    await flushAsyncWork()

    expect(hook.result.current.view.readingContext.bindings).toEqual([])
    expect(hook.result.current.view.readingContext.automaticAttachmentCount).toBe(2)
    expect(filterPdfContextCandidates).not.toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject.project).toBeUndefined()
    expect(hook.result.current.lifecycle.captureSend()).toMatchObject({
      pendingPdfContextAttachmentIds: ['upload-pdf-1', 'upload-pdf-2']
    })

    act(() => hook.result.current.actions.dismissAutomaticReading())
    expect(hook.result.current.view.readingContext.automaticAttachmentCount).toBe(0)
    expect(hook.result.current.view.attachments).toEqual(staged)

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(hook.result.current.view.readingContext.automaticAttachmentCount).toBe(2)

    act(() => expect(hook.result.current.actions.redo()).toBe(true))
    expect(hook.result.current.view.readingContext.automaticAttachmentCount).toBe(0)
    expect(hook.result.current.view.attachments).toEqual(staged)
    expect(
      hook.result.current.lifecycle.captureSend().pendingPdfContextAttachmentIds
    ).toBeUndefined()
  })

  it('adds an immutable PDF mentioned with @ as a send-time Reading candidate', () => {
    const hook = renderController()
    mounted.push(hook)
    act(() =>
      hook.result.current.actions.changeDoc({
        nodes: [
          { type: 'text', text: 'Summarize ' },
          {
            type: 'artifact',
            id: 'paper',
            name: 'paper.pdf',
            path: '/paper.pdf',
            source: 'artifact',
            sourceFileId: 'paper',
            mimeType: 'application/pdf',
            versionId: 'paper-version'
          }
        ]
      })
    )

    expect(hook.result.current.lifecycle.captureSend()).toMatchObject({
      pendingPdfContextVersions: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'paper',
          sourceVersionId: 'paper-version'
        }
      ]
    })
    expect(hook.result.current.lifecycle.captureSend(false)).toMatchObject({
      pendingPdfContextVersions: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'paper',
          sourceVersionId: 'paper-version'
        }
      ]
    })
  })

  it('clears a staged-upload draft selection whose attachment is not in the draft', () => {
    const hook = renderController(uploads(), undefined, [], null)
    mounted.push(hook)

    // A preview tab can outlive its composer attachment; a selection pointing at the missing
    // upload would read linked in the preview header while no chip or send could honor it.
    act(() =>
      usePreviewWorkbenchStore.getState().setPendingPdfContext('project', {
        kind: 'staged-upload',
        attachmentId: 'upload-gone',
        previewItemId: 'upload:upload-gone'
      })
    )

    expect(usePreviewWorkbenchStore.getState().pendingPdfContextByProject.project).toBeUndefined()
    expect(hook.result.current.view.readingContext.bindings).toEqual([])
  })

  it('owns annotations in the draft and captured send snapshot', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => expect(hook.result.current.actions.addAnnotation(annotation())).toBeUndefined())

    expect(hook.result.current.view.annotations).toEqual([annotation()])
    expect(hook.result.current.lifecycle.captureSend().annotations).toEqual([annotation()])

    act(() => hook.result.current.actions.updateAnnotationNote('annotation-1', '  Recheck this.  '))
    expect(hook.result.current.view.annotations[0]).toMatchObject({ note: 'Recheck this.' })

    act(() => hook.result.current.actions.removeAnnotation('annotation-1'))
    expect(hook.result.current.view.annotations).toEqual([])
  })

  it('undoes and redoes annotation add, edit, and removal', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => expect(hook.result.current.actions.addAnnotation(annotation())).toBeUndefined())
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(hook.result.current.view.annotations).toEqual([])

    act(() => expect(hook.result.current.actions.redo()).toBe(true))
    expect(hook.result.current.view.annotations).toEqual([annotation()])

    act(() => hook.result.current.actions.updateAnnotationNote('annotation-1', 'Review'))
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(hook.result.current.view.annotations[0]?.note).toBeUndefined()

    act(() => hook.result.current.actions.removeAnnotation('annotation-1'))
    expect(hook.result.current.view.annotations).toEqual([])
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(hook.result.current.view.annotations).toEqual([annotation()])
  })

  it('restores annotations with a failed send snapshot', () => {
    const hook = renderController()
    mounted.push(hook)
    act(() => hook.result.current.actions.addAnnotation(annotation()))
    const snapshot = hook.result.current.lifecycle.captureSend()

    act(() => hook.result.current.lifecycle.clearDraft(snapshot.draftKey, snapshot.version))
    expect(hook.result.current.view.annotations).toEqual([])
    act(() => expect(hook.result.current.lifecycle.restoreFailedSend(snapshot)).toBe(true))
    expect(hook.result.current.view.annotations).toEqual([annotation()])
  })

  it('keeps annotations isolated by draft key', () => {
    const hook = renderController()
    mounted.push(hook)
    act(() => hook.result.current.actions.addAnnotation(annotation('session-a-annotation')))

    hook.selectDraft('session-b')
    expect(hook.result.current.view.annotations).toEqual([])
    act(() => hook.result.current.actions.addAnnotation(annotation('session-b-annotation')))

    hook.selectDraft('session-a')
    expect(hook.result.current.view.annotations.map(({ id }) => id)).toEqual([
      'session-a-annotation'
    ])
  })

  it('keeps multiple annotated drafts isolated across Sessions and New Conversation', () => {
    const hook = renderController()
    mounted.push(hook)
    const projectAnnotation: TextAnnotation = {
      id: 'project-source',
      kind: 'text',
      target: 'agent',
      quote: 'Quoted project source',
      note: 'Check the source.',
      source: {
        kind: 'project-file',
        projectId: 'project',
        path: 'results/report.md',
        name: 'report.md',
        versionId: 'version-a'
      }
    }

    act(() => hook.result.current.actions.changeDoc(textDoc('Session A draft')))
    act(() => hook.result.current.actions.addAnnotation(annotation('agent-source')))
    act(() => hook.result.current.actions.addAnnotation(projectAnnotation))

    hook.selectDraft('new:project')
    act(() => hook.result.current.actions.changeDoc(textDoc('New Conversation draft')))
    act(() => hook.result.current.actions.addAnnotation(annotation('new-conversation-source')))

    hook.selectDraft('session-b')
    expect(hook.result.current.view).toMatchObject({ doc: emptyDoc, annotations: [] })

    hook.selectDraft('session-a')
    expect(hook.result.current.view.doc).toEqual(textDoc('Session A draft'))
    expect(hook.result.current.view.annotations).toEqual([
      annotation('agent-source'),
      projectAnnotation
    ])

    hook.selectDraft('new:project')
    expect(hook.result.current.view.doc).toEqual(textDoc('New Conversation draft'))
    expect(hook.result.current.view.annotations).toEqual([annotation('new-conversation-source')])
  })

  it('freezes annotations in a send snapshot while the live draft remains editable', () => {
    const hook = renderController()
    mounted.push(hook)
    act(() => hook.result.current.actions.addAnnotation(annotation()))
    const snapshot = hook.result.current.lifecycle.captureSend()

    act(() => hook.result.current.actions.updateAnnotationNote('annotation-1', 'New note'))
    act(() => hook.result.current.actions.addAnnotation(annotation('annotation-2')))

    expect(snapshot.annotations).toEqual([annotation()])
    expect(hook.result.current.view.annotations).toEqual([
      { ...annotation(), note: 'New note' },
      annotation('annotation-2')
    ])
  })

  it('captures an inline revision without mutating the active composer draft', () => {
    const hook = renderController()
    mounted.push(hook)
    act(() => hook.result.current.actions.changeDoc(textDoc('Unrelated composer draft')))
    const revisionDoc = textDoc('Edited historical prompt')
    const revisionAnnotation = annotation('revision-annotation')

    const snapshot = hook.result.current.lifecycle.captureRevision(revisionDoc, [
      revisionAnnotation
    ])

    expect(snapshot).toMatchObject({
      draftKey: 'session-a',
      doc: revisionDoc,
      annotations: [revisionAnnotation],
      attachments: []
    })
    expect(hook.result.current.view.doc).toEqual(textDoc('Unrelated composer draft'))
    expect(hook.result.current.view.annotations).toEqual([])
  })

  it('drops deleted Session drafts only after deletion succeeds', () => {
    const hook = renderController()
    mounted.push(hook)
    act(() => hook.result.current.actions.changeDoc(textDoc('Delete me')))
    act(() => hook.result.current.actions.addAnnotation(annotation()))

    expect(hook.result.current.lifecycle.beginSessionDeletion('session-a')).toBe(true)
    act(() => hook.result.current.lifecycle.settleSessionDeletion('session-a', false))
    expect(hook.result.current.view.doc).toEqual(textDoc('Delete me'))
    expect(hook.result.current.view.annotations).toEqual([annotation()])

    expect(hook.result.current.lifecycle.beginSessionDeletion('session-a')).toBe(true)
    act(() => hook.result.current.lifecycle.settleSessionDeletion('session-a', true))
    expect(hook.result.current.view.doc).toEqual(emptyDoc)
    expect(hook.result.current.view.annotations).toEqual([])

    hook.selectDraft('session-b')
    hook.selectDraft('session-a')
    expect(hook.result.current.view.doc).toEqual(emptyDoc)
    expect(hook.result.current.view.annotations).toEqual([])
  })

  it('removes a deleted background Session draft without affecting the active draft', () => {
    const hook = renderController()
    mounted.push(hook)
    act(() => hook.result.current.actions.addAnnotation(annotation('session-a-annotation')))
    hook.selectDraft('session-b')
    act(() => hook.result.current.actions.changeDoc(textDoc('Session B draft')))

    expect(hook.result.current.lifecycle.beginSessionDeletion('session-a')).toBe(true)
    act(() => hook.result.current.lifecycle.settleSessionDeletion('session-a', true))
    expect(hook.result.current.view.doc).toEqual(textDoc('Session B draft'))

    hook.selectDraft('session-a')
    expect(hook.result.current.view).toMatchObject({ doc: emptyDoc, annotations: [] })
  })

  it('does not restore a failed send into a deleted Session draft', () => {
    const hook = renderController()
    mounted.push(hook)
    act(() => hook.result.current.actions.addAnnotation(annotation()))
    const snapshot = hook.result.current.lifecycle.captureSend()

    expect(hook.result.current.lifecycle.beginSessionDeletion('session-a')).toBe(true)
    act(() => hook.result.current.lifecycle.settleSessionDeletion('session-a', true))

    expect(hook.result.current.lifecycle.restoreFailedSend(snapshot)).toBe(false)
    expect(hook.result.current.view).toMatchObject({ doc: emptyDoc, annotations: [] })
  })
  it('undoes typed text through the current Composer draft', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('draft')))
    act(() => expect(hook.result.current.actions.undo()).toBe(true))

    expect(hook.result.current.view.doc).toEqual(emptyDoc)
    expect(hook.result.current.actions.undo()).toBe(false)
    expect(hook.result.current.view.doc).toEqual(emptyDoc)
  })

  it('redoes the latest undone document edit and clears redo after a new edit', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('draft')))
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    act(() => expect(hook.result.current.actions.redo()).toBe(true))
    expect(hook.result.current.view.doc).toEqual(textDoc('draft'))

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    act(() => hook.result.current.actions.changeDoc(textDoc('replacement')))
    expect(hook.result.current.actions.redo()).toBe(false)
    expect(hook.result.current.view.doc).toEqual(textDoc('replacement'))
  })

  it('restores the caret captured before a Composer document edit', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('draft'), { nodeIndex: 0, offset: 2 }))
    act(() => expect(hook.result.current.actions.undo()).toBe(true))

    expect(hook.result.current.view.caretRequest?.position).toEqual({ nodeIndex: 0, offset: 2 })
  })

  it('restores the post-edit caret when redoing a Composer document edit', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('draft'), { nodeIndex: 0, offset: 2 }))
    act(() => expect(hook.result.current.actions.undo({ nodeIndex: 0, offset: 5 })).toBe(true))
    act(() => expect(hook.result.current.actions.redo()).toBe(true))

    expect(hook.result.current.view.caretRequest?.position).toEqual({ nodeIndex: 0, offset: 5 })
  })

  it('releases Composer undo history when its session is deleted', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('draft')))
    expect(hook.result.current.lifecycle.beginSessionDeletion('session-a')).toBe(true)
    act(() => hook.result.current.lifecycle.settleSessionDeletion('session-a', true))

    expect(hook.result.current.actions.undo()).toBe(false)
    expect(hook.result.current.actions.redo()).toBe(false)
  })

  it('undoes a pasted image after its attachment finishes staging', async () => {
    const image = {
      id: 'upload-image',
      sessionId: '.pending',
      name: 'figure.png',
      originalName: 'figure.png',
      path: '/uploads/figure.png',
      mimeType: 'image/png',
      size: 5
    }
    const uploadApi = uploads(vi.fn().mockResolvedValue(image))
    const hook = renderController(uploadApi)
    mounted.push(hook)

    act(() =>
      hook.result.current.actions.stageFiles([
        new File(['image'], 'figure.png', { type: 'image/png' })
      ])
    )
    await flushAsyncWork()
    expect(hook.result.current.view.attachments).toEqual([image])

    act(() => expect(hook.result.current.actions.undo()).toBe(true))

    expect(hook.result.current.view.attachments).toEqual([])
    expect(uploadApi.deleteUpload).not.toHaveBeenCalled()

    act(() => expect(hook.result.current.actions.redo()).toBe(true))
    expect(hook.result.current.view.attachments).toEqual([image])
    expect(uploadApi.deleteUpload).not.toHaveBeenCalled()

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    act(() => hook.result.current.actions.changeDoc(textDoc('replacement')))
    expect(hook.result.current.actions.redo()).toBe(false)
    expect(uploadApi.deleteUpload).toHaveBeenCalledWith({ path: '/uploads/figure.png' })
  })

  it('deletes an attachment retained only by redo history when the controller unmounts', async () => {
    const image = {
      id: 'upload-image',
      sessionId: '.pending',
      name: 'figure.png',
      originalName: 'figure.png',
      path: '/uploads/figure.png',
      mimeType: 'image/png',
      size: 5
    }
    const uploadApi = uploads(vi.fn().mockResolvedValue(image))
    const hook = renderController(uploadApi)

    act(() =>
      hook.result.current.actions.stageFiles([
        new File(['image'], 'figure.png', { type: 'image/png' })
      ])
    )
    await flushAsyncWork()
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(uploadApi.deleteUpload).not.toHaveBeenCalled()

    hook.unmount()

    expect(uploadApi.deleteUpload).toHaveBeenCalledWith({ path: '/uploads/figure.png' })
  })

  it('undoes a pasted image while its upload is still pending', () => {
    const pending = deferred<UploadedAttachment | null>()
    const uploadApi = uploads(vi.fn(() => pending.promise))
    const hook = renderController(uploadApi)
    mounted.push(hook)

    act(() =>
      hook.result.current.actions.stageFiles([
        new File(['image'], 'figure.png', { type: 'image/png' })
      ])
    )
    expect(hook.result.current.view.transfers).toHaveLength(1)
    const originalTransferId = hook.result.current.view.transfers[0].transferId

    act(() => expect(hook.result.current.actions.undo()).toBe(true))

    expect(hook.result.current.view.transfers).toEqual([])
    expect(uploadApi.abortTransfer).toHaveBeenCalledOnce()

    act(() => expect(hook.result.current.actions.redo()).toBe(true))
    expect(hook.result.current.view.transfers).toHaveLength(1)
    expect(hook.result.current.view.transfers[0].transferId).not.toBe(originalTransferId)
    expect(uploadApi.stageLocalFile).toHaveBeenCalledTimes(2)
  })

  it('restores a failed upload on redo without retrying it', async () => {
    const stageLocalFile = vi.fn().mockRejectedValue(new Error('disk full'))
    const hook = renderController(uploads(stageLocalFile))
    mounted.push(hook)

    act(() => hook.result.current.actions.stageFiles([new File(['paper'], 'paper.pdf')]))
    await flushAsyncWork()
    expect(hook.result.current.view.transfers[0]).toMatchObject({
      name: 'paper.pdf',
      status: 'error',
      error: 'disk full'
    })

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(hook.result.current.view.transfers).toEqual([])
    act(() => expect(hook.result.current.actions.redo()).toBe(true))

    expect(hook.result.current.view.transfers[0]).toMatchObject({
      name: 'paper.pdf',
      status: 'error',
      error: 'disk full'
    })
    expect(stageLocalFile).toHaveBeenCalledOnce()
  })

  it('preserves a shared pending transfer while undoing and redoing a later text edit', () => {
    const pending = deferred<UploadedAttachment | null>()
    const stageLocalFile = vi.fn(() => pending.promise)
    const uploadApi = uploads(stageLocalFile)
    const hook = renderController(uploadApi)
    mounted.push(hook)

    act(() => hook.result.current.actions.stageFiles([new File(['image'], 'figure.png')]))
    const transferId = hook.result.current.view.transfers[0].transferId
    act(() => hook.result.current.actions.changeDoc(textDoc('describe it')))

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(hook.result.current.view.transfers[0].transferId).toBe(transferId)
    act(() => expect(hook.result.current.actions.redo()).toBe(true))

    expect(hook.result.current.view.doc).toEqual(textDoc('describe it'))
    expect(hook.result.current.view.transfers[0].transferId).toBe(transferId)
    expect(stageLocalFile).toHaveBeenCalledOnce()
    expect(uploadApi.abortTransfer).not.toHaveBeenCalled()
  })

  it('keeps an attachment whose pending transfer completed after a later text edit', async () => {
    const pending = deferred<UploadedAttachment | null>()
    const uploadApi = uploads(vi.fn(() => pending.promise))
    const hook = renderController(uploadApi)
    mounted.push(hook)

    act(() => hook.result.current.actions.stageFiles([new File(['a'], 'paper.pdf')]))
    act(() => hook.result.current.actions.changeDoc(textDoc('explain this')))
    await act(async () => {
      pending.resolve({
        id: 'upload-a',
        sessionId: '.pending',
        name: 'paper.pdf',
        originalName: 'paper.pdf',
        path: '/uploads/paper.pdf',
        size: 1
      })
      await pending.promise
      await Promise.resolve()
    })

    act(() => expect(hook.result.current.actions.undo()).toBe(true))

    expect(hook.result.current.view.doc).toEqual(emptyDoc)
    expect(hook.result.current.view.attachments.map(({ id }) => id)).toEqual(['upload-a'])
    expect(hook.result.current.view.transfers).toEqual([])
    expect(uploadApi.deleteUpload).not.toHaveBeenCalled()
  })

  it('clears draft undo when prompt history replaces the Composer document', () => {
    const historyEntry: ComposerHistoryEntry = {
      id: 'session:message',
      messageId: 'message',
      doc: textDoc('history prompt')
    }
    const hook = renderController(uploads(), vi.fn().mockResolvedValue(undefined), [historyEntry])
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('scratch')))
    act(() => expect(hook.result.current.actions.navigateHistory('previous')).toBe(true))

    expect(hook.result.current.view.doc).toEqual(textDoc('history prompt'))
    expect(hook.result.current.actions.undo()).toBe(false)
    expect(hook.result.current.actions.redo()).toBe(false)
  })

  it('clears draft undo when a customize prefill replaces the Composer document', () => {
    const hook = renderController()
    mounted.push(hook)
    hook.selectDraft('new:project')
    act(() => hook.result.current.actions.changeDoc(textDoc('scratch')))

    hook.setCustomizePrefill({
      requestId: 1,
      projectId: 'project',
      goal: 'specialist'
    })

    expect(docToText(hook.result.current.view.doc)).not.toBe('scratch')
    expect(hook.result.current.actions.undo()).toBe(false)
    expect(hook.result.current.actions.redo()).toBe(false)
  })

  it('undoes a long paste as one Composer edit', async () => {
    const uploadApi = uploads(
      vi.fn().mockResolvedValue({
        id: 'upload-paste',
        sessionId: '.pending',
        name: 'Pastedtext-payload.txt',
        originalName: 'Pastedtext-payload.txt',
        path: '/uploads/paste.txt',
        mimeType: 'text/plain',
        size: 7
      })
    )
    const hook = renderController(uploadApi)
    mounted.push(hook)
    const node: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-1', text: 'payload' }

    act(() =>
      hook.result.current.actions.stagePastedText(pastedDoc(node), node, {
        nodeIndex: 0,
        offset: 3
      })
    )
    await flushAsyncWork()
    act(() => expect(hook.result.current.actions.undo()).toBe(true))

    expect(hook.result.current.view.doc).toEqual(emptyDoc)
    expect(hook.result.current.view.caretRequest?.position).toEqual({ nodeIndex: 0, offset: 3 })
    expect(hook.result.current.view.attachments).toEqual([])
    expect(uploadApi.deleteUpload).not.toHaveBeenCalled()

    act(() => expect(hook.result.current.actions.redo()).toBe(true))
    expect(hook.result.current.view.doc.nodes[1]).toMatchObject({
      type: 'pasted-text',
      id: 'paste-1',
      attachmentId: 'upload-paste'
    })
    expect(hook.result.current.view.attachments[0]?.id).toBe('upload-paste')
  })

  it('stages a long pasted text node and binds the managed attachment back to its anchor', async () => {
    const pastedTextName = 'Pastedtext-div-data-pane-body-l.txt'
    const stageLocalFile = vi.fn().mockResolvedValue({
      id: 'upload-paste',
      sessionId: '.pending',
      name: pastedTextName,
      originalName: pastedTextName,
      path: `/uploads/${pastedTextName}`,
      mimeType: 'text/plain',
      size: 7
    })
    const hook = renderController(uploads(stageLocalFile))
    mounted.push(hook)
    const node: ComposerPastedTextNode = {
      type: 'pasted-text',
      id: 'paste-1',
      text: `<div data-pane-body="left">${'x'.repeat(50)}`
    }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    expect(hook.result.current.view.transfers[0]).toMatchObject({
      pastedTextId: 'paste-1',
      name: pastedTextName,
      mimeType: 'text/plain'
    })

    await flushAsyncWork()

    expect(hook.result.current.view.attachments).toHaveLength(1)
    expect(stageLocalFile.mock.calls[0]?.[0]).toBeInstanceOf(File)
    expect(stageLocalFile.mock.calls[0]?.[0].name).toBe(pastedTextName)
    expect(Array.from(pastedTextName.replace(/^Pastedtext-|\.txt$/gu, ''))).toHaveLength(20)
    expect(hook.result.current.view.doc.nodes[1]).toMatchObject({
      type: 'pasted-text',
      id: 'paste-1',
      attachmentId: 'upload-paste',
      transferId: undefined
    })
    expect(docToText(hook.result.current.view.doc)).toBe('before  after')
  })

  it('restarts and rebinds an undone pending long paste when it is redone', async () => {
    const first = deferred<UploadedAttachment | null>()
    const second = deferred<UploadedAttachment | null>()
    const stageLocalFile = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const uploadApi = uploads(stageLocalFile)
    const hook = renderController(uploadApi)
    mounted.push(hook)
    const node: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-1', text: 'payload' }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    const firstTransferId = hook.result.current.view.transfers[0].transferId
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    act(() => expect(hook.result.current.actions.redo()).toBe(true))

    const secondTransferId = hook.result.current.view.transfers[0].transferId
    expect(secondTransferId).not.toBe(firstTransferId)
    expect(hook.result.current.view.doc.nodes[1]).toMatchObject({
      type: 'pasted-text',
      id: 'paste-1',
      transferId: secondTransferId
    })

    await act(async () => {
      first.resolve({
        id: 'upload-old',
        sessionId: '.pending',
        name: 'old.txt',
        originalName: 'old.txt',
        path: '/uploads/old.txt',
        mimeType: 'text/plain',
        size: 7
      })
      await first.promise
      await Promise.resolve()
    })
    await act(async () => {
      second.resolve({
        id: 'upload-redone',
        sessionId: '.pending',
        name: 'redone.txt',
        originalName: 'redone.txt',
        path: '/uploads/redone.txt',
        mimeType: 'text/plain',
        size: 7
      })
      await second.promise
      await Promise.resolve()
    })

    expect(hook.result.current.view.attachments[0]?.id).toBe('upload-redone')
    expect(hook.result.current.view.doc.nodes[1]).toMatchObject({
      type: 'pasted-text',
      id: 'paste-1',
      transferId: undefined,
      attachmentId: 'upload-redone'
    })
    expect(uploadApi.deleteUpload).toHaveBeenCalledWith({ path: '/uploads/old.txt' })
  })

  it('releases a re-staged pasted attachment replaced by repeated undo and redo', async () => {
    const stageLocalFile = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'upload-old',
        sessionId: '.pending',
        name: 'old.txt',
        originalName: 'old.txt',
        path: '/uploads/old.txt',
        mimeType: 'text/plain',
        size: 3
      })
      .mockResolvedValueOnce({
        id: 'upload-new',
        sessionId: '.pending',
        name: 'new.txt',
        originalName: 'new.txt',
        path: '/uploads/new.txt',
        mimeType: 'text/plain',
        size: 3
      })
      .mockResolvedValueOnce({
        id: 'upload-old-restaged',
        sessionId: '.pending',
        name: 'old-restaged.txt',
        originalName: 'old-restaged.txt',
        path: '/uploads/old-restaged.txt',
        mimeType: 'text/plain',
        size: 3
      })
      .mockResolvedValueOnce({
        id: 'upload-old-restaged-again',
        sessionId: '.pending',
        name: 'old-restaged-again.txt',
        originalName: 'old-restaged-again.txt',
        path: '/uploads/old-restaged-again.txt',
        mimeType: 'text/plain',
        size: 3
      })
    const uploadApi = uploads(stageLocalFile)
    const hook = renderController(uploadApi)
    mounted.push(hook)
    const oldPaste: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-old', text: 'old' }
    const newPaste: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-new', text: 'new' }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(oldPaste), oldPaste))
    await flushAsyncWork()
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(newPaste), newPaste))
    await flushAsyncWork()
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await flushAsyncWork()
    expect(hook.result.current.view.attachments[0]?.id).toBe('upload-old-restaged')

    act(() => expect(hook.result.current.actions.redo()).toBe(true))
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await flushAsyncWork()

    expect(hook.result.current.view.attachments[0]?.id).toBe('upload-old-restaged-again')
    expect(uploadApi.deleteUpload).toHaveBeenCalledWith({ path: '/uploads/old-restaged.txt' })
  })

  it('stages copied pasted-text anchors as one independent upload batch', async () => {
    const stageLocalFile = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'upload-a',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/a.txt',
        mimeType: 'text/plain',
        size: 5
      })
      .mockResolvedValueOnce({
        id: 'upload-b',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/b.txt',
        mimeType: 'text/plain',
        size: 5
      })
    const hook = renderController(uploads(stageLocalFile))
    mounted.push(hook)
    const pasteA: ComposerPastedTextNode = { type: 'pasted-text', id: 'copy-a', text: 'alpha' }
    const pasteB: ComposerPastedTextNode = { type: 'pasted-text', id: 'copy-b', text: 'bravo' }
    const doc: ComposerDoc = {
      nodes: [
        { type: 'text', text: 'before ' },
        pasteA,
        { type: 'text', text: ' middle ' },
        pasteB,
        { type: 'text', text: ' after' }
      ]
    }

    act(() => hook.result.current.actions.stagePastedText(doc, [pasteA, pasteB]))

    expect(hook.result.current.view.transfers).toHaveLength(2)
    expect(hook.result.current.view.transfers.map((transfer) => transfer.pastedTextId)).toEqual([
      'copy-a',
      'copy-b'
    ])

    await flushAsyncWork()

    expect(stageLocalFile).toHaveBeenCalledTimes(2)
    expect(hook.result.current.view.attachments.map((attachment) => attachment.id)).toEqual([
      'upload-a',
      'upload-b'
    ])
    expect(
      hook.result.current.view.doc.nodes
        .filter((node): node is ComposerPastedTextNode => node.type === 'pasted-text')
        .map((node) => ({ id: node.id, attachmentId: node.attachmentId }))
    ).toEqual([
      { id: 'copy-a', attachmentId: 'upload-a' },
      { id: 'copy-b', attachmentId: 'upload-b' }
    ])
  })

  it('restores staged pasted text at its exact position and Cmd+Z converts it back', async () => {
    const uploadApi = uploads(
      vi
        .fn()
        .mockResolvedValueOnce({
          id: 'upload-paste',
          sessionId: '.pending',
          name: 'Pasted text.txt',
          originalName: 'Pasted text.txt',
          path: '/uploads/Pasted text.txt',
          mimeType: 'text/plain',
          size: 7
        })
        .mockResolvedValueOnce({
          id: 'upload-paste-restaged',
          sessionId: '.pending',
          name: 'Pasted text.txt',
          originalName: 'Pasted text.txt',
          path: '/uploads/Pasted text-restaged.txt',
          mimeType: 'text/plain',
          size: 7
        })
    )
    const hook = renderController(uploadApi)
    mounted.push(hook)
    const node: ComposerPastedTextNode = {
      type: 'pasted-text',
      id: 'paste-1',
      text: 'payload'
    }
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    await flushAsyncWork()

    expect(hook.result.current.view.attachments).toHaveLength(1)
    act(() =>
      hook.result.current.actions.changeDoc({
        nodes: [...hook.result.current.view.doc.nodes, { type: 'text', text: ' typed' }]
      })
    )
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    act(() => hook.result.current.actions.restorePastedText('paste-1'))

    expect(hook.result.current.view.doc).toEqual(textDoc('before payload after'))
    expect(hook.result.current.actions.redo()).toBe(false)
    expect(hook.result.current.view.attachments).toEqual([])
    expect(hook.result.current.view.caretRequest?.position).toEqual({
      nodeIndex: 0,
      offset: 'before payload'.length
    })
    expect(uploadApi.deleteUpload).toHaveBeenCalledWith({ path: '/uploads/Pasted text.txt' })

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await flushAsyncWork()

    expect(hook.result.current.view.doc.nodes[1]).toMatchObject({
      type: 'pasted-text',
      id: 'paste-1',
      attachmentId: 'upload-paste-restaged'
    })
    expect(docToText(hook.result.current.view.doc)).toBe('before  after')
    expect(hook.result.current.view.attachments[0]?.id).toBe('upload-paste-restaged')

    hook.selectDraft('session-b')
    expect(hook.result.current.view.caretRequest).toBeUndefined()
  })

  it('restores the original text inline when staging a converted paste fails', async () => {
    const hook = renderController(uploads(vi.fn().mockRejectedValue(new Error('disk full'))))
    mounted.push(hook)
    const node: ComposerPastedTextNode = {
      type: 'pasted-text',
      id: 'paste-1',
      text: 'payload'
    }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    await flushAsyncWork()

    expect(hook.result.current.view.transfers).toEqual([])
    expect(hook.result.current.view.doc).toEqual(textDoc('before payload after'))
    expect(hook.result.current.view.attachments).toEqual([])
    expect(hook.result.current.view.error).toBe('disk full')
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(hook.result.current.view.doc).toEqual(emptyDoc)
  })

  it('keeps later text edits undoable when a converted paste upload fails', async () => {
    const pending = deferred<UploadedAttachment | null>()
    const hook = renderController(uploads(vi.fn(() => pending.promise)))
    mounted.push(hook)
    const node: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-1', text: 'payload' }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    act(() =>
      hook.result.current.actions.changeDoc({
        nodes: [...hook.result.current.view.doc.nodes, { type: 'text', text: ' typed' }]
      })
    )
    pending.reject(new Error('disk full'))
    await flushAsyncWork()

    expect(docToText(hook.result.current.view.doc)).toBe('before payload after typed')
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(docToText(hook.result.current.view.doc)).toBe('before payload after')
  })

  it('rebinds an undo snapshot when a pending long paste finishes uploading', async () => {
    const pending = deferred<UploadedAttachment | null>()
    const hook = renderController(uploads(vi.fn(() => pending.promise)))
    mounted.push(hook)
    const node: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-1', text: 'payload' }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    act(() =>
      hook.result.current.actions.changeDoc({
        nodes: [...hook.result.current.view.doc.nodes, { type: 'text', text: ' question' }]
      })
    )
    await act(async () => {
      pending.resolve({
        id: 'upload-paste',
        sessionId: '.pending',
        name: 'Pastedtext-payload.txt',
        originalName: 'Pastedtext-payload.txt',
        path: '/uploads/paste.txt',
        mimeType: 'text/plain',
        size: 7
      })
      await pending.promise
      await Promise.resolve()
    })

    act(() => expect(hook.result.current.actions.undo()).toBe(true))

    expect(hook.result.current.view.doc.nodes[1]).toMatchObject({
      type: 'pasted-text',
      id: 'paste-1',
      attachmentId: 'upload-paste',
      transferId: undefined
    })
    expect(hook.result.current.view.attachments.map(({ id }) => id)).toEqual(['upload-paste'])
    expect(hook.result.current.view.transfers).toEqual([])
  })

  it('keeps the long paste inline when the composer attachment cap is already full', () => {
    const blocked = deferred<UploadedAttachment | null>()
    const hook = renderController(uploads(vi.fn(() => blocked.promise)))
    mounted.push(hook)
    act(() =>
      hook.result.current.actions.stageFiles(
        Array.from({ length: 10 }, (_, index) => new File(['x'], `file-${index}.txt`))
      )
    )
    expect(hook.result.current.view.transfers).toHaveLength(10)
    const node: ComposerPastedTextNode = {
      type: 'pasted-text',
      id: 'paste-1',
      text: 'payload'
    }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))

    expect(hook.result.current.view.doc).toEqual(textDoc('before payload after'))
    expect(hook.result.current.view.error).toBe('You can attach up to 10 files')
  })

  it('finishes a pasted-text upload in the draft that started it after a session switch', async () => {
    const staged = deferred<UploadedAttachment | null>()
    const hook = renderController(uploads(vi.fn(() => staged.promise)))
    mounted.push(hook)
    const node: ComposerPastedTextNode = {
      type: 'pasted-text',
      id: 'paste-1',
      text: 'payload'
    }
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    hook.selectDraft('session-b')

    await act(async () => {
      staged.resolve({
        id: 'upload-paste',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/Pasted text.txt',
        mimeType: 'text/plain',
        size: 7
      })
      await staged.promise
      await Promise.resolve()
    })

    expect(hook.result.current.view.attachments).toEqual([])
    hook.selectDraft('session-a')
    expect(hook.result.current.view.attachments[0]?.id).toBe('upload-paste')
    expect(hook.result.current.view.doc.nodes[1]).toMatchObject({
      type: 'pasted-text',
      id: 'paste-1',
      attachmentId: 'upload-paste'
    })
  })

  it('undoes a pasted attachment close by re-staging it, then undoes ordinary typing', async () => {
    const stageLocalFile = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'upload-first',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/first.txt',
        mimeType: 'text/plain',
        size: 7
      })
      .mockResolvedValueOnce({
        id: 'upload-restaged',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/restaged.txt',
        mimeType: 'text/plain',
        size: 7
      })
    const uploadApi = uploads(stageLocalFile)
    const hook = renderController(uploadApi)
    mounted.push(hook)
    const node: ComposerPastedTextNode = {
      type: 'pasted-text',
      id: 'paste-1',
      text: 'payload'
    }
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    await flushAsyncWork()
    expect(hook.result.current.view.attachments).toHaveLength(1)

    const firstAttachment = hook.result.current.view.attachments[0]
    act(() => hook.result.current.actions.removeAttachment(firstAttachment))
    expect(hook.result.current.view.doc).toEqual(textDoc('before  after'))
    expect(hook.result.current.view.attachments).toEqual([])

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await flushAsyncWork()
    expect(hook.result.current.view.attachments[0]?.id).toBe('upload-restaged')
    expect(hook.result.current.view.doc.nodes[1]).toMatchObject({
      type: 'pasted-text',
      id: 'paste-1',
      attachmentId: 'upload-restaged'
    })
    expect(uploadApi.deleteUpload).toHaveBeenCalledWith({ path: '/uploads/first.txt' })

    act(() => hook.result.current.actions.removeAttachment(hook.result.current.view.attachments[0]))
    act(() => hook.result.current.actions.changeDoc(textDoc('new typing')))
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    expect(hook.result.current.view.doc).toEqual(textDoc('before  after'))
  })

  it('undoes an atomic pasted-text anchor deletion emitted by the editor', async () => {
    const stageLocalFile = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'upload-first',
        sessionId: '.pending',
        name: 'Pastedtext-payload.txt',
        originalName: 'Pastedtext-payload.txt',
        path: '/uploads/first.txt',
        mimeType: 'text/plain',
        size: 7
      })
      .mockResolvedValueOnce({
        id: 'upload-restaged',
        sessionId: '.pending',
        name: 'Pastedtext-payload.txt',
        originalName: 'Pastedtext-payload.txt',
        path: '/uploads/restaged.txt',
        mimeType: 'text/plain',
        size: 7
      })
    const hook = renderController(uploads(stageLocalFile))
    mounted.push(hook)
    const node: ComposerPastedTextNode = {
      type: 'pasted-text',
      id: 'paste-1',
      text: 'payload'
    }
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    await flushAsyncWork()

    act(() => hook.result.current.actions.changeDoc(textDoc('before  after')))
    expect(hook.result.current.view.attachments).toEqual([])

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await flushAsyncWork()
    expect(hook.result.current.view.doc.nodes[1]).toMatchObject({
      type: 'pasted-text',
      id: 'paste-1',
      attachmentId: 'upload-restaged'
    })
  })

  it('undoes a selection edit that removes a pasted-text anchor and surrounding text', async () => {
    const stageLocalFile = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'upload-first',
        sessionId: '.pending',
        name: 'Pastedtext-payload.txt',
        originalName: 'Pastedtext-payload.txt',
        path: '/uploads/first.txt',
        mimeType: 'text/plain',
        size: 7
      })
      .mockResolvedValueOnce({
        id: 'upload-restaged',
        sessionId: '.pending',
        name: 'Pastedtext-payload.txt',
        originalName: 'Pastedtext-payload.txt',
        path: '/uploads/restaged.txt',
        mimeType: 'text/plain',
        size: 7
      })
    const hook = renderController(uploads(stageLocalFile))
    mounted.push(hook)
    const node: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-1', text: 'payload' }
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(node), node))
    await flushAsyncWork()

    act(() => hook.result.current.actions.changeDoc(textDoc('replacement')))
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await flushAsyncWork()

    expect(hook.result.current.view.doc.nodes).toContainEqual(
      expect.objectContaining({
        type: 'pasted-text',
        id: 'paste-1',
        attachmentId: 'upload-restaged'
      })
    )
  })

  it('undoes only the closed paste when another staged paste falls back inline', async () => {
    const failedSecond = deferred<UploadedAttachment | null>()
    const stageLocalFile = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'upload-a',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/a.txt',
        mimeType: 'text/plain',
        size: 5
      })
      .mockImplementationOnce(() => failedSecond.promise)
      .mockResolvedValueOnce({
        id: 'upload-a-restaged',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/a-restaged.txt',
        mimeType: 'text/plain',
        size: 5
      })
    const hook = renderController(uploads(stageLocalFile))
    mounted.push(hook)
    const pasteA: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-a', text: 'alpha' }
    const pasteB: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-b', text: 'bravo' }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(pasteA), pasteA))
    await flushAsyncWork()
    const boundA = hook.result.current.view.doc.nodes.find(
      (node): node is ComposerPastedTextNode => node.type === 'pasted-text'
    )!
    act(() =>
      hook.result.current.actions.stagePastedText(
        {
          nodes: [
            { type: 'text', text: 'before ' },
            boundA,
            { type: 'text', text: ' middle ' },
            pasteB,
            { type: 'text', text: ' after' }
          ]
        },
        pasteB
      )
    )
    act(() => hook.result.current.actions.removeAttachment(hook.result.current.view.attachments[0]))
    failedSecond.reject(new Error('disk full'))
    await flushAsyncWork()

    expect(hook.result.current.view.doc.nodes.some((node) => node.type === 'pasted-text')).toBe(
      false
    )
    expect(docToText(hook.result.current.view.doc)).toBe('before  middle bravo after')

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await flushAsyncWork()
    expect(docToText(hook.result.current.view.doc)).toBe('before  middle bravo after')
    expect(hook.result.current.view.doc.nodes).toContainEqual(
      expect.objectContaining({
        type: 'pasted-text',
        id: 'paste-a',
        attachmentId: 'upload-a-restaged'
      })
    )
    expect(hook.result.current.view.doc.nodes).not.toContainEqual(
      expect.objectContaining({ type: 'pasted-text', id: 'paste-b' })
    )
  })

  it('deletes an existing pasted attachment when a new long paste replaces its anchor', async () => {
    const stageLocalFile = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'upload-old',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/old.txt',
        mimeType: 'text/plain',
        size: 3
      })
      .mockResolvedValueOnce({
        id: 'upload-new',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/new.txt',
        mimeType: 'text/plain',
        size: 3
      })
      .mockResolvedValueOnce({
        id: 'upload-old-restaged',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/old-restaged.txt',
        mimeType: 'text/plain',
        size: 3
      })
    const uploadApi = uploads(stageLocalFile)
    const hook = renderController(uploadApi)
    mounted.push(hook)
    const oldPaste: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-old', text: 'old' }
    const newPaste: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-new', text: 'new' }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(oldPaste), oldPaste))
    await flushAsyncWork()
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(newPaste), newPaste))
    await flushAsyncWork()

    expect(uploadApi.deleteUpload).toHaveBeenCalledWith({ path: '/uploads/old.txt' })
    expect(hook.result.current.view.attachments.map((attachment) => attachment.id)).toEqual([
      'upload-new'
    ])
    expect(hook.result.current.view.doc.nodes).toContainEqual(
      expect.objectContaining({ type: 'pasted-text', id: 'paste-new' })
    )
    expect(hook.result.current.view.doc.nodes).not.toContainEqual(
      expect.objectContaining({ type: 'pasted-text', id: 'paste-old' })
    )

    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await flushAsyncWork()

    expect(hook.result.current.view.doc.nodes).toContainEqual(
      expect.objectContaining({
        type: 'pasted-text',
        id: 'paste-old',
        attachmentId: 'upload-old-restaged'
      })
    )
    expect(hook.result.current.view.attachments.map(({ id }) => id)).toEqual([
      'upload-old-restaged'
    ])
  })

  it('re-stages a pending pasted attachment when undo restores its replaced anchor', async () => {
    const oldUpload = deferred<UploadedAttachment | null>()
    const newUpload = deferred<UploadedAttachment | null>()
    const stageLocalFile = vi
      .fn()
      .mockImplementationOnce(() => oldUpload.promise)
      .mockImplementationOnce(() => newUpload.promise)
      .mockResolvedValueOnce({
        id: 'upload-old-restaged',
        sessionId: '.pending',
        name: 'Pasted text.txt',
        originalName: 'Pasted text.txt',
        path: '/uploads/old-restaged.txt',
        mimeType: 'text/plain',
        size: 3
      })
    const hook = renderController(uploads(stageLocalFile))
    mounted.push(hook)
    const oldPaste: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-old', text: 'old' }
    const newPaste: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-new', text: 'new' }

    act(() => hook.result.current.actions.stagePastedText(pastedDoc(oldPaste), oldPaste))
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(newPaste), newPaste))
    act(() => expect(hook.result.current.actions.undo()).toBe(true))
    await flushAsyncWork()

    expect(stageLocalFile).toHaveBeenCalledTimes(3)
    expect(hook.result.current.view.doc.nodes).toContainEqual(
      expect.objectContaining({
        type: 'pasted-text',
        id: 'paste-old',
        attachmentId: 'upload-old-restaged'
      })
    )
    expect(hook.result.current.view.attachments.map(({ id }) => id)).toEqual([
      'upload-old-restaged'
    ])
  })

  it('reuses the attachment slot when a new long paste replaces an anchor at the cap', () => {
    const blocked = deferred<UploadedAttachment | null>()
    const hook = renderController(uploads(vi.fn(() => blocked.promise)))
    mounted.push(hook)
    act(() =>
      hook.result.current.actions.stageFiles(
        Array.from({ length: 9 }, (_, index) => new File(['x'], `file-${index}.txt`))
      )
    )
    const oldPaste: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-old', text: 'old' }
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(oldPaste), oldPaste))
    expect(hook.result.current.view.transfers).toHaveLength(10)

    const newPaste: ComposerPastedTextNode = { type: 'pasted-text', id: 'paste-new', text: 'new' }
    act(() => hook.result.current.actions.stagePastedText(pastedDoc(newPaste), newPaste))

    expect(hook.result.current.view.transfers).toHaveLength(10)
    expect(
      hook.result.current.view.transfers.some((item) => item.pastedTextId === 'paste-old')
    ).toBe(false)
    expect(
      hook.result.current.view.transfers.some((item) => item.pastedTextId === 'paste-new')
    ).toBe(true)
    expect(hook.result.current.view.doc.nodes).toContainEqual(
      expect.objectContaining({ type: 'pasted-text', id: 'paste-new' })
    )
    expect(hook.result.current.view.error).toBeNull()
  })

  it('commits a completed upload to the draft that started it after selection changes', async () => {
    const staged = deferred<UploadedAttachment | null>()
    const hook = renderController(uploads(vi.fn(() => staged.promise)))
    mounted.push(hook)

    act(() => hook.result.current.actions.stageFiles([new File(['a'], 'a.txt')]))
    hook.selectDraft('session-b')

    await act(async () => {
      staged.resolve({
        id: 'upload-a',
        sessionId: '.pending',
        name: 'a.txt',
        originalName: 'a.txt',
        path: '/uploads/a.txt',
        size: 1
      })
      await staged.promise
      await Promise.resolve()
    })

    expect(hook.result.current.view.attachments).toEqual([])
    hook.selectDraft('session-a')
    expect(hook.result.current.view.attachments.map((item) => item.id)).toEqual(['upload-a'])
  })

  it('restores a failed send only while its captured draft version is still current', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('original')))
    const original = hook.result.current.lifecycle.captureSend()
    act(() => hook.result.current.lifecycle.clearDraft('session-a'))
    act(() => hook.result.current.lifecycle.restoreFailedSend(original))
    expect(hook.result.current.view.doc).toEqual(textDoc('original'))

    const superseded = hook.result.current.lifecycle.captureSend()
    act(() => hook.result.current.lifecycle.clearDraft('session-a'))
    act(() => hook.result.current.actions.changeDoc(textDoc('new intent')))
    act(() => hook.result.current.lifecycle.restoreFailedSend(superseded))
    expect(hook.result.current.view.doc).toEqual(textDoc('new intent'))
  })

  it('reports a queued-edit conflict without replacing the newer composer draft', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('queued intent')))
    const queued = hook.result.current.lifecycle.captureSend()
    act(() => hook.result.current.lifecycle.clearDraft(queued.draftKey, queued.version))
    act(() => hook.result.current.actions.changeDoc(textDoc('new intent')))

    expect(hook.result.current.lifecycle.restoreFailedSend(queued, true)).toBe(false)
    expect(hook.result.current.view.doc).toEqual(textDoc('new intent'))
  })

  it('restores an older queued item after later queued drafts leave the composer empty', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('first queued intent')))
    const first = hook.result.current.lifecycle.captureSend()
    act(() => hook.result.current.lifecycle.clearDraft(first.draftKey, first.version))
    act(() => hook.result.current.actions.changeDoc(textDoc('second queued intent')))
    const second = hook.result.current.lifecycle.captureSend()
    act(() => hook.result.current.lifecycle.clearDraft(second.draftKey, second.version))

    act(() => expect(hook.result.current.lifecycle.restoreFailedSend(first, true)).toBe(true))
    expect(hook.result.current.view.doc).toEqual(textDoc('first queued intent'))
  })

  it('discards queued uploads without changing the current draft version', () => {
    const uploadApi = uploads()
    const hook = renderController(uploadApi)
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('current intent')))
    const current = hook.result.current.lifecycle.captureSend()
    act(() =>
      hook.result.current.lifecycle.discardSnapshot({
        ...current,
        attachments: [
          {
            id: 'queued-upload',
            sessionId: '.pending',
            name: 'queued.txt',
            originalName: 'queued.txt',
            path: '/uploads/queued.txt',
            size: 1
          }
        ]
      })
    )

    expect(uploadApi.deleteUpload).toHaveBeenCalledWith({ path: '/uploads/queued.txt' })
    expect(hook.result.current.lifecycle.captureSend().version).toBe(current.version)
  })

  it('clears a Side chat first prompt only when the captured draft is still current', () => {
    const hook = renderController()
    mounted.push(hook)

    act(() => hook.result.current.actions.changeDoc(textDoc('first prompt')))
    const admitted = hook.result.current.lifecycle.captureSend()
    act(() =>
      expect(hook.result.current.lifecycle.clearDraft(admitted.draftKey, admitted.version)).toBe(
        true
      )
    )
    expect(hook.result.current.view.doc).toEqual({ nodes: [] })

    act(() => hook.result.current.actions.changeDoc(textDoc('captured')))
    const superseded = hook.result.current.lifecycle.captureSend()
    act(() => hook.result.current.actions.changeDoc(textDoc('new intent')))
    act(() =>
      expect(
        hook.result.current.lifecycle.clearDraft(superseded.draftKey, superseded.version)
      ).toBe(false)
    )
    expect(hook.result.current.view.doc).toEqual(textDoc('new intent'))
  })

  it('refreshes a cached Skill catalog when the settings bridge is available', async () => {
    window.api = { settings: { listSkills: vi.fn() } } as unknown as Window['api']
    const loadSkills = vi.fn().mockResolvedValue(undefined)
    const hook = renderController(uploads(), loadSkills)
    mounted.push(hook)

    await act(async () => {
      await Promise.resolve()
    })

    expect(loadSkills).toHaveBeenCalledOnce()
  })
})
