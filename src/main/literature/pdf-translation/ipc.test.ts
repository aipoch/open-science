import { describe, expect, it, vi } from 'vitest'
import { ApplicationCallerLeaseRegistry, bindCallerLeaseToEvent } from '../../caller-lifecycle'
import { PdfTranslationOwner } from './index'
import { registerPdfTranslationIpc } from './ipc'
import { PdfTranslationError } from '../../../shared/pdf-translation'
import { PdfTranslationPdfCache } from './pdf-cache'

const handlers = vi.hoisted(() => new Map<string, (...args: never[]) => unknown>())
vi.mock('../../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (...args: never[]) => unknown) =>
    handlers.set(channel, handler)
}))

describe('PDF translation IPC', () => {
  it('uses the bound caller lease through begin, translate and close without chat APIs', async () => {
    const registry = new ApplicationCallerLeaseRegistry()
    const caller = registry.acquire({ leaseId: 'window', surface: 'electron' })
    const run = vi.fn().mockResolvedValue({ text: '细胞', stopReason: 'end_turn' })
    const owner = new PdfTranslationOwner({
      usage: { start: async () => async () => {}, recover: async () => {}, flush: async () => {} },
      captureTarget: async () => ({
        frameworkId: 'claude-code',
        providerId: 'p',
        model: { kind: 'required', id: 'm' },
        reasoningEffort: 'default'
      }),
      runner: {
        run,
        supportsTarget: () => true,
        shutdown: async () => {},
        sweepStaleProfiles: async () => {}
      }
    })
    const confirm = vi
      .spyOn(PdfTranslationPdfCache.prototype, 'confirm')
      .mockResolvedValue(undefined)
    registerPdfTranslationIpc(owner)
    const invoke = (channel: string, value: unknown): Promise<unknown> => {
      const event = { sender: {} }
      bindCallerLeaseToEvent(event, caller.lease)
      return Promise.resolve(handlers.get(channel)!(...([event, value] as never[])))
    }
    const operation = (await invoke('pdf-translation:begin', {
      resourceRequestKey: 'paper',
      fingerprint: 'sha',
      language: '中文',
      glossary: [],
      sources: ['cell']
    })) as { operationId: string }
    expect(
      await invoke('pdf-translation:translate', { ...operation, sourceIndex: 0, source: 'cell' })
    ).toBe('细胞')
    await invoke('pdf-translation:close', operation)
    await expect(
      invoke('pdf-translation:translate', { ...operation, sourceIndex: 0, source: 'cell' })
    ).rejects.toThrow('unavailable')
    expect(run).toHaveBeenCalledOnce()
    const translate = vi.spyOn(owner, 'translate')
    translate.mockRejectedValueOnce(
      new PdfTranslationError(
        'incomplete-output',
        'The translation omitted required numeric values.',
        { reasonCode: 'missing-numeric-literals', pageNumbers: [2], attempts: 2 }
      )
    )
    await expect(
      invoke('pdf-translation:translate', { ...operation, sourceIndex: 0, source: 'cell' })
    ).resolves.toEqual({
      failure: 'incomplete-output',
      diagnostic: { reasonCode: 'missing-numeric-literals', pageNumbers: [2], attempts: 2 },
      message:
        '[pdf-translation:incomplete-output] The translation omitted required numeric values.'
    })
    for (const code of ['checkpoint-failed', 'timeout', 'unsupported-model'] as const) {
      translate.mockRejectedValueOnce(new PdfTranslationError(code, 'Failed'))
      await expect(
        invoke('pdf-translation:translate', { ...operation, sourceIndex: 0, source: 'cell' })
      ).rejects.toThrow(`[pdf-translation:${code}]`)
    }
    translate.mockRejectedValueOnce(
      new PdfTranslationError('cancelled', 'PDF translation was cancelled.')
    )
    await expect(
      invoke('pdf-translation:translate', { ...operation, sourceIndex: 0, source: 'cell' })
    ).resolves.toEqual({
      failure: 'cancelled',
      message: '[pdf-translation:cancelled] PDF translation was cancelled.'
    })
    const providerAbort = Object.assign(new Error('Provider aborted unexpectedly'), {
      name: 'AbortError'
    })
    translate.mockRejectedValueOnce(providerAbort)
    await expect(
      invoke('pdf-translation:translate', { ...operation, sourceIndex: 0, source: 'cell' })
    ).rejects.toBe(providerAbort)
    const skip = vi.spyOn(owner, 'skip').mockResolvedValue(undefined)
    const skipRequest = { ...operation, sourceIndex: 0, source: 'cell' }
    await expect(invoke('pdf-translation:skip', skipRequest)).resolves.toBeUndefined()
    expect(skip).toHaveBeenCalledWith(skipRequest, caller.lease)
    const read = vi.spyOn(owner, 'readCheckpoint').mockResolvedValue(null)
    expect(await invoke('pdf-translation:read-checkpoint', 'version')).toBeNull()
    expect(read).toHaveBeenCalledWith('version', caller.lease)
    const workspaceSource = {
      kind: 'upload-version',
      projectId: 'project',
      sourceFileId: 'file',
      versionId: 'version',
      checksum: 'a'.repeat(64),
      name: 'paper.pdf',
      path: 'upload-version:version'
    }
    expect(await invoke('pdf-translation:read-checkpoint', workspaceSource)).toBeNull()
    expect(read).toHaveBeenLastCalledWith(workspaceSource, caller.lease)
    const list = vi.spyOn(owner, 'listEditions').mockResolvedValue([])
    expect(await invoke('pdf-translation:list-editions', workspaceSource)).toEqual([])
    expect(list).toHaveBeenCalledWith(workspaceSource, caller.lease)
    const select = vi
      .spyOn(owner, 'selectEdition')
      .mockRejectedValueOnce(new Error('Unavailable edition'))
    const selection = { source: workspaceSource, translationId: 'edition' }
    await expect(invoke('pdf-translation:select-edition', selection)).rejects.toThrow(
      'Unavailable edition'
    )
    expect(select).toHaveBeenCalledWith(selection, caller.lease)
    const remove = vi.spyOn(owner, 'deleteEdition').mockResolvedValue(undefined)
    await expect(invoke('pdf-translation:delete-edition', selection)).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledWith(selection, caller.lease)
    const record = vi.spyOn(owner, 'recordLayout').mockResolvedValue(undefined)
    const layout = {
      source: workspaceSource,
      checkpointKey: '00000000-0000-4000-8000-000000000000',
      generatedAt: Date.now(),
      units: []
    }
    await expect(invoke('pdf-translation:record-layout', layout)).resolves.toBeUndefined()
    expect(record).toHaveBeenCalledWith(layout, caller.lease)
    expect(confirm).toHaveBeenCalledWith(layout, caller.lease)
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(confirm.mock.invocationCallOrder[0])
    confirm.mockClear()
    record.mockRejectedValueOnce(new Error('Source is unavailable'))
    await expect(invoke('pdf-translation:record-layout', layout)).rejects.toThrow('unavailable')
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
    registry.dispose()
  })
})
