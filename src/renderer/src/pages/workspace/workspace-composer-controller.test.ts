// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../../../shared/uploads'
import type { CustomizePrefillIntent } from '@/stores/navigation-store'

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
  setCustomizePrefill: (prefill: CustomizePrefillIntent) => void
  unmount: () => void
}

const renderController = (
  uploadApi = uploads(),
  loadSkills = vi.fn().mockResolvedValue(undefined),
  historyEntries: ComposerHistoryEntry[] = []
): ControllerHook => {
  let currentDraftKey = 'session-a'
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
      hasActiveSession: true,
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
  window.api = originalApi
})

describe('workspace composer controller', () => {
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
    act(() => hook.result.current.actions.restorePastedText('paste-1'))

    expect(hook.result.current.view.doc).toEqual(textDoc('before payload after'))
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
