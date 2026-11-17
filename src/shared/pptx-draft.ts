import type { ManagedFileIdentity, SaveTextEditResult } from './managed-file-versions'
import type { PptxOperation } from './pptx-edit'

export type PptxDraftSummary = {
  draftId: string
  basedOnVersionId: string
  summary: string
  opCount: number
  createdAt: number
  operations: PptxOperation[]
}

export type PptxDraftChangedEvent = {
  identity: ManagedFileIdentity
  draft: PptxDraftSummary | null
  reason: 'proposed' | 'accepted' | 'rejected' | 'expired'
}

export type PptxDraftReviewRequest = {
  identity: ManagedFileIdentity
  draftId: string
}

export type PptxDraftAcceptOutcome =
  | { kind: 'saved'; result: SaveTextEditResult }
  | { kind: 'missing' }
  | { kind: 'stale'; headVersionId: string }
