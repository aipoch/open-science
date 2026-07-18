import { CircleCheck, Pencil, PlugZap, TriangleAlert, Trash2 } from 'lucide-react'

import type {
  ProviderApiType,
  ProviderValidationFailure,
  ProviderView
} from '../../../../shared/settings'
import { providerValidationFailed } from '../../../../shared/settings'
import { getOfficialVendor } from '../../../../shared/provider-registry'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'
import { SettingsIconAction } from './SettingsLayout'

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

// Concise, actionable reason for a failed connection test, shown on the unverified warning.
const describeValidationFailure = (failure: ProviderValidationFailure): string => {
  switch (failure.category) {
    case 'auth':
      return failure.message
        ? `Test failed: ${failure.message}`
        : 'Test failed: authentication rejected — check the API key.'
    case 'network':
      return 'Test failed: could not reach the endpoint — check the base URL/connection.'
    case 'bad-url':
      return 'Test failed: the base URL looks invalid.'
    case 'model-not-found':
      return 'Test failed: the configured model was not found.'
    case 'timeout':
      return 'Test failed: the connection timed out.'
    default:
      return failure.message ? `Test failed: ${failure.message}` : 'Connection test failed.'
  }
}

// Short label + full description for the chat endpoint a provider speaks. Surfaced as a badge so the
// user can see at a glance which agent frameworks a provider can drive: Claude Code needs the Anthropic
// /v1/messages shape, while OpenCode also accepts the OpenAI /v1/chat/completions shape.
const ENDPOINT_LABELS: Record<ProviderApiType, { short: string; full: string }> = {
  anthropic: { short: 'Anthropic', full: 'Anthropic /v1/messages endpoint' },
  openai: { short: 'OpenAI', full: 'OpenAI-compatible /v1/chat/completions endpoint' },
  both: {
    short: 'Anthropic · OpenAI',
    full: 'both the Anthropic /v1/messages and OpenAI /v1/chat/completions endpoints'
  }
}

// Human label for a provider type badge: the vendor name for official providers, else a type name.
const describeType = (provider: ProviderView): string => {
  if (provider.type === 'custom') return 'Custom'
  if (provider.type === 'claude-default') return 'Local Claude'

  return provider.vendorId
    ? (getOfficialVendor(provider.vendorId)?.label ?? 'Official')
    : 'Official'
}

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
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
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
          // A failed test flags the provider as unverified: it shows a warning here and is excluded
          // from the model pickers until a later test passes.
          const failure = providerValidationFailed(provider)
            ? provider.lastValidationFailure
            : undefined
          // A passing test shows a green check. Suppressed while a test is in flight.
          const isVerified = !failure && !isBusy && provider.lastValidatedAt !== undefined
          // The provider sourcing the selected model (and the last remaining one) can't be deleted:
          // removing it would leave no model to run, so its delete action stays disabled.
          const canDelete = !isActiveSource && providers.length > 1
          // The chat endpoint(s) this provider speaks; defaults to Anthropic when unset (older/custom).
          const endpoint = ENDPOINT_LABELS[provider.apiType ?? 'anthropic']

          return (
            <li
              key={provider.id}
              data-slot="settings-list-row"
              className="rounded-lg border border-border bg-card p-3"
            >
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                          aria-label={`Speaks the ${endpoint.full}`}
                        >
                          {endpoint.short}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Speaks the {endpoint.full}</TooltipContent>
                    </Tooltip>
                    {isBusy ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">Testing…</span>
                    ) : failure ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex shrink-0 text-amber-500"
                            aria-label={describeValidationFailure(failure)}
                          >
                            <TriangleAlert
                              className="size-3.5"
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{describeValidationFailure(failure)}</TooltipContent>
                      </Tooltip>
                    ) : isVerified ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex shrink-0 text-emerald-500"
                            aria-label="Connection verified"
                          >
                            <CircleCheck className="size-3.5" strokeWidth={2} aria-hidden="true" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Connection verified</TooltipContent>
                      </Tooltip>
                    ) : null}
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
                    {failure ? (
                      <div className="text-amber-600 dark:text-amber-500">
                        {describeValidationFailure(failure)}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <SettingsIconAction
                    label="Test connection"
                    icon={PlugZap}
                    onClick={() => onTest(provider)}
                    disabled={isBusy}
                    className="border border-border text-foreground"
                  />
                  <SettingsIconAction
                    label="Edit"
                    icon={Pencil}
                    onClick={() => onEdit(provider)}
                    className="border border-border text-foreground"
                  />
                  <SettingsIconAction
                    label="Delete"
                    icon={Trash2}
                    onClick={() => onDelete(provider)}
                    disabled={!canDelete}
                    className="border border-border"
                    danger
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </TooltipProvider>
  )
}

export { ProviderList }
