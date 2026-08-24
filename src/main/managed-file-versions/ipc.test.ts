import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ManagedFileVersionCancelDiffRequest,
  ManagedFileVersionDiffRequest,
  ManagedFileVersionDiffResult,
  ManagedFileVersionIpcResult,
  ManagedFileVersionInspectRequest,
  ManagedFileVersionInspectResult,
  ManagedFileVersionSaveTextEditRequest,
  SaveTextEditResult
} from '../../shared/managed-file-versions'

const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (event: unknown, request: never) => unknown>()
}))

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: vi.fn((channel: string, handler: (event: unknown, request: never) => unknown) => {
    registered.set(channel, handler)
  })
}))

import { ManagedFileVersionError } from './service'
import { createManagedFileVersionHandlers, registerManagedFileVersionIpcHandlers } from './ipc'

const inspectRequest: ManagedFileVersionInspectRequest = {
  source: 'artifact',
  projectId: 'project-1',
  fileId: 'artifact-1'
}
const saveRequest: ManagedFileVersionSaveTextEditRequest = {
  ...inspectRequest,
  basedOnVersionId: 'version-1',
  expectedHeadVersionId: 'version-1',
  operationId: 'operation-1',
  content: 'changed\n'
}
const diffRequest: ManagedFileVersionDiffRequest = {
  ...inspectRequest,
  versionId: 'version-2',
  requestId: 'diff-request-1'
}
const cancelDiffRequest: ManagedFileVersionCancelDiffRequest = { requestId: 'diff-request-1' }
const diffResult: ManagedFileVersionDiffResult = {
  baseVersionId: 'version-1',
  selectedVersionId: 'version-2',
  lines: [
    {
      kind: 'removed',
      oldLineNumber: 1,
      segments: [{ kind: 'removed', text: 'before' }]
    },
    {
      kind: 'added',
      newLineNumber: 1,
      segments: [{ kind: 'added', text: 'after' }]
    }
  ]
}
const inspectResult: ManagedFileVersionInspectResult = {
  ...inspectRequest,
  sessionId: 'session-1',
  displayName: 'README.md',
  headVersionId: 'version-1',
  selectedVersionId: 'version-1',
  versions: [],
  canEdit: true,
  canDiff: false,
  text: 'before\n',
  textFormat: { hasUtf8Bom: false, newline: 'lf', hasTrailingNewline: true }
}
const saveResult: SaveTextEditResult = {
  kind: 'created',
  replayed: false,
  version: {
    id: 'version-2',
    source: 'artifact',
    fileId: 'artifact-1',
    versionNumber: 2,
    displayName: 'README.md',
    originKind: 'user_edit',
    basedOnVersionId: 'version-1',
    contentType: 'text/markdown',
    sizeBytes: 8,
    checksum: 'a'.repeat(64),
    createdAt: '2026-08-11T00:00:00.000Z'
  },
  headVersionId: 'version-2'
}

describe('managed file version IPC', () => {
  beforeEach(() => registered.clear())

  it('returns renderer-safe discriminated envelopes and gates writes through the data-root lease', async () => {
    const service = {
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => inspectResult),
      diffText: vi.fn(async () => diffResult),
      cancelDiff: vi.fn(() => true),
      saveTextEdit: vi.fn(async () => saveResult)
    }
    const writeGateEntered = vi.fn()
    const withDataRootWrite = async <Result>(write: () => Promise<Result>): Promise<Result> => {
      writeGateEntered()
      return write()
    }
    const onChanged = vi.fn()
    const handlers = createManagedFileVersionHandlers(service, { withDataRootWrite, onChanged })

    await expect(handlers.inspect(inspectRequest)).resolves.toEqual({
      ok: true,
      value: inspectResult
    })
    await expect(handlers.diffText(diffRequest)).resolves.toEqual({ ok: true, value: diffResult })
    expect(handlers.cancelDiff(cancelDiffRequest)).toEqual({ ok: true, value: { cancelled: true } })
    await expect(handlers.saveTextEdit(saveRequest)).resolves.toEqual({
      ok: true,
      value: saveResult
    })
    expect(writeGateEntered).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact'],
      kind: 'upsert'
    })
  })

  it('preserves stable expected error codes instead of relying on Electron Error serialization', async () => {
    const handlers = createManagedFileVersionHandlers(
      {
        getCapability: vi.fn(() => ({
          available: false as const,
          reason: 'STORAGE_UNAVAILABLE' as const
        })),
        inspect: vi.fn(async () => {
          throw new ManagedFileVersionError('INVALID_UTF8', 'Not valid UTF-8.')
        }),
        diffText: vi.fn(async () => {
          throw new ManagedFileVersionError('DIFF_OUTPUT_LIMIT_EXCEEDED', 'Diff is too large.')
        }),
        cancelDiff: vi.fn(() => false),
        saveTextEdit: vi.fn(async () => {
          throw new Error('unexpected implementation failure')
        })
      },
      { withDataRootWrite: async (write) => write() }
    )

    await expect(handlers.inspect(inspectRequest)).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_UTF8', message: 'Not valid UTF-8.' }
    })
    await expect(handlers.diffText(diffRequest)).resolves.toEqual({
      ok: false,
      error: { code: 'DIFF_OUTPUT_LIMIT_EXCEEDED', message: 'Diff is too large.' }
    })
    await expect(handlers.saveTextEdit(saveRequest)).resolves.toEqual({
      ok: false,
      error: { code: 'CONTENT_INTEGRITY_FAILED', message: 'Managed file operation failed.' }
    })
  })

  it('does not emit another Files change event for a replayed published operation', async () => {
    const onChanged = vi.fn()
    const handlers = createManagedFileVersionHandlers(
      {
        getCapability: vi.fn(() => ({ available: true as const })),
        inspect: vi.fn(async () => inspectResult),
        diffText: vi.fn(async () => diffResult),
        cancelDiff: vi.fn(() => false),
        saveTextEdit: vi.fn(async () => ({ ...saveResult, replayed: true }))
      },
      { withDataRootWrite: async (write) => write(), onChanged }
    )

    await expect(handlers.saveTextEdit(saveRequest)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'created', replayed: true }
    })
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('registers the exact typed channels and forwards requests', async () => {
    const handlers = {
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => ({ ok: true as const, value: inspectResult })),
      diffText: vi.fn(async () => ({ ok: true as const, value: diffResult })),
      cancelDiff: vi.fn(() => ({ ok: true as const, value: { cancelled: true } })),
      saveTextEdit: vi.fn(async () => ({ ok: true as const, value: saveResult }))
    }
    registerManagedFileVersionIpcHandlers(handlers)

    expect([...registered.keys()].sort()).toEqual([
      'managed-file-versions:cancel-diff',
      'managed-file-versions:diff-text',
      'managed-file-versions:get-capability',
      'managed-file-versions:inspect',
      'managed-file-versions:save-text-edit'
    ])
    await registered.get('managed-file-versions:get-capability')?.({}, undefined as never)
    await registered.get('managed-file-versions:inspect')?.({}, inspectRequest as never)
    const sender = { id: 1, once: vi.fn() }
    await registered.get('managed-file-versions:diff-text')?.({ sender }, diffRequest as never)
    await registered.get('managed-file-versions:cancel-diff')?.(
      { sender },
      cancelDiffRequest as never
    )
    await registered.get('managed-file-versions:save-text-edit')?.({}, saveRequest as never)
    expect(handlers.inspect).toHaveBeenCalledWith(inspectRequest)
    expect(handlers.diffText).toHaveBeenCalledWith(diffRequest)
    expect(handlers.cancelDiff).not.toHaveBeenCalled()
    expect(handlers.saveTextEdit).toHaveBeenCalledWith(saveRequest)
    expect(handlers.getCapability).toHaveBeenCalledTimes(1)
  })

  it('scopes diff cancellation to its sender and cancels all tasks when that renderer is destroyed', async () => {
    let resolveDiff!: () => void
    const pendingDiff = new Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>(
      (resolve) => {
        resolveDiff = () => resolve({ ok: true, value: diffResult })
      }
    )
    registerManagedFileVersionIpcHandlers({
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => ({ ok: true as const, value: inspectResult })),
      diffText: vi.fn(() => pendingDiff),
      cancelDiff: vi.fn(() => ({ ok: true as const, value: { cancelled: true } })),
      saveTextEdit: vi.fn(async () => ({ ok: true as const, value: saveResult }))
    })
    const destroyedListeners: Array<() => void> = []
    const senderA = {
      id: 11,
      once: vi.fn((_event: string, listener: () => void) => destroyedListeners.push(listener))
    }
    const senderB = { id: 22, once: vi.fn() }

    const diff = registered.get('managed-file-versions:diff-text')!
    const cancel = registered.get('managed-file-versions:cancel-diff')!
    void diff({ sender: senderA }, diffRequest as never)

    expect(cancel({ sender: senderB }, cancelDiffRequest as never)).toEqual({
      ok: true,
      value: { cancelled: false }
    })
    expect(cancel({ sender: senderA }, cancelDiffRequest as never)).toEqual({
      ok: true,
      value: { cancelled: true }
    })

    void diff({ sender: senderA }, { ...diffRequest, requestId: 'diff-request-2' } as never)
    destroyedListeners.at(-1)?.()
    expect(cancel({ sender: senderA }, { requestId: 'diff-request-2' } as never)).toEqual({
      ok: true,
      value: { cancelled: false }
    })
    resolveDiff()
  })

  it('rejects a colliding diff request id without transferring ownership to another sender', async () => {
    let resolveDiff!: () => void
    const pendingDiff = new Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>(
      (resolve) => {
        resolveDiff = () => resolve({ ok: true, value: diffResult })
      }
    )
    const handlers = {
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => ({ ok: true as const, value: inspectResult })),
      diffText: vi.fn(() => pendingDiff),
      cancelDiff: vi.fn(() => ({ ok: true as const, value: { cancelled: true } })),
      saveTextEdit: vi.fn(async () => ({ ok: true as const, value: saveResult }))
    }
    registerManagedFileVersionIpcHandlers(handlers)
    const senderA = { id: 11, once: vi.fn() }
    const senderB = { id: 22, once: vi.fn() }
    const diff = registered.get('managed-file-versions:diff-text')!
    const cancel = registered.get('managed-file-versions:cancel-diff')!

    const senderAResult = diff({ sender: senderA }, diffRequest as never)
    await expect(diff({ sender: senderB }, diffRequest as never)).resolves.toEqual({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Diff request id is already active.'
      }
    })
    expect(handlers.diffText).toHaveBeenCalledTimes(1)
    expect(cancel({ sender: senderB }, cancelDiffRequest as never)).toEqual({
      ok: true,
      value: { cancelled: false }
    })

    resolveDiff()
    await senderAResult
  })

  it('does not allow a request id to be reused until the cancelled owner settles', async () => {
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const first = new Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>(
      (resolve) => {
        resolveFirst = () => resolve({ ok: true, value: diffResult })
      }
    )
    const second = new Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>(
      (resolve) => {
        resolveSecond = () => resolve({ ok: true, value: diffResult })
      }
    )
    const handlers = {
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => ({ ok: true as const, value: inspectResult })),
      diffText: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
      cancelDiff: vi.fn(() => ({ ok: true as const, value: { cancelled: true } })),
      saveTextEdit: vi.fn(async () => ({ ok: true as const, value: saveResult }))
    }
    registerManagedFileVersionIpcHandlers(handlers)
    const senderA = { id: 11, once: vi.fn() }
    const senderB = { id: 22, once: vi.fn() }
    const diff = registered.get('managed-file-versions:diff-text')!
    const cancel = registered.get('managed-file-versions:cancel-diff')!

    const firstResult = diff({ sender: senderA }, diffRequest as never)
    expect(cancel({ sender: senderA }, cancelDiffRequest as never)).toEqual({
      ok: true,
      value: { cancelled: true }
    })
    await expect(diff({ sender: senderB }, diffRequest as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })

    resolveFirst()
    await firstResult
    const secondResult = diff({ sender: senderB }, diffRequest as never)
    expect(cancel({ sender: senderB }, cancelDiffRequest as never)).toEqual({
      ok: true,
      value: { cancelled: true }
    })

    resolveSecond()
    await secondResult
  })

  it('bounds active diff work per sender and globally with a stable concurrency error', async () => {
    const pendingResolvers: Array<() => void> = []
    const handlers = {
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => ({ ok: true as const, value: inspectResult })),
      diffText: vi.fn(
        () =>
          new Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>((resolve) => {
            pendingResolvers.push(() => resolve({ ok: true, value: diffResult }))
          })
      ),
      cancelDiff: vi.fn(() => ({ ok: true as const, value: { cancelled: true } })),
      saveTextEdit: vi.fn(async () => ({ ok: true as const, value: saveResult }))
    }
    registerManagedFileVersionIpcHandlers(handlers)
    const diff = registered.get('managed-file-versions:diff-text')!
    const senderA = { id: 11, once: vi.fn() }
    const senderB = { id: 22, once: vi.fn() }
    const senderC = { id: 33, once: vi.fn() }

    const active = [
      diff({ sender: senderA }, { ...diffRequest, requestId: 'a-1' } as never),
      diff({ sender: senderA }, { ...diffRequest, requestId: 'a-2' } as never),
      diff({ sender: senderB }, { ...diffRequest, requestId: 'b-1' } as never),
      diff({ sender: senderB }, { ...diffRequest, requestId: 'b-2' } as never)
    ]

    await expect(
      diff({ sender: senderA }, { ...diffRequest, requestId: 'a-3' } as never)
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'DIFF_CONCURRENCY_LIMIT',
        message: 'Too many diff requests are active.'
      }
    })
    await expect(
      diff({ sender: senderC }, { ...diffRequest, requestId: 'c-1' } as never)
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'DIFF_CONCURRENCY_LIMIT',
        message: 'Too many diff requests are active.'
      }
    })
    expect(handlers.diffText).toHaveBeenCalledTimes(4)

    for (const resolve of pendingResolvers) resolve()
    await Promise.all(active)
  })

  it('retains ownership when cancellation arrives before the worker starts', async () => {
    let resolveDiff!: () => void
    const pendingDiff = new Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>(
      (resolve) => {
        resolveDiff = () => resolve({ ok: true, value: diffResult })
      }
    )
    const handlers = {
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => ({ ok: true as const, value: inspectResult })),
      diffText: vi.fn(() => pendingDiff),
      cancelDiff: vi.fn(() => ({ ok: true as const, value: { cancelled: false } })),
      saveTextEdit: vi.fn(async () => ({ ok: true as const, value: saveResult }))
    }
    registerManagedFileVersionIpcHandlers(handlers)
    const senderA = { id: 11, once: vi.fn() }
    const senderB = { id: 22, once: vi.fn() }
    const diff = registered.get('managed-file-versions:diff-text')!
    const cancel = registered.get('managed-file-versions:cancel-diff')!

    const first = diff({ sender: senderA }, diffRequest as never)
    expect(cancel({ sender: senderA }, cancelDiffRequest as never)).toEqual({
      ok: true,
      value: { cancelled: true }
    })
    const collision = diff({ sender: senderB }, diffRequest as never)
    await Promise.resolve()
    expect(handlers.diffText).toHaveBeenCalledTimes(1)

    resolveDiff()
    await first
    await expect(collision).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
    await expect(diff({ sender: senderB }, diffRequest as never)).resolves.toMatchObject({
      ok: true
    })
  })

  it('keeps a cancelled pre-worker request in the sender concurrency count until settle', async () => {
    const pendingResolvers: Array<() => void> = []
    const handlers = {
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => ({ ok: true as const, value: inspectResult })),
      diffText: vi.fn(
        () =>
          new Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>((resolve) => {
            pendingResolvers.push(() => resolve({ ok: true, value: diffResult }))
          })
      ),
      cancelDiff: vi.fn(() => ({ ok: true as const, value: { cancelled: false } })),
      saveTextEdit: vi.fn(async () => ({ ok: true as const, value: saveResult }))
    }
    registerManagedFileVersionIpcHandlers(handlers)
    const sender = { id: 11, once: vi.fn() }
    const diff = registered.get('managed-file-versions:diff-text')!
    const cancel = registered.get('managed-file-versions:cancel-diff')!

    const first = diff({ sender }, { ...diffRequest, requestId: 'slot-1' } as never)
    const second = diff({ sender }, { ...diffRequest, requestId: 'slot-2' } as never)
    expect(cancel({ sender }, { requestId: 'slot-1' } as never)).toMatchObject({
      ok: true,
      value: { cancelled: true }
    })
    await expect(
      diff({ sender }, { ...diffRequest, requestId: 'slot-3' } as never)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'DIFF_CONCURRENCY_LIMIT' }
    })

    for (const resolve of pendingResolvers) resolve()
    await Promise.all([first, second])
  })

  it('keeps destroyed sender requests owned until their pending diff settles', async () => {
    let resolveDiff!: () => void
    const pendingDiff = new Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>(
      (resolve) => {
        resolveDiff = () => resolve({ ok: true, value: diffResult })
      }
    )
    const handlers = {
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => ({ ok: true as const, value: inspectResult })),
      diffText: vi.fn(() => pendingDiff),
      cancelDiff: vi.fn(() => ({ ok: true as const, value: { cancelled: false } })),
      saveTextEdit: vi.fn(async () => ({ ok: true as const, value: saveResult }))
    }
    registerManagedFileVersionIpcHandlers(handlers)
    const destroyedListeners: Array<() => void> = []
    const senderA = {
      id: 11,
      once: vi.fn((_event: string, listener: () => void) => destroyedListeners.push(listener))
    }
    const senderB = { id: 22, once: vi.fn() }
    const diff = registered.get('managed-file-versions:diff-text')!

    const first = diff({ sender: senderA }, diffRequest as never)
    destroyedListeners[0]?.()
    await expect(diff({ sender: senderB }, diffRequest as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })

    resolveDiff()
    await first
    await expect(diff({ sender: senderB }, diffRequest as never)).resolves.toMatchObject({
      ok: true
    })
  })

  it('releases sender lifecycle observation when destruction happens after all work settles', async () => {
    const handlers = {
      getCapability: vi.fn(() => ({ available: true as const })),
      inspect: vi.fn(async () => ({ ok: true as const, value: inspectResult })),
      diffText: vi.fn(async () => ({ ok: true as const, value: diffResult })),
      cancelDiff: vi.fn(() => ({ ok: true as const, value: { cancelled: false } })),
      saveTextEdit: vi.fn(async () => ({ ok: true as const, value: saveResult }))
    }
    registerManagedFileVersionIpcHandlers(handlers)
    const destroyedListeners: Array<() => void> = []
    const settledSender = {
      id: 41,
      once: vi.fn((_event: string, listener: () => void) => destroyedListeners.push(listener))
    }
    const replacementSender = { id: 41, once: vi.fn() }
    const diff = registered.get('managed-file-versions:diff-text')!

    await diff({ sender: settledSender }, diffRequest as never)
    destroyedListeners[0]?.()
    await diff({ sender: replacementSender }, {
      ...diffRequest,
      requestId: 'replacement-request'
    } as never)

    expect(replacementSender.once).toHaveBeenCalledOnce()
  })
})
