export function ProgressBar({
  label,
  value,
  pulse = false
}: {
  label: string
  value?: number
  pulse?: boolean
}): React.JSX.Element {
  const percent =
    value !== undefined && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-bg-300"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
    >
      <div
        className={`h-full origin-left rounded-full bg-primary transition-transform duration-150 ease-out motion-reduce:transition-none ${pulse ? 'animate-pulse' : ''} ${percent === undefined ? 'w-1/3 animate-pulse' : 'w-full'}`}
        style={percent === undefined ? undefined : { transform: `scaleX(${percent / 100})` }}
      />
    </div>
  )
}
