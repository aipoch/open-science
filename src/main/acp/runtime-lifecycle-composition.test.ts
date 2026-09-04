import { describe, expect, it, vi } from 'vitest'

import { composeAcpRuntimeBaseOwners, type AcpRuntimeBaseOwners } from './runtime-base-composition'
import {
  composeAcpRuntimeLifecycleOwners,
  type AcpRuntimeLifecycleOwners
} from './runtime-lifecycle-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

describe('ACP Runtime lifecycle composition', () => {
  it('builds a fresh frozen graph and routes the bound lifecycle cycle', async () => {
    const options = { appVersion: 'test', defaultCwd: '/workspace' }
    const create = (): {
      base: AcpRuntimeBaseOwners
      disconnect: ReturnType<typeof vi.fn>
      clearPromptResources: ReturnType<typeof vi.fn>
      lifecycle: AcpRuntimeLifecycleOwners
    } => {
      const base = composeAcpRuntimeBaseOwners(options)
      const session = composeAcpRuntimeSessionOwners(options, base)
      const host = {
        connect: vi.fn(async () => session.publication.getSnapshot()),
        disconnect: vi.fn(async () => session.publication.getSnapshot()),
        clearPromptResources: vi.fn(),
        openAgentConnection: vi.fn(async () => {
          throw new Error('not called during composition')
        })
      }
      const lifecycle = composeAcpRuntimeLifecycleOwners(options, base, session, host)
      expect(host.connect).not.toHaveBeenCalled()
      expect(host.disconnect).not.toHaveBeenCalled()
      expect(host.openAgentConnection).not.toHaveBeenCalled()
      return {
        base,
        disconnect: host.disconnect,
        clearPromptResources: host.clearPromptResources,
        lifecycle
      }
    }

    const first = create()
    const second = create()

    expect(Object.isFrozen(first.lifecycle)).toBe(true)
    expect(first.lifecycle.modelChanges).not.toBe(second.lifecycle.modelChanges)
    expect(first.lifecycle.connectionClose).not.toBe(second.lifecycle.connectionClose)
    expect(first.lifecycle.connectionLifecycle).not.toBe(second.lifecycle.connectionLifecycle)
    expect(first.base.generationActivity.blockers()).toEqual({
      reconnect: false,
      retirement: false
    })

    await first.base.connectionTransitions.requestProviderReconnect()
    expect(first.disconnect).toHaveBeenCalledOnce()
    expect(first.disconnect).toHaveBeenCalledWith(false)
    await expect(first.lifecycle.connectionClose.disconnect(false)).resolves.toMatchObject({
      status: 'idle'
    })
    expect(first.clearPromptResources).toHaveBeenCalledOnce()
    expect(first.disconnect).toHaveBeenCalledOnce()
  })
})
