import { expect, it } from 'vitest'
import { SESSION_DETAILS_TITLE_MAX_LENGTH } from '../../shared/session-persistence'
import { createForkSession, nextForkTitle } from './fork-session'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createLinearConversationGraph } from '../../shared/conversation-graph'

it.each([
  ['Study', [], 'Study(2)'],
  ['Study', ['Study(2)', 'Study(3)'], 'Study(4)'],
  ['Study(2)', [], 'Study(2)(2)'],
  ['文'.repeat(80), [], `${'文'.repeat(77)}(2)`],
  ['x'.repeat(1000), [], `${'x'.repeat(77)}(2)`],
  ['x'.repeat(76) + '😀tail', [], `${'x'.repeat(76)}(2)`],
  ['x'.repeat(76) + 'e\u0301tail', [], `${'x'.repeat(76)}(2)`],
  ['x'.repeat(76) + '👩‍🔬tail', [], `${'x'.repeat(76)}(2)`],
  ['x'.repeat(75) + '😀tail', [], `${'x'.repeat(75)}😀(2)`],
  ['x'.repeat(80), [`${'x'.repeat(77)}(2)`], `${'x'.repeat(77)}(3)`],
  [
    'x'.repeat(80),
    Array.from({ length: 8 }, (_, i) => `${'x'.repeat(77)}(${i + 2})`),
    `${'x'.repeat(76)}(10)`
  ]
] as const)(
  'allocates a bounded title without splitting characters (%s)',
  (source, existing, expected) => {
    const title = nextForkTitle(source, existing)
    expect(title).toBe(expected)
    expect(title.length).toBeLessThanOrEqual(SESSION_DETAILS_TITLE_MAX_LENGTH)
    expect(existing).not.toContain(title)
  }
)

it('records the copied active branch head independently of original usage attribution on refork', () => {
  const copied: PersistedChatSession = {
    id: 'child',
    projectId: 'project',
    title: 'Copy',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    packageOrigin: {
      importId: 'copy',
      sourceProjectId: 'project',
      sourceSessionId: 'source',
      importedAt: 2,
      manifestChecksum: 'a'.repeat(64)
    },
    conversationGraph: createLinearConversationGraph({
      sessionId: 'child',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'local-head',
          role: 'agent',
          content: 'Copied answer',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          usageOrigin: { sessionId: 'ancestor', messageId: 'original-head' }
        }
      ]
    })
  }
  const source = {
    ...copied,
    id: 'source',
    packageOrigin: undefined,
    forkHeadMessageId: 'previous-copy-head'
  }
  const fork = createForkSession(copied, source, 'ask', 'Copy(2)')
  expect(fork.forkHeadMessageId).toBe('local-head')
  expect(fork.conversationGraph?.messages[0].usageOrigin).toEqual({
    sessionId: 'ancestor',
    messageId: 'original-head'
  })
})
