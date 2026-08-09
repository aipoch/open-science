import { describe, expect, it, vi } from 'vitest'

import type { SessionRuntimeContext } from '../../shared/session-persistence'
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
  const patches = vi.fn(async (command) => {
    context = {
      ...context,
      ...command.patch,
      revision: context.revision + 1
    }
    return structuredClone(context)
  })
  return {
    sessions: {
      readSessionRuntimeContext: vi.fn(async () => structuredClone(context)),
      patchSessionRuntimeContext: patches,
      containsMessageOnActiveBranch: vi.fn(async () => containsMessage)
    },
    context: () => context,
    patches
  }
}

describe('ACP durable permission wait owner', () => {
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
