import type { HTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ErrorNotice } from '../error-notice'
import type { ErrorNoticeTone, NoticeLevel } from './notice-chrome'

// Contextual guidance shares Notice semantics without adding a nested card.
const InlineNotice = ({
  children,
  role = 'note',
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'role'> & {
  role?: 'note' | 'alert' | 'status'
  tone?: ErrorNoticeTone
  level?: NoticeLevel
  icon?: LucideIcon
}): React.JSX.Element => <ErrorNotice {...props} inline role={role} content={children} />

export { InlineNotice }
