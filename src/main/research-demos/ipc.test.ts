import { describe, expect, it, vi } from 'vitest'
import { createCallerContext } from '../caller-context'
import {
  createApplicationCommandRouter,
  type ApplicationInvocation
} from '../application-command-router'
import type { ResearchDemoOwner } from './owner'
import {
  createResearchDemoHandlers,
  registerResearchDemoCommands,
  researchDemoCommandGroup
} from './ipc'

type MutableInvocation = {
  -readonly [K in keyof ApplicationInvocation<readonly unknown[]>]: ApplicationInvocation<
    readonly unknown[]
  >[K]
}
function setup(): {
  owner: Record<string, ReturnType<typeof vi.fn>>
  invocation: MutableInvocation
  controller: AbortController
  revoke(): void
  restore(): void
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
  const controller = new AbortController()
  let current = true
  const id = 'd1896421-cafb-49e4-9b3a-1f536c13256e'
  const invocation: MutableInvocation = {
    callerContext: createCallerContext({
      clientId: id,
      lifecycleClientId: id,
      leaseId: id,
      surface: 'electron',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human'
    }),
    callerLease: {
      leaseId: id,
      generation: 1,
      signal: controller.signal,
      isCurrent: () => current
    },
    args: []
  }
  const handlers = createResearchDemoHandlers(owner as unknown as ResearchDemoOwner)
  return {
    owner,
    invocation,
    controller,
    revoke: () => {
      current = false
    },
    restore: () => {
      current = true
    },
    call: async (method, request = {}) =>
      handlers[('research-demos:' + method) as keyof typeof handlers]({
        ...invocation,
        args: [request]
      })
  }
}
describe('research demo desktop admission', () => {
  it('exposes only the explicit lifecycle and validates a live local desktop caller', async () => {
    const f = setup()
    const router = createApplicationCommandRouter()
    const installation = registerResearchDemoCommands(
      router.registrar,
      f.owner as unknown as ResearchDemoOwner
    )
    expect(router.dispatcher.commandNames()).toEqual(
      researchDemoCommandGroup.commands.map((command) => command.name).sort()
    )
    installation.uninstall()
    expect(router.dispatcher.commandNames()).toEqual([])
    router.dispose()
    await f.call('start', { requestId: 'request' })
    expect(f.owner.start).toHaveBeenCalledWith({ requestId: 'request' }, f.controller.signal)
    f.invocation.callerContext = createCallerContext({
      ...f.invocation.callerContext,
      location: 'remote'
    })
    await expect(f.call('start')).rejects.toThrow('unauthorized')
    expect(f.owner.start).toHaveBeenCalledTimes(1)
  })
  it.each(['web', 'task'] as const)(
    'rejects the %s surface before reaching execution',
    async (surface) => {
      const f = setup()
      f.invocation.callerContext = createCallerContext({ ...f.invocation.callerContext, surface })
      await expect(f.call('start')).rejects.toThrow('unauthorized')
      expect(f.owner.start).not.toHaveBeenCalled()
    }
  )
  it('rejects stale and aborted documents before execution', async () => {
    const f = setup()
    f.revoke()
    await expect(f.call('start')).rejects.toThrow('unauthorized')
    f.restore()
    f.controller.abort()
    await expect(f.call('start')).rejects.toThrow('unauthorized')
    expect(f.owner.start).not.toHaveBeenCalled()
  })
  it('redacts arbitrary errors and retains only fixed actionable status codes', async () => {
    const f = setup()
    f.owner.start.mockRejectedValueOnce(new Error('/private/user/secret.env content'))
    await expect(f.call('start')).rejects.toThrow(/^research-demo-operation-failed$/)
    f.owner.start.mockRejectedValueOnce(new Error('research-demo-already-running'))
    await expect(f.call('start')).rejects.toThrow(/^research-demo-already-running$/)
  })
  it('revalidates the renderer lease after asynchronous access and for question selection', async () => {
    const f = setup()
    f.owner.inspect.mockImplementationOnce(async () => {
      f.revoke()
      return {}
    })
    await expect(f.call('inspect')).rejects.toThrow('operation-failed')
    f.restore()
    await f.call('question')
    const caller = (
      f.owner.question.mock.calls[0] as unknown as [
        unknown,
        { clientId: string; isAuthorizationCurrent(): boolean }
      ]
    )[1]
    expect(caller.clientId).toBe(f.invocation.callerContext.clientId)
    expect(caller.isAuthorizationCurrent()).toBe(true)
    f.revoke()
    expect(caller.isAuthorizationCurrent()).toBe(false)
  })
})
