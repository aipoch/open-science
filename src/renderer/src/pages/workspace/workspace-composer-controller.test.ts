// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UploadedAttachment } from '../../../../shared/uploads'

import type { UploadStagingApi } from './composer-upload-transfer'
import type { ComposerDoc } from './composer/composer-doc'
import { useWorkspaceComposerController } from './workspace-composer-controller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const textDoc = (text: string): ComposerDoc => ({ nodes: [{ type: 'text', text }] })

const deferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
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
  unmount: () => void
}

const renderController = (
  uploadApi = uploads(),
  loadSkills = vi.fn().mockResolvedValue(undefined)
): ControllerHook => {
  let currentDraftKey = 'session-a'
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
      pendingCustomizePrefill: undefined,
      onCustomizePrefillApplied: vi.fn(),
      historyEntries: [],
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
