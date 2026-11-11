import { expect, it, vi } from 'vitest'
import { createApplicationCommandRouter } from '../application-command-router'
import { createElectronCallerContext, createWebCallerContext } from '../caller-context'
import { registerResourceRecordingCommands, resourceRecordingCommands } from './resource-recording'

it('only admits validated desktop commands and never starts on a status read', async () => {
  const router = createApplicationCommandRouter()
  const owner = {
    getState: vi.fn(() => 'off' as const),
    start: vi.fn(async () => 'idle' as const),
    stop: vi.fn(async () => 'off' as const)
  }
  const installed = registerResourceRecordingCommands(router.registrar, owner)
  const context = createElectronCallerContext(1)
  const invocation = {
    args: [] as [],
    callerContext: context,
    callerLease: {
      leaseId: context.leaseId,
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => true
    }
  }
  expect(await router.dispatcher.invoke(resourceRecordingCommands.getState, invocation)).toBe('off')
  expect(owner.start).not.toHaveBeenCalled()
  expect(await router.dispatcher.invoke(resourceRecordingCommands.start, invocation)).toBe('idle')
  expect(await router.dispatcher.invoke(resourceRecordingCommands.stop, invocation)).toBe('off')
  for (const location of ['local', 'remote'] as const) {
    const callerContext = createWebCallerContext('browser', { location })
    for (const command of Object.values(resourceRecordingCommands))
      await expect(
        router.dispatcher.invoke(command, { ...invocation, callerContext })
      ).rejects.toThrow()
  }
  await expect(
    router.dispatcher.invoke(resourceRecordingCommands.start, {
      ...invocation,
      args: [true] as never
    })
  ).rejects.toThrow()
  expect(owner.start).toHaveBeenCalledOnce()
  installed.uninstall()
})
