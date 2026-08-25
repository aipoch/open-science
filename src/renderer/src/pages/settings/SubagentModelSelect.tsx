import { useTranslation } from 'react-i18next'

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
  parseConfiguredModelKey,
  type ConfiguredModelCatalogEntry
} from '../../../../shared/configured-model-catalog'
import { resolveProviderReasoningEffortProfile } from '../../../../shared/provider-reasoning-effort'
import {
  projectReasoningEffortIntent,
  resolveReasoningEffortControl
} from '../../../../shared/reasoning-effort'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'
import { SettingsField, SettingsRow } from './SettingsLayout'
import {
  isCodexSubscriptionProvider,
  type SubagentModelConfiguration
} from '../../../../shared/settings'

const INHERIT_KEY = 'same-as-main-model'

type ModelPolicySelectProps = Readonly<{
  modelAriaLabel: string
  reasoningEffortAriaLabel: string
  inheritLabel: string
  configuration: SubagentModelConfiguration
  pending: boolean
  setConfiguration: (configuration: SubagentModelConfiguration) => Promise<void>
  entryFilter?: (entry: ConfiguredModelCatalogEntry) => boolean
}>

const ModelPolicySelect = ({
  modelAriaLabel,
  reasoningEffortAriaLabel,
  inheritLabel,
  configuration,
  pending,
  setConfiguration,
  entryFilter
}: ModelPolicySelectProps): React.JSX.Element => {
  const { t } = useTranslation()
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (state) => state.claudeSubscriptionProviderId
  )
  const frameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const catalog = buildConfiguredModelCatalog({
    providers,
    activeProviderId,
    claudeSubscriptionProviderId,
    frameworkId,
    frameworkEndpoints
  })
  const eligibleCatalog = entryFilter ? catalog.filter(entryFilter) : catalog
  const selectedKey =
    configuration.mode === 'inherit'
      ? INHERIT_KEY
      : configuredModelKey(configuration.providerId, configuration.model)
  const selectedEntry =
    configuration.mode === 'fixed'
      ? eligibleCatalog.find((entry) => entry.key === selectedKey && entry.selectable)
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
      entries: eligibleCatalog.filter(
        (entry) => entry.providerId === provider.id && entry.selectable && entry.model
      )
    }))
    .filter((group) => group.entries.length > 0)
  const unavailable = configuration.mode === 'fixed' && !selectedEntry

  return (
    <SettingsRow layout="model-effort">
      <SettingsField label={t('Model')}>
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
              identity &&
              eligibleCatalog.find((candidate) => candidate.key === key && candidate.selectable)
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
          <SelectTrigger aria-label={modelAriaLabel}>
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
                  {configuration.model} · {configuration.providerId} · {t('Unavailable')}
                </span>
              ) : (
                <span className="truncate">{inheritLabel}</span>
              )}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_KEY}>{inheritLabel}</SelectItem>
            {unavailable ? (
              <SelectItem value={selectedKey} disabled>
                {configuration.model} · {configuration.providerId} · {t('Unavailable')}
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

      <SettingsField label={t('Reasoning effort')}>
        {configuration.mode === 'inherit' ? (
          <Select value={INHERIT_KEY} disabled>
            <SelectTrigger aria-label={reasoningEffortAriaLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT_KEY}>{inheritLabel}</SelectItem>
            </SelectContent>
          </Select>
        ) : effortProfile && !effortProfile.supported ? (
          <Select value="not-supported" disabled>
            <SelectTrigger aria-label={reasoningEffortAriaLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="not-supported">{t('Not supported')}</SelectItem>
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
            <SelectTrigger aria-label={reasoningEffortAriaLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t('Default')}</SelectItem>
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

const SubagentModelSelect = (): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <ModelPolicySelect
      modelAriaLabel={t('Subagent model Model')}
      reasoningEffortAriaLabel={t('Subagent model Reasoning effort')}
      inheritLabel={t('Same as main model')}
      configuration={useSettingsStore((state) => state.subagentModel)}
      pending={useSettingsStore((state) => state.subagentModelPending)}
      setConfiguration={useSettingsStore((state) => state.setSubagentModel)}
    />
  )
}

const ReviewerModelSelect = (): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <ModelPolicySelect
      modelAriaLabel={t('Reviewer model Model')}
      reasoningEffortAriaLabel={t('Reviewer model Reasoning effort')}
      inheritLabel={t('Follow main model')}
      configuration={useSettingsStore((state) => state.reviewerModel)}
      pending={useSettingsStore((state) => state.reviewerModelPending)}
      setConfiguration={useSettingsStore((state) => state.setReviewerModel)}
    />
  )
}

const VisionModelSelect = (): React.JSX.Element => {
  const { t } = useTranslation()
  const configuration = useSettingsStore((state) => state.visionModel)
  const setVisionModel = useSettingsStore((state) => state.setVisionModel)

  return (
    <ModelPolicySelect
      modelAriaLabel={t('Vision model Model')}
      reasoningEffortAriaLabel={t('Vision model Reasoning effort')}
      inheritLabel={t('Not configured')}
      configuration={configuration ? { mode: 'fixed', ...configuration } : { mode: 'inherit' }}
      pending={useSettingsStore((state) => state.visionModelPending)}
      entryFilter={(entry) =>
        entry.supportsImageInput && !isCodexSubscriptionProvider(entry.providerType)
      }
      setConfiguration={(next) =>
        setVisionModel(
          next.mode === 'fixed'
            ? {
                providerId: next.providerId,
                model: next.model,
                reasoningEffort: next.reasoningEffort
              }
            : undefined
        )
      }
    />
  )
}

export { ReviewerModelSelect, SubagentModelSelect, VisionModelSelect }
