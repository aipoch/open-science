import { describe, expect, it, vi } from 'vitest'

import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import { createDeckFixture } from '../../shared/pptx-edit/pptx-fixture.test-support'
import { PptxAgentHandler } from './agent-handler'
import { PptxDraftReview } from './draft-review'
import { PptxDraftStore } from './draft-store'

const path = (versionId = 'v1'): string =>
  createArtifactVersionLocator({
    projectId: 'p',
    appSessionId: 's',
    artifactId: 'a1',
    versionId
  })

const context = { projectId: 'p', sessionId: 's', signal: new AbortController().signal }
const deck = createDeckFixture()
const settext = (text: string): Record<string, unknown> => ({
  op: 'setText',
  slideId: 256,
  shapeId: 2,
  paragraphs: [{ runs: [{ text }] }]
})

const setup = (
  head = 'v1'
): {
  service: { saveBinaryEdit: ReturnType<typeof vi.fn> }
  drafts: PptxDraftStore
  handler: PptxAgentHandler
  review: PptxDraftReview
} => {
  const service = {
    inspect: vi.fn(async () => ({ headVersionId: head })),
    openVersion: vi.fn(async () => ({
      size: deck.byteLength,
      readRange: async () => deck,
      verifyUnchanged: async () => undefined,
      close: async () => undefined
    })),
    saveBinaryEdit: vi.fn(async () => ({ kind: 'created' }))
  }
  const drafts = new PptxDraftStore()
  const handler = new PptxAgentHandler(service as never, drafts)
  const review = new PptxDraftReview(service as never, drafts)
  return { service, drafts, handler, review }
}

describe('PptxAgentHandler', () => {
  it('reads the head version with the outline', async () => {
    const { handler } = setup()
    const result = (await handler.read(context, { path: path() })) as {
      headVersionId: string
      pendingDraft: unknown
    }
    expect(result.headVersionId).toBe('v1')
    expect(result.pendingDraft).toBeNull()
  })

  it('stages a draft without saving', async () => {
    const { handler, drafts, service } = setup()
    await handler.propose(context, {
      path: path(),
      expectedHeadVersionId: 'v1',
      operations: [settext('Hi')]
    })
    expect(drafts.get({ source: 'artifact', projectId: 'p', fileId: 'a1' })).toBeDefined()
    expect(service.saveBinaryEdit).not.toHaveBeenCalled()
  })

  it('rejects a stale head and unknown shapes', async () => {
    const { handler } = setup('v2')
    await expect(
      handler.propose(context, {
        path: path(),
        expectedHeadVersionId: 'v1',
        operations: [settext('Hi')]
      })
    ).rejects.toThrow('PPTX_HEAD_STALE')
    const fresh = setup()
    await expect(
      fresh.handler.propose(context, {
        path: path(),
        expectedHeadVersionId: 'v1',
        operations: [{ ...settext('x'), shapeId: 999 }]
      })
    ).rejects.toThrow('PPTX_OPERATION_REJECTED')
  })

  it('rejects a path outside the session', async () => {
    const { handler } = setup()
    await expect(
      handler.read({ ...context, sessionId: 'other' }, { path: path() })
    ).rejects.toThrow('PPTX_TARGET_INVALID')
  })
})
