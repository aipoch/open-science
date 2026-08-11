import { describe, expect, it, vi } from 'vitest'

import {
  sanitizeSessionRuntimeContext,
  type SessionPlanRuntimeContext,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import {
  SessionPlanContinuationOwner,
  type SessionPlanContinuationSessions
} from './session-plan-continuation-owner'

const createPlan = (
  continuation: SessionPlanRuntimeContext['continuation'] = {
    commandId: 'continuation-1',
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
  continuation,
  stepStatuses: {}
})

const createSessions = (
  continuation?: SessionPlanRuntimeContext['continuation']
): {
  sessions: SessionPlanContinuationSessions
  context: () => SessionRuntimeContext
  patch: ReturnType<typeof vi.fn>
} => {
  let context: SessionRuntimeContext = {
    version: 1,
    revision: 0,
    plan: createPlan(continuation)
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

describe('Session Plan continuation owner', () => {
  it('claims one queued continuation before dispatch without changing Session status', async () => {
    const fixture = createSessions()
    const owner = new SessionPlanContinuationOwner(fixture.sessions)

    await expect(owner.begin('project-1', 'session-1', 'continuation-1')).resolves.toBe(true)

    expect(fixture.context().plan).toEqual(
      createPlan({
        commandId: 'continuation-1',
        kind: 'approved-plan',
        state: 'continuing',
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

  it('lets only one competing consumer claim the queued continuation', async () => {
    const fixture = createSessions()
    const first = new SessionPlanContinuationOwner(fixture.sessions)
    const second = new SessionPlanContinuationOwner(fixture.sessions)

    await expect(
      Promise.all([
        first.begin('project-1', 'session-1', 'continuation-1'),
        second.begin('project-1', 'session-1', 'continuation-1')
      ])
    ).resolves.toEqual([true, false])

    expect(fixture.context().plan?.continuation?.state).toBe('continuing')
  })

  it('rearms a claimed continuation only when dispatch is known not to have started', async () => {
    const fixture = createSessions({
      commandId: 'continuation-1',
      kind: 'approved-plan',
      state: 'continuing',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })
    const owner = new SessionPlanContinuationOwner(fixture.sessions)

    await expect(owner.rearmUndispatched('project-1', 'session-1', 'continuation-1')).resolves.toBe(
      true
    )

    expect(fixture.context().plan?.continuation).toMatchObject({
      commandId: 'continuation-1',
      state: 'queued'
    })
    expect(fixture.patch.mock.calls[0]?.[0]).not.toHaveProperty('sessionStatus')
  })

  it('clears the claimed command after successful continuation without removing the Plan', async () => {
    const fixture = createSessions({
      commandId: 'continuation-1',
      kind: 'approved-plan',
      state: 'continuing',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })
    const owner = new SessionPlanContinuationOwner(fixture.sessions)

    await expect(owner.clear('project-1', 'session-1', 'continuation-1')).resolves.toBe(true)

    expect(fixture.context().plan).not.toHaveProperty('continuation')
    expect(fixture.patch.mock.calls[0]?.[0].patch.plan).not.toHaveProperty('continuation')
    expect(fixture.patch.mock.calls[0]?.[0]).not.toHaveProperty('sessionStatus')
  })

  it('marks a claimed command interrupted after its dispatched prompt is explicitly cancelled', async () => {
    const fixture = createSessions({
      commandId: 'continuation-1',
      kind: 'approved-plan',
      state: 'continuing',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })
    const owner = new SessionPlanContinuationOwner(fixture.sessions)

    await expect(owner.interrupt('project-1', 'session-1', 'continuation-1')).resolves.toBe(true)

    expect(fixture.context().plan?.continuation).toMatchObject({
      commandId: 'continuation-1',
      state: 'interrupted'
    })
    expect(fixture.patch.mock.calls[0]?.[0]).not.toHaveProperty('sessionStatus')
  })

  it('does not replay a continuing command when a new owner starts', async () => {
    const fixture = createSessions({
      commandId: 'continuation-1',
      kind: 'approved-plan',
      state: 'continuing',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })

    const restartedOwner = new SessionPlanContinuationOwner(fixture.sessions)

    await expect(restartedOwner.begin('project-1', 'session-1', 'continuation-1')).resolves.toBe(
      false
    )
    expect(fixture.patch).not.toHaveBeenCalled()
    expect(fixture.context().plan?.continuation?.state).toBe('continuing')
  })

  it('does not replay an interrupted command when a new owner starts', async () => {
    const fixture = createSessions({
      commandId: 'continuation-1',
      kind: 'approved-plan',
      state: 'interrupted',
      originatingPromptMessageId: 'prompt-1',
      createdAt: 42
    })

    const restartedOwner = new SessionPlanContinuationOwner(fixture.sessions)

    await expect(restartedOwner.begin('project-1', 'session-1', 'continuation-1')).resolves.toBe(
      false
    )
    expect(fixture.patch).not.toHaveBeenCalled()
  })
})
