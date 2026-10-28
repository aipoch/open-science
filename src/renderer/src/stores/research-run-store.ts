import { create } from 'zustand'
import { z } from 'zod'
import {
  researchMembershipSchema,
  type ResearchMembership
} from '../../../shared/session-persistence'
import {
  runObservationTargetSchema,
  type RunObservationTarget
} from '../../../shared/run-observation'
import { researchIdentity } from '@/pages/workspace/research-draft-identity'
import { useNavigationStore } from './navigation-store'

const STORAGE_KEY = 'open-science.research-run-receipts.v1'
const MAX_RECEIPTS = 30
const identity = z.string().min(1).max(512)
const receiptSchema = z
  .object({
    requestId: identity,
    source: researchMembershipSchema,
    requestedAt: z.number().finite().nonnegative(),
    sessionId: identity,
    promptMessageId: identity,
    target: runObservationTargetSchema.optional()
  })
  .strict()
  .refine(
    (receipt) =>
      !receipt.target ||
      (receipt.target.projectId === receipt.source.sourceProjectId &&
        receipt.target.sessionId === receipt.sessionId)
  )

export type ResearchRunRequest = {
  requestId: string
  source: ResearchMembership
  requestedAt: number
  sessionId?: string
  promptMessageId?: string
  target?: RunObservationTarget
  /** Only settled ordinary Session identities are persisted; optimistic IDs are transient. */
  settled?: boolean
  rejected?: boolean
  /** Never restored: opening a previous request is an explicit action after restart. */
  autoOpenNavigationRevision?: number
  autoOpenConsumed?: boolean
}

export const restoreResearchRunReceipts = (
  raw: string | null
): Record<string, ResearchRunRequest> => {
  if (!raw || raw.length > 256_000) return {}
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows) || rows.length > MAX_RECEIPTS) return {}
    return Object.fromEntries(
      rows.flatMap((row) => {
        const parsed = receiptSchema.safeParse(row)
        return parsed.success
          ? [
              [
                researchIdentity(parsed.data.source),
                { ...parsed.data, settled: true, autoOpenConsumed: true }
              ]
            ]
          : []
      })
    )
  } catch {
    return {}
  }
}

const readReceipts = (): Record<string, ResearchRunRequest> => {
  try {
    return restoreResearchRunReceipts(localStorage.getItem(STORAGE_KEY))
  } catch {
    return {}
  }
}

const persistedReceipts = (requests: Record<string, ResearchRunRequest>): unknown[] =>
  Object.values(requests)
    .filter((request) => request.settled && !request.rejected)
    .map((request) => ({
      requestId: request.requestId,
      source: request.source,
      requestedAt: request.requestedAt,
      sessionId: request.sessionId,
      promptMessageId: request.promptMessageId,
      ...(request.target ? { target: request.target } : {})
    }))

const updateRequest = (
  requests: Record<string, ResearchRunRequest>,
  requestId: string,
  update: (request: ResearchRunRequest) => ResearchRunRequest
): Record<string, ResearchRunRequest> => {
  const entry = Object.entries(requests).find(([, request]) => request.requestId === requestId)
  return entry ? { ...requests, [entry[0]]: update(entry[1]) } : requests
}

type ResearchRunStore = {
  requests: Record<string, ResearchRunRequest>
  begin: (requestId: string, source: ResearchMembership) => void
  bind: (requestId: string, destination: { sessionId: string; messageId: string }) => void
  settle: (requestId: string, destination: { sessionId: string; messageId?: string }) => void
  reject: (requestId: string) => void
  attach: (requestId: string, target: RunObservationTarget) => void
  consumeAutoOpen: (requestId: string) => void
}

/** Local launch receipts are presentation hints only. Notebook provenance and Main admission
 * remain authoritative. No scripts, local paths, viewer URLs, grants or credentials are stored. */
export const useResearchRunStore = create<ResearchRunStore>((set) => ({
  requests: readReceipts(),
  begin: (requestId, source) =>
    set((state) => {
      const request: ResearchRunRequest = {
        requestId,
        source: { ...source },
        requestedAt: Date.now(),
        autoOpenNavigationRevision: useNavigationStore.getState().explicitNavigationRevision
      }
      return {
        requests: Object.fromEntries(
          Object.entries({
            ...state.requests,
            [researchIdentity(source)]: request
          })
            .sort(([, a], [, b]) => b.requestedAt - a.requestedAt)
            .slice(0, MAX_RECEIPTS)
        )
      }
    }),
  bind: (requestId, destination) =>
    set((state) => ({
      requests: updateRequest(state.requests, requestId, (request) => ({
        ...request,
        sessionId: destination.sessionId,
        promptMessageId: destination.messageId
      }))
    })),
  settle: (requestId, destination) =>
    set((state) => ({
      requests: updateRequest(state.requests, requestId, (request) => ({
        ...request,
        sessionId: destination.sessionId,
        promptMessageId: destination.messageId ?? request.promptMessageId,
        settled: true,
        ...(request.target && request.target.sessionId !== destination.sessionId
          ? { target: undefined }
          : {})
      }))
    })),
  reject: (requestId) =>
    set((state) => ({
      requests: updateRequest(state.requests, requestId, (request) => ({
        ...request,
        rejected: true
      }))
    })),
  attach: (requestId, target) =>
    set((state) => ({
      requests: updateRequest(state.requests, requestId, (request) =>
        request.target ||
        target.projectId !== request.source.sourceProjectId ||
        target.sessionId !== request.sessionId
          ? request
          : { ...request, target }
      )
    })),
  consumeAutoOpen: (requestId) =>
    set((state) => ({
      requests: updateRequest(state.requests, requestId, (request) => ({
        ...request,
        autoOpenConsumed: true
      }))
    }))
}))

useResearchRunStore.subscribe((state) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedReceipts(state.requests)))
  } catch {
    // Full/private storage must never block an ordinary Agent send or an exact Run viewer.
  }
})
