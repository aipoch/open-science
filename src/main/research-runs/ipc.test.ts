import { describe, expect, it, vi } from 'vitest'
import { createCallerContext } from '../caller-context'
import { createApplicationCommandRouter } from '../application-command-router'
import { registerResearchRunCommands, researchRunCommandGroup } from './ipc'

describe('research inspection desktop commands', () => {
  it('registers only read inspection and preserves the document UUID and revocable caller lease', async () => {
    const inspect = vi.fn(async () => ({ status: 'ready' }))
    const router = createApplicationCommandRouter()
    const installation = registerResearchRunCommands(router.registrar, { inspect } as never)
    expect(router.dispatcher.commandNames()).toEqual(['research-runs:inspect'])
    const controller = new AbortController()
    let current = true
    const identity = 'bb495823-e805-4d3b-ab74-887b01e4467e'
    const callerContext = createCallerContext({
      clientId: identity,
      lifecycleClientId: identity,
      leaseId: identity,
      surface: 'electron',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human'
    })
    const request = { projectId: 'project', sourceSessionId: 'source', sourceImportId: 'import' }
    await router.dispatcher.invoke(researchRunCommandGroup.commands[0], {
      callerContext,
      callerLease: {
        leaseId: identity,
        generation: 1,
        signal: controller.signal,
        isCurrent: () => current
      },
      args: [request]
    })
    const [forwarded, caller, signal] = inspect.mock.calls[0] as unknown as [
      unknown,
      { clientId: string; isAuthorizationCurrent(): boolean },
      AbortSignal
    ]
    expect(forwarded).toBe(request)
    expect(caller.clientId).toBe(identity)
    expect(signal).toBe(controller.signal)
    expect(caller.isAuthorizationCurrent()).toBe(true)
    current = false
    expect(caller.isAuthorizationCurrent()).toBe(false)
    current = true
    controller.abort()
    expect(caller.isAuthorizationCurrent()).toBe(false)
    installation.uninstall()
    expect(router.dispatcher.commandNames()).toEqual([])
    router.dispose()
  })
})
