import { describe, expect, it, vi } from 'vitest'
import { ResearchSubmissionDispatcher, type ResearchSubmissionDispatchPorts } from './dispatcher'
import type { ResearchSubmissionClaim } from '../../../../shared/research-submission'
const claimed: NonNullable<ResearchSubmissionClaim> = {
  submission: {
    id: 'intent',
    sequence: 1,
    projectId: 'project',
    sourceSessionId: 'source',
    discussionSessionId: 'discussion',
    messageId: 'research-intent',
    state: 'sending',
    claimToken: 'claim',
    createdAt: 1,
    payload: {
      text: 'Question',
      annotations: [],
      attachments: [],
      permissionProfile: 'ask',
      agentConfiguration: { providerId: 'codex', model: 'chosen-model', reasoningEffort: 'high' },
      forcedSkillIds: []
    }
  },
  session: {
    id: 'discussion',
    projectId: 'project',
    title: 'Discussion',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }
}
const ports = (): ResearchSubmissionDispatchPorts => ({
  writer: vi.fn(async () => ({ runtimeWriterToken: 'writer' })),
  claim: vi.fn().mockResolvedValueOnce(claimed).mockResolvedValue(null),
  finish: vi.fn(async () => ({ ...claimed.submission, state: 'accepted' as const })),
  hydrate: vi.fn(),
  send: vi.fn(async () => ({ sessionId: 'discussion', messageId: 'research-intent' }))
})
describe('research question renderer dispatcher', () => {
  it('dispatches only from the elected window and preserves normal captured configuration', async () => {
    const owner = ports(),
      other = ports()
    vi.mocked(other.writer).mockResolvedValue(undefined)
    await Promise.all([
      new ResearchSubmissionDispatcher(owner).tick(),
      new ResearchSubmissionDispatcher(other).tick()
    ])
    expect(other.claim).not.toHaveBeenCalled()
    expect(other.send).not.toHaveBeenCalled()
    expect(owner.hydrate).toHaveBeenCalledExactlyOnceWith(claimed.session)
    expect(owner.send).toHaveBeenCalledExactlyOnceWith({
      ...claimed.submission.payload,
      sessionId: 'discussion',
      projectId: 'project',
      messageId: 'research-intent',
      requireExistingSession: true,
      preserveSelection: true
    })
    expect(owner.finish).toHaveBeenCalledExactlyOnceWith({
      runtimeWriterToken: 'writer',
      id: 'intent',
      claimToken: 'claim',
      disposition: 'accepted'
    })
  })
  it('coalesces simultaneous ticks and does not call the model again after an uncertain acknowledgement', async () => {
    const current = ports()
    vi.mocked(current.finish).mockRejectedValue(new Error('Lost acknowledgement'))
    const dispatcher = new ResearchSubmissionDispatcher(current)
    const first = dispatcher.tick(),
      second = dispatcher.tick()
    expect(first).toBe(second)
    await expect(first).rejects.toThrow('Lost acknowledgement')
    await dispatcher.tick()
    expect(current.send).toHaveBeenCalledOnce()
  })
  it('reports failed admission for main-process verification instead of local retry', async () => {
    const current = ports()
    vi.mocked(current.send).mockResolvedValue(undefined)
    await new ResearchSubmissionDispatcher(current).tick()
    expect(current.finish).toHaveBeenCalledWith(expect.objectContaining({ disposition: 'failed' }))
    expect(current.send).toHaveBeenCalledOnce()
  })
})
