import { describe, expect, it, vi } from 'vitest'
import { createApplicationCommandRouter } from '../application-command-router'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { createElectronCallerContext } from '../caller-context'
import {
  registerSideChatApplicationCommands,
  sideChatApplicationCommandGroup
} from './application-commands'

describe('Side chat application commands', () => {
  it.each(['claude-code', 'opencode', 'codex', 'codebuddy'] as const)(
    'dispatches the same owner with preserved branch and model selection for %s',
    async (frameworkId) => {
      const router = createApplicationCommandRouter()
      const callerContext = createElectronCallerContext(1)
      const lease = new ApplicationCallerLeaseRegistry().acquire(callerContext)
      const start = vi.fn(async () => ({ sideSessionId: 'side', frameworkId, model: 'model' }))
      const installed = registerSideChatApplicationCommands(router.registrar, {
        list: vi.fn(),
        start,
        send: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn()
      })
      const request = {
        parentSessionId: 'parent',
        projectId: 'project',
        text: 'hello',
        expectedParentBranch: { frameId: 'frame', branchId: 'branch' },
        modelSelection: { providerId: 'provider', model: 'model', reasoningEffort: 'high' as const }
      }
      await expect(
        router.dispatcher.invoke(sideChatApplicationCommandGroup.commands[1], {
          callerContext,
          callerLease: lease.lease,
          args: [request]
        })
      ).resolves.toEqual({ sideSessionId: 'side', frameworkId, model: 'model' })
      expect(start).toHaveBeenCalledExactlyOnceWith(request)
      await expect(
        router.dispatcher.invoke(sideChatApplicationCommandGroup.commands[1], {
          callerContext,
          callerLease: lease.lease,
          args: [
            { ...request, modelSelection: { providerId: 'provider', reasoningEffort: 'invalid' } }
          ] as never
        })
      ).rejects.toMatchObject({ code: 'invalid-command-arguments' })
      expect(start).toHaveBeenCalledOnce()
      installed.uninstall()
      lease.release()
    }
  )
})
