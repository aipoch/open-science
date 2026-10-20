import { describe, expect, it, vi } from 'vitest'
import { createLinearConversationGraph } from '../../../../shared/conversation-graph'
import type {
  PersistedChatMessage,
  PersistedChatSession
} from '../../../../shared/session-persistence'
import type { PersistedUploadedAttachment } from '../../../../shared/uploads'
import { loadReplayDocument, type ReplayReaderApi } from './source'

const upload = (versionId: string | undefined): PersistedUploadedAttachment => ({
  id: 'data-file',
  versionId,
  versionNumber: versionId === 'old-version' ? 1 : 2,
  name: 'data.csv',
  originalName: 'data.csv',
  sessionId: 'original-upload-owner',
  size: 12,
  mimeType: 'text/csv',
  sha256: 'sha',
  createdAt: '2026-09-29T00:00:01Z'
})
const message = (id: string, versionId: string | undefined): PersistedChatMessage => ({
  id,
  role: 'user',
  content: '',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  uploads: [upload(versionId)]
})
const session = (messages: PersistedChatMessage[]): PersistedChatSession => ({
  id: 'imported',
  projectId: 'project',
  title: 'Uploaded evidence only',
  cwd: '',
  status: 'idle',
  messages,
  createdAt: 1,
  updatedAt: 1
})
const apiFor = (source: PersistedChatSession): ReplayReaderApi => ({
  sessions: { loadOne: vi.fn().mockResolvedValue(source) },
  notebook: { getReference: vi.fn().mockResolvedValue(null), state: vi.fn() },
  artifacts: { getLineage: vi.fn() }
})
const request = { projectId: 'project', sessionId: 'imported' }

describe('Replay uploaded evidence', () => {
  it('indexes a file-only imported message without executing or resolving a mutable head', async () => {
    const source = session([message('file-only', 'old-version')])
    const before = structuredClone(source)
    const api = apiFor(source)
    const doc = await loadReplayDocument(api, request)
    expect(doc.resources).toEqual([
      expect.objectContaining({
        id: 'upload-version:old-version',
        source: 'upload',
        fileId: 'data-file',
        sessionId: 'original-upload-owner',
        versionId: 'old-version',
        locator: 'upload-version:project/original-upload-owner/data-file/old-version',
        availability: 'recorded'
      })
    ])
    const step = doc.branches[0].steps.find((item) => item.resourceIds.length)!
    expect(step.evidence).toEqual([
      expect.objectContaining({
        kind: 'upload-version',
        fileId: 'data-file',
        versionId: 'old-version',
        projectId: 'project',
        sessionId: 'imported'
      })
    ])
    expect(api.artifacts.getLineage).not.toHaveBeenCalled()
    expect(api.notebook.state).not.toHaveBeenCalled()
    expect(source).toEqual(before)
  })

  it('retains a missing-version placeholder and never reads its legacy path', async () => {
    const source = session([message('legacy', undefined)])
    source.messages[0].uploads![0].path = '/mutable/latest/data.csv'
    const doc = await loadReplayDocument(apiFor(source), request)
    expect(doc.resources[0]).toMatchObject({ source: 'upload', availability: 'unavailable' })
    expect(doc.resources[0].locator).toBeUndefined()
    expect(doc.issues).toContainEqual({
      code: 'unversioned-artifact',
      sourceId: doc.resources[0].id
    })
    expect(
      doc.branches[0].steps.some((step) => step.resourceIds.includes(doc.resources[0].id))
    ).toBe(true)
  })

  it('keeps inactive-branch uploads at their exact versions and deduplicates shared records', async () => {
    const source = session([message('old-question', 'old-version')])
    const graph = createLinearConversationGraph({
      sessionId: source.id,
      messages: source.messages,
      createdAt: 1,
      updatedAt: 1
    })
    const mainId = graph.branches[0].id
    graph.messages.push({
      ...message('alternate-question', 'new-version'),
      agentFrameId: graph.rootFrameId,
      introducedOnBranchId: 'alternate',
      parentMessageId: 'old-question'
    })
    graph.branches.push({
      id: 'alternate',
      agentFrameId: graph.rootFrameId,
      parentBranchId: mainId,
      forkMessageId: 'old-question',
      headMessageId: 'alternate-question',
      createdAt: 2,
      updatedAt: 2
    })
    source.conversationGraph = graph
    const doc = await loadReplayDocument(apiFor(source), request)
    expect(doc.resources.map((item) => item.versionId)).toEqual(['old-version', 'new-version'])
    expect(
      doc.branches.find((branch) => branch.id === mainId)!.steps.flatMap((step) => step.resourceIds)
    ).toEqual(['upload-version:old-version'])
    expect(
      doc.branches
        .find((branch) => branch.id === 'alternate')!
        .steps.flatMap((step) => step.resourceIds)
    ).toEqual(['upload-version:old-version', 'upload-version:new-version'])
  })
})
