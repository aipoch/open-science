import { randomUUID } from 'node:crypto'

import type { ManagedFileIdentity, SaveTextEditResult } from '../../shared/managed-file-versions'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import type { PptxDraftStore } from './draft-store'

type ReviewService = Pick<ManagedFileVersionService, 'inspect' | 'saveBinaryEdit'>

type DraftAcceptResult =
  | { kind: 'saved'; result: SaveTextEditResult }
  | { kind: 'missing' }
  | { kind: 'stale'; headVersionId: string }

class PptxDraftReview {
  constructor(
    private readonly service: ReviewService,
    private readonly drafts: PptxDraftStore
  ) {}

  async accept(identity: ManagedFileIdentity, draftId: string): Promise<DraftAcceptResult> {
    const draft = this.drafts.get(identity)
    if (!draft || draft.draftId !== draftId) return { kind: 'missing' }
    const head = (await this.service.inspect(identity)).headVersionId
    // Replaying onto a newer head is not attempted yet; a moved head makes the draft stale.
    if (head !== draft.basedOnVersionId) {
      this.drafts.clear(identity, 'rejected')
      return { kind: 'stale', headVersionId: head }
    }
    const result = await this.service.saveBinaryEdit({
      ...identity,
      basedOnVersionId: draft.basedOnVersionId,
      expectedHeadVersionId: head,
      operationId: randomUUID(),
      content: draft.bytes,
      actor: 'agent',
      summary: draft.summary,
      opCount: draft.operations.length
    })
    if (result.kind !== 'conflict') this.drafts.clear(identity, 'accepted')
    return { kind: 'saved', result }
  }

  reject(identity: ManagedFileIdentity, draftId: string): boolean {
    const draft = this.drafts.get(identity)
    if (!draft || draft.draftId !== draftId) return false
    return this.drafts.clear(identity, 'rejected')
  }
}

export { PptxDraftReview }
export type { DraftAcceptResult }
