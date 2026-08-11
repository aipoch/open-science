import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import {
  buildConfiguredModelCatalog,
  configuredModelKey,
  parseConfiguredModelKey
} from '../../../../shared/configured-model-catalog'
import { resolveProviderReasoningEffortProfile } from '../../../../shared/provider-reasoning-effort'
import {
  projectReasoningEffortIntent,
  resolveReasoningEffortControl
} from '../../../../shared/reasoning-effort'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'
import { SettingsField, SettingsRow } from './SettingsLayout'

const INHERIT_KEY = 'same-as-main-model'

const SubagentModelSelect = (): React.JSX.Element => {
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (state) => state.claudeSubscriptionProviderId
  )
  const frameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const configuration = useSettingsStore((state) => state.subagentModel)
  const pending = useSettingsStore((state) => state.subagentModelPending)
  const setConfiguration = useSettingsStore((state) => state.setSubagentModel)
  const catalog = buildConfiguredModelCatalog({
    providers,
    activeProviderId,
    claudeSubscriptionProviderId,
    frameworkId,
    frameworkEndpoints
  })
  const selectedKey =
    configuration.mode === 'inherit'
      ? INHERIT_KEY
      : configuredModelKey(configuration.providerId, configuration.model)
  const selectedEntry =
    configuration.mode === 'fixed'
      ? catalog.find((entry) => entry.key === selectedKey && entry.selectable)
      : undefined
  const selectedProvider = selectedEntry
    ? providers.find((provider) => provider.id === selectedEntry.providerId)
    : undefined
  const effortProfile = selectedEntry
    ? resolveProviderReasoningEffortProfile(selectedProvider, selectedEntry.model)
    : undefined
  const effortControl =
    configuration.mode === 'fixed' && effortProfile
      ? resolveReasoningEffortControl(configuration.reasoningEffort, effortProfile)
      : undefined
  const selectedEffortIntent =
    configuration.mode === 'fixed' && configuration.reasoningEffort !== 'default'
      ? (effortControl?.options.find((option) => option.value === effortControl.selectedValue)
          ?.intent ?? configuration.reasoningEffort)
      : configuration.mode === 'fixed'
        ? configuration.reasoningEffort
        : undefined
  const groups = providers
    .map((provider) => ({
      provider,
      entries: catalog.filter(
        (entry) => entry.providerId === provider.id && entry.selectable && entry.model
      )
    }))
    .filter((group) => group.entries.length > 0)
  const unavailable = configuration.mode === 'fixed' && !selectedEntry

  return (
    <SettingsRow layout="model-effort">
      <SettingsField label="Model">
        <Select
          value={selectedKey}
          disabled={pending}
          onValueChange={(key) => {
            if (key === INHERIT_KEY) {
              void setConfiguration({ mode: 'inherit' })
              return
            }
            const identity = parseConfiguredModelKey(key)
            const entry =
              identity && catalog.find((candidate) => candidate.key === key && candidate.selectable)
            if (!entry || !identity || !entry.model) return
            const provider = providers.find((candidate) => candidate.id === identity.providerId)
            const profile = resolveProviderReasoningEffortProfile(provider, identity.model)
            const reasoningEffort =
              configuration.mode === 'fixed' && effortProfile
                ? projectReasoningEffortIntent(
                    configuration.reasoningEffort,
                    effortProfile,
                    profile
                  )
                : 'default'
            void setConfiguration({ mode: 'fixed', ...identity, reasoningEffort })
          }}
        >
          <SelectTrigger aria-label="Subagent model Model">
            <span className="flex items-center gap-2 truncate">
              {configuration.mode === 'fixed' && selectedEntry ? (
                <>
                  <ProviderKindIcon
                    kindKey={providerKindKey(selectedEntry.providerType, selectedEntry.vendorId)}
                    className="size-4"
                  />
                  <span className="truncate">
                    {selectedEntry.label}
                    <span className="ml-1.5 text-muted-foreground">
                      · {selectedEntry.providerName}
                    </span>
                  </span>
                </>
              ) : unavailable ? (
                <span className="truncate">
                  {configuration.model} · {configuration.providerId} · Unavailable
                </span>
              ) : (
                <span className="truncate">Same as main model</span>
              )}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_KEY}>Same as main model</SelectItem>
            {unavailable ? (
              <SelectItem value={selectedKey} disabled>
                {configuration.model} · {configuration.providerId} · Unavailable
              </SelectItem>
            ) : null}
            {groups.map(({ provider, entries }) => (
              <SelectGroup key={provider.id}>
                <SelectLabel>{provider.name}</SelectLabel>
                {entries.map((entry) => (
                  <SelectItem
                    key={entry.key}
                    value={entry.key}
                    icon={
                      <ProviderKindIcon
                        kindKey={providerKindKey(entry.providerType, entry.vendorId)}
                        className="size-4"
                      />
                    }
                  >
                    {entry.label} · {entry.providerName}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </SettingsField>

      <SettingsField label="Reasoning effort">
        {configuration.mode === 'inherit' ? (
          <Select value={INHERIT_KEY} disabled>
            <SelectTrigger aria-label="Subagent model Reasoning effort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT_KEY}>Same as main model</SelectItem>
            </SelectContent>
          </Select>
        ) : effortProfile && !effortProfile.supported ? (
          <Select value="not-supported" disabled>
            <SelectTrigger aria-label="Subagent model Reasoning effort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="not-supported">Not supported</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Select
            value={selectedEffortIntent}
            disabled={pending || unavailable}
            onValueChange={(reasoningEffort) => {
              if (
                reasoningEffort !== 'default' &&
                reasoningEffort !== 'low' &&
                reasoningEffort !== 'medium' &&
                reasoningEffort !== 'high' &&
                reasoningEffort !== 'xhigh' &&
                reasoningEffort !== 'max'
              )
                return
              void setConfiguration({ ...configuration, reasoningEffort })
            }}
          >
            <SelectTrigger aria-label="Subagent model Reasoning effort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default</SelectItem>
              {effortControl?.options.map((option) => (
                <SelectItem key={option.intent} value={option.intent}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsField>
    </SettingsRow>
  )
}

export { SubagentModelSelect }
