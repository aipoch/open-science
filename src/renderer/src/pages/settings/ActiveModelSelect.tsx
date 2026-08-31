import { useTranslation } from 'react-i18next'

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import {
  buildConfiguredModelCatalog,
  parseConfiguredModelKey
} from '../../../../shared/configured-model-catalog'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'
import { modelUnavailableReason } from '../workspace/composer-model-picker-utils'

// The single "active model" selector for settings: one selected model, grouped and tagged by its
// source provider. Mirrors the composer picker (both drive activeProviderId + activeModel), so
// changing it here changes what the composer shows and vice versa. Hidden until a model exists.
const ActiveModelSelect = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (state) => state.claudeSubscriptionProviderId
  )
  const activeModel = useSettingsStore((state) => state.activeModel)
  const setActiveProvider = useSettingsStore((state) => state.setActiveProvider)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const frameworkName =
    agentFrameworks.find((framework) => framework.id === agentFrameworkId)?.displayName ??
    agentFrameworkId

  const options = buildConfiguredModelCatalog({
    providers,
    activeProviderId,
    claudeSubscriptionProviderId,
    frameworkId: agentFrameworkId,
    frameworkEndpoints
  })

  if (options.length === 0) return null

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
      value={current?.key}
      onValueChange={(value) => {
        const identity = parseConfiguredModelKey(value)
        if (identity)
          void setActiveProvider(identity.providerId, identity.model).catch(() => undefined)
      }}
    >
      <SelectTrigger aria-label={t('Main model')}>
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
            t('Select a model')
          )}
        </span>
      </SelectTrigger>
      <SelectContent>
        {groups.map((group) => {
          const compatible = group.options.some((option) => option.selectable)

          return (
            <SelectGroup key={group.provider.id}>
              <SelectLabel>
                {group.provider.name}
                {compatible ? null : (
                  <span className="ml-1 font-normal text-muted-foreground">
                    {t('· not usable with this framework')}
                  </span>
                )}
              </SelectLabel>
              {group.options.map((option) => {
                if (option.selectable) {
                  return (
                    <SelectItem
                      key={option.key}
                      value={option.key}
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
                }

                const reason = modelUnavailableReason(
                  option,
                  group.provider,
                  frameworkName,
                  frameworkEndpoints,
                  t
                )

                return (
                  <TooltipProvider key={option.key} delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SelectItem
                          value={option.key}
                          disabled
                          aria-label={reason}
                          className="data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed"
                          icon={
                            <ProviderKindIcon
                              kindKey={providerKindKey(option.providerType, option.vendorId)}
                              className="size-4"
                            />
                          }
                        >
                          {option.model || option.providerName}
                        </SelectItem>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-72 leading-5">
                        {reason}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
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
