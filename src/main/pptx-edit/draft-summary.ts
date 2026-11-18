import { z } from 'zod'

import type { PptxDraftChangedEvent, PptxDraftSummary } from '../../shared/pptx-draft'
import type { PptxDraft, PptxDraftEvent } from './draft-store'

export const identitySchema = z
  .object({
    source: z.enum(['artifact', 'upload']),
    projectId: z.string().min(1).max(256),
    fileId: z.string().min(1).max(256)
  })
  .strict()

export const reviewSchema = z
  .object({ identity: identitySchema, draftId: z.string().min(1).max(128) })
  .strict()

export const summarizePptxDraft = (draft: PptxDraft): PptxDraftSummary => ({
  draftId: draft.draftId,
  basedOnVersionId: draft.basedOnVersionId,
  summary: draft.summary,
  opCount: draft.operations.length,
  createdAt: draft.createdAt,
  operations: [...draft.operations]
})

export const toPptxDraftChangedEvent = (event: PptxDraftEvent): PptxDraftChangedEvent =>
  event.kind === 'proposed'
    ? { identity: event.draft.identity, draft: summarizePptxDraft(event.draft), reason: 'proposed' }
    : { identity: event.identity, draft: null, reason: event.reason }
