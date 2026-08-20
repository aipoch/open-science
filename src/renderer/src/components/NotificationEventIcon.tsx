import { CircleAlert, CircleCheck, ShieldCheck } from 'lucide-react'

import type { NotificationInboxItem } from '../../../shared/notifications'

const NotificationEventIcon = ({
  notification
}: Readonly<{ notification: NotificationInboxItem }>): React.JSX.Element => {
  if (notification.kind === 'authorization.required') {
    return <ShieldCheck className="size-4" strokeWidth={2} aria-hidden="true" />
  }
  if (notification.kind === 'task.completed') {
    return <CircleCheck className="size-4" strokeWidth={2} aria-hidden="true" />
  }
  return <CircleAlert className="size-4" strokeWidth={2} aria-hidden="true" />
}

export { NotificationEventIcon }
