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
import { isCodexSubscriptionProvider, type ReasoningEffort } from '../../../../shared/settings'

const INHERIT_KEY = 'same-as-main-model'
const DISABLED_KEY = 'not-configured'

type EnabledModelPolicyConfiguration =
  | Readonly<{ mode: 'inherit'; reasoningEffort?: ReasoningEffort }>
  | Readonly<{
      mode: 'fixed'
      providerId: string
      model: string
      reasoningEffort: ReasoningEffort
    }>

type ModelPolicyConfiguration = EnabledModelPolicyConfiguration | Readonly<{ mode: 'disabled' }>

type ModelPolicySelectBaseProps = Readonly<{
  modelAriaLabel: string
  reasoningEffortAriaLabel: string
  inheritLabel: string
  pending: boolean
  entryFilter?: (entry: ConfiguredModelCatalogEntry) => boolean
}>

type ModelPolicySelectProps = ModelPolicySelectBaseProps &
  (
    | Readonly<{
        variant: 'standard'
        configuration: EnabledModelPolicyConfiguration
        setConfiguration: (configuration: EnabledModelPolicyConfiguration) => Promise<void>
      }>
    | Readonly<{
        variant: 'session-details'
        configuration: ModelPolicyConfiguration
        setConfiguration: (configuration: ModelPolicyConfiguration) => Promise<void>
        disabledLabel: string
      }>
  )

const ModelPolicySelect = (props: ModelPolicySelectProps): React.JSX.Element => {
  const {
    modelAriaLabel,
    reasoningEffortAriaLabel,
    inheritLabel,
    configuration,
    pending,
    entryFilter
  } = props
  const { t } = useTranslation()
  const isSessionDetails = props.variant === 'session-details'
  const disabledLabel = isSessionDetails ? props.disabledLabel : undefined
  const defaultReasoningEffort = isSessionDetails ? 'low' : 'default'
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
      : configuration.mode === 'disabled'
        ? DISABLED_KEY
        : configuredModelKey(configuration.providerId, configuration.model)
  const selectedEntry =
    configuration.mode === 'fixed'
      ? eligibleCatalog.find((entry) => entry.key === selectedKey && entry.selectable)
      : undefined
  const selectedProvider = selectedEntry
    ? providers.find((provider) => provider.id === selectedEntry.providerId)
    : undefined
  const activeProvider = providers.find((provider) => provider.id === activeProviderId)
  const activeModel = useSettingsStore((state) => state.activeModel) ?? activeProvider?.model
  const effortProvider = configuration.mode === 'inherit' ? activeProvider : selectedProvider
  const effortModel = configuration.mode === 'inherit' ? activeModel : selectedEntry?.model
  const effortProfile = effortModel
    ? resolveProviderReasoningEffortProfile(effortProvider, effortModel)
    : undefined
  const configuredEffort =
    configuration.mode === 'disabled'
      ? undefined
      : (configuration.reasoningEffort ?? defaultReasoningEffort)
  const effortControl =
    configuration.mode !== 'disabled' &&
    (configuration.mode === 'fixed' || isSessionDetails) &&
    effortProfile
      ? resolveReasoningEffortControl(configuredEffort ?? defaultReasoningEffort, effortProfile)
      : undefined
  const selectedEffortIntent =
    configuration.mode !== 'disabled' && configuredEffort !== 'default'
      ? (effortControl?.options.find((option) => option.value === effortControl.selectedValue)
          ?.intent ?? configuredEffort)
      : configuration.mode !== 'disabled'
        ? configuredEffort
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
              void props.setConfiguration(
                isSessionDetails
                  ? {
                      mode: 'inherit',
                      reasoningEffort:
                        configuration.mode === 'disabled'
                          ? defaultReasoningEffort
                          : (configuration.reasoningEffort ?? defaultReasoningEffort)
                    }
                  : { mode: 'inherit' }
              )
              return
            }
            if (key === DISABLED_KEY && props.variant === 'session-details') {
              void props.setConfiguration({ mode: 'disabled' })
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
              configuration.mode !== 'disabled' && effortProfile
                ? isSessionDetails && (!effortProfile.supported || !profile.supported)
                  ? (configuredEffort ?? defaultReasoningEffort)
                  : projectReasoningEffortIntent(
                      configuredEffort ?? defaultReasoningEffort,
                      effortProfile,
                      profile
                    )
                : defaultReasoningEffort
            void props.setConfiguration({ mode: 'fixed', ...identity, reasoningEffort })
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
              ) : configuration.mode === 'disabled' ? (
                <span className="truncate">{disabledLabel}</span>
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
            {disabledLabel ? <SelectItem value={DISABLED_KEY}>{disabledLabel}</SelectItem> : null}
          </SelectContent>
        </Select>
      </SettingsField>
      <SettingsField label={t('Reasoning effort')}>
        {configuration.mode === 'disabled' ? (
          <Select value={DISABLED_KEY} disabled>
            <SelectTrigger aria-label={reasoningEffortAriaLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DISABLED_KEY}>{disabledLabel}</SelectItem>
            </SelectContent>
          </Select>
        ) : configuration.mode === 'inherit' && !isSessionDetails ? (
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
              void props.setConfiguration({ ...configuration, reasoningEffort })
            }}
          >
            <SelectTrigger aria-label={reasoningEffortAriaLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!isSessionDetails ? <SelectItem value="default">{t('Default')}</SelectItem> : null}
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
      variant="standard"
      modelAriaLabel={t('Subagent model Model')}
      reasoningEffortAriaLabel={t('Subagent model Reasoning effort')}
      inheritLabel={t('Same as main model')}
      configuration={useSettingsStore((state) => state.subagentModel)}
      pending={useSettingsStore((state) => state.subagentModelPending)}
      setConfiguration={(next) =>
        useSettingsStore.getState().setSubagentModel(
          next.mode === 'inherit'
            ? { mode: 'inherit' }
            : {
                mode: 'fixed',
                providerId: next.providerId,
                model: next.model,
                reasoningEffort: next.reasoningEffort
              }
        )
      }
    />
  )
}

const SessionDetailsModelSelect = (): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <ModelPolicySelect
      variant="session-details"
      modelAriaLabel={t('Session details model Model')}
      reasoningEffortAriaLabel={t('Session details model Reasoning effort')}
      inheritLabel={t('Same as main model')}
      disabledLabel={t('Not configured')}
      entryFilter={(entry) => !isCodexSubscriptionProvider(entry.providerType)}
      configuration={useSettingsStore((state) => state.sessionDetailsModel)}
      pending={useSettingsStore((state) => state.sessionDetailsModelPending)}
      setConfiguration={(next) =>
        useSettingsStore
          .getState()
          .setSessionDetailsModel(
            next.mode === 'inherit'
              ? { mode: 'inherit', reasoningEffort: next.reasoningEffort ?? 'low' }
              : next
          )
      }
    />
  )
}

const ReviewerModelSelect = (): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <ModelPolicySelect
      variant="standard"
      modelAriaLabel={t('Reviewer model Model')}
      reasoningEffortAriaLabel={t('Reviewer model Reasoning effort')}
      inheritLabel={t('Follow main model')}
      configuration={useSettingsStore((state) => state.reviewerModel)}
      pending={useSettingsStore((state) => state.reviewerModelPending)}
      setConfiguration={(next) =>
        useSettingsStore.getState().setReviewerModel(
          next.mode === 'inherit'
            ? { mode: 'inherit' }
            : {
                mode: 'fixed',
                providerId: next.providerId,
                model: next.model,
                reasoningEffort: next.reasoningEffort
              }
        )
      }
    />
  )
}

const VisionModelSelect = (): React.JSX.Element => {
  const { t } = useTranslation()
  const configuration = useSettingsStore((state) => state.visionModel)
  const setVisionModel = useSettingsStore((state) => state.setVisionModel)

  return (
    <ModelPolicySelect
      variant="standard"
      modelAriaLabel={t('Vision model Model')}
      reasoningEffortAriaLabel={t('Vision model Reasoning effort')}
      inheritLabel={t('Not configured')}
      configuration={configuration ? { mode: 'fixed', ...configuration } : { mode: 'inherit' }}
      pending={useSettingsStore((state) => state.visionModelPending)}
      entryFilter={(entry) => entry.supportsImageInput}
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

export { ReviewerModelSelect, SessionDetailsModelSelect, SubagentModelSelect, VisionModelSelect }
