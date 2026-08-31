import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactReproducibilityCheckRequest } from '../../shared/artifact-reproducibility'
import { registerArtifactReproducibilityIpcHandlers } from './artifact-reproducibility-ipc'

const handlers = new Map<string, (event: never, request: never) => unknown>()

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (event: never, request: never) => unknown) =>
    handlers.set(channel, handler)
}))

const request: ArtifactReproducibilityCheckRequest = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  frontierId: 'original-inputs'
}

const environmentLockRequest = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  lockChecksum: 'b'.repeat(64)
}

describe('artifact reproducibility IPC', () => {
  beforeEach(() => handlers.clear())

  it('routes progress and cancellation through the invoking renderer identity', async () => {
    let publish!: (state: { attemptId: string }) => void
    let destroyed!: () => void
    const owner = {
      start: vi.fn((_request, _ownerId, report) => {
        publish = report
        return { attemptId: 'attempt-1' }
      }),
      cancel: vi.fn(),
      cancelOwner: vi.fn(),
      getCheck: vi.fn(() => ({ attemptId: 'attempt-1' })),
      getCheckLog: vi.fn(async () => ({ attemptId: 'attempt-1' })),
      listReceipts: vi.fn(async () => ({ receipts: [] }))
    }
    const sender = {
      id: 17,
      once: vi.fn((_event, listener) => {
        destroyed = listener
      }),
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    }
    const exportReceipt = vi.fn(async () => ({ saved: true }))
    const exportEnvironmentLock = vi.fn(async () => ({ saved: true }))
    const describeEnvironmentLock = vi.fn(async () => ({ lockChecksum: 'b'.repeat(64) }))
    const createEnvironmentFromLock = vi.fn(async () => ({
      environmentName: 'repro-bbbbbbbbbbbb',
      kernelKind: 'python' as const,
      reused: false
    }))
    const importEnvironmentLock = vi.fn(async () => ({ imported: false as const }))
    const storage = { sizeBytes: 24, fileCount: 1, clearedReceiptChecksums: [] }
    const outputStorage = vi.fn(async () => storage)
    const clearOutputs = vi.fn(async () => ({ ...storage, sizeBytes: 0, fileCount: 0 }))
    registerArtifactReproducibilityIpcHandlers(owner as never, {
      previewOutput: vi.fn(),
      outputStorage,
      clearOutputs,
      withSessionAvailable: (_request, start) => start(),
      describeEnvironmentLock: describeEnvironmentLock as never,
      createEnvironmentFromLock,
      exportEnvironmentLock,
      exportReceipt,
      importEnvironmentLock
    })

    const scope = {
      projectId: request.projectId,
      appSessionId: request.appSessionId,
      artifactId: request.artifactId,
      versionId: request.versionId
    }
    await expect(
      handlers.get('artifacts:get-reproducibility-output-storage')?.(
        { sender } as never,
        scope as never
      )
    ).resolves.toEqual(storage)
    expect(() =>
      handlers.get('artifacts:clear-reproducibility-outputs')?.(
        { sender } as never,
        { ...scope, path: '/arbitrary' } as never
      )
    ).toThrow('Invalid')
    expect(clearOutputs).not.toHaveBeenCalled()
    await handlers.get('artifacts:clear-reproducibility-outputs')?.(
      { sender } as never,
      scope as never
    )
    expect(clearOutputs).toHaveBeenCalledWith(scope)

    await expect(
      handlers.get('artifacts:start-reproducibility-check')?.({ sender } as never, request as never)
    ).resolves.toEqual({ attemptId: 'attempt-1' })
    publish({ attemptId: 'attempt-1' })
    handlers.get('artifacts:cancel-reproducibility-check')?.(
      { sender } as never,
      { attemptId: 'attempt-1' } as never
    )
    destroyed()

    expect(owner.start).toHaveBeenCalledWith(request, 17, expect.any(Function))
    expect(
      handlers.get('artifacts:get-reproducibility-check')?.({ sender } as never, request as never)
    ).toEqual({ attemptId: 'attempt-1' })
    expect(owner.getCheck).toHaveBeenCalledWith(request, 17)
    expect(sender.send).toHaveBeenCalledWith('artifacts:reproducibility-check-changed', {
      attemptId: 'attempt-1'
    })
    expect(owner.cancel).toHaveBeenCalledWith({ attemptId: 'attempt-1' }, 17)
    expect(owner.cancelOwner).toHaveBeenCalledWith(17)
    await expect(
      handlers.get('artifacts:list-reproducibility-receipts')?.(
        { sender } as never,
        request as never
      )
    ).resolves.toEqual({ receipts: [] })
    await expect(
      handlers.get('artifacts:export-reproducibility-receipt')?.(
        { sender } as never,
        { ...request, receiptChecksum: 'a'.repeat(64), suggestedName: 'result.csv' } as never
      )
    ).resolves.toEqual({ saved: true })
    expect(exportReceipt).toHaveBeenCalledWith(sender, {
      ...request,
      receiptChecksum: 'a'.repeat(64),
      suggestedName: 'result.csv'
    })
    await expect(
      handlers.get('artifacts:export-environment-lock')?.(
        { sender } as never,
        environmentLockRequest as never
      )
    ).resolves.toEqual({ saved: true })
    expect(exportEnvironmentLock).toHaveBeenCalledWith(sender, environmentLockRequest)
    await handlers.get('artifacts:describe-environment-lock')?.(
      { sender } as never,
      environmentLockRequest as never
    )
    expect(describeEnvironmentLock).toHaveBeenCalledWith(environmentLockRequest)
    await handlers.get('artifacts:create-environment-from-lock')?.(
      { sender } as never,
      environmentLockRequest as never
    )
    expect(createEnvironmentFromLock).toHaveBeenCalledWith(environmentLockRequest)
    await handlers.get('artifacts:import-environment-lock')?.(
      { sender } as never,
      { projectId: 'project-1' } as never
    )
    expect(importEnvironmentLock).toHaveBeenCalledWith(sender, { projectId: 'project-1' })
    await expect(
      handlers.get('artifacts:get-reproducibility-check-log')?.(
        { sender } as never,
        { ...request, receiptChecksum: 'a'.repeat(64) } as never
      )
    ).resolves.toEqual({ attemptId: 'attempt-1' })
  })

  it('does not publish after the renderer has been destroyed', async () => {
    let publish!: (state: { attemptId: string }) => void
    const owner = {
      start: vi.fn((_request, _ownerId, report) => {
        publish = report
        return { attemptId: 'attempt-1' }
      }),
      cancel: vi.fn(),
      cancelOwner: vi.fn(),
      getCheckLog: vi.fn(async () => undefined),
      listReceipts: vi.fn(async () => ({ receipts: [] }))
    }
    const sender = {
      id: 17,
      once: vi.fn(),
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    }
    registerArtifactReproducibilityIpcHandlers(owner as never, {
      previewOutput: vi.fn(),
      outputStorage: vi.fn(),
      clearOutputs: vi.fn(),
      withSessionAvailable: (_request, start) => start(),
      describeEnvironmentLock: vi.fn() as never,
      createEnvironmentFromLock: vi.fn(async () => ({
        environmentName: 'repro-bbbbbbbbbbbb',
        kernelKind: 'python' as const,
        reused: false
      })),
      exportEnvironmentLock: vi.fn(async () => ({ saved: false })),
      exportReceipt: vi.fn(async () => ({ saved: false })),
      importEnvironmentLock: vi.fn(async () => ({ imported: false as const }))
    })

    await handlers.get('artifacts:start-reproducibility-check')?.(
      { sender } as never,
      request as never
    )
    sender.isDestroyed.mockReturnValue(true)
    publish({ attemptId: 'attempt-1' })

    expect(sender.send).not.toHaveBeenCalled()
  })

  it.each(['archived', 'deleted', 'renderer-destroyed'])(
    'does not start a queued check after its owner becomes %s',
    async (reason) => {
      const owner = { start: vi.fn(), cancelOwner: vi.fn() }
      let admit!: () => void
      const admission = new Promise<void>((resolve) => {
        admit = resolve
      })
      const withSessionAvailable = vi.fn(async (_request, start) => {
        await admission
        if (reason !== 'renderer-destroyed') throw new Error(reason)
        return start()
      })
      registerArtifactReproducibilityIpcHandlers(owner as never, {
        withSessionAvailable,
        previewOutput: vi.fn(),
        outputStorage: vi.fn(),
        clearOutputs: vi.fn(),
        describeEnvironmentLock: vi.fn(),
        createEnvironmentFromLock: vi.fn(),
        exportEnvironmentLock: vi.fn(),
        exportReceipt: vi.fn(),
        importEnvironmentLock: vi.fn()
      })
      const sender = { id: 17, once: vi.fn(), isDestroyed: vi.fn(() => false) }
      const pending = handlers.get('artifacts:start-reproducibility-check')?.(
        { sender } as never,
        request as never
      )
      expect(owner.start).not.toHaveBeenCalled()
      sender.isDestroyed.mockReturnValue(true)
      const rejected = expect(pending).rejects.toThrow()
      admit()
      await rejected
      expect(withSessionAvailable).toHaveBeenCalledWith(request, expect.any(Function))
      expect(owner.start).not.toHaveBeenCalled()
    }
  )
})
