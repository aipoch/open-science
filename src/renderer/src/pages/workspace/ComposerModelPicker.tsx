import { AlertTriangle, Brain, Check, ChevronDown, ChevronRight, Cpu } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ProviderKindIcon } from '../settings/provider-icons'
import { providerKindKey } from '../settings/provider-form-value'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import { isProviderUsableByFramework } from '../../../../shared/settings'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import {
  buildConfiguredModelCatalog,
  type ConfiguredModelCatalogEntry
} from '../../../../shared/configured-model-catalog'
import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile
} from '../../../../shared/provider-reasoning-effort'
import { resolveReasoningEffortControl } from '../../../../shared/reasoning-effort'
import { incompatibilityReason, modelUnavailableReason } from './composer-model-picker-utils'

const triggerClassName =
  'flex h-8 min-w-0 max-w-[220px] shrink items-center gap-1 rounded-md px-2.5 text-sm text-text-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors'

// Label for an option: the model name, or the provider name when the option carries no concrete model.
const optionLabel = (option: Pick<ConfiguredModelCatalogEntry, 'label'>): string => option.label

// One radio row shape shared by both submenus: menuitemradio semantics, bold + trailing Check when
// picked, optional leading icon and trailing hint. The three call sites (default effort, effort
// rung, model) stay behavior-identical by construction.
const MenuRadioItem = ({
  checked,
  onSelect,
  leading,
  hint,
  children
}: {
  checked: boolean
  onSelect: () => void
  leading?: React.ReactNode
  hint?: string
  children: React.ReactNode
}): React.JSX.Element => (
  <DropdownMenuItem
    role="menuitemradio"
    aria-checked={checked}
    onSelect={onSelect}
    className={cn('gap-2', checked && 'font-medium')}
  >
    {leading}
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {hint ? <span className="text-[11px] text-text-300">{hint}</span> : null}
    {checked ? (
      <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
    ) : null}
  </DropdownMenuItem>
)

type ComposerModelPickerProps = Readonly<{
  configuration: SessionAgentConfiguration | undefined
  unavailable: boolean
  includeAllClaudeSubscriptions?: boolean
  onChange: (configuration: SessionAgentConfiguration) => void
}>

// Model/provider switcher shown in the composer toolbar. Provider inventory and framework
// compatibility remain Settings-owned, while the selected value belongs to the current Session.
const ComposerModelPicker = ({
  configuration,
  unavailable,
  includeAllClaudeSubscriptions = false,
  onChange
}: ComposerModelPickerProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (state) => state.claudeSubscriptionProviderId
  )
  const openSettings = useSettingsStore((state) => state.openSettings)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const reasoningEffort = configuration?.reasoningEffort ?? 'default'
  const selectedProviderId = configuration?.providerId
  const selectedModel = configuration?.model

  const frameworkName =
    agentFrameworks.find((framework) => framework.id === agentFrameworkId)?.displayName ??
    'this framework'

  // Reasoning-effort state resolves through the same chain as the Settings page control: the
  // effective model for the active provider, that model's static effort profile, then the control
  // options the stored intent maps onto.
  const selectedProvider = providers.find((candidate) => candidate.id === selectedProviderId)
  const effectiveModel = resolveProviderEffectiveModel(selectedProvider, selectedModel)
  const effortProfile = resolveProviderReasoningEffortProfile(selectedProvider, effectiveModel)
  const effortControl = resolveReasoningEffortControl(reasoningEffort, effortProfile)
  const selectedEffortLabel = effortControl.options.find(
    (option) => option.value === effortControl.selectedValue
  )?.label

  // The effort row only makes sense when the active provider's model can take an effort at all;
  // without an active provider there is nothing the selection would apply to, so the row hides.
  const showEffortRow =
    selectedProvider !== undefined && effortProfile.supported && effortControl.options.length > 0

  // The trigger advertises a non-default effort as a suffix, derived from showEffortRow so the two
  // visibility rules can never drift apart. 'default' means "whatever the provider does" — the
  // common case — and stays quiet.
  const effortSuffixLabel =
    showEffortRow && reasoningEffort !== 'default' ? selectedEffortLabel : undefined
  const defaultEffortChecked = reasoningEffort === 'default'

  const options = buildConfiguredModelCatalog({
    providers,
    activeProviderId,
    claudeSubscriptionProviderId,
    includeAllClaudeSubscriptions,
    frameworkId: agentFrameworkId,
    frameworkEndpoints
  })
  const usableOptions = options.filter((option) => option.selectable)
  const hasUsable = usableOptions.length > 0

  // No provider configured at all: nothing to pick or explain, so warn with a button that opens
  // Settings rather than leaving the toolbar a silent dead end.
  if (options.length === 0) {
    return (
      <button
        type="button"
        onClick={() => openSettings()}
        className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-status-warning-foreground transition-colors hover:bg-status-warning-surface dark:text-status-warning-dark-foreground dark:hover:bg-status-warning-dark-surface"
        aria-label={t('No model available — open settings')}
      >
        <AlertTriangle className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="truncate">{t('No model available')}</span>
      </button>
    )
  }

  // A single usable option leaves nothing to switch between unless it still exposes the Session's
  // reasoning-effort control. An incompatible sole provider also stays visible so its reason remains
  // reachable — an all-incompatible framework must never silently vanish.
  if (options.length === 1 && hasUsable && !unavailable && !showEffortRow) return null

  // The active option matches by provider and model; an undefined activeModel maps to the empty-model
  // "default" entry. Account-owned subscription defaults omit the model, so the trigger shows the
  // provider name instead of pinning the first catalog row.
  const activeKeyModel = selectedModel ?? ''
  const current = options.find(
    (option) => option.providerId === selectedProviderId && option.model === activeKeyModel
  )
  const displayCurrent =
    current ??
    (selectedModel === undefined && selectedProvider
      ? {
          providerId: selectedProvider.id,
          providerName: selectedProvider.name,
          providerType: selectedProvider.type,
          ...(selectedProvider.vendorId ? { vendorId: selectedProvider.vendorId } : {}),
          model: '',
          label: selectedProvider.name
        }
      : undefined)

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
          className={cn(
            triggerClassName,
            (unavailable || !hasUsable) &&
              'text-status-warning-foreground hover:text-status-warning-foreground dark:text-status-warning-dark-foreground dark:hover:text-status-warning-dark-foreground'
          )}
          aria-label={
            unavailable
              ? t('Session model unavailable')
              : hasUsable
                ? t('Select model')
                : t('No compatible model')
          }
        >
          {hasUsable && !unavailable ? (
            <>
              {displayCurrent ? (
                <ProviderKindIcon
                  kindKey={providerKindKey(displayCurrent.providerType, displayCurrent.vendorId)}
                  className="size-4"
                />
              ) : null}
              <span className="flex min-w-0 items-center">
                {displayCurrent ? (
                  <>
                    {/* The model name alone ellipsizes under the trigger's max width; the effort
                        suffix is the newer signal and stays fully visible. */}
                    <span className="truncate font-medium text-text-100">
                      {optionLabel(displayCurrent)}
                    </span>
                    {effortSuffixLabel ? (
                      <span className="ml-1.5 shrink-0 whitespace-nowrap text-text-300">
                        · {effortSuffixLabel}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="truncate">{t('Select model')}</span>
                )}
              </span>
            </>
          ) : (
            <>
              <AlertTriangle className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="truncate">
                {unavailable ? t('Session model unavailable') : t('No compatible model')}
              </span>
            </>
          )}
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      {/* Two-level menu: the first level is two summary rows (effort, model) whose actual choices
          live in their submenus. This keeps the long provider catalog out of the top level, which
          now reads as a compact overview instead of a scrolling list. */}
      <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-84 p-1">
        {showEffortRow ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="items-center gap-2 px-2 py-1.5">
              <Brain className="size-4 shrink-0 text-text-200" strokeWidth={2} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium leading-5">
                  {tCommon('Reasoning effort')}
                </span>
                <span className="block text-[11px] leading-4 text-text-300">
                  {tCommon('How long the model thinks before answering')}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-bg-200 px-2 py-0.5 text-[11px] font-medium leading-4 text-text-100">
                {defaultEffortChecked ? t('Default') : selectedEffortLabel}
                <ChevronRight
                  className="size-3 shrink-0 opacity-60"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56 p-1">
              <MenuRadioItem
                checked={defaultEffortChecked}
                onSelect={() => {
                  if (configuration) onChange({ ...configuration, reasoningEffort: 'default' })
                }}
                hint={t('provider default')}
              >
                {t('Default')}
              </MenuRadioItem>
              {effortControl.options.map((option) => (
                // Checked by concrete value, not intent: several intents can project onto one
                // value, and the profile owns which one is selected.
                <MenuRadioItem
                  key={option.value}
                  checked={
                    reasoningEffort !== 'default' && option.value === effortControl.selectedValue
                  }
                  onSelect={() => {
                    if (configuration) {
                      onChange({ ...configuration, reasoningEffort: option.intent })
                    }
                  }}
                >
                  {option.label}
                </MenuRadioItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            data-testid="model-row"
            className="items-center gap-2 px-2 py-1.5"
          >
            {/* The leading icon stays a generic model glyph; the provider identity lives in the
                right-hand two-line summary instead. */}
            <Cpu className="size-4 shrink-0 text-text-200" strokeWidth={2} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium leading-5">{tCommon('Model')}</span>
              <span className="block text-[11px] leading-4 text-text-300">
                {tCommon('Provider and model for this chat')}
              </span>
            </span>
            {/* The current pick echoes on the right inside a capsule: small bold provider line
                with its own icon over the model name. The capsule is two lines tall, so it uses
                a soft rounded-lg corner rather than the single-line pill's rounded-full; long
                names ellipsize against the max width. */}
            {displayCurrent ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded-lg bg-bg-200 px-2 py-1">
                <span className="flex max-w-[12rem] flex-col items-end text-right">
                  <span className="flex max-w-full items-center gap-1 text-[11px] font-semibold leading-4 text-text-300">
                    <ProviderKindIcon
                      kindKey={providerKindKey(
                        displayCurrent.providerType,
                        displayCurrent.vendorId
                      )}
                      className="size-3 shrink-0"
                    />
                    <span className="min-w-0 truncate">{displayCurrent.providerName}</span>
                  </span>
                  <span className="block max-w-full truncate text-[13px] font-medium leading-5">
                    {optionLabel(displayCurrent)}
                  </span>
                </span>
                <ChevronRight
                  className="size-3.5 shrink-0 opacity-60"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </span>
            ) : (
              <>
                <span className="shrink-0 text-[11px] text-text-300">{tCommon('Select')}</span>
                <ChevronRight
                  className="size-3.5 shrink-0 opacity-60"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </>
            )}
          </DropdownMenuSubTrigger>
          {/* The full grouped catalog (compatibility rows included) lives one level down so the
              first level stays a summary; behavior per item is unchanged from the flat menu. */}
          <DropdownMenuSubContent className="max-h-[320px] min-w-[15rem] overflow-y-auto p-1">
            {groups.map((group) => {
              const compatible = group.options.some((option) => option.selectable)
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
                  ? t(
                      'No model from {{provider}} is supported over the Codex Chat Completions bridge.',
                      { provider: group.provider.name }
                    )
                  : incompatibilityReason(
                      {
                        apiEndpoints: group.provider.apiEndpoints,
                        type: group.provider.type,
                        name: group.provider.name
                      },
                      frameworkName,
                      frameworkEndpoints,
                      tCommon
                    )

              return (
                <DropdownMenuGroup key={group.provider.id}>
                  <DropdownMenuLabel>{group.provider.name}</DropdownMenuLabel>
                  {compatible ? (
                    group.options.map((option) => {
                      const isActive =
                        option.providerId === selectedProviderId && option.model === activeKeyModel
                      const optionCompatible = option.selectable

                      if (!optionCompatible) {
                        const optionReason = modelUnavailableReason(
                          option,
                          group.provider,
                          frameworkName,
                          frameworkEndpoints,
                          tCommon
                        )
                        return (
                          <TooltipProvider
                            key={`${option.providerId}:${option.model}`}
                            delayDuration={200}
                          >
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <DropdownMenuItem
                                  aria-disabled
                                  aria-label={optionReason}
                                  onSelect={(event) => event.preventDefault()}
                                  className="gap-2 text-text-300"
                                >
                                  <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                                  <span className="min-w-0 flex-1 truncate">
                                    {optionLabel(option)}
                                  </span>
                                  <span className="text-xs">{t('unsupported')}</span>
                                </DropdownMenuItem>
                              </TooltipTrigger>
                              <TooltipContent side="right" className="max-w-72 leading-5">
                                {optionReason}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )
                      }

                      return (
                        <MenuRadioItem
                          key={`${option.providerId}:${option.model}`}
                          checked={isActive}
                          onSelect={() =>
                            onChange({
                              providerId: option.providerId,
                              ...(option.model ? { model: option.model } : {}),
                              reasoningEffort
                            })
                          }
                          leading={
                            <ProviderKindIcon
                              kindKey={providerKindKey(option.providerType, option.vendorId)}
                              className="size-4 shrink-0"
                            />
                          }
                        >
                          {optionLabel(option)}
                        </MenuRadioItem>
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
                      <AlertTriangle
                        className="size-4 shrink-0"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {t('Unavailable for {{framework}}', { framework: frameworkName })}
                      </span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              )
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {hasUsable && !unavailable ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openSettings()}>
              {t('Open Settings')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ComposerModelPicker }
