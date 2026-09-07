import * as acp from '@agentclientprotocol/sdk'
import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../shared/acp'
import { AcpSessionDeletionWorkflow } from './session-deletion-workflow'
import { AcpSessionRegistry, type AcpSessionRegistryEntry } from './session-registry'

const publishSession = (
  registry: AcpSessionRegistry,
  appSessionId: string,
  providerSessionId: string,
  dispose: () => void = vi.fn()
): ActiveSession => {
  const session = { sessionId: providerSessionId, dispose } as unknown as ActiveSession
  const reserved = registry.reserve({ sessionIds: [appSessionId, providerSessionId] })
  if (reserved.collision) throw reserved.collision
  registry.publish(reserved.reservation, appSessionId, {
    session,
    cwd: '/workspace',
    projectId: 'project',
    frameworkId: 'claude-code',
    permissionProfile: {
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      availableModeIds: ['default'],
      fullAccessAvailable: false
    }
  })
  reserved.reservation.release()
  return session
}

const snapshot = (registry: AcpSessionRegistry): AcpStateSnapshot =>
  ({
    sessionId: registry.currentSessionId,
    sessionIds: registry.entries(true).map(({ appSessionId }) => appSessionId)
  }) as AcpStateSnapshot

const dependencies = (
  registry: AcpSessionRegistry,
  connection: ClientConnection | undefined,
  capabilities: Readonly<{ delete: boolean; close: boolean }>
): ConstructorParameters<typeof AcpSessionDeletionWorkflow>[0] => ({
  registry,
  withOperation: (work) => work(),
  currentConnection: () => connection,
  supportsSessionDelete: () => capabilities.delete,
  supportsSessionClose: () => capabilities.close,
  permission: { cancelForSession: vi.fn(), clearSession: vi.fn() },
  elicitation: { cancelForSession: vi.fn() },
  clearUserChoiceProvenanceForSession: vi.fn(),
  appContinuations: { delete: vi.fn() },
  interactions: { supersedeCurrent: vi.fn() },
  capabilities: { revokeSession: vi.fn() },
  promptContent: { resetSession: vi.fn() },
  releasePromptResourcesForSession: vi.fn(),
  handoff: { clearSession: vi.fn() },
  contextUsage: { deleteSession: vi.fn() },
  projector: { clearSession: vi.fn() },
  pushEvent: vi.fn(),
  emitState: vi.fn(),
  getSnapshot: () => snapshot(registry)
})

describe('AcpSessionDeletionWorkflow', () => {
  it('deletes an attached provider Session and cleans each app-owned Session interface in order', async () => {
    const actions: string[] = []
    const registry = new AcpSessionRegistry()
    publishSession(registry, 'app-a', 'provider-a')
    const dispose = vi.fn(() => actions.push('dispose'))
    publishSession(registry, 'app-b', 'provider-b', dispose)
    const request = vi.fn(async () => {
      actions.push('provider-request')
      return {}
    })
    const notify = vi.fn(async () => undefined)
    const connection = { agent: { request, notify } } as unknown as ClientConnection
    const pushEvent = vi.fn(() => actions.push('event'))
    const emitState = vi.fn(() => actions.push('emit'))
    const workflow = new AcpSessionDeletionWorkflow({
      registry,
      withOperation: async (work) => {
        actions.push('operation')
        return work()
      },
      currentConnection: () => connection,
      supportsSessionDelete: () => true,
      supportsSessionClose: () => true,
      permission: {
        cancelForSession: vi.fn(() => actions.push('permission-cancel')),
        clearSession: vi.fn(() => actions.push('permission-clear'))
      },
      elicitation: { cancelForSession: vi.fn(() => actions.push('elicitation-cancel')) },
      clearUserChoiceProvenanceForSession: vi.fn(() =>
        actions.push('user-choice-provenance-clear')
      ),
      appContinuations: {
        delete: vi.fn(() => {
          actions.push('continuation-delete')
          return true
        })
      },
      interactions: { supersedeCurrent: vi.fn(() => actions.push('interaction')) },
      capabilities: { revokeSession: vi.fn(() => actions.push('capability')) },
      promptContent: { resetSession: vi.fn(() => actions.push('prompt-content')) },
      releasePromptResourcesForSession: vi.fn(() => actions.push('prompt-resources')),
      handoff: { clearSession: vi.fn(() => actions.push('handoff')) },
      contextUsage: { deleteSession: vi.fn(() => actions.push('context')) },
      projector: { clearSession: vi.fn(() => actions.push('projector')) },
      pushEvent,
      emitState,
      getSnapshot: () => {
        actions.push('snapshot')
        return snapshot(registry)
      }
    })

    await expect(workflow.delete('app-b')).resolves.toMatchObject({
      sessionId: 'app-a',
      sessionIds: ['app-a']
    })

    expect(request).toHaveBeenCalledWith(
      acp.methods.agent.session.delete,
      { sessionId: 'provider-b' },
      { cancellationSignal: expect.objectContaining({ aborted: false }) }
    )
    expect(notify).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    expect(registry.lookup('app-b')).toBeUndefined()
    expect(pushEvent).toHaveBeenCalledWith({
      kind: 'system',
      level: 'info',
      sessionId: 'app-b',
      title: 'Session deleted'
    })
    expect(emitState).toHaveBeenCalledOnce()
    expect(actions).toEqual([
      'operation',
      'permission-cancel',
      'user-choice-provenance-clear',
      'elicitation-cancel',
      'continuation-delete',
      'provider-request',
      'dispose',
      'permission-clear',
      'interaction',
      'capability',
      'prompt-content',
      'prompt-resources',
      'handoff',
      'context',
      'projector',
      'event',
      'emit',
      'snapshot'
    ])
  })

  it('uses provider close when delete is not advertised', async () => {
    const registry = new AcpSessionRegistry()
    publishSession(registry, 'app-session', 'provider-session')
    const request = vi.fn(async () => ({}))
    const notify = vi.fn(async () => undefined)
    const connection = { agent: { request, notify } } as unknown as ClientConnection
    const workflow = new AcpSessionDeletionWorkflow(
      dependencies(registry, connection, { delete: false, close: true })
    )

    await workflow.delete('app-session')

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(
      acp.methods.agent.session.close,
      { sessionId: 'provider-session' },
      { cancellationSignal: expect.objectContaining({ aborted: false }) }
    )
    expect(notify).not.toHaveBeenCalled()
  })

  it('uses provider cancel when neither delete nor close is advertised', async () => {
    const registry = new AcpSessionRegistry()
    publishSession(registry, 'app-session', 'provider-session')
    const request = vi.fn(async () => ({}))
    const notify = vi.fn(async () => undefined)
    const connection = { agent: { request, notify } } as unknown as ClientConnection
    const workflow = new AcpSessionDeletionWorkflow(
      dependencies(registry, connection, { delete: false, close: false })
    )

    await workflow.delete('app-session')

    expect(request).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith(acp.methods.agent.session.cancel, {
      sessionId: 'provider-session'
    })
  })

  it('removes detached affinity and local state without publishing an active deletion', async () => {
    const registry = new AcpSessionRegistry()
    publishSession(registry, 'app-session', 'provider-session')
    const attachment = registry.lookup('app-session')?.attachment
    if (!attachment) throw new Error('expected an attached Session')
    registry.detach(attachment, 'connection')
    const deps = dependencies(registry, undefined, { delete: true, close: true })
    const workflow = new AcpSessionDeletionWorkflow(deps)

    await expect(workflow.delete('app-session')).resolves.toMatchObject({
      sessionIds: []
    })

    expect(registry.lookup('app-session')).toBeUndefined()
    expect(deps.permission.cancelForSession).toHaveBeenCalledWith('app-session')
    expect(deps.permission.clearSession).toHaveBeenCalledWith('app-session')
    expect(deps.interactions.supersedeCurrent).toHaveBeenCalledWith('app-session')
    expect(deps.capabilities.revokeSession).toHaveBeenCalledWith('app-session')
    expect(deps.promptContent.resetSession).toHaveBeenCalledWith('app-session')
    expect(deps.releasePromptResourcesForSession).toHaveBeenCalledWith('app-session')
    expect(deps.handoff.clearSession).toHaveBeenCalledWith('app-session')
    expect(deps.contextUsage.deleteSession).toHaveBeenCalledWith('app-session')
    expect(deps.projector.clearSession).toHaveBeenCalledWith('app-session')
    expect(deps.pushEvent).not.toHaveBeenCalled()
    expect(deps.emitState).not.toHaveBeenCalled()
  })

  it('preserves a provider deletion failure without falling through or clearing local ownership', async () => {
    const registry = new AcpSessionRegistry()
    const dispose = vi.fn()
    publishSession(registry, 'app-session', 'provider-session', dispose)
    const providerFailure = new Error('provider delete failed')
    const request = vi.fn(async () => {
      throw providerFailure
    })
    const notify = vi.fn(async () => undefined)
    const connection = { agent: { request, notify } } as unknown as ClientConnection
    const deps = dependencies(registry, connection, { delete: true, close: true })
    const workflow = new AcpSessionDeletionWorkflow(deps)

    await expect(workflow.delete('app-session')).rejects.toBe(providerFailure)

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(
      acp.methods.agent.session.delete,
      { sessionId: 'provider-session' },
      { cancellationSignal: expect.objectContaining({ aborted: false }) }
    )
    expect(notify).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    expect(registry.lookup('app-session')?.attachment?.providerSessionId).toBe('provider-session')
    expect(deps.permission.cancelForSession).toHaveBeenCalledWith('app-session')
    expect(deps.permission.clearSession).not.toHaveBeenCalled()
    expect(deps.capabilities.revokeSession).not.toHaveBeenCalled()
    expect(deps.interactions.supersedeCurrent).not.toHaveBeenCalled()
    expect(deps.promptContent.resetSession).not.toHaveBeenCalled()
    expect(deps.releasePromptResourcesForSession).not.toHaveBeenCalled()
    expect(deps.handoff.clearSession).not.toHaveBeenCalled()
    expect(deps.contextUsage.deleteSession).not.toHaveBeenCalled()
    expect(deps.projector.clearSession).not.toHaveBeenCalled()
    expect(deps.pushEvent).not.toHaveBeenCalled()

    const retry = registry.reserve({
      sessionIds: ['app-session'],
      publishedAppSessionId: 'app-session'
    })
    expect(retry.collision).toBeUndefined()
    retry.reservation?.release()
  })

  it('times out only the provider request and retains every Session on a shared runtime', async () => {
    vi.useFakeTimers()
    try {
      const registry = new AcpSessionRegistry()
      const deletingDispose = vi.fn()
      const siblingDispose = vi.fn()
      publishSession(registry, 'app-deleting', 'provider-deleting', deletingDispose)
      publishSession(registry, 'app-sibling', 'provider-sibling', siblingDispose)
      const request = vi.fn(() => new Promise<never>(() => undefined))
      const connection = {
        agent: { request, notify: vi.fn(async () => undefined) }
      } as unknown as ClientConnection
      const workflow = new AcpSessionDeletionWorkflow(
        dependencies(registry, connection, { delete: true, close: true })
      )

      const deleting = workflow.delete('app-deleting')
      const deletionResult = deleting.then(
        () => 'deleted' as const,
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await Promise.race([deletionResult, Promise.resolve('still-pending' as const)])

      expect(result).toMatchObject({
        name: 'AcpProviderSessionDeletionTimeoutError',
        message: 'ACP provider Session deletion timed out.'
      })
      expect(request).toHaveBeenCalledWith(
        acp.methods.agent.session.delete,
        { sessionId: 'provider-deleting' },
        { cancellationSignal: expect.objectContaining({ aborted: true }) }
      )
      expect(registry.lookup('app-deleting')?.attachment?.providerSessionId).toBe(
        'provider-deleting'
      )
      expect(registry.lookup('app-sibling')?.attachment?.providerSessionId).toBe('provider-sibling')
      expect(deletingDispose).not.toHaveBeenCalled()
      expect(siblingDispose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the deletion epoch while the operation lease waits behind a barrier', async () => {
    const registry = new AcpSessionRegistry()
    publishSession(registry, 'app-session', 'provider-session')
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    const deps = dependencies(registry, undefined, { delete: false, close: false })
    const workflow = new AcpSessionDeletionWorkflow({
      ...deps,
      withOperation: async (work) => {
        await barrier
        return work()
      }
    })

    const deleting = workflow.delete('app-session')
    expect(registry.reserve({ sessionIds: ['app-session'] }).collision?.message).toBe(
      'Primary session id collision with deletion in progress: app-session'
    )

    releaseBarrier()
    await deleting

    const afterDelete = registry.reserve({ sessionIds: ['app-session'] })
    expect(afterDelete.collision).toBeUndefined()
    afterDelete.reservation?.release()
  })

  it('does not let stale deletion cleanup erase a same-ID replacement', async () => {
    const oldDispose = vi.fn()
    const oldSession = {
      sessionId: 'provider-old',
      dispose: oldDispose
    } as unknown as ActiveSession
    const replacementSession = {
      sessionId: 'provider-new',
      dispose: vi.fn()
    } as unknown as ActiveSession
    const entry = (generation: number, session: ActiveSession): AcpSessionRegistryEntry =>
      ({
        appSessionId: 'app-session',
        generation,
        aggregate: {},
        attachment: {
          appSessionId: 'app-session',
          providerSessionId: session.sessionId,
          generation,
          session
        }
      }) as unknown as AcpSessionRegistryEntry
    const original = entry(1, oldSession)
    const replacement = entry(2, replacementSession)
    let current = original
    const removal = { removed: false, wasActive: false, currentSessionId: 'app-session' }
    const finish = vi.fn(() => removal)
    const detach = vi.fn(() => false)
    const fakeRegistry = {
      beginDelete: vi.fn(() => ({ finish })),
      lookup: vi.fn(() => current),
      detach
    } as unknown as AcpSessionRegistry
    const request = vi.fn(async () => {
      current = replacement
      return {}
    })
    const connection = {
      agent: { request, notify: vi.fn(async () => undefined) }
    } as unknown as ClientConnection
    const deps = {
      ...dependencies(fakeRegistry, connection, { delete: true, close: true }),
      getSnapshot: () =>
        ({ sessionId: 'app-session', sessionIds: ['app-session'] }) as AcpStateSnapshot
    }
    const workflow = new AcpSessionDeletionWorkflow(deps)

    await expect(workflow.delete('app-session')).resolves.toMatchObject({
      sessionIds: ['app-session']
    })

    expect(oldDispose).toHaveBeenCalledOnce()
    expect(detach).toHaveBeenCalledWith(original.attachment, 'provider')
    expect(current).toBe(replacement)
    expect(finish).toHaveBeenCalledWith(original)
    expect(deps.permission.cancelForSession).toHaveBeenCalledWith('app-session')
    expect(deps.permission.clearSession).not.toHaveBeenCalled()
    expect(deps.interactions.supersedeCurrent).not.toHaveBeenCalled()
    expect(deps.capabilities.revokeSession).not.toHaveBeenCalled()
    expect(deps.promptContent.resetSession).not.toHaveBeenCalled()
    expect(deps.releasePromptResourcesForSession).not.toHaveBeenCalled()
    expect(deps.handoff.clearSession).not.toHaveBeenCalled()
    expect(deps.contextUsage.deleteSession).not.toHaveBeenCalled()
    expect(deps.projector.clearSession).not.toHaveBeenCalled()
    expect(deps.pushEvent).not.toHaveBeenCalled()
    expect(deps.emitState).not.toHaveBeenCalled()
  })

  it('does not announce success or clear local owners when provider Session disposal fails', async () => {
    const registry = new AcpSessionRegistry()
    const disposeFailure = new Error('provider Session disposal failed')
    publishSession(registry, 'app-session', 'provider-session', () => {
      throw disposeFailure
    })
    const request = vi.fn(async () => ({}))
    const connection = {
      agent: { request, notify: vi.fn(async () => undefined) }
    } as unknown as ClientConnection
    const deps = dependencies(registry, connection, { delete: true, close: true })
    const workflow = new AcpSessionDeletionWorkflow(deps)

    await expect(workflow.delete('app-session')).rejects.toBe(disposeFailure)

    expect(request).toHaveBeenCalledOnce()
    expect(registry.lookup('app-session')?.attachment?.providerSessionId).toBe('provider-session')
    expect(deps.permission.cancelForSession).toHaveBeenCalledWith('app-session')
    expect(deps.permission.clearSession).not.toHaveBeenCalled()
    expect(deps.capabilities.revokeSession).not.toHaveBeenCalled()
    expect(deps.interactions.supersedeCurrent).not.toHaveBeenCalled()
    expect(deps.promptContent.resetSession).not.toHaveBeenCalled()
    expect(deps.releasePromptResourcesForSession).not.toHaveBeenCalled()
    expect(deps.handoff.clearSession).not.toHaveBeenCalled()
    expect(deps.contextUsage.deleteSession).not.toHaveBeenCalled()
    expect(deps.projector.clearSession).not.toHaveBeenCalled()
    expect(deps.pushEvent).not.toHaveBeenCalled()
    expect(deps.emitState).not.toHaveBeenCalled()

    const retry = registry.reserve({
      sessionIds: ['app-session'],
      publishedAppSessionId: 'app-session'
    })
    expect(retry.collision).toBeUndefined()
    retry.reservation?.release()
  })
})
