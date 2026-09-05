import { describe, expect, it, vi } from 'vitest'

import {
  sanitizeSessionRuntimeContext,
  type SessionPlanRuntimeContext,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import {
  SessionPlanDeliveryOwner,
  type SessionPlanDeliverySessions
} from './session-plan-delivery-owner'

const createPlan = (
  delivery: SessionPlanRuntimeContext['delivery'] = {
    commandId: 'delivery-1',
    kind: 'approved-plan',
    state: 'queued',
    originatingPromptMessageId: 'prompt-1',
    createdAt: 42
  }
): SessionPlanRuntimeContext => ({
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'checksum-1',
  originatingPromptMessageId: 'prompt-1',
  approval: 'approved',
  delivery,
  stepStatuses: {}
})

const createSessions = (
  delivery?: SessionPlanRuntimeContext['delivery']
): {
  sessions: SessionPlanDeliverySessions
  context: () => SessionRuntimeContext
  patch: ReturnType<typeof vi.fn>
} => {
  let context: SessionRuntimeContext = {
    version: 1,
    revision: 0,
    plan: createPlan(delivery)
  }
  const patch = vi.fn(async (command) => {
    if (command.expectedRevision !== context.revision) {
      throw Object.assign(new Error('revision conflict'), { code: 'revision-conflict' })
    }
    const next = sanitizeSessionRuntimeContext({
      ...context,
      ...command.patch,
      revision: context.revision + 1
    })
    if (!next) throw new Error('Session runtime context patch is not JSON-safe.')
    context = next
    return structuredClone(context)
  })
  return {
    sessions: {
      readSessionRuntimeContext: vi.fn(async () => structuredClone(context)),
      patchSessionRuntimeContext: patch
    },
    context: () => context,
    patch
  }
}

describe('Session Plan delivery owner', () => {
  it('claims one queued delivery before dispatch without changing Session status', async () => {
    const fixture = createSessions()
    const owner = new SessionPlanDeliveryOwner(fixture.sessions)

    await expect(owner.begin('project-1', 'session-1', 'delivery-1')).resolves.toBe(true)

    expect(fixture.context().plan).toEqual(
      createPlan({
        commandId: 'delivery-1',
        kind: 'approved-plan',
        state: 'delivering',
        originatingPromptMessageId: 'prompt-1',
        createdAt: 42
      })
    )
    expect(fixture.patch).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 0,
      patch: { plan: fixture.context().plan }
    })
  })

  it('lets only one competing consumer claim the queued delivery', async () => {
    const fixture = createSessions()
    const first = new SessionPlanDeliveryOwner(fixture.sessions)
    const second = new SessionPlanDeliveryOwner(fixture.sessions)

    await expect(
      Promise.all([
        first.begin('project-1', 'session-1', 'delivery-1'),
        second.begin('project-1', 'session-1', 'delivery-1')
      ])
    ).resolves.toEqual([true, false])

    expect(fixture.context().plan?.delivery?.state).toBe('delivering')
  })

  it('rearms a claimed delivery before provider acceptance is durably observed', async () => {
    const fixture = createSessions({
      commandId: 'delivery-1',
      kind: 'approved-plan',
      state: 'delivering',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })
    const owner = new SessionPlanDeliveryOwner(fixture.sessions)

    await expect(owner.rearmUnaccepted('project-1', 'session-1', 'delivery-1')).resolves.toBe(true)

    expect(fixture.context().plan?.delivery).toMatchObject({
      commandId: 'delivery-1',
      state: 'queued'
    })
    expect(fixture.patch.mock.calls[0]?.[0]).not.toHaveProperty('sessionStatus')
  })

  it('clears the claimed command after successful delivery without removing the Plan', async () => {
    const fixture = createSessions({
      commandId: 'delivery-1',
      kind: 'approved-plan',
      state: 'accepted',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })
    const owner = new SessionPlanDeliveryOwner(fixture.sessions)

    await expect(owner.clear('project-1', 'session-1', 'delivery-1')).resolves.toBe(true)

    expect(fixture.context().plan).not.toHaveProperty('delivery')
    expect(fixture.patch.mock.calls[0]?.[0].patch.plan).not.toHaveProperty('delivery')
    expect(fixture.patch.mock.calls[0]?.[0]).not.toHaveProperty('sessionStatus')
  })

  it('records provider acceptance before clearing a delivery receipt', async () => {
    const fixture = createSessions({
      commandId: 'delivery-1',
      kind: 'approved-plan',
      state: 'delivering',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })
    const owner = new SessionPlanDeliveryOwner(fixture.sessions)

    await expect(owner.accept('project-1', 'session-1', 'delivery-1')).resolves.toBe(true)

    expect(fixture.context().plan?.delivery).toMatchObject({
      commandId: 'delivery-1',
      state: 'accepted'
    })
  })

  it('marks a claimed command interrupted after its dispatched prompt is explicitly cancelled', async () => {
    const fixture = createSessions({
      commandId: 'delivery-1',
      kind: 'approved-plan',
      state: 'delivering',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })
    const owner = new SessionPlanDeliveryOwner(fixture.sessions)

    await expect(owner.interrupt('project-1', 'session-1', 'delivery-1')).resolves.toBe(true)

    expect(fixture.context().plan?.delivery).toMatchObject({
      commandId: 'delivery-1',
      state: 'interrupted'
    })
    expect(fixture.patch.mock.calls[0]?.[0]).not.toHaveProperty('sessionStatus')
  })

  it('does not guess whether a delivering command crossed the provider boundary after restart', async () => {
    const fixture = createSessions({
      commandId: 'delivery-1',
      kind: 'approved-plan',
      state: 'delivering',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })

    const restartedOwner = new SessionPlanDeliveryOwner(fixture.sessions)

    await expect(restartedOwner.begin('project-1', 'session-1', 'delivery-1')).resolves.toBe(false)
    expect(fixture.patch).not.toHaveBeenCalled()
    expect(fixture.context().plan?.delivery?.state).toBe('delivering')
  })

  it('does not replay an interrupted command when a new owner starts', async () => {
    const fixture = createSessions({
      commandId: 'delivery-1',
      kind: 'approved-plan',
      state: 'interrupted',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })

    const restartedOwner = new SessionPlanDeliveryOwner(fixture.sessions)

    await expect(restartedOwner.begin('project-1', 'session-1', 'delivery-1')).resolves.toBe(false)
    expect(fixture.patch).not.toHaveBeenCalled()
  })
})
