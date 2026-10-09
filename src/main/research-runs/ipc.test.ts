import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { createElectronCallerContext } from '../caller-context'
import { registerResearchRunInspectionIpc } from './ipc'

const seam = vi.hoisted(() => ({ register: vi.fn(), lease: vi.fn(), caller: vi.fn() }))
vi.mock('../ipc-handler-registry', () => ({ ipcMainHandle: seam.register }))
vi.mock('../caller-lifecycle', () => ({ callerLeaseForEvent: seam.lease }))
vi.mock('../caller-context', async (original) => ({
  ...(await original<typeof import('../caller-context')>()),
  callerContextForEvent: seam.caller
}))
beforeEach(() => vi.clearAllMocks())

describe('research inspection IPC', () => {
  it('registers only read inspection and forwards the current caller lease with cancellation', async () => {
    const inspect = vi.fn(async () => ({ status: 'ready' }))
    registerResearchRunInspectionIpc({ inspect } as never)
    expect(seam.register).toHaveBeenCalledOnce()
    expect(seam.register.mock.calls[0][0]).toBe('research-runs:inspect')
    const controller = new AbortController()
    let current = true
    seam.lease.mockReturnValue({ signal: controller.signal, isCurrent: () => current })
    seam.caller.mockReturnValue(createElectronCallerContext(42))
    const event = {} as IpcMainInvokeEvent
    const request = { projectId: 'project', sourceSessionId: 'source', sourceImportId: 'import' }
    await seam.register.mock.calls[0][1](event, request)
    const [forwarded, caller, signal] = inspect.mock.calls[0] as unknown as [
      unknown,
      { isAuthorizationCurrent(): boolean },
      AbortSignal
    ]
    expect(forwarded).toBe(request)
    expect(signal).toBe(controller.signal)
    expect(caller.isAuthorizationCurrent()).toBe(true)
    current = false
    expect(caller.isAuthorizationCurrent()).toBe(false)
    current = true
    controller.abort()
    expect(caller.isAuthorizationCurrent()).toBe(false)
  })
})
