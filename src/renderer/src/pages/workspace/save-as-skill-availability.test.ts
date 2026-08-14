import { describe, expect, it } from 'vitest'

import { materializeSessionConversationGraph } from '../../../../shared/session-persistence'
import type { ChatSession } from '@/stores/session-store'
import { isSaveAsSkillRunning, resolveSaveAsSkillAvailability } from './save-as-skill-availability'

const session = (): ChatSession =>
  materializeSessionConversationGraph({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Session',
    cwd: '/workspace',
    status: 'idle',
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Build a workflow.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'answer-1',
        role: 'agent',
        content: 'Done.',
        status: 'complete',
        eventIds: [],
        responseToMessageId: 'prompt-1',
        createdAt: 2,
        completedAt: 2,
        updatedAt: 2
      }
    ],
    createdAt: 1,
    updatedAt: 2
  }) as ChatSession

const availability = (
  overrides: Partial<Parameters<typeof resolveSaveAsSkillAvailability>[0]>
): ReturnType<typeof resolveSaveAsSkillAvailability> =>
  resolveSaveAsSkillAvailability({
    session: session(),
    persistenceReady: true,
    runtimeInteraction: false,
    pending: false,
    running: false,
    customizeAvailable: true,
    hasRunningSubagents: false,
    sideChatOpen: false,
    ...overrides
  })

describe('Save as skill availability', () => {
  it('enables only a completed idle conversation', () => {
    expect(availability({})).toEqual({ enabled: true, disabledReason: undefined })
    expect(availability({ session: { ...session(), status: 'running' } })).toMatchObject({
      enabled: false
    })
  })

  it('uses the active Branch tail instead of the flat compatibility projection', () => {
    const withOffBranchFlatTail = session()
    withOffBranchFlatTail.messages.push({
      id: 'off-branch-flat-tail',
      role: 'user',
      content: 'Not active.',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    })

    expect(availability({ session: withOffBranchFlatTail })).toEqual({
      enabled: true,
      disabledReason: undefined
    })
  })

  it('fails closed for an invalid active Branch graph', () => {
    const invalid = session()
    invalid.conversationGraph = {
      ...invalid.conversationGraph!,
      branches: []
    }

    expect(availability({ session: invalid }).disabledReason).toContain(
      'Conversation branch history'
    )
  })

  it('explains Customize and subagent capability gates', () => {
    expect(availability({ customizeAvailable: false }).disabledReason).toContain('Customize')
    expect(availability({ hasRunningSubagents: true }).disabledReason).toContain('subagents')
  })

  it('requires Side chat to be closed', () => {
    expect(availability({ sideChatOpen: true }).disabledReason).toContain('Close Side chat')
  })

  it('waits for pending Branch and Specialist replay state', () => {
    expect(
      availability({ session: { ...session(), branchContextResetRequired: true } }).disabledReason
    ).toContain('Session operation')
    expect(
      availability({ session: { ...session(), specialistSwitchResetRequired: true } })
        .disabledReason
    ).toContain('Session operation')
  })

  it('describes a cancelled turn as interrupted instead of still running', () => {
    expect(
      availability({
        session: {
          ...session(),
          status: 'error',
          resumeRecovery: {
            kind: 'resume-required',
            cause: 'cancelled',
            promptMessageId: 'prompt-1'
          }
        }
      }).disabledReason
    ).toContain('Session operation')
  })

  it('recognizes the active hidden control turn as Save as skill running', () => {
    const running = session()
    running.messages.push({
      id: 'save-as-skill-control',
      role: 'user',
      content: 'Save as skill',
      status: 'complete',
      eventIds: [],
      turnIntent: 'save-as-skill',
      createdAt: 3,
      updatedAt: 3
    })
    running.activeRun = { promptMessageId: 'save-as-skill-control', startedAt: 3 }

    expect(isSaveAsSkillRunning(running)).toBe(true)
    expect(availability({ session: running, running: true }).disabledReason).toBe(
      'Save as skill is running.'
    )
  })
})
