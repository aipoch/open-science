import { CheckCircle2, Pencil, PlugZap, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { ProviderView } from '../../../../shared/settings'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type ProviderListProps = {
  providers: ProviderView[]
  // Id of the currently selected provider (the one requests are routed through).
  activeProviderId: string | undefined
  busyProviderId?: string
  onEdit: (provider: ProviderView) => void
  onDelete: (provider: ProviderView) => void
  onSetActive: (provider: ProviderView) => void
  onTest: (provider: ProviderView) => void
}

type IconActionButtonProps = {
  // Accessible name and hover tooltip text (kept identical so the hover label is also the a11y name).
  label: string
  icon: LucideIcon
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

// Human label for a provider type badge.
const describeType = (type: ProviderView['type']): string =>
  type === 'custom' ? 'Custom' : 'Local Claude'

// An icon-only row action with a hover tooltip. The label is exposed via aria-label for accessibility
// and shown on hover via the shared tooltip so the actions row stays compact.
const IconActionButton = ({
  label,
  icon: Icon,
  onClick,
  disabled = false,
  danger = false
}: IconActionButtonProps): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'inline-flex size-7 items-center justify-center rounded-lg border border-border text-foreground transition-colors hover:bg-muted',
          danger && 'text-destructive hover:bg-destructive/10 hover:text-destructive',
          // Disabled actions read as inert gray with no hover affordance (e.g. delete on the selected provider).
          'disabled:pointer-events-none disabled:border-border disabled:text-muted-foreground disabled:opacity-50'
        )}
      >
        <Icon className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
)

// Lists configured providers with their type, masked key, and model. Each row leads with the
// select/selected control, followed by compact icon actions (test / edit / delete) with hover
// tooltips. Shared by the settings page (the onboarding wizard uses the form directly).
const ProviderList = ({
  providers,
  activeProviderId,
  busyProviderId,
  onEdit,
  onDelete,
  onSetActive,
  onTest
}: ProviderListProps): React.JSX.Element => {
  if (providers.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No providers yet. Add one to choose your model source.
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={200}>
      <ul className="space-y-2">
        {providers.map((provider) => {
          const isSelected = provider.id === activeProviderId
          const isBusy = provider.id === busyProviderId
          // The selected provider (and the last remaining one) can't be deleted: removing the active
          // provider would drop the app back to onboarding, so its delete action stays disabled.
          const canDelete = !isSelected && providers.length > 1

          return (
            <li key={provider.id} className="rounded-xl border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {provider.name}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {describeType(provider.type)}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {provider.type === 'custom' ? (
                      <>
                        {provider.model ? (
                          <div className="truncate">Model: {provider.model}</div>
                        ) : null}
                        {provider.maskedKey ? (
                          <div className="font-mono">Key: {provider.maskedKey}</div>
                        ) : null}
                        {provider.needsKey ? (
                          <div className="text-destructive">Key needs re-entry</div>
                        ) : null}
                      </>
                    ) : (
                      // Local Claude reuses the machine's own auth: show only the model (never a key).
                      <div className="truncate">Model: {provider.model || 'default'}</div>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {/* First action is always the select control: a marker when selected, a button otherwise. */}
                {isSelected ? (
                  <span className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                    <CheckCircle2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    Selected
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onSetActive(provider)}
                    className="rounded-lg border border-primary px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                  >
                    Select
                  </button>
                )}
                <IconActionButton
                  label="Test connection"
                  icon={PlugZap}
                  onClick={() => onTest(provider)}
                  disabled={isBusy}
                />
                <IconActionButton label="Edit" icon={Pencil} onClick={() => onEdit(provider)} />
                <IconActionButton
                  label="Delete"
                  icon={Trash2}
                  onClick={() => onDelete(provider)}
                  disabled={!canDelete}
                  danger
                />
              </div>
            </li>
          )
        })}
      </ul>
    </TooltipProvider>
  )
}

export { ProviderList }
