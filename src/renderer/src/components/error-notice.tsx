import { Notice, type NoticeProps, type NoticeButtonProps } from './notice'
import type { ErrorNoticeTone, NoticeLevel } from './ui/notice-chrome'

// Preserve the existing public error API while all surfaces use the same Notice renderer.
type ErrorNoticeProps = NoticeProps & { tone?: ErrorNoticeTone }
const levels: Record<ErrorNoticeTone, NoticeLevel> = {
  teal: 'info',
  amber: 'warning',
  red: 'error'
}
const ErrorNotice = ({ tone = 'amber', level, ...props }: ErrorNoticeProps): React.JSX.Element => (
  <Notice {...props} level={level ?? levels[tone]} />
)

export { ErrorNotice }
export type { ErrorNoticeProps, NoticeButtonProps as ErrorNoticeButton, ErrorNoticeTone }
