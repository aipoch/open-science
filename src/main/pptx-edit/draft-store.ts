import { randomUUID } from 'node:crypto'

import type { ManagedFileIdentity } from '../../shared/managed-file-versions'
import type { PptxOperation } from '../../shared/pptx-edit'

const MAX_DRAFTS = 16
const DRAFT_TTL_MS = 2 * 60 * 60 * 1000

type PptxDraft = Readonly<{
  draftId: string
  identity: ManagedFileIdentity
  basedOnVersionId: string
  operations: readonly PptxOperation[]
  bytes: Uint8Array
  summary: string
  createdAt: number
}>

type PptxDraftEvent =
  | { kind: 'proposed'; draft: PptxDraft }
  | { kind: 'cleared'; identity: ManagedFileIdentity; reason: 'accepted' | 'rejected' | 'expired' }

type DraftListener = (event: PptxDraftEvent) => void

const keyOf = (identity: ManagedFileIdentity): string =>
  `${identity.source}:${identity.projectId}:${identity.fileId}`

// Drafts live only in memory: an unreviewed AI proposal is never worth surviving an app restart.
class PptxDraftStore {
  private readonly drafts = new Map<string, PptxDraft>()
  private readonly listeners = new Set<DraftListener>()

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(listener: DraftListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // A new proposal replaces the previous draft for the same file; callers pass the cumulative list.
  put(input: Omit<PptxDraft, 'draftId' | 'createdAt'>): PptxDraft {
    const draft: PptxDraft = { ...input, draftId: randomUUID(), createdAt: this.now() }
    const key = keyOf(draft.identity)
    this.drafts.delete(key)
    this.drafts.set(key, draft)
    this.evict()
    this.emit({ kind: 'proposed', draft })
    return draft
  }

  get(identity: ManagedFileIdentity): PptxDraft | undefined {
    const key = keyOf(identity)
    const draft = this.drafts.get(key)
    if (draft && this.now() - draft.createdAt > DRAFT_TTL_MS) {
      this.drafts.delete(key)
      this.emit({ kind: 'cleared', identity, reason: 'expired' })
      return undefined
    }
    return draft
  }

  clear(identity: ManagedFileIdentity, reason: 'accepted' | 'rejected'): boolean {
    const removed = this.drafts.delete(keyOf(identity))
    if (removed) this.emit({ kind: 'cleared', identity, reason })
    return removed
  }

  private evict(): void {
    while (this.drafts.size > MAX_DRAFTS) {
      const oldest = this.drafts.keys().next().value
      if (oldest === undefined) return
      const draft = this.drafts.get(oldest)
      this.drafts.delete(oldest)
      if (draft) this.emit({ kind: 'cleared', identity: draft.identity, reason: 'expired' })
    }
  }

  private emit(event: PptxDraftEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

export { PptxDraftStore }
export type { PptxDraft, PptxDraftEvent }
