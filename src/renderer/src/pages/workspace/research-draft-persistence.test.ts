// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type {
  ResearchDraft,
  ResearchDraftMutationResult,
  SaveResearchDraftRequest
} from '../../../../shared/research-draft'
import type { ComposerSendSnapshot } from './workspace-composer-controller'
import type { ComposerDraft } from './workspace-composer-upload-controller'
import {
  ResearchDraftPersistence,
  payloadToDraft,
  type ResearchDraftApi
} from './research-draft-persistence'
const scope = { projectId: 'project', sourceSessionId: 'source' }
const draft = (text: string): ComposerDraft => ({
  doc: { nodes: [{ type: 'text', text }] },
  annotations: [],
  attachments: [],
  attachmentTransfers: [],
  automaticReadingEnabled: true
})
const snapshot = (text: string, draftKey = 'research:source'): ComposerSendSnapshot => ({
  ...draft(text),
  draftKey,
  version: 1
})
const saved = (request: SaveResearchDraftRequest): ResearchDraftMutationResult => ({
  status: 'saved',
  draft: {
    ...scope,
    id: request.id,
    editorId: request.editorId,
    revision: request.expectedRevision + 1,
    state: 'active',
    payload: structuredClone(request.payload),
    updatedAt: 1
  }
})
const apiMock = (): ResearchDraftApi => ({
  list: vi.fn(async () => []),
  save: vi.fn(async (request) => saved(request)),
  act: vi.fn()
})
const setup = (): { api: ResearchDraftApi; manager: ResearchDraftPersistence } => {
  const api = apiMock()
  const manager = new ResearchDraftPersistence(() => api, 'window-1')
  manager.bind(scope, 'research:source')
  return { api, manager }
}
const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

describe('research draft persistence owner', () => {
  it('does not save the automatic source reference as a recoverable empty question', async () => {
    const { api, manager } = setup()
    const opening = {
      ...draft(''),
      doc: {
        nodes: [
          { type: 'session' as const, sessionId: scope.sourceSessionId, title: 'Imported source' },
          { type: 'text' as const, text: '   ' }
        ]
      }
    }
    expect(manager.write(scope.projectId, 'research:source', opening)).toBeUndefined()
    await flush()
    expect(api.save).not.toHaveBeenCalled()
    manager.write(scope.projectId, 'research:source', {
      ...opening,
      doc: {
        nodes: [
          ...opening.doc.nodes,
          { type: 'session', sessionId: 'another-source', title: 'Other source' }
        ]
      }
    })
    await flush()
    expect(api.save).toHaveBeenCalledTimes(1)
  })

  it('keeps stable send identity and retains a captured old snapshot while newer typing saves', async () => {
    const { api, manager } = setup()
    const outgoing = snapshot('first question')
    outgoing.researchDraft = manager.capture(scope.projectId, outgoing)
    const duplicate = manager.capture(scope.projectId, outgoing)
    expect(duplicate).toEqual(outgoing.researchDraft)
    manager.write(scope.projectId, outgoing.draftKey, draft('newer question'))
    expect((await manager.persist(scope.projectId, outgoing)).doc).toEqual(outgoing.doc)
    await flush()
    expect(vi.mocked(api.save).mock.calls.map(([request]) => request.expectedRevision)).toEqual([
      0, 1
    ])
    expect(vi.mocked(api.save).mock.lastCall![0].payload.doc).toEqual(draft('newer question').doc)
  })
  it('reconciles a lost save acknowledgement before advancing a newer edit', async () => {
    const { api, manager } = setup()
    vi.mocked(api.save).mockRejectedValueOnce(new Error('reply lost'))
    const outgoing = snapshot('first')
    outgoing.researchDraft = manager.capture(scope.projectId, outgoing)
    await flush()
    manager.write(scope.projectId, outgoing.draftKey, draft('second'))
    await flush()
    const calls = vi.mocked(api.save).mock.calls.map(([request]) => request)
    expect(calls).toHaveLength(3)
    expect(calls[1]).toEqual(calls[0])
    expect(calls[2].expectedRevision).toBe(1)
    expect((await manager.persist(scope.projectId, outgoing)).researchDraft).toEqual(
      outgoing.researchDraft
    )
  })
  it('preserves the owner across source-to-discussion migration and ignores the parked old alias', async () => {
    const { api, manager } = setup()
    const initial = manager.write(scope.projectId, 'research:source', draft('keep this question'))
    manager.bind(scope, 'discussion')
    expect(manager.write(scope.projectId, 'discussion', draft('keep this question'))).toEqual(
      initial
    )
    manager.write(scope.projectId, 'research:source', draft('stale parked input'))
    await flush()
    expect(api.save).toHaveBeenCalledTimes(1)
    const next = snapshot('keep this question', 'discussion')
    next.researchDraft = manager.capture(scope.projectId, next)
    expect((await manager.persist(scope.projectId, next)).researchDraft).toEqual(initial)
  })
  it('creates independent editor drafts and only lists saved content for explicit restore', async () => {
    const { api, manager } = setup()
    const another = new ResearchDraftPersistence(() => api, 'window-2')
    another.bind(scope, 'research:source')
    const first = manager.write(scope.projectId, 'research:source', draft('first window'))!
    const second = another.write(scope.projectId, 'research:source', draft('second window'))!
    expect(first.id).not.toBe(second.id)
    await manager.list(scope)
    expect(api.act).not.toHaveBeenCalled()
  })
  it('recovers stable immutable upload references and never treats unfinished transfers as complete', async () => {
    const { api, manager } = setup()
    const outgoing = snapshot('question')
    outgoing.attachments = [
      {
        id: 'upload',
        sessionId: '.pending',
        name: 'file.csv',
        originalName: 'file.csv',
        path: '/tmp/file',
        size: 1
      }
    ]
    vi.mocked(api.save).mockImplementation(async (request) =>
      saved({
        ...request,
        payload: {
          ...request.payload,
          attachments: request.payload.attachments.map((file) => ({
            ...file,
            versionId: 'immutable',
            path: '/managed/file'
          }))
        }
      })
    )
    outgoing.researchDraft = manager.capture(scope.projectId, outgoing)
    const confirmed = await manager.persist(scope.projectId, outgoing)
    expect(confirmed.attachments[0].versionId).toBe('immutable')
    const record = (saved(vi.mocked(api.save).mock.calls[0][0]) as { draft: ResearchDraft }).draft
    record.payload.attachments = confirmed.attachments
    record.payload.transfers = [{ name: 'unfinished.csv', size: 5 }]
    const recovered = payloadToDraft(record.payload, 'Choose file again')
    expect(recovered.attachments).toEqual(confirmed.attachments)
    expect(recovered.attachmentTransfers[0]).toMatchObject({
      status: 'error',
      error: 'Choose file again'
    })
    manager.adopt(record)
  })
  it('tombstones a cleared draft after its pending write and uses a new id for further input', async () => {
    const { api, manager } = setup()
    vi.mocked(api.act).mockImplementation(async (request) => ({
      status: 'saved',
      draft: {
        ...scope,
        id: request.id,
        editorId: request.editorId,
        revision: request.expectedRevision + 1,
        state: 'discarded',
        payload: { ...draft('old'), transfers: [], editRevision: 1, intentId: 'intent' },
        updatedAt: 1
      }
    }))
    const old = manager.write(scope.projectId, 'research:source', draft('sent'))!
    manager.write(scope.projectId, 'research:source', draft(''))
    const next = manager.write(scope.projectId, 'research:source', draft('next'))!
    expect(old.id).not.toBe(next.id)
    await flush()
    expect(api.act).toHaveBeenCalledWith(
      expect.objectContaining({ id: old.id, expectedRevision: 1, action: 'discard' })
    )
  })
})
