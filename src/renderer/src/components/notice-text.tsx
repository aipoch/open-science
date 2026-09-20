import { cn } from '@/lib/utils'

// Short feedback stays on one line. Keep the full text in the DOM and native hover title.
export const NoticeText = ({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element => (
  <span title={text} className={cn('min-w-0 flex-1 text-sm leading-5', className, 'truncate')}>
    {text}
  </span>
)
