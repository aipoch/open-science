import { describe, expect, it, vi } from 'vitest'
import {
  materializeSessionConversationGraph,
  setTurnOutcome,
  resolveTurnOutcome,
  type PersistedChatSession,
  type TurnOutcome
} from '../../shared/session-persistence'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import { SessionPersistenceReconciliationOwner } from './reconciliation-owner'

const version = (): ArtifactVersionFile => ({
  id: 'version',
  artifactId: 'file',
  versionId: 'version',
  versionNumber: 1,
  checksum: 'a'.repeat(64),
  createdAt: new Date(4).toISOString(),
  projectId: 'p',
  sessionId: 's',
  messageId: 'response',
  runId: 'run',
  name: 'result.txt',
  path: '/published/result.txt',
  fileUrl: 'file:///published/result.txt',
  size: 1,
  mtimeMs: 4,
  isPublished: true
})
const fixture = (outcome: TurnOutcome): PersistedChatSession =>
  setTurnOutcome(
    materializeSessionConversationGraph({
      id: 's',
      projectId: 'p',
      title: 'Research',
      cwd: '/workspace',
      status: 'error',
      error: 'Publication failed',
      createdAt: 1,
      updatedAt: 3,
      messages: [
        {
          id: 'prompt',
          role: 'user',
          content: 'Research',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'response',
          role: 'agent',
          responseToMessageId: 'prompt',
          content: 'Result',
          status: 'complete',
          artifactIds: ['pending'],
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      artifacts: [
        { id: 'pending', kind: 'managed-file', path: '/.pending/run/result.txt' },
        { id: 'historical', kind: 'managed-file', path: '/historical/keep.txt' }
      ]
    }),
    'prompt',
    outcome
  )
const publicationFailure: TurnOutcome = {
  kind: 'failed',
  settledAt: 3,
  error: 'Publication failed',
  recovery: 'retry-artifact-publication'
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = () => {
  const saveSession = vi.fn(async (session: PersistedChatSession) => structuredClone(session))
  const onSessionCommitted = vi.fn()
  const owner = new SessionPersistenceReconciliationOwner({
    repository: { saveSession },
    onSessionCommitted,
    fileIndex: {
      syncSession: vi.fn(async () => []),
      reconcileActiveSessions: vi.fn(async () => undefined)
    }
  })
  return { owner, saveSession, onSessionCommitted }
}

describe('Main Artifact retry outcomes', () => {
  it('commits exact references and completes the same turn without deleting historical file metadata', async () => {
    const h = harness()
    const session = fixture(publicationFailure)
    await h.owner.commitRecoveredArtifacts(session, 'response', [version()])
    const saved = h.saveSession.mock.calls[0][0]
    expect(saved.messages[0].turnOutcome?.kind).toBe('completed')
    expect(saved.conversationGraph?.messages[0].turnOutcome).toEqual(saved.messages[0].turnOutcome)
    expect(saved.messages[1].artifactIds).toEqual(['version'])
    expect(saved.artifacts?.map(({ id }) => id)).toEqual(['pending', 'historical', 'version'])
    expect(saved.status).toBe('idle')
    expect(saved.error).toBeUndefined()
    expect(h.onSessionCommitted).toHaveBeenCalledWith(saved)
    expect(session.messages[0].turnOutcome).toEqual(publicationFailure)
  })

  it.each([
    { kind: 'failed', settledAt: 3, error: 'Ordinary provider failure' },
    { kind: 'cancelled', settledAt: 3, recovery: 'resume' },
    { kind: 'interrupted', settledAt: 3, cause: 'app-restart', recovery: 'resume' }
  ] satisfies TurnOutcome[])(
    'does not reinterpret a $kind outcome as publication success',
    async (outcome) => {
      const h = harness()
      await h.owner.commitRecoveredArtifacts(fixture(outcome), 'response', [version()])
      expect(h.saveSession.mock.calls[0][0].messages[0].turnOutcome).toEqual(outcome)
    }
  )

  it('retains a publication failure when native publication is not confirmed', async () => {
    const h = harness()
    await h.owner.commitRecoveredArtifacts(fixture(publicationFailure), 'response', [
      { ...version(), isPublished: false }
    ])
    expect(h.saveSession.mock.calls[0][0].messages[0].turnOutcome).toEqual(publicationFailure)
  })

  it('preserves newer active state while repairing the older turn', async () => {
    const h = harness()
    const session = fixture(publicationFailure)
    session.status = 'running'
    session.error = 'Concurrent state'
    session.activeRun = { promptMessageId: 'new-prompt', startedAt: 5 }
    await h.owner.commitRecoveredArtifacts(session, 'response', [version()])
    const saved = h.saveSession.mock.calls[0][0]
    expect(saved.messages[0].turnOutcome?.kind).toBe('completed')
    expect(saved.activeRun).toEqual(session.activeRun)
    expect(saved.status).toBe('running')
    expect(saved.error).toBe('Concurrent state')
  })

  it('does not drop unresolved references or settle an incomplete group', async () => {
    const h = harness()
    const session = fixture(publicationFailure)
    session.messages[1].artifactIds = [...session.messages[1].artifactIds!, 'missing-version']
    session.conversationGraph!.messages[1].artifactIds = [
      ...session.conversationGraph!.messages[1].artifactIds!,
      'missing-version'
    ]
    await h.owner.commitRecoveredArtifacts(session, 'response', [version()])
    expect(h.saveSession.mock.calls[0][0].messages[0].turnOutcome).toEqual(publicationFailure)
    expect(h.saveSession.mock.calls[0][0].messages[1].artifactIds).toEqual([
      'missing-version',
      'version'
    ])
  })
})

it('retains another unresolved file from the same pending run when recovery returns only one file', async () => {
  const h = harness()
  const session = fixture(publicationFailure)
  session.artifacts!.push({
    id: 'pending-other',
    kind: 'managed-file',
    path: '/.pending/run/other.txt'
  })
  session.messages[1].artifactIds = ['pending', 'pending-other']
  session.conversationGraph!.messages[1].artifactIds = ['pending', 'pending-other']
  await h.owner.commitRecoveredArtifacts(session, 'response', [version()])
  const saved = h.saveSession.mock.calls[0][0]
  expect(saved.messages[1].artifactIds).toEqual(['pending-other', 'version'])
  expect(saved.messages[0].turnOutcome).toEqual(publicationFailure)
  expect(saved.artifacts?.map(({ id }) => id)).toEqual([
    'pending',
    'historical',
    'pending-other',
    'version'
  ])
})

it.each([false, true])(
  'settles legacy-only retry with Main publication proof (native=%s)',
  async (native) => {
    const h = harness()
    const session = setTurnOutcome(fixture(publicationFailure), 'prompt', undefined)
    session.error = 'Generated file finalization failed: temporary storage failure'
    delete session.messages[1].responseToMessageId
    delete session.conversationGraph!.messages[1].responseToMessageId
    const before = structuredClone(session)
    expect(resolveTurnOutcome(session, 'prompt')).toMatchObject({
      kind: 'failed',
      recovery: 'retry-artifact-publication'
    })
    expect(session).toEqual(before)
    const compatibility = {
      id: 'version',
      projectId: 'p',
      sessionId: 's',
      messageId: 'response',
      name: 'result.txt',
      path: '/published/result.txt',
      fileUrl: 'file:///published/result.txt',
      size: 1,
      mtimeMs: 4
    }
    await h.owner.commitRecoveredArtifacts(
      session,
      'response',
      native ? [version()] : [compatibility],
      ['/.pending/run/result.txt']
    )
    const saved = h.saveSession.mock.calls[0][0]
    expect(saved.status).toBe('idle')
    expect(saved.error).toBeUndefined()
    expect(saved.messages[0].turnOutcome?.kind).toBe('completed')
    expect(saved.messages[1].artifactIds).toEqual(['version'])
    expect(saved.artifacts?.some(({ id }) => id === 'historical')).toBe(true)
  }
)

it('does not let advisory relay replies block publication settlement of the preceding legacy turn', async () => {
  const h = harness()
  let session = setTurnOutcome(fixture(publicationFailure), 'prompt', undefined)
  session.error = 'Generated file finalization failed: temporary storage failure'
  delete session.messages[1].responseToMessageId
  session = materializeSessionConversationGraph({
    ...session,
    conversationGraph: undefined,
    messages: [
      ...session.messages,
      {
        ...session.messages[0],
        id: 'relay',
        relayedFrom: { kind: 'side-chat', direction: 'to-main' }
      },
      { ...session.messages[1], id: 'relay-response', artifactIds: ['relay-pending'] }
    ],
    artifacts: [
      ...session.artifacts!,
      { id: 'relay-pending', kind: 'managed-file', path: '/.pending/relay/relay.txt' }
    ]
  })

  await h.owner.commitRecoveredArtifacts(session, 'response', [version()])

  const saved = h.saveSession.mock.calls[0][0]
  expect(saved.messages[0].turnOutcome?.kind).toBe('completed')
  expect(saved.messages[3].artifactIds).toEqual(['relay-pending'])
  expect(saved.artifacts?.find(({ id }) => id === 'relay-pending')?.path).toBe(
    '/.pending/relay/relay.txt'
  )
})

describe('legacy turn interval with a routed reply', () => {
  const steering = {
    id: 'steering',
    role: 'user' as const,
    content: 'Also add a legend',
    status: 'complete' as const,
    eventIds: [],
    createdAt: 2,
    updatedAt: 2,
    responseToMessageId: 'prompt'
  }
  const legacyFailed = (order: 'steering-first' | 'steering-between'): PersistedChatSession => {
    const base = setTurnOutcome(fixture(publicationFailure), 'prompt', undefined)
    const [prompt, response] = base.messages
    const later = {
      ...response,
      id: 'later-response',
      artifactIds: ['later-pending']
    }
    delete response.responseToMessageId
    delete later.responseToMessageId
    return materializeSessionConversationGraph({
      ...base,
      error: 'Generated file finalization failed: temporary storage failure',
      conversationGraph: undefined,
      messages:
        order === 'steering-first'
          ? [prompt, steering, response]
          : [prompt, response, steering, later],
      artifacts: [
        ...base.artifacts!,
        { id: 'later-pending', kind: 'managed-file', path: '/.pending/run/later.txt' }
      ]
    })
  }

  it('settles a legacy failure whose only untagged reply follows the turn own steering', async () => {
    const h = harness()
    const session = legacyFailed('steering-first')
    expect(resolveTurnOutcome(session, 'prompt')).toMatchObject({
      kind: 'failed',
      recovery: 'retry-artifact-publication'
    })
    await h.owner.commitRecoveredArtifacts(session, 'response', [version()])
    const saved = h.saveSession.mock.calls[0][0]
    expect(saved.status).toBe('idle')
    expect(resolveTurnOutcome(saved, 'prompt')?.kind).toBe('completed')
  })

  it('does not settle while an untagged reply after the steering still has a pending file', async () => {
    const h = harness()
    const session = legacyFailed('steering-between')
    await h.owner.commitRecoveredArtifacts(session, 'response', [version()])
    const saved = h.saveSession.mock.calls[0][0]
    expect(saved.messages.find(({ id }) => id === 'later-response')?.artifactIds).toEqual([
      'later-pending'
    ])
    expect(saved.status).toBe('error')
    expect(resolveTurnOutcome(saved, 'prompt')).toMatchObject({ kind: 'failed' })
  })
})
