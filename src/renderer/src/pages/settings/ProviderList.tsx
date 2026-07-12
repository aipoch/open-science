import { Pencil, PlugZap, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { ProviderView } from '../../../../shared/settings'
import { getOfficialVendor } from '../../../../shared/provider-registry'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'

type ProviderListProps = {
  providers: ProviderView[]
  // Provider that sources the currently selected model. Not shown as an "active provider"; used only
  // to keep the in-use provider from being deleted (which would leave no selectable model).
  activeProviderId: string | undefined
  busyProviderId?: string
  onEdit: (provider: ProviderView) => void
  onDelete: (provider: ProviderView) => void
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

// Human label for a provider type badge: the vendor name for official providers, else a type name.
const describeType = (provider: ProviderView): string => {
  if (provider.type === 'custom') return 'Custom'
  if (provider.type === 'claude-default') return 'Local Claude'

  return provider.vendorId
    ? (getOfficialVendor(provider.vendorId)?.label ?? 'Official')
    : 'Official'
}

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
          const isActiveSource = provider.id === activeProviderId
          const isBusy = provider.id === busyProviderId
          // The provider sourcing the selected model (and the last remaining one) can't be deleted:
          // removing it would leave no model to run, so its delete action stays disabled.
          const canDelete = !isActiveSource && providers.length > 1

          return (
            <li key={provider.id} className="rounded-xl border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {provider.name}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <ProviderKindIcon
                        kindKey={providerKindKey(provider.type, provider.vendorId)}
                        className="size-3"
                      />
                      {describeType(provider)}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {provider.type === 'claude-default' ? (
                      // Local Claude reuses the machine's own auth: show only the model (never a key).
                      <div className="truncate">Model: {provider.model || 'default'}</div>
                    ) : (
                      // custom + official both authenticate with a key; official's models come from its
                      // catalog (shown as a count) rather than a single stored model.
                      <>
                        {provider.type === 'custom' && provider.model ? (
                          <div className="truncate">Model: {provider.model}</div>
                        ) : null}
                        {provider.type === 'official' && provider.models.length > 0 ? (
                          <div className="truncate">{provider.models.length} models</div>
                        ) : null}
                        {provider.maskedKey ? (
                          <div className="font-mono">Key: {provider.maskedKey}</div>
                        ) : null}
                        {provider.needsKey ? (
                          <div className="text-destructive">Key needs re-entry</div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
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
