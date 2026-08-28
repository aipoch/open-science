import type { NotificationInboxItem } from '../../../shared/notifications'

import { resolveNotificationEventVisual } from './notification-event-visual'

const NotificationEventIcon = ({
  notification
}: Readonly<{ notification: NotificationInboxItem }>): React.JSX.Element => {
  const { Icon } = resolveNotificationEventVisual(notification)
  return <Icon className="size-4" strokeWidth={2} aria-hidden="true" />
}

export { NotificationEventIcon }
