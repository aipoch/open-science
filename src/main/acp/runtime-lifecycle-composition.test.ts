import { describe, expect, it, vi } from 'vitest'

import { composeAcpRuntimeBaseOwners, type AcpRuntimeBaseOwners } from './runtime-base-composition'
import {
  composeAcpRuntimeLifecycleOwners,
  type AcpRuntimeLifecycleOwners
} from './runtime-lifecycle-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import type { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import type { AcpRuntimeEvent } from '../../shared/acp'

describe('ACP Runtime lifecycle composition', () => {
  it('commits each unexpected-close terminal through Main before publishing it', async () => {
    const committed: AcpRuntimeEvent[] = []
    const observed: AcpRuntimeEvent[] = []
    const order: string[] = []
    const onPromptEnded = vi.fn(() => order.push('released'))
    const hostPromptEnded = vi.fn(() => order.push('host:released'))
    const commitTerminal = vi.fn(
      async (event: AcpRuntimeEvent, publish: (event: AcpRuntimeEvent) => void) => {
        committed.push(event)
        order.push('committed')
        expect(observed).toHaveLength(0)
        publish({ ...event, publicationOwner: 'main' })
      }
    )
    const retryTerminalCommits = vi.fn(() => order.push('retry'))
    const options = {
      appVersion: 'test',
      defaultCwd: '/workspace',
      callbacks: { onEvent: (event: AcpRuntimeEvent) => observed.push(event), onPromptEnded },
      runtimeSessions: { commitTerminal, retryTerminalCommits } as unknown as RuntimeSessionOwner
    }
    const base = composeAcpRuntimeBaseOwners(options)
    const session = composeAcpRuntimeSessionOwners(options, base)
    base.snapshotOwner.transitionStatus('connected')
    const prompt = base.sessionInteractions.claim({
      sessionId: 's1',
      kind: 'prompt',
      promptMessageId: 'prompt'
    })
    const lifecycle = composeAcpRuntimeLifecycleOwners(options, base, session, {
      connect: async () => session.publication.getSnapshot(),
      disconnect: async () => session.publication.getSnapshot(),
      onPromptEnded: hostPromptEnded,
      openAgentConnection: async () => {
        throw new Error('not needed')
      }
    })
    lifecycle.connectionClose.handleUnexpectedClose()
    await Promise.resolve()
    expect(committed).toHaveLength(1)
    expect(committed[0]).toMatchObject({
      kind: 'error',
      sessionId: 's1',
      promptMessageId: 'prompt',
      promptExecutionId: prompt.turnToken,
      interruptionCause: 'connection-lost',
      providerError: false,
      errorReportable: false
    })
    expect(observed[0]).toMatchObject({ publicationOwner: 'main' })
    expect(retryTerminalCommits).toHaveBeenCalledWith('s1')
    expect(onPromptEnded).toHaveBeenCalledExactlyOnceWith('s1', prompt.turnToken)
    expect(hostPromptEnded).toHaveBeenCalledExactlyOnceWith('s1', prompt.turnToken)
    expect(order).toEqual(['host:released', 'released', 'committed', 'retry'])
    lifecycle.connectionClose.handleUnexpectedClose()
    expect(onPromptEnded).toHaveBeenCalledOnce()
  })
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
