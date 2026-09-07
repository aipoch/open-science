import { ErrorNotice, type ErrorNoticeProps } from '@/components/error-notice'

/** Recoverable library errors share a compact surface; field validation stays by its input. */
export function LiteratureErrorNotice(
  props: Omit<ErrorNoticeProps, 'fullPage'>
): React.JSX.Element {
  return (
    <div role="alert">
      <ErrorNotice {...props} />
    </div>
  )
}
