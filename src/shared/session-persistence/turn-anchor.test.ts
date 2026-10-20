import { describe, expect, it } from 'vitest'
import type { PersistedChatMessage } from './message'
import { INTERRUPTED_SESSION_ERROR, normalizeSessionAfterRestore } from './restore'
import type { PersistedChatSession } from './session'
import {
  isInLatestTurn,
  isInheritedForkTurn,
  isTurnAnchor,
  latestTurnAnchor,
  turnAnchorInterval
} from './turn-anchor'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../conversation-graph'
import { latestOutcomePrompt } from './turn-outcome'

const message = (
  id: string,
  role: PersistedChatMessage['role'],
  overrides: Partial<PersistedChatMessage> = {}
): PersistedChatMessage => ({
  id,
  role,
  content: id,
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const prompt = message('prompt-1', 'user')
const steering = message('steering-1', 'user', { responseToMessageId: 'prompt-1' })
const relay = message('relay-1', 'user', {
  relayedFrom: { kind: 'side-chat', direction: 'to-main' }
})
const control = message('control-1', 'user', { turnIntent: 'save-as-skill' })

describe('turn anchor', () => {
  it('excludes in-turn replies and advisory relays but keeps hidden controls as anchors', () => {
    expect(isTurnAnchor(prompt)).toBe(true)
    expect(isTurnAnchor(steering)).toBe(false)
    expect(isTurnAnchor(relay)).toBe(false)
    expect(isTurnAnchor(message('agent-1', 'agent'))).toBe(false)
    // Hidden controls own their turn; callers hide them only after assigning the latest turn.
    expect(isTurnAnchor(control)).toBe(true)
    expect(latestTurnAnchor([prompt, steering, relay])?.id).toBe('prompt-1')
    expect(latestTurnAnchor([prompt, control])?.id).toBe('control-1')
  })

  it('keeps replies inside the owning interval but ends it at any other user message', () => {
    const untagged = message('agent-1', 'agent')
    const later = message('agent-2', 'agent')
    expect(
      turnAnchorInterval([prompt, untagged, steering, later], 'prompt-1').map(({ id }) => id)
    ).toEqual(['agent-1', 'steering-1', 'agent-2'])
    expect(turnAnchorInterval([prompt, untagged, relay, later], 'prompt-1')).toEqual([untagged])
    expect(
      turnAnchorInterval([prompt, untagged, message('prompt-2', 'user'), later], 'prompt-1')
    ).toEqual([untagged])
    expect(turnAnchorInterval([prompt, untagged], 'missing')).toEqual([])
  })

  it('treats the latest anchor and its routed replies as the latest turn', () => {
    const next = message('prompt-2', 'user')
    const nextReply = message('steering-2', 'user', { responseToMessageId: 'prompt-2' })
    const messages = [prompt, steering, relay, next, nextReply]
    expect(isInLatestTurn(messages, 'prompt-2')).toBe(true)
    expect(isInLatestTurn(messages, 'steering-2')).toBe(true)
    expect(isInLatestTurn(messages, 'prompt-1')).toBe(false)
    expect(isInLatestTurn(messages, 'steering-1')).toBe(false)
    expect(isInLatestTurn([prompt, steering, relay], 'steering-1')).toBe(true)
    expect(isInLatestTurn([], 'prompt-1')).toBe(false)
  })
})

describe('inherited fork turn', () => {
  const answer = message('agent-1', 'agent', { responseToMessageId: 'prompt-1' })
  const next = message('prompt-2', 'user')
  const flat = (
    forkHeadMessageId: string | undefined,
    messages: PersistedChatMessage[]
  ): Pick<PersistedChatSession, 'forkHeadMessageId' | 'messages' | 'conversationGraph'> => ({
    forkHeadMessageId,
    messages
  })

  it('is false for a Session that is not a fork', () => {
    expect(isInheritedForkTurn(flat(undefined, [prompt, answer]), 'prompt-1')).toBe(false)
  })

  it('treats prompts at or before the fork head as inherited and later prompts as new', () => {
    const session = flat('agent-1', [prompt, answer, next])
    expect(isInheritedForkTurn(session, 'prompt-1')).toBe(true)
    expect(isInheritedForkTurn(session, 'prompt-2')).toBe(false)
    expect(isInheritedForkTurn(session, 'missing')).toBe(false)
  })

  it('keeps a hidden control head and the prompt before it inherited', () => {
    const session = flat('control-1', [prompt, answer, control, next])
    expect(isInheritedForkTurn(session, 'prompt-1')).toBe(true)
    expect(isInheritedForkTurn(session, 'control-1')).toBe(true)
    expect(isInheritedForkTurn(session, 'prompt-2')).toBe(false)
  })

  it('does not treat a prompt as inherited when the head is not on the active path', () => {
    expect(isInheritedForkTurn(flat('gone', [prompt, answer]), 'prompt-1')).toBe(false)
  })

  it('follows the Conversation Graph ancestry when an edit leaves the head off the active path', () => {
    const base = createLinearConversationGraph({
      sessionId: 'fork',
      createdAt: 1,
      updatedAt: 2,
      messages: [prompt, answer]
    })
    const edited = message('edited-1', 'user')
    const graph = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(base, 'prompt-1', 'edited-branch', 3),
      [edited],
      3
    )
    const session = { forkHeadMessageId: 'agent-1', messages: [edited], conversationGraph: graph }
    expect(isInheritedForkTurn(session, 'edited-1')).toBe(false)
    const original = { ...session, messages: [prompt, answer], conversationGraph: base }
    expect(isInheritedForkTurn(original, 'prompt-1')).toBe(true)
  })
})

const crashedSession = (overrides: Partial<PersistedChatSession>): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'running',
  activeRun: { promptMessageId: 'prompt-1', startedAt: 2 },
  messages: [
    prompt,
    message('agent-1', 'agent', { responseToMessageId: 'prompt-1', status: 'streaming' }),
    steering
  ],
  createdAt: 1,
  updatedAt: 5,
  ...overrides
})

describe('restore after an in-turn reply', () => {
  it('recovers a crashed continuing permission on the owning prompt, not on the reply', () => {
    const restored = normalizeSessionAfterRestore(
      crashedSession({
        runtimeContext: {
          version: 1,
          revision: 4,
          permission: {
            state: 'continuing',
            request: {
              requestId: 'permission-1',
              sessionId: 'session-1',
              toolCallId: 'tool-1',
              title: 'Run npm test',
              isMcp: true,
              options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
            },
            originatingPromptMessageId: 'prompt-1',
            fingerprint: 'a'.repeat(64),
            createdAt: 2
          }
        }
      })
    )

    expect(restored.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: 'prompt-1'
    })
    expect(latestOutcomePrompt(restored)?.id).toBe(restored.resumeRecovery?.promptMessageId)
    expect(restored.messages.find(({ id }) => id === 'prompt-1')?.interrupted).toBe(true)
    expect(restored.messages.find(({ id }) => id === 'steering-1')?.interrupted).toBeUndefined()
  })

  it('anchors the legacy interrupted fallback on the owning prompt', () => {
    const restored = normalizeSessionAfterRestore(
      crashedSession({
        status: 'error',
        activeRun: undefined,
        error: INTERRUPTED_SESSION_ERROR
      })
    )

    expect(restored.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: 'prompt-1'
    })
    expect(restored.messages.find(({ id }) => id === 'prompt-1')?.interrupted).toBe(true)
    expect(restored.messages.find(({ id }) => id === 'steering-1')?.interrupted).toBeUndefined()
  })
})
