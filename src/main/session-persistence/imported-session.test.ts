import { expect, it, vi } from 'vitest'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  resolveActiveConversationMessages,
  projectConversationMessage
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { preserveImportedSession } from './imported-session'

const history = (): PersistedChatSession => {
  const messages = [
    {
      id: 'question',
      role: 'user' as const,
      content: 'research '.repeat(128 * 1024),
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
  return {
    id: 'import-session',
    projectId: 'project',
    title: 'History',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages,
    conversationGraph: createLinearConversationGraph({
      sessionId: 'import-session',
      messages,
      createdAt: 1,
      updatedAt: 1
    }),
    packageOrigin: {
      importId: 'import',
      sourceProjectId: 'source-project',
      sourceSessionId: 'source-session',
      importedAt: 1,
      manifestChecksum: 'a'.repeat(64)
    }
  }
}

it('checks large imported history without serializing comparison copies', () => {
  const current = history()
  const candidate = structuredClone(current)
  candidate.title = 'Renamed history'
  const stringify = vi.spyOn(JSON, 'stringify')
  try {
    expect(preserveImportedSession(current, candidate).title).toBe(candidate.title)
    expect(stringify).not.toHaveBeenCalled()
  } finally {
    stringify.mockRestore()
  }
})

it('accepts JSON-equivalent omitted fields but rejects changed nested research', () => {
  const current = history()
  const candidate = structuredClone(current)
  candidate.messages[0] = { ...candidate.messages[0], streamId: undefined }
  candidate.description = ''
  candidate.permissionProfile = 'ask'
  expect(preserveImportedSession(current, candidate)).toBeDefined()
  candidate.messages[0].content = 'Different research'
  expect(() => preserveImportedSession(current, candidate)).toThrow('read-only')
})

it('rejects edits to an inactive branch while allowing its view to change', () => {
  const current = history()
  current.conversationGraph = forkEditedConversationMessage(
    current.conversationGraph!,
    'question',
    'Alternative question',
    2
  )
  current.messages = resolveActiveConversationMessages(current.conversationGraph).map(
    projectConversationMessage
  )
  const candidate = structuredClone(current)
  expect(preserveImportedSession(current, candidate)).toBeDefined()
  candidate.conversationGraph!.messages.find((message) => message.id === 'question')!.content =
    'Edited hidden evidence'
  expect(() => preserveImportedSession(current, candidate)).toThrow('read-only')
})

it.each([
  { label: 'omitted nested values', value: { nested: { omitted: undefined, present: false } } },
  { label: 'nullable array values', value: [undefined, null, false, '', 0] },
  { label: 'JSON number normalization', value: [-0, NaN, Infinity, -Infinity, 1] },
  { label: 'Date serialization', value: new Date('2026-09-12T00:00:00.000Z') }
])('preserves $label comparison semantics in structured evidence', ({ value }) => {
  const candidate = history()
  candidate.messages[0].structuredOutputEvidence = {
    attemptId: 'attempt',
    dialect: '2020-12',
    profile: 'ajv-8-draft-2020-12-v1',
    schemaDigest: 'a'.repeat(64),
    schema: value
  }
  candidate.conversationGraph = createLinearConversationGraph({
    sessionId: candidate.id,
    messages: candidate.messages,
    createdAt: 1,
    updatedAt: 1
  })
  const current: PersistedChatSession = JSON.parse(JSON.stringify(candidate))
  expect(preserveImportedSession(current, candidate)).toBeDefined()
})
