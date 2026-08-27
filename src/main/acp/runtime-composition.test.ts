// Pins the production Agent Context resolver: createAcpRuntime is Electron-coupled, so the lookup
// policy is extracted as createProjectAgentContextResolver and covered here against a fake repository.

import { describe, expect, it, vi } from 'vitest'

import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import type { PersistedChatMessage } from '../../shared/session-persistence'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { createProjectAgentContextResolver, sessionHasReplayableImageHistory } =
  await import('./runtime-composition')

const message = (
  id: string,
  content: string,
  images?: PersistedChatMessage['images']
): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  ...(images ? { images } : {}),
  createdAt: 1,
  updatedAt: 1
})

describe('createProjectAgentContextResolver', () => {
  it('returns the trimmed Agent Context for a known project', async () => {
    const get = vi.fn(async () => ({ agentContext: '  Always cite DOIs.\n' }))
    const resolver = createProjectAgentContextResolver({ get })

    await expect(resolver('project-1')).resolves.toBe('Always cite DOIs.')
    expect(get).toHaveBeenCalledWith('project-1')
  })

  it('returns undefined when the project is missing or its Agent Context is blank', async () => {
    const missing = createProjectAgentContextResolver({ get: vi.fn(async () => null) })
    const blank = createProjectAgentContextResolver({
      get: vi.fn(async () => ({ agentContext: '   ' }))
    })
    const absent = createProjectAgentContextResolver({ get: vi.fn(async () => ({})) })

    await expect(missing('unknown-id')).resolves.toBeUndefined()
    await expect(blank('project-1')).resolves.toBeUndefined()
    await expect(absent('project-1')).resolves.toBeUndefined()
  })

  it('fails closed when the Project lookup fails', async () => {
    const resolver = createProjectAgentContextResolver({
      get: vi.fn(async () => {
        throw new Error('database is locked')
      })
    })

    await expect(resolver('project-1')).rejects.toThrow('Project Agent Context')
  })
})

describe('sessionHasReplayableImageHistory', () => {
  it('ignores images that exist only on an inactive conversation branch', () => {
    const imageMessage = message('original', 'original', [
      {
        id: 'image-1',
        mimeType: 'image/png',
        data: Buffer.from('image').toString('base64'),
        byteLength: 5
      }
    ])
    const original = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [imageMessage],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 1
    })
    const originalBranchId = original.branches[0].id
    const edited = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(original, imageMessage.id, 'branch-without-image', 2),
      [message('edited', 'edited without image')],
      2
    )

    expect(
      sessionHasReplayableImageHistory({ messages: [imageMessage], conversationGraph: edited })
    ).toBe(false)
    expect(
      sessionHasReplayableImageHistory({
        messages: [],
        conversationGraph: activateConversationBranch(edited, originalBranchId)
      })
    ).toBe(true)
  })
})
