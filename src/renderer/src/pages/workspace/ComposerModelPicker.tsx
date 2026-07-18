import { AlertTriangle, Check, ChevronDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { incompatibilityReason } from './composer-model-picker-utils'

const triggerClassName =
  'flex h-8 max-w-[220px] items-center gap-1 rounded-md px-2.5 text-sm text-text-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors'

// Label for an option: the model name, or the provider name when the option carries no concrete model
// (a claude-default without an override).
const optionLabel = (option: ProviderModelOption): string => option.model || option.providerName

// Model/provider switcher shown in the composer toolbar. Reads the settings store directly (the store
// is global) so the presentational ConversationPanel needn't thread provider state through. With no
// selectable model it shows a warning that opens Settings; with a single option it renders nothing
// (there's nothing to switch between); otherwise it renders the switcher.
const ComposerModelPicker = (): React.JSX.Element | null => {
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const activeModel = useSettingsStore((state) => state.activeModel)
  const setActiveProvider = useSettingsStore((state) => state.setActiveProvider)
  const openSettings = useSettingsStore((state) => state.openSettings)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)

  const frameworkName =
    agentFrameworks.find((framework) => framework.id === agentFrameworkId)?.displayName ??
    'this framework'

  // A provider is selectable only when it can actually drive the current framework (endpoint + type;
  // a Local Claude provider is Claude-only).
  const isCompatible = (provider: (typeof providers)[number]): boolean =>
    isProviderUsableByFramework(
      { apiType: provider.apiType ?? 'anthropic', type: provider.type },
      { id: agentFrameworkId, supportedApiTypes: frameworkEndpoints }
    )

  const options = selectProviderModelOptions(providers)
  const compatibleProviderIds = new Set(
    providers.filter((provider) => isCompatible(provider)).map((provider) => provider.id)
  )
  const usableOptions = options.filter((option) => compatibleProviderIds.has(option.providerId))

  // No option the current framework can actually use: warn instead of hiding so the toolbar isn't a
  // silent dead end (this also catches the case where the only configured provider is incompatible
  // with the selected framework). Clicking opens Settings to add/fix a provider or switch frameworks.
  if (usableOptions.length === 0) {
    const label = options.length === 0 ? 'No model available' : 'No compatible model'

    return (
      <button
        type="button"
        onClick={() => openSettings()}
        className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-amber-700 hover:bg-amber-50 transition-colors"
        aria-label={`${label} — open settings`}
      >
        <AlertTriangle className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </button>
    )
  }

  // A single option (the sole provider, which is usable since usableOptions is non-empty) leaves
  // nothing to switch between, so the picker stays hidden.
  if (options.length === 1) return null

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
        <Button variant="ghost" className={triggerClassName} aria-label="Select model">
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
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[320px] min-w-[15rem] overflow-y-auto">
        {groups.map((group) => {
          const compatible = isCompatible(group.provider)

          return (
            <DropdownMenuGroup key={group.provider.id}>
              <DropdownMenuLabel>
                {group.provider.name}
                {compatible ? null : (
                  <span
                    className="ml-1 cursor-help font-normal text-text-300 underline decoration-dotted underline-offset-2"
                    title={incompatibilityReason(
                      {
                        apiType: group.provider.apiType ?? 'anthropic',
                        type: group.provider.type,
                        name: group.provider.name
                      },
                      frameworkName,
                      frameworkEndpoints
                    )}
                  >
                    · unavailable
                  </span>
                )}
              </DropdownMenuLabel>
              {group.options.map((option) => {
                const isActive =
                  option.providerId === activeProviderId && option.model === activeKeyModel

                return (
                  <DropdownMenuItem
                    key={`${option.providerId}:${option.model}`}
                    role="menuitemradio"
                    aria-checked={isActive}
                    disabled={!compatible}
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
              })}
            </DropdownMenuGroup>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ComposerModelPicker }
