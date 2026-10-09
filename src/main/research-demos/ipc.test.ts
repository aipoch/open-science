import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElectronCallerContext } from '../caller-context'
import type { ResearchDemoOwner } from './owner'
import { registerResearchDemoIpc } from './ipc'

const seam = vi.hoisted(() => ({ register: vi.fn(), lease: vi.fn(), caller: vi.fn() }))
vi.mock('../ipc-handler-registry', () => ({ ipcMainHandle: seam.register }))
vi.mock('../caller-lifecycle', () => ({ callerLeaseForEvent: seam.lease }))
vi.mock('../caller-context', async (original) => ({
  ...(await original<typeof import('../caller-context')>()),
  callerContextForEvent: seam.caller
}))
beforeEach(() => {
  vi.clearAllMocks()
  seam.caller.mockReturnValue(createElectronCallerContext(1))
  seam.lease.mockReturnValue({ isCurrent: () => true, signal: new AbortController().signal })
})
function setup(): {
  owner: Record<string, ReturnType<typeof vi.fn>>
  call: (method: string, request?: unknown) => Promise<unknown>
} {
  const owner = Object.fromEntries(
    [
      'inspect',
      'start',
      'list',
      'get',
      'readHistory',
      'readReceipt',
      'stop',
      'carriers',
      'question'
    ].map((method) => [method, vi.fn(async () => ({}))])
  )
  registerResearchDemoIpc(owner as unknown as ResearchDemoOwner)
  return {
    owner,
    call: (method: string, request: unknown = {}) =>
      seam.register.mock.calls.find(([channel]) => channel === 'research-demos:' + method)![1](
        {},
        request
      )
  }
}
describe('Replay demo desktop admission', () => {
  it('exposes only the explicit lifecycle and validates a live local desktop caller', async () => {
    const f = setup()
    expect(seam.register).toHaveBeenCalledTimes(9)
    await f.call('start', { requestId: 'request' })
    expect(f.owner.start).toHaveBeenCalledWith({ requestId: 'request' }, expect.any(AbortSignal))
    seam.caller.mockReturnValue({ ...createElectronCallerContext(1), location: 'remote' })
    await expect(f.call('start')).rejects.toThrow('unauthorized')
    expect(f.owner.start).toHaveBeenCalledTimes(1)
  })
  it('redacts arbitrary errors and retains only fixed actionable status codes', async () => {
    const f = setup()
    f.owner.start.mockRejectedValueOnce(new Error('/private/user/secret.env content'))
    await expect(f.call('start')).rejects.toThrow(/^research-demo-operation-failed$/)
    f.owner.start.mockRejectedValueOnce(new Error('research-demo-already-running'))
    await expect(f.call('start')).rejects.toThrow(/^research-demo-already-running$/)
  })
  it('revalidates the renderer lease after asynchronous access and for question selection', async () => {
    let current = true
    seam.lease.mockReturnValue({ isCurrent: () => current, signal: new AbortController().signal })
    const f = setup()
    f.owner.inspect.mockImplementationOnce(async () => {
      current = false
      return {}
    })
    await expect(f.call('inspect')).rejects.toThrow('operation-failed')
    current = true
    await f.call('question')
    const caller = (
      f.owner.question.mock.calls[0] as unknown as [unknown, { isAuthorizationCurrent(): boolean }]
    )[1]
    expect(caller.isAuthorizationCurrent()).toBe(true)
    current = false
    expect(caller.isAuthorizationCurrent()).toBe(false)
  })
})
