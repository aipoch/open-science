import type {
  ComputeCancellationFeedback,
  ComputeJobCancellationStatus
} from '../../shared/compute'

export const CANCELLATION_WINDOW_MS = 90_000
export const CANCELLATION_MAX_ATTEMPTS = 3
export type CancellationRecord = {
  phase: string
  outcome: string | null
  failureCode?: string | null
  requestedAt?: Date | null
  createdAt?: Date
  updatedAt?: Date
  claimExpiresAt?: Date | null
  attemptCount?: number
}

export const cancellationProjection = (
  record: CancellationRecord | null | undefined,
  now = Date.now()
): {
  cancellation_status?: ComputeJobCancellationStatus
  cancellation?: ComputeCancellationFeedback
} => {
  if (!record) return {}
  if (record.phase !== 'active')
    return { cancellation_status: record.outcome === 'fulfilled' ? 'cancelled' : undefined }
  const requestedAt = (record.requestedAt ?? record.createdAt)?.getTime() ?? now
  const expired =
    now - requestedAt >= CANCELLATION_WINDOW_MS ||
    (record.claimExpiresAt != null && record.claimExpiresAt.getTime() <= now)
  const failureCode = record.failureCode ?? (expired ? 'timeout' : undefined)
  return {
    cancellation_status: failureCode ? 'cancel_failed' : 'cancelling',
    cancellation: {
      failureCode,
      attemptCount: record.attemptCount ?? 0,
      requestedAt,
      updatedAt: record.updatedAt?.getTime() ?? requestedAt
    }
  }
}
