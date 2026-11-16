import { describe, expect, it, vi } from 'vitest'

import type { ManagedFileIdentity } from '../../shared/managed-file-versions'
import { PptxDraftReview } from './draft-review'
import { PptxDraftStore, type PptxDraft } from './draft-store'

const identity: ManagedFileIdentity = { source: 'upload', projectId: 'p', fileId: 'f' }

const setup = (
  head = 'v1',
  saved = 'created'
): {
  service: { inspect: ReturnType<typeof vi.fn>; saveBinaryEdit: ReturnType<typeof vi.fn> }
  drafts: PptxDraftStore
  draft: PptxDraft
  review: PptxDraftReview
} => {
  const service = {
    inspect: vi.fn(async () => ({ headVersionId: head })),
    saveBinaryEdit: vi.fn(async () => ({ kind: saved }))
  }
  const drafts = new PptxDraftStore()
  const draft = drafts.put({
    identity,
    basedOnVersionId: 'v1',
    operations: [],
    bytes: new Uint8Array([1]),
    summary: 'edit'
  })
  return { service, drafts, draft, review: new PptxDraftReview(service as never, drafts) }
}

describe('PptxDraftReview', () => {
  it('saves an accepted draft as an agent edit and clears it', async () => {
    const { review, draft, drafts, service } = setup()
    const result = await review.accept(identity, draft.draftId)
    expect(result.kind).toBe('saved')
    expect(service.saveBinaryEdit).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'agent', expectedHeadVersionId: 'v1', summary: 'edit' })
    )
    expect(drafts.get(identity)).toBeUndefined()
  })

  it('marks a draft stale when the head moved', async () => {
    const { review, draft, service } = setup('v2')
    expect(await review.accept(identity, draft.draftId)).toEqual({
      kind: 'stale',
      headVersionId: 'v2'
    })
    expect(service.saveBinaryEdit).not.toHaveBeenCalled()
  })

  it('keeps the draft after a save conflict', async () => {
    const { review, draft, drafts } = setup('v1', 'conflict')
    await review.accept(identity, draft.draftId)
    expect(drafts.get(identity)).toBeDefined()
  })

  it('rejects only the matching draft id', () => {
    const { review, draft, drafts } = setup()
    expect(review.reject(identity, 'other')).toBe(false)
    expect(review.reject(identity, draft.draftId)).toBe(true)
    expect(drafts.get(identity)).toBeUndefined()
  })
})
