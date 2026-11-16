import type { ManagedFileIdentity } from '../../shared/managed-file-versions'
import type {
  PptxDraftAcceptOutcome,
  PptxDraftReviewRequest,
  PptxDraftSummary
} from '../../shared/pptx-draft'
import type { ApplicationInvocation } from '../application-command-router'
import { requireDesktopCaller } from '../caller-context'
import type { PptxDraftReview } from './draft-review'
import { identitySchema, reviewSchema, summarizePptxDraft } from './draft-summary'
import type { PptxDraftStore } from './draft-store'

export type PptxDraftCommands = {
  get(
    invocation: ApplicationInvocation<readonly [ManagedFileIdentity]>
  ): Promise<PptxDraftSummary | null>
  accept(
    invocation: ApplicationInvocation<readonly [PptxDraftReviewRequest]>
  ): Promise<PptxDraftAcceptOutcome>
  reject(invocation: ApplicationInvocation<readonly [PptxDraftReviewRequest]>): Promise<boolean>
}

export const createPptxDraftCommands = (dependencies: {
  drafts: Pick<PptxDraftStore, 'get'>
  review: Pick<PptxDraftReview, 'accept' | 'reject'>
  withDataRootWrite<Result>(write: () => Promise<Result>): Promise<Result>
  onSaved?(identity: ManagedFileIdentity): void
}): PptxDraftCommands => ({
  get: async (invocation) => {
    requireDesktopCaller(invocation.callerContext)
    const draft = dependencies.drafts.get(identitySchema.parse(invocation.args[0]))
    return draft ? summarizePptxDraft(draft) : null
  },
  accept: async (invocation) => {
    requireDesktopCaller(invocation.callerContext)
    const { identity, draftId } = reviewSchema.parse(invocation.args[0])
    const outcome = await dependencies.withDataRootWrite(() =>
      dependencies.review.accept(identity, draftId)
    )
    const saved = outcome.kind === 'saved' ? outcome.result : undefined
    if (saved?.kind === 'created' && !saved.replayed) dependencies.onSaved?.(identity)
    return outcome
  },
  reject: async (invocation) => {
    requireDesktopCaller(invocation.callerContext)
    const { identity, draftId } = reviewSchema.parse(invocation.args[0])
    return dependencies.review.reject(identity, draftId)
  }
})
