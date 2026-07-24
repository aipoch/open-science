import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger
} from '@/components/ui/select'
import {
  selectFrameworkApiEndpoints,
  selectProviderModelOptions,
  useSettingsStore
} from '@/stores/settings-store'
import { isProviderUsableByFramework } from '../../../../shared/settings'
import { isModelBridgeSupported } from '../../../../shared/provider-registry'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'

// Separator for the composite (providerId, model) select value. This unit-separator control char
// never appears in provider ids or model names, so splitting on it is unambiguous.
const SEP = '␟'

// The single "active model" selector for settings: one selected model, grouped and tagged by its
// source provider. Mirrors the composer picker (both drive activeProviderId + activeModel), so
// changing it here changes what the composer shows and vice versa. Hidden until a model exists.
const ActiveModelSelect = (): React.JSX.Element | null => {
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const activeModel = useSettingsStore((state) => state.activeModel)
  const setActiveProvider = useSettingsStore((state) => state.setActiveProvider)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)

  const options = selectProviderModelOptions(providers)

  if (options.length === 0) return null

  // A provider is selectable only when it can actually drive the current framework (endpoint + type).
  const isCompatible = (provider: (typeof providers)[number], model: string): boolean =>
    isProviderUsableByFramework(
      { apiEndpoints: provider.apiEndpoints, type: provider.type },
      { id: agentFrameworkId, supportedApiTypes: frameworkEndpoints }
    ) &&
    (agentFrameworkId !== 'codex' || isModelBridgeSupported(provider, model))

  const activeKeyModel = activeModel ?? ''
  const current = options.find(
    (option) => option.providerId === activeProviderId && option.model === activeKeyModel
  )

  const groups = providers
    .map((provider) => ({
      provider,
      options: options.filter((option) => option.providerId === provider.id)
    }))
    .filter((group) => group.options.length > 0)

  return (
    <Select
      value={current ? `${current.providerId}${SEP}${current.model}` : undefined}
      onValueChange={(value) => {
        const [providerId, model] = value.split(SEP)
        void setActiveProvider(providerId, model)
      }}
    >
      <SelectTrigger aria-label="Active model">
        <span className="flex items-center gap-2 truncate">
          {current ? (
            <>
              <ProviderKindIcon
                kindKey={providerKindKey(current.providerType, current.vendorId)}
                className="size-4"
              />
              <span className="truncate">
                {current.model || current.providerName}
                <span className="ml-1.5 text-muted-foreground">· {current.providerName}</span>
              </span>
            </>
          ) : (
            'Select a model'
          )}
        </span>
      </SelectTrigger>
      <SelectContent>
        {groups.map((group) => {
          const compatible = group.options.some((option) =>
            isCompatible(group.provider, option.model)
          )

          return (
            <SelectGroup key={group.provider.id}>
              <SelectLabel>
                {group.provider.name}
                {compatible ? null : (
                  <span className="ml-1 font-normal text-muted-foreground">
                    · not usable with this framework
                  </span>
                )}
              </SelectLabel>
              {group.options.map((option) => {
                const optionCompatible = isCompatible(group.provider, option.model)
                return (
                  <SelectItem
                    key={`${option.providerId}${SEP}${option.model}`}
                    value={`${option.providerId}${SEP}${option.model}`}
                    disabled={!optionCompatible}
                    icon={
                      <ProviderKindIcon
                        kindKey={providerKindKey(option.providerType, option.vendorId)}
                        className="size-4"
                      />
                    }
                  >
                    {option.model || option.providerName}
                  </SelectItem>
                )
              })}
            </SelectGroup>
          )
        })}
      </SelectContent>
    </Select>
  )
}

export { ActiveModelSelect }
