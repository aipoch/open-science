import { describe, expect, it } from 'vitest'

import { AcpHandoffContinuityOwner } from './handoff-continuity-owner'

const switchReadBack = {
  status: 'approved' as const,
  operation: 'switch' as const,
  binding: {
    sessionId: 'session-1',
    specialistId: 'specialist-1',
    targetName: 'Target Specialist',
    revision: 4
  }
}

describe('AcpHandoffContinuityOwner', () => {
  it('constructs an app-owned continuation from the latest admitted prompt context', () => {
    const owner = new AcpHandoffContinuityOwner()
    const attachments = [
      {
        id: 'upload-1',
        sessionId: 'session-1',
        name: 'dataset.csv',
        originalName: 'dataset.csv',
        path: '/workspace/dataset.csv',
        size: 42
      }
    ]
    owner.recordAdmittedPrompt({
      sessionId: 'session-1',
      text: 'Analyse the dataset',
      memoryEnabled: false,
      provenanceContext: {
        promptMessageId: 'message-1',
        messageAncestry: ['message-root']
      },
      attachments,
      forcedSkillIds: ['source-only-skill']
    })

    const continuation = owner.createClaudeContinuation({
      sessionId: 'session-1',
      switchReadBack
    })

    expect(continuation).toEqual({
      sessionId: 'session-1',
      text: 'Continue the existing task from the approved handoff as Target Specialist.',
      memoryEnabled: false,
      suppressUserMessage: true,
      provenanceContext: {
        promptMessageId: 'message-1',
        messageAncestry: ['message-root']
      },
      attachments
    })
    expect(continuation).not.toHaveProperty('forcedSkillIds')
    expect(continuation.attachments).not.toBe(attachments)
    expect(continuation.provenanceContext?.messageAncestry).not.toBe(
      owner.createClaudeContinuation({ sessionId: 'session-1', switchReadBack }).provenanceContext
        ?.messageAncestry
    )
  })

  it('retains a deduplicated Claude replay stage until successful adoption commits it', () => {
    const owner = new AcpHandoffContinuityOwner()
    owner.recordAdmittedPrompt({
      sessionId: 'session-1',
      text: '  Load the live experiment  ',
      provenanceContext: { promptMessageId: 'live-message' }
    })
    owner.recordAdmittedPrompt({
      sessionId: 'session-1',
      text: 'Analyse the experiment',
      provenanceContext: { promptMessageId: 'analysis-message' }
    })

    owner.stageClaudeReplay({
      sessionId: 'session-1',
      capturedCompletion: { kind: 'returned', value: { afterAwait: 'complete' } },
      supportedTaskContext: [
        { messageId: 'persisted-message', text: 'Open the saved project' },
        { messageId: 'live-message', text: 'stale persisted copy' }
      ],
      switchReadBack
    })

    const staged = owner.peekClaudeReplay('session-1')
    expect(staged).toContain(
      '1. Open the saved project\n2. Load the live experiment\n3. Analyse the experiment'
    )
    expect(staged).not.toContain('stale persisted copy')
    expect(staged).toContain('"afterAwait":"complete"')
    expect(staged).toContain('"revision":4')

    expect(owner.peekClaudeReplay('session-1')).toBe(staged)
    owner.commitClaudeReplay('session-1')
    expect(owner.peekClaudeReplay('session-1')).toBeUndefined()
    owner.commitClaudeReplay('session-1')
  })

  it('bounds retained task and serialized completion context', () => {
    const owner = new AcpHandoffContinuityOwner()
    owner.recordAdmittedPrompt({
      sessionId: 'session-1',
      text: `discarded-prefix${'t'.repeat(12_000)}`,
      provenanceContext: { promptMessageId: 'large-task' }
    })
    owner.stageClaudeReplay({
      sessionId: 'session-1',
      capturedCompletion: { kind: 'returned', value: 'c'.repeat(9_000) },
      switchReadBack
    })

    const staged = owner.peekClaudeReplay('session-1') ?? ''
    const taskContext = staged.match(
      /Prior user task requests \(oldest first\):\n1\. ([\s\S]+)\n\nCaptured control completion:/
    )?.[1]
    const completion = staged.match(
      /Captured control completion: ([\s\S]+)\n\nApproved switch read-back:/
    )?.[1]

    expect(taskContext).toBe('t'.repeat(12_000))
    expect(completion).toHaveLength(8_000)
  })

  it('discards only replay staging and clears continuity by Session or generation', () => {
    const owner = new AcpHandoffContinuityOwner()
    for (const sessionId of ['session-1', 'session-2']) {
      owner.recordAdmittedPrompt({ sessionId, text: `Task for ${sessionId}` })
      owner.stageClaudeReplay({
        sessionId,
        capturedCompletion: { kind: 'returned', value: 'done' },
        switchReadBack: {
          ...switchReadBack,
          binding: { ...switchReadBack.binding, sessionId }
        }
      })
    }

    owner.discardClaudeReplay('session-1')
    expect(owner.peekClaudeReplay('session-1')).toBeUndefined()
    expect(
      owner.createClaudeContinuation({ sessionId: 'session-1', switchReadBack })
    ).toMatchObject({ sessionId: 'session-1', suppressUserMessage: true })

    owner.clearSession('session-1')
    expect(() =>
      owner.createClaudeContinuation({ sessionId: 'session-1', switchReadBack })
    ).toThrow('No user task is available')

    owner.clearGeneration()
    expect(owner.peekClaudeReplay('session-2')).toBeUndefined()
    expect(() =>
      owner.createClaudeContinuation({
        sessionId: 'session-2',
        switchReadBack: {
          ...switchReadBack,
          binding: { ...switchReadBack.binding, sessionId: 'session-2' }
        }
      })
    ).toThrow('No user task is available')
  })
})
