// Per-session Auto-review toggle for the composer toolbar.
// Mirrors the shape of ComposerPermissionProfilePicker: a single button that calls onChange
// with the new boolean value. Default state is on (true); absent (older sessions) also means on.
// On/off is made legible by color, not just opacity: on = teal shield (--primary) + near-black
// label; off = greyed shield + muted label. (The earlier off style used text-text-400, an
// undefined theme token, so off looked almost identical to on.)

import { ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

type ComposerAutoReviewToggleProps = {
  value: boolean
  disabled?: boolean
  onChange: (enabled: boolean) => void
}

const ComposerAutoReviewToggle = ({
  value,
  disabled = false,
  onChange
}: ComposerAutoReviewToggleProps): React.JSX.Element => {
  const handleClick = (): void => {
    if (disabled) return
    onChange(!value)
  }

  return (
    <button
      type="button"
      className={cn(
        'flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-200 ease-out hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50',
        value ? 'font-medium text-text-000' : 'text-text-300 hover:text-text-100'
      )}
      aria-label={value ? 'Auto-review on — click to disable' : 'Auto-review off — click to enable'}
      aria-pressed={value}
      disabled={disabled}
      onClick={handleClick}
    >
      <ShieldCheck
        className={cn('size-3.5 shrink-0', value ? 'text-primary' : 'opacity-55')}
        strokeWidth={2}
        aria-hidden="true"
      />
      <span className="max-w-32 truncate @max-[28rem]/composer:hidden">Auto-review</span>
    </button>
  )
}

export { ComposerAutoReviewToggle }
