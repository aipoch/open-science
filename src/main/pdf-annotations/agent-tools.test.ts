import { expect, it, vi } from 'vitest'
import { PdfAnnotationAgent, type AnnotationToolContext } from './agent-tools'
import type { SessionPdfSourceResolver } from '../literature/session-pdf-source-resolver'
import type { PdfAnnotationService } from './service'
import type { PersistedChatSession, SessionPdfBinding } from '../../shared/session-persistence'
import { createLinearConversationGraph } from '../../shared/conversation-graph'

function fixture(): {
  agent: PdfAnnotationAgent
  context: AnnotationToolContext
  session: PersistedChatSession
  binding: SessionPdfBinding
  abort: AbortController
  create: ReturnType<typeof vi.fn<PdfAnnotationService['create']>>
  list: ReturnType<typeof vi.fn<PdfAnnotationService['list']>>
  resolveVersion: ReturnType<typeof vi.fn<SessionPdfSourceResolver['resolveVersion']>>
  locate: () => Promise<string>
  setSession: (session: PersistedChatSession) => void
} {
  const abort = new AbortController()
  const binding: SessionPdfBinding = {
    version: 1,
    bindingId: 'paper',
    sourceKind: 'literature-attachment-version',
    sourceFileId: 'file',
    sourceVersionId: 'version',
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    checksum: 'a'.repeat(64),
    sizeBytes: 20,
    linkedAt: 1
  }
  const session: PersistedChatSession = {
    id: 'session',
    projectId: 'project',
    title: 'Reading',
    cwd: '/workspace',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Highlight the limitations',
        status: 'complete',
        createdAt: 1,
        updatedAt: 1,
        eventIds: [],
        pdfContext: { version: 1, bindings: [binding] }
      }
    ]
  }
  let current = session
  const context: AnnotationToolContext = {
    projectId: 'project',
    sessionId: 'session',
    promptMessageId: 'prompt',
    signal: abort.signal,
    check: () => abort.signal.throwIfAborted()
  }
  const create = vi.fn<PdfAnnotationService['create']>(async (request, guard) => {
    guard?.()
    return {
      ...request,
      version: 1,
      createdInSessionId: undefined,
      origin: 'user',
      createdAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z'
    }
  })
  const list = vi.fn<PdfAnnotationService['list']>(async () => ({ items: [], total: 0 }))
  const resolveVersion = vi.fn<SessionPdfSourceResolver['resolveVersion']>(async () => undefined)
  const agent = new PdfAnnotationAgent({
    sources: { resolveVersion },
    sessions: { loadSessionForContinuation: async () => current },
    withSession: async (_context, operation) => operation(current),
    annotations: {
      create,
      list,
      withVerifiedSource: async (source, operation) =>
        operation(
          { path: '/verified/paper.pdf', size: 20, verifyUnchanged: async () => {} },
          source
        )
    },
    elements: {
      annotationRegions: async () => ({
        documentId: 'paper',
        regions: [{ page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4, rotation: 90 }]
      })
    },
    geometry: async () => ({
      selectors: [{ kind: 'page-note', pageNumber: 1, pageRotation: 0, coordinateVersion: 1 }],
      truncated: false
    })
  })
  return {
    agent,
    context,
    session,
    binding,
    abort,
    create,
    list,
    resolveVersion,
    setSession: (value) => {
      current = value
    },
    locate: async () => {
      const result = await agent.locate(context, { target: { kind: 'document-note' } })
      return (result.targets as Array<{ targetRef: string }>)[0]!.targetRef
    }
  }
}
it('uses host-owned identities, stable retry IDs and existing annotation storage', async () => {
  const f = fixture()
  const targetRef = await f.locate()
  const request = { targetRef, requestId: 'note-1', note: 'Small cohort.' }
  const first = await f.agent.create(f.context, request)
  const retry = await f.agent.create(f.context, request)
  expect(retry.id).toBe(first.id)
  expect(f.create.mock.calls[0]![0]).toMatchObject({
    literatureVersionId: 'version',
    createdInSessionId: 'session',
    kind: 'document-note',
    note: 'Small cohort.',
    target: { source: { kind: 'literature-attachment-version', versionId: 'version' } }
  })
  expect(f.create.mock.calls[0]![0].projectId).toBeUndefined()
  expect(f.create.mock.calls[0]![1]).toBe(f.context.check)
  await expect(
    f.agent.create(f.context, { ...request, projectId: 'other' } as typeof request)
  ).rejects.toThrow()
})
it('rejects targets from another prompt, changed bindings, and inactive branches before writing', async () => {
  const f = fixture()
  const targetRef = await f.locate()
  const request = { targetRef, requestId: 'note-1', note: 'Note' }
  await expect(f.agent.create({ ...f.context, promptMessageId: 'other' }, request)).rejects.toThrow(
    'TARGET_STALE'
  )
  f.setSession({
    ...f.session,
    messages: [
      {
        ...f.session.messages[0]!,
        pdfContext: { version: 1, bindings: [{ ...f.binding, checksum: 'b'.repeat(64) }] }
      }
    ]
  })
  await expect(f.agent.create(f.context, request)).rejects.toThrow('TARGET_STALE')
  f.setSession(f.session)
  const other = [{ ...f.session.messages[0]!, id: 'other' }]
  f.setSession({
    ...f.session,
    conversationGraph: createLinearConversationGraph({
      sessionId: 'session',
      messages: other,
      createdAt: 1,
      updatedAt: 1
    })
  })
  await expect(f.agent.create(f.context, request)).rejects.toThrow('TARGET_STALE')
  expect(f.create).not.toHaveBeenCalled()
})
it('rejects read-only and cancelled writes even through a Literature binding', async () => {
  const f = fixture()
  const targetRef = await f.locate()
  const request = { targetRef, requestId: 'note-1', note: 'Note' }
  f.setSession({
    ...f.session,
    packageOrigin: {} as NonNullable<PersistedChatSession['packageOrigin']>
  })
  await expect(f.agent.create(f.context, request)).rejects.toThrow('READ_ONLY')
  f.setSession(f.session)
  f.abort.abort()
  await expect(f.agent.create(f.context, request)).rejects.toThrow()
  expect(f.create).not.toHaveBeenCalled()
})
it('converts a Structure region into the reader rotation without model-provided coordinates', async () => {
  const f = fixture()
  const result = await f.agent.locate(f.context, {
    target: { kind: 'element', elementRef: 'signed' }
  })
  const targets = result.targets as Array<{
    targetRef: string
    rect: { x: number; y: number; width: number; height: number }
  }>
  expect(result.selection).toBe('regions-of-one-element')
  expect(targets[0]!.rect.x).toBeCloseTo(0.2)
  expect(targets[0]!.rect.y).toBeCloseTo(0.6)
  expect(targets[0]!.rect.width).toBeCloseTo(0.4)
  expect(targets[0]!.rect.height).toBeCloseTo(0.3)
  await f.agent.create(f.context, { targetRef: targets[0]!.targetRef, requestId: 'area', note: '' })
  expect(f.create.mock.calls[0]![0]).toMatchObject({
    kind: 'area',
    target: { selector: { pageRotation: 0 } }
  })
})

it('reads package snapshots and creates fork notes through the managed upload source', async () => {
  const f = fixture()
  f.resolveVersion.mockResolvedValue({
    sourceKind: 'upload-version',
    sourceSessionId: 'session',
    sourceFileId: f.binding.sourceFileId,
    sourceVersionId: f.binding.sourceVersionId,
    checksum: f.binding.checksum,
    sizeBytes: f.binding.sizeBytes,
    filename: f.binding.name,
    path: 'managed-identity'
  })
  f.setSession({
    ...f.session,
    packageOrigin: {} as NonNullable<PersistedChatSession['packageOrigin']>
  })
  await f.agent.list(f.context, {})
  expect(f.list).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'project',
      sessionId: 'session',
      sourceFileId: 'file',
      versionId: 'version'
    })
  )
  expect(f.list.mock.calls[0]![0].literatureVersionId).toBeUndefined()
  f.setSession({ ...f.session, forkOrigin: {} as NonNullable<PersistedChatSession['forkOrigin']> })
  const targetRef = await f.locate()
  await f.agent.create(f.context, { targetRef, requestId: 'fork-note', note: 'Follow-up' })
  expect(f.create.mock.calls[0]![0]).toMatchObject({
    projectId: 'project',
    target: { source: { kind: 'upload-version', sessionId: 'session' } }
  })
  expect(f.create.mock.calls[0]![0].literatureVersionId).toBeUndefined()
})
