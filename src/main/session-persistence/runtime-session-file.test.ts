import { describe, expect, it } from 'vitest'
import type { AcpRuntimeEvent } from '../../shared/acp'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import {
  createSessionFile,
  decodeSessionFile,
  sanitizeSessionUploadedAttachments,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  applyRuntimeSessionEventsWithChanges,
  type RuntimeSessionScope
} from '../../shared/runtime-session-projection'
import { normalizeJournalValue, type JournalValue } from './journal-codec'
import type { SessionJournalRead } from './journal'
import { createRuntimeSessionFile } from './runtime-session-file'
import { encodeSessionDataPaths } from './session-data-paths'
import { initDataRoot } from '../storage-root'

const fullFile = (session: PersistedChatSession): JournalValue =>
  normalizeJournalValue(
    createSessionFile(encodeSessionDataPaths(sanitizeSessionUploadedAttachments(session)))
  )
const fixture = (): { session: PersistedChatSession; scope: RuntimeSessionScope } => {
  initDataRoot('/tmp/open-science-runtime-session-file-test')
  const messages: PersistedChatSession['messages'] = [
    {
      id: 'history',
      role: 'user',
      content: 'Unchanged history'.repeat(1000),
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'prompt',
      role: 'user',
      content: 'Continue',
      status: 'complete',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
  ]
  const graph = createLinearConversationGraph({
    sessionId: 's',
    messages,
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 2
  })
  const session: PersistedChatSession = {
    id: 's',
    projectId: 'p',
    title: 'Research',
    cwd: '/workspace',
    status: 'running',
    revision: 1,
    messages,
    conversationGraph: graph,
    createdAt: 1,
    updatedAt: 2,
    activeRun: { promptMessageId: 'prompt', startedAt: 2 }
  }
  const scope = {
    promptMessageId: 'prompt',
    agentFrameId: graph.rootFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id
  }
  return { session, scope }
}
const event = (fields: Partial<AcpRuntimeEvent>): AcpRuntimeEvent =>
  ({
    kind: 'message',
    id: 'delta',
    timestamp: 3,
    level: 'info',
    sessionId: 's',
    role: 'assistant',
    messageId: 'answer',
    text: 'Answer',
    ...fields
  }) as AcpRuntimeEvent

describe('runtime business record encoding', () => {
  it.each([100, 1000])(
    'preserves complete logical state with tool output size %i and shares history',
    (size) => {
      const initial = fixture()
      let document = fullFile(initial.session)
      const batches = [
        [event({})],
        [event({ id: 'delta-2', text: ' continued' })],
        [
          event({
            kind: 'tool',
            id: 'group',
            timestamp: 4,
            toolCallId: 'group',
            providerToolName: 'mcp__open-science-activity__begin_activity_group',
            rawInput: { title: 'Analysis' }
          })
        ],
        [
          event({
            kind: 'tool',
            id: 'tool-start',
            timestamp: 5,
            toolCallId: 'tool',
            status: 'in_progress',
            rawInput: { command: 'calculate' }
          })
        ],
        [
          event({
            kind: 'tool',
            id: 'tool-end',
            timestamp: 6,
            toolCallId: 'tool',
            status: 'completed',
            rawOutput: { result: 'Large result'.repeat(size) }
          })
        ],
        [event({ id: 'delta-3', timestamp: 7, text: ' Final text' })],
        [
          event({
            kind: 'tool',
            id: 'tool-followup',
            timestamp: 8,
            toolCallId: 'tool',
            status: 'completed',
            rawOutput: { result: 'Replacement result' }
          })
        ]
      ]
      for (const batch of batches) {
        const decoded = decodeSessionFile(document, { preserveRuntimeState: true })
        expect(decoded.status).toBe('ok')
        if (decoded.status !== 'ok') throw new Error('Invalid fixture')
        const previous = decoded.session
        const { session, changes } = applyRuntimeSessionEventsWithChanges(
          previous,
          initial.scope,
          batch
        )
        expect(changes).toBeDefined()
        const candidate = { ...session, revision: previous.revision! + 1 }
        const authority: SessionJournalRead = {
          document,
          revision: previous.revision!,
          format: 'journal',
          storageBytes: 0
        }
        const encoded = createRuntimeSessionFile(candidate, authority, {
          previous,
          changes: changes!
        })
        expect(encoded).toBeDefined()
        const full = fullFile(candidate)
        // The legacy reader bounds raw tool payloads. Appending an unrelated message keeps the
        // original stored tool record, rather than rewriting it from that bounded projection.
        // Both paths must still restore exactly the same complete business state.
        expect(decodeSessionFile(encoded, { preserveRuntimeState: true })).toEqual(
          decodeSessionFile(full, { preserveRuntimeState: true })
        )
        if (size === 100) expect(normalizeJournalValue(encoded)).toEqual(full)
        if (batch[0].id === 'delta-3') {
          expect(
            encoded!.session.conversationGraph!.activities.find(({ id }) => id === 'tool')
              ?.rawOutput
          ).toEqual({ result: 'Large result'.repeat(size) })
        }
        if (batch[0].id === 'tool-followup') {
          expect(
            encoded!.session.conversationGraph!.activities.find(({ id }) => id === 'tool')
              ?.rawOutput
          ).toEqual({ result: 'Replacement result' })
        }
        const stored = document as unknown as ReturnType<typeof createSessionFile>
        expect(encoded!.session.conversationGraph!.messages[0]).toBe(
          stored.session.conversationGraph!.messages[0]
        )
        document = normalizeJournalValue(encoded)
      }
    }
  )

  it('leaves legacy migration, stale evidence and attachment validation to the full codec', () => {
    const { session: previous, scope } = fixture()
    const result = applyRuntimeSessionEventsWithChanges(previous, scope, [event({})])
    const candidate = { ...result.session, revision: 2 }
    const authority: SessionJournalRead = {
      document: fullFile(previous),
      revision: 1,
      format: 'journal',
      storageBytes: 0
    }
    const evidence = { previous, changes: result.changes! }
    expect(
      createRuntimeSessionFile(candidate, { ...authority, format: 'legacy' }, evidence)
    ).toBeUndefined()
    expect(
      createRuntimeSessionFile(candidate, { ...authority, revision: 2 }, evidence)
    ).toBeUndefined()
    const message = result.changes!.messages[0]
    const withUpload = { ...message, uploads: [{ id: 'old-upload' }] as never }
    expect(
      createRuntimeSessionFile(candidate, authority, {
        previous,
        changes: { ...result.changes!, messages: [withUpload] }
      })
    ).toBeUndefined()
  })
})
