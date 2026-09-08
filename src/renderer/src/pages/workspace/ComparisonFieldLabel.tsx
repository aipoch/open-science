import { FieldHelp } from '@/components/FieldHelp'

export const ComparisonFieldLabel = ({
  htmlFor,
  label,
  help,
  overlayClassName,
  error
}: {
  htmlFor: string
  label: string
  help: string
  overlayClassName?: string
  error?: string
}): React.JSX.Element => (
  <div className="min-w-0">
    <div className="flex min-w-0 items-center gap-1">
      <label htmlFor={htmlFor} className="min-w-0 [overflow-wrap:anywhere]">
        {label}
      </label>
      <span className="shrink-0">
        <FieldHelp content={help} delayDuration={0} contentClassName={overlayClassName} />
      </span>
    </div>
    {error ? (
      <p
        id={`${htmlFor}-error`}
        role="alert"
        className="mt-1 text-status-warning-foreground dark:text-status-warning-dark-foreground"
      >
        {error}
      </p>
    ) : null}
  </div>
)
