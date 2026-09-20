import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { forkEditedConversationMessage } from '../../shared/conversation-graph'
import { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import { SessionRepository } from '../session-persistence/repository'
import { SessionSideChatPersistenceOwner } from '../session-persistence/side-chat-owner'
import { createMainPromptSideChatRelay } from './main-prompt-relay'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const setup = async (): Promise<{
  repository: SessionRepository
  persistence: SessionSideChatPersistenceOwner
  relay: SideChatRelayOwner
  adapter: ReturnType<typeof createMainPromptSideChatRelay>
  notify: ReturnType<typeof vi.fn>
  onDelivered: ReturnType<typeof vi.fn>
}> => {
  root = await mkdtemp(join(tmpdir(), 'side-chat-lifetime-'))
  const repository = new SessionRepository(root)
  await repository.saveSession({
    id: 'main',
    projectId: 'project',
    title: 'Main',
    cwd: '/workspace',
    status: 'idle',
    filesRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Original research',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  const notify = vi.fn()
  const persistence = new SessionSideChatPersistenceOwner({
    repository,
    assertMutable: () => undefined,
    recordSession: () => undefined,
    notifySessionUpdated: notify
  })
  const relay = new SideChatRelayOwner({ targetState: () => 'idle' })
  relay.bind({
    sideSessionId: 'provider',
    sideChatId: 'side-chat-one',
    parentSessionId: 'main',
    projectId: 'project'
  })
  const onDelivered = vi.fn()
  const adapter = createMainPromptSideChatRelay({
    relay,
    commitSideChatRelays: (command) => persistence.commitRelays(command),
    onDelivered
  })
  return { repository, persistence, relay, adapter, notify, onDelivered }
}

describe('process-local Side chat delivery', () => {
  it('does not save queued advisories, discards them on restart, and keeps accepted Main history', async () => {
    const { repository, relay, adapter, onDelivered } = await setup()
    const save = vi.spyOn(repository, 'saveSession')
    const queued = await relay.send({
      sideSessionId: 'provider',
      target: 'main',
      text: 'Accepted advisory'
    })
    expect(queued).toMatchObject({ persisted: false, status: 'queued' })
    expect(queued.systemHint).toContain('discards undelivered')
    expect(save).not.toHaveBeenCalled()
    expect(new SideChatRelayOwner({ targetState: () => 'idle' }).claim('main')).toBeUndefined()
    await adapter.claim('main')!.commit('prompt')
    expect(save).toHaveBeenCalledOnce()
    expect(onDelivered).toHaveBeenCalledOnce()
    await relay.send({ sideSessionId: 'provider', target: 'main', text: 'Discard after restart' })
    expect(save).toHaveBeenCalledOnce()
    const reopened = new SessionRepository(root!)
    const loaded = await reopened.loadSessionWithDiagnostics('project', 'main')
    expect(loaded.status).toBe('found')
    if (loaded.status !== 'found') throw new Error('Missing Main history')
    expect(loaded.session.messages.map(({ content }) => content)).toEqual([
      'Original research',
      'Accepted advisory'
    ])
    expect(loaded.session.runtimeContext?.sideChatRelays).toBeUndefined()
    expect(loaded.session.runtimeContext?.sideChat).toBeUndefined()
  })

  it('retries an accepted authority write without duplicating history after its response fails', async () => {
    const { repository, relay, adapter, onDelivered } = await setup()
    const save = repository.saveSession.bind(repository)
    const writes = vi.spyOn(repository, 'saveSession').mockImplementationOnce(async (session) => {
      await save(session)
      throw new Error('projection publication failed after authority commit')
    })
    await relay.send({ sideSessionId: 'provider', target: 'main', text: 'Accepted once' })
    const claim = adapter.claim('main')!
    await expect(claim.commit('prompt')).rejects.toThrow('after authority commit')
    claim.restore() // Once accepted, this must never queue another provider delivery.
    expect(relay.claim('main')).toBeUndefined()
    await claim.commit('prompt')
    expect(writes).toHaveBeenCalledOnce()
    expect(onDelivered).toHaveBeenCalledOnce()
    const loaded = await new SessionRepository(root!).loadSessionWithDiagnostics('project', 'main')
    if (loaded.status !== 'found') throw new Error('Missing Main history')
    expect(
      loaded.session.messages.filter(({ content }) => content === 'Accepted once')
    ).toHaveLength(1)
  })

  it('keeps an accepted batch retryable after an uncommitted write fails', async () => {
    const { repository, relay, adapter } = await setup()
    vi.spyOn(repository, 'saveSession').mockRejectedValueOnce(new Error('disk unavailable'))
    await relay.send({ sideSessionId: 'provider', target: 'main', text: 'Retry the record only' })
    const claim = adapter.claim('main')!
    await expect(claim.commit('prompt')).rejects.toThrow('disk unavailable')
    expect(relay.claim('main')).toBeUndefined()
    await claim.commit('prompt')
    const loaded = await repository.loadSessionWithDiagnostics('project', 'main')
    if (loaded.status !== 'found') throw new Error('Missing Main history')
    expect(loaded.session.messages.map(({ content }) => content)).toContain('Retry the record only')
  })

  it('does not overwrite history if a replay reuses a delivery identity for different content', async () => {
    const { persistence } = await setup()
    const command = {
      projectId: 'project',
      sessionId: 'main',
      promptMessageId: 'prompt',
      relayIds: ['relay-one'],
      relays: [
        { id: 'relay-one', sideChatId: 'side-chat-one', text: 'Original advisory', createdAt: 1 }
      ]
    }
    await persistence.commitRelays(command)
    await expect(
      persistence.commitRelays({
        ...command,
        relays: [{ ...command.relays[0], text: 'Wrong content' }]
      })
    ).rejects.toThrow('conflicts')
  })

  it('finds an already committed advisory on an inactive branch when retrying', async () => {
    const { repository, persistence } = await setup()
    const command = {
      projectId: 'project',
      sessionId: 'main',
      promptMessageId: 'prompt',
      relayIds: ['relay-one'],
      relays: [
        { id: 'relay-one', sideChatId: 'side-chat-one', text: 'Original branch only', createdAt: 1 }
      ]
    }
    await persistence.commitRelays(command)
    const loaded = await repository.loadSessionWithDiagnostics('project', 'main')
    if (loaded.status !== 'found') throw new Error('Missing Main history')
    await repository.saveSession({
      ...loaded.session,
      messages: [],
      conversationGraph: forkEditedConversationMessage(
        loaded.session.conversationGraph!,
        'prompt',
        'edited-branch',
        Date.now()
      )
    })
    const save = vi.spyOn(repository, 'saveSession')
    await persistence.commitRelays(command)
    expect(save).not.toHaveBeenCalled()
    const reopened = await new SessionRepository(root!).loadSessionWithDiagnostics(
      'project',
      'main'
    )
    if (reopened.status !== 'found') throw new Error('Missing Main history')
    expect(reopened.session.messages).toEqual([])
    expect(
      reopened.session.conversationGraph?.messages.filter(
        ({ content }) => content === 'Original branch only'
      )
    ).toHaveLength(1)
  })

  it('retries publication after commit without replaying the provider advisory', async () => {
    const { repository, relay, adapter, notify, onDelivered } = await setup()
    notify.mockImplementationOnce(() => {
      throw new Error('notification failed')
    })
    const save = vi.spyOn(repository, 'saveSession')
    await relay.send({ sideSessionId: 'provider', target: 'main', text: 'Already committed' })
    const claim = adapter.claim('main')!
    await expect(claim.commit('prompt')).rejects.toThrow('notification failed')
    await claim.commit('prompt')
    expect(save).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(onDelivered).toHaveBeenCalledOnce()
  })

  it('keeps startup composition free of Side chat authority scans and persistence wiring', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/ipc.ts'), 'utf8')
    expect(source).not.toMatch(/\.loadPersistedSideChats\s*\(/)
    expect(source).not.toMatch(/\.(?:saveSideChatProjection|appendSideChatRelay)\s*\(/)
    expect(source).not.toMatch(/(?:sideChatRuntime|sideChatRelay)\.hydrate\s*\(/)
    expect(source).not.toMatch(/await sideChatRuntime\.sweepStaleProfiles/)
  })
})
