import { Check, ChevronDown } from 'lucide-react'

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
  selectProviderModelOptions,
  useSettingsStore,
  type ProviderModelOption
} from '@/stores/settings-store'

const triggerClassName =
  'flex h-8 max-w-[220px] items-center gap-1 rounded-md px-2.5 text-sm text-text-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors'

// Label for an option: the model name, or the provider name when the option carries no concrete model
// (a claude-default without an override).
const optionLabel = (option: ProviderModelOption): string => option.model || option.providerName

// Model/provider switcher shown in the composer toolbar. Reads the settings store directly (the store
// is global) so the presentational ConversationPanel needn't thread provider state through. Renders
// nothing unless there's more than one selectable (provider, model) — with a single option there's
// nothing to switch between.
const ComposerModelPicker = (): React.JSX.Element | null => {
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const activeModel = useSettingsStore((state) => state.activeModel)
  const setActiveProvider = useSettingsStore((state) => state.setActiveProvider)

  const options = selectProviderModelOptions(providers)

  if (options.length <= 1) return null

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
        {groups.map((group) => (
          <DropdownMenuGroup key={group.provider.id}>
            <DropdownMenuLabel>{group.provider.name}</DropdownMenuLabel>
            {group.options.map((option) => {
              const isActive =
                option.providerId === activeProviderId && option.model === activeKeyModel

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
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ComposerModelPicker }
