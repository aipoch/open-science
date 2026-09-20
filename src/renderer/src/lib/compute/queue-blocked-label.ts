import type { TFunction } from 'i18next'
import type { ComputeQueueBlockedReason } from '../../../../shared/compute'

export function computeQueueBlockedLabel(
  reason: ComputeQueueBlockedReason | undefined,
  t: TFunction
): string | undefined {
  if (!reason) return undefined
  switch (reason) {
    case 'runtime_stopped':
      return t('Compute dispatch is stopped')
    case 'session_policy_identity_conflict':
      return t('Session ownership could not be verified')
    case 'session_policy_missing':
    case 'session_policy_deleted':
      return t('Waiting for Session recovery. Dispatch retries automatically.')
    default:
      return t('Session compute settings could not be read. Dispatch retries automatically.')
  }
}
