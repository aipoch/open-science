import { AlertCircle } from 'lucide-react'
import { ErrorNotice, type ErrorNoticeProps } from '@/components/error-notice'

/** Recoverable library errors share a compact surface; field validation stays by its input. */
export function LiteratureErrorNotice(
  props: Omit<ErrorNoticeProps, 'showBrand'>
): React.JSX.Element {
  return (
    <div role="alert" className="rounded-lg border border-border bg-bg-000 p-3">
      <ErrorNotice icon={AlertCircle} tone="amber" {...props} showBrand={false} />
    </div>
  )
}
