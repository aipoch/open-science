import type {
  NotificationMarkAllReadRequest,
  NotificationMarkReadRequest
} from '../../shared/notifications'

const requireNotificationMarkReadRequest = (value: unknown): NotificationMarkReadRequest => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { ids?: unknown }).ids) ||
    !(value as { ids: unknown[] }).ids.every((id) => typeof id === 'string')
  ) {
    throw new Error('Invalid notifications:mark-read request.')
  }
  return value as NotificationMarkReadRequest
}

const requireNotificationMarkAllReadRequest = (value: unknown): NotificationMarkAllReadRequest => {
  const throughSequence = (value as { throughSequence?: unknown } | null)?.throughSequence
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof throughSequence !== 'number' ||
    !Number.isSafeInteger(throughSequence) ||
    throughSequence < 0
  ) {
    throw new Error('Invalid notifications:mark-all-read request.')
  }
  return value as NotificationMarkAllReadRequest
}

export { requireNotificationMarkAllReadRequest, requireNotificationMarkReadRequest }
