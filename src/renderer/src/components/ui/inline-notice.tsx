import type { HTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ErrorNotice } from '../error-notice'
import type { ErrorNoticeTone, NoticeLevel } from './notice-chrome'

// Existing contextual callers share the Notice renderer; no separate inset layout or styling.
const InlineNotice = ({
  children,
  role = 'note',
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'role'> & {
  role?: 'note' | 'alert' | 'status'
  tone?: ErrorNoticeTone
  level?: NoticeLevel
  icon?: LucideIcon
}): React.JSX.Element => <ErrorNotice {...props} role={role} content={children} />

export { InlineNotice }
