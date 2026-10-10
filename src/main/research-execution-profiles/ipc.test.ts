import { describe, expect, it, vi } from 'vitest'
import {
  createResearchExecutionProfileHandlers,
  registerResearchExecutionProfileCommands,
  researchExecutionProfileCommandGroup,
  type ResearchExecutionProfileCommands
} from './ipc'
import {
  createApplicationCommandRouter,
  type ApplicationInvocation
} from '../application-command-router'
import { createCallerContext } from '../caller-context'

function fixture(): {
  service: { [K in keyof ResearchExecutionProfileCommands]: ReturnType<typeof vi.fn> }
  handlers: ReturnType<typeof createResearchExecutionProfileHandlers>
  invocation: ApplicationInvocation<readonly unknown[]>
  controller: AbortController
  revoke(): void
} {
  const controller = new AbortController()
  let current = true
  const caller = createCallerContext({
    clientId: 'document-id',
    lifecycleClientId: 'document-id',
    leaseId: 'document-id',
    surface: 'electron',
    location: 'local',
    principalKind: 'human',
    actionOrigin: 'human'
  })
  const invocation: ApplicationInvocation<readonly unknown[]> = {
    callerContext: caller,
    callerLease: {
      leaseId: 'document-id',
      generation: 1,
      signal: controller.signal,
      isCurrent: () => current
    },
    args: [{ fixture: true }]
  }
  const service = {
    pendingConfigurations: vi.fn().mockResolvedValue([]),
    resolveConfiguration: vi.fn().mockResolvedValue({ status: 'configured' }),
    preflight: vi.fn().mockResolvedValue({ ready: true }),
    saveExecutionProfile: vi.fn().mockResolvedValue({ profileId: 'public-id' }),
    removeExecutionProfile: vi.fn().mockResolvedValue(undefined)
  }
  const handlers = createResearchExecutionProfileHandlers(
    service as unknown as ResearchExecutionProfileCommands
  )
  return {
    service,
    handlers,
    invocation,
    controller,
    revoke: () => {
      current = false
    }
  }
}

describe('research profile desktop commands', () => {
  it.each(['web', 'task'] as const)(
    'rejects %s callers without reaching the credential owner',
    async (surface) => {
      const f = fixture()
      await expect(
        f.handlers['research-execution-profiles:save']({
          ...f.invocation,
          callerContext: createCallerContext({ ...f.invocation.callerContext, surface })
        })
      ).rejects.toThrow('unauthorized')
      expect(f.service.saveExecutionProfile).not.toHaveBeenCalled()
    }
  )
  it('rejects remote, stale, and aborted documents', async () => {
    const f = fixture()
    await expect(
      f.handlers['research-execution-profiles:save']({
        ...f.invocation,
        callerContext: createCallerContext({ ...f.invocation.callerContext, location: 'remote' })
      })
    ).rejects.toThrow('unauthorized')
    f.revoke()
    await expect(f.handlers['research-execution-profiles:save'](f.invocation)).rejects.toThrow(
      'unauthorized'
    )
    const aborted = fixture()
    aborted.controller.abort()
    await expect(
      aborted.handlers['research-execution-profiles:save'](aborted.invocation)
    ).rejects.toThrow('unauthorized')
    expect(f.service.saveExecutionProfile).not.toHaveBeenCalled()
    expect(aborted.service.saveExecutionProfile).not.toHaveBeenCalled()
  })
  it('redacts owner failures and refuses a response after document revocation', async () => {
    const f = fixture()
    f.service.saveExecutionProfile.mockRejectedValue(
      new Error('secret-value must never leave the owner')
    )
    await expect(f.handlers['research-execution-profiles:save'](f.invocation)).rejects.toThrow(
      'research-profile-operation-failed'
    )
    f.service.preflight.mockImplementation(async () => {
      f.revoke()
      return { credential: 'never returned' }
    })
    await expect(f.handlers['research-execution-profiles:inspect'](f.invocation)).rejects.toThrow(
      'research-profile-operation-failed'
    )
  })
  it('registers all five commands on the Node router and forwards the live document signal', async () => {
    const f = fixture()
    const router = createApplicationCommandRouter()
    const installation = registerResearchExecutionProfileCommands(
      router.registrar,
      f.service as unknown as ResearchExecutionProfileCommands
    )
    for (const command of researchExecutionProfileCommandGroup.commands) {
      await router.dispatcher.invoke(command, f.invocation)
    }
    expect(f.service.pendingConfigurations).toHaveBeenCalledWith()
    for (const method of [
      'resolveConfiguration',
      'preflight',
      'saveExecutionProfile',
      'removeExecutionProfile'
    ] as const) {
      expect(f.service[method]).toHaveBeenCalledWith(f.invocation.args[0], f.controller.signal)
    }
    installation.uninstall()
    expect(router.dispatcher.commandNames()).toEqual([])
    router.dispose()
  })
})
