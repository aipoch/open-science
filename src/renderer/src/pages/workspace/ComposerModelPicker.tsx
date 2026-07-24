import { AlertTriangle, Check, ChevronDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ProviderKindIcon } from '../settings/provider-icons'
import { providerKindKey } from '../settings/provider-form-value'
import {
  selectFrameworkApiEndpoints,
  selectProviderModelOptions,
  useSettingsStore,
  type ProviderModelOption
} from '@/stores/settings-store'
import { isProviderUsableByFramework } from '../../../../shared/settings'
import { isModelBridgeSupported } from '../../../../shared/provider-registry'
import { incompatibilityReason } from './composer-model-picker-utils'

const triggerClassName =
  'flex h-8 max-w-[220px] items-center gap-1 rounded-md px-2.5 text-sm text-text-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors'

// Label for an option: the model name, or the provider name when the option carries no concrete model.
const optionLabel = (option: ProviderModelOption): string => option.model || option.providerName

// Model/provider switcher shown in the composer toolbar. Reads the settings store directly (the store
// is global) so the presentational ConversationPanel needn't thread provider state through. With no
// selectable model it shows a warning that opens Settings; with a single option it renders nothing
// (there's nothing to switch between); otherwise it renders the switcher.
const ComposerModelPicker = (): React.JSX.Element | null => {
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (state) => state.claudeSubscriptionProviderId
  )
  const activeModel = useSettingsStore((state) => state.activeModel)
  const setActiveProvider = useSettingsStore((state) => state.setActiveProvider)
  const openSettings = useSettingsStore((state) => state.openSettings)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)

  const frameworkName =
    agentFrameworks.find((framework) => framework.id === agentFrameworkId)?.displayName ??
    'this framework'

  // A provider is selectable only when it can actually drive the current framework (endpoint + type).
  const isCompatible = (provider: (typeof providers)[number], model: string): boolean =>
    isProviderUsableByFramework(
      { apiEndpoints: provider.apiEndpoints, type: provider.type },
      { id: agentFrameworkId, supportedApiTypes: frameworkEndpoints }
    ) &&
    (agentFrameworkId !== 'codex' || isModelBridgeSupported(provider, model))

  const options = selectProviderModelOptions(
    providers,
    activeProviderId,
    claudeSubscriptionProviderId
  )
  const usableOptions = options.filter((option) => {
    const provider = providers.find((candidate) => candidate.id === option.providerId)
    return provider ? isCompatible(provider, option.model) : false
  })
  const hasUsable = usableOptions.length > 0

  // No provider configured at all: nothing to pick or explain, so warn with a button that opens
  // Settings rather than leaving the toolbar a silent dead end.
  if (options.length === 0) {
    return (
      <button
        type="button"
        onClick={() => openSettings()}
        className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-amber-700 hover:bg-amber-50 transition-colors"
        aria-label="No model available — open settings"
      >
        <AlertTriangle className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="truncate">No model available</span>
      </button>
    )
  }

  // A single usable option leaves nothing to switch between, so the picker stays hidden. When the
  // sole provider is incompatible we instead fall through to the dropdown (hasUsable is false) so its
  // incompatibility reason stays reachable — an all-incompatible framework must never silently vanish.
  if (options.length === 1 && hasUsable) return null

  // The active option matches by provider and model; an undefined activeModel maps to the empty-model
  // "default" entry.
  const activeKeyModel = activeModel ?? ''
  const current = options.find(
    (option) => option.providerId === activeProviderId && option.model === activeKeyModel
  )

  // Group options by provider so official vendors show their catalog under one heading.
  const groups = providers
    .map((provider) => ({
      provider,
      options: options.filter((option) => option.providerId === provider.id)
    }))
    .filter((group) => group.options.length > 0)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(triggerClassName, !hasUsable && 'text-amber-700 hover:text-amber-700')}
          aria-label={hasUsable ? 'Select model' : 'No compatible model'}
        >
          {hasUsable ? (
            <>
              {current ? (
                <ProviderKindIcon
                  kindKey={providerKindKey(current.providerType, current.vendorId)}
                  className="size-4"
                />
              ) : null}
              <span className="truncate">
                {current ? (
                  <>
                    <span className="font-medium text-text-100">{optionLabel(current)}</span>
                    {current.model ? (
                      <span className="ml-1.5 text-text-300">· {current.providerName}</span>
                    ) : null}
                  </>
                ) : (
                  'Select model'
                )}
              </span>
            </>
          ) : (
            <>
              <AlertTriangle className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="truncate">No compatible model</span>
            </>
          )}
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[320px] min-w-[15rem] overflow-y-auto">
        {groups.map((group) => {
          const compatible = group.options.some((option) =>
            isCompatible(group.provider, option.model)
          )
          const endpointCompatible = isProviderUsableByFramework(
            {
              apiEndpoints: group.provider.apiEndpoints,
              type: group.provider.type
            },
            { id: agentFrameworkId, supportedApiTypes: frameworkEndpoints }
          )
          const reason = compatible
            ? undefined
            : endpointCompatible && agentFrameworkId === 'codex'
              ? `No model from ${group.provider.name} is supported over the Codex Chat Completions bridge.`
              : incompatibilityReason(
                  {
                    apiEndpoints: group.provider.apiEndpoints,
                    type: group.provider.type,
                    name: group.provider.name
                  },
                  frameworkName,
                  frameworkEndpoints
                )

          return (
            <DropdownMenuGroup key={group.provider.id}>
              <DropdownMenuLabel>{group.provider.name}</DropdownMenuLabel>
              {compatible ? (
                group.options.map((option) => {
                  const isActive =
                    option.providerId === activeProviderId && option.model === activeKeyModel
                  const optionCompatible = isCompatible(group.provider, option.model)

                  if (!optionCompatible) {
                    // Endpoint is fine but this model is statically marked unsupported over the Codex
                    // bridge. Grey it with a warning icon; the full reason is on hover (title) and read
                    // by assistive tech (aria-label), so it isn't a long inline string.
                    const optionReason = `${optionLabel(option)} is not supported over the Codex Chat Completions bridge.`
                    return (
                      <DropdownMenuItem
                        key={`${option.providerId}:${option.model}`}
                        aria-disabled
                        aria-label={optionReason}
                        title={optionReason}
                        onSelect={(event) => event.preventDefault()}
                        className="gap-2 text-text-300"
                      >
                        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{optionLabel(option)}</span>
                        <span className="text-xs">unsupported</span>
                      </DropdownMenuItem>
                    )
                  }

                  return (
                    <DropdownMenuItem
                      key={`${option.providerId}:${option.model}`}
                      role="menuitemradio"
                      aria-checked={isActive}
                      onSelect={() => void setActiveProvider(option.providerId, option.model)}
                      className={cn('gap-2', isActive && 'font-medium')}
                    >
                      <ProviderKindIcon
                        kindKey={providerKindKey(option.providerType, option.vendorId)}
                        className="size-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate">{optionLabel(option)}</span>
                      {isActive ? (
                        <Check
                          className="size-4 shrink-0 text-primary"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                      ) : null}
                    </DropdownMenuItem>
                  )
                })
              ) : (
                // An incompatible provider gets one greyed, non-actionable row: a short "Unavailable"
                // label + warning icon, with the full reason on hover (title) and exposed to assistive
                // tech (aria-label) — so the dropdown stays compact instead of wrapping a long
                // sentence. It stays keyboard-reachable via roving focus (a `disabled` item is skipped,
                // and a label is not focusable), aria-disabled marks it unselectable, and onSelect is
                // prevented so it never switches the model.
                <DropdownMenuItem
                  aria-disabled
                  aria-label={reason}
                  title={reason}
                  onSelect={(event) => event.preventDefault()}
                  className="gap-2 text-text-300"
                >
                  <AlertTriangle className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">Unavailable for {frameworkName}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          )
        })}
        {hasUsable ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openSettings()}>Open Settings</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ComposerModelPicker }
