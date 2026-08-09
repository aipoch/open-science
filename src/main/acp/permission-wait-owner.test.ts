import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession, SessionRuntimeContext } from '../../shared/session-persistence'
import type { DurablePermissionWaitCandidate } from './permission-broker'
import { AcpPermissionWaitOwner, type PermissionWaitSessions } from './permission-wait-owner'

const createCandidate = (): DurablePermissionWaitCandidate => ({
  request: {
    requestId: 'permission-1',
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    title: 'Run npm test',
    providerToolName: 'Bash',
    rawInput: { command: 'npm test' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ]
  },
  projectId: 'project-1',
  promptMessageId: 'prompt-1',
  fingerprint: 'a'.repeat(64),
  categoryKey: 'shell:npm-test',
  capability: { kind: 'execution', key: 'shell:npm-test' }
})

const createSessions = (
  containsMessage = true
): {
  sessions: PermissionWaitSessions
  context: () => SessionRuntimeContext
  patches: ReturnType<typeof vi.fn>
} => {
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  const session: PersistedChatSession = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Permission wait',
    cwd: '/workspace',
    status: 'idle',
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Run npm test',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 1
  }
  const patches = vi.fn(async (command) => {
    context = {
      ...context,
      ...command.patch,
      revision: context.revision + 1
    }
    session.runtimeContext = structuredClone(context)
    session.status = command.sessionStatus
    session.updatedAt += 1
    return structuredClone(context)
  })
  return {
    sessions: {
      readSessionRuntimeContext: vi.fn(async () => structuredClone(context)),
      patchSessionRuntimeContext: patches,
      containsMessageOnActiveBranch: vi.fn(async () => containsMessage),
      loadSessionForPermissionReplay: vi.fn(async () => structuredClone(session))
    },
    context: () => context,
    patches
  }
}

describe('ACP durable permission wait owner', () => {
  it('publishes the authoritative Session after permission authority is durable', async () => {
    const fixture = createSessions()
    const publishSessionUpdated = vi.fn()
    const owner = new AcpPermissionWaitOwner(fixture.sessions, publishSessionUpdated)

    await expect(owner.persist(createCandidate())).resolves.toBe(true)

    expect(publishSessionUpdated).toHaveBeenCalledOnce()
    expect(publishSessionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        status: 'waiting-permission',
        runtimeContext: expect.objectContaining({
          permission: expect.objectContaining({
            state: 'pending',
            request: expect.objectContaining({ requestId: 'permission-1' })
          })
        })
      })
    )

    await owner.clearLive(createCandidate())

    expect(publishSessionUpdated).toHaveBeenCalledTimes(2)
    expect(publishSessionUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'session-1',
        status: 'running',
        runtimeContext: expect.not.objectContaining({ permission: expect.anything() })
      })
    )
  })

  it('persists, revalidates, and clears one prompt-bound permission authority', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    const candidate = createCandidate()

    await expect(owner.persist(candidate)).resolves.toBe(true)
    expect(fixture.patches).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 0,
        sessionStatus: 'waiting-permission',
        patch: {
          permission: expect.objectContaining({
            state: 'pending',
            request: expect.objectContaining({ requestId: 'permission-1' }),
            originatingPromptMessageId: 'prompt-1',
            fingerprint: 'a'.repeat(64)
          })
        }
      })
    )

    await expect(
      owner.resolveRestored(
        {
          requestId: 'permission-1',
          optionId: 'allow-once',
          restored: { sessionId: 'session-1', projectId: 'project-1' }
        },
        'project-1',
        'session-1'
      )
    ).resolves.toMatchObject({
      denied: false,
      option: { optionId: 'allow-once' },
      permission: { originatingPromptMessageId: 'prompt-1' }
    })

    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    expect(fixture.context().permission).toMatchObject({ state: 'continuing' })
    await expect(
      owner.resolveRestored(
        {
          requestId: 'permission-1',
          optionId: 'allow-once',
          restored: { sessionId: 'session-1', projectId: 'project-1' }
        },
        'project-1',
        'session-1'
      )
    ).rejects.toThrow('stale or no longer pending')

    await owner.rearmContinuation('project-1', 'session-1', 'permission-1')
    expect(fixture.context().permission).toMatchObject({ state: 'pending' })

    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    await owner.clearAfterContinuation('project-1', 'session-1', 'permission-1')
    expect(fixture.context().permission).toBeUndefined()
    expect(fixture.patches).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionStatus: 'idle', patch: { permission: undefined } })
    )
  })

  it('does not persist authority for a prompt outside the active Message Branch', async () => {
    const fixture = createSessions(false)
    const owner = new AcpPermissionWaitOwner(fixture.sessions)

    await expect(owner.persist(createCandidate())).resolves.toBe(false)
    expect(fixture.patches).not.toHaveBeenCalled()
  })

  it('does not let a new durable wait replace an active continuation', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    const candidate = createCandidate()

    await owner.persist(candidate)
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')

    await expect(
      owner.persist({
        ...candidate,
        request: {
          ...candidate.request,
          requestId: 'permission-2',
          toolCallId: 'tool-2'
        }
      })
    ).rejects.toThrow('Another durable permission request already owns this Session.')
    expect(fixture.context().permission).toMatchObject({
      state: 'continuing',
      request: { requestId: 'permission-1' }
    })
  })

  it('cancels matching pending and continuing authority idempotently', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    const candidate = createCandidate()

    await owner.persist(candidate)
    await owner.cancelContinuation('project-1', 'session-1', 'permission-1')
    expect(fixture.context().permission).toBeUndefined()

    await owner.persist(candidate)
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    await owner.cancelContinuation('project-1', 'session-1', 'permission-1')
    await owner.cancelContinuation('project-1', 'session-1', 'permission-1')

    expect(fixture.context().permission).toBeUndefined()
    expect(fixture.patches).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionStatus: 'idle', patch: { permission: undefined } })
    )
  })

  it('rejects a restored locator that does not match the durable Session', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    await owner.persist(createCandidate())

    await expect(
      owner.resolveRestored(
        {
          requestId: 'permission-1',
          optionId: 'allow-once',
          restored: { sessionId: 'session-1', projectId: 'other-project' }
        },
        'project-1',
        'session-1'
      )
    ).rejects.toThrow('does not match the active Session')
  })
})
