import { useState } from 'react'
import { ChevronRight, Eye, SearchCheck, Workflow, type LucideIcon } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import {
  buildConfiguredModelCatalog,
  configuredModelKey,
  type ConfiguredModelCatalogEntry
} from '../../../../shared/configured-model-catalog'
import type { ProviderView, ReasoningEffort } from '../../../../shared/settings'
import { resolveProviderReasoningEffortProfile } from '../../../../shared/provider-reasoning-effort'
import {
  resolveReasoningEffortControl,
  type ReasoningEffortProfile
} from '../../../../shared/reasoning-effort'
import { SettingsSection } from './SettingsLayout'
import { ReviewerModelSelect, SubagentModelSelect, VisionModelSelect } from './SubagentModelSelect'
import { providerKindKey } from './provider-form-value'
import { ProviderKindIcon } from './provider-icons'

type ScenarioId = 'subagent' | 'reviewer' | 'vision'

// One-line summary of a scenario's routing policy, derived from the same catalog the in-row
// selectors use so the row and the expanded selector never disagree on availability.
type ScenarioSummary =
  | Readonly<{ kind: 'inherit'; label: string }>
  | Readonly<{ kind: 'unconfigured' }>
  | Readonly<{
      kind: 'fixed'
      model: string
      providerName: string
      providerKind: string
      effortLabel: string
    }>
  | Readonly<{
      kind: 'unavailable'
      model: string
      providerId: string
      providerName?: string
      providerKind?: string
      effortLabel: string
    }>

// Badge labels must match what the paired control displays: the per-scenario select projects the
// stored intent onto the provider's effort ladder (an unsupported slot approximates to the nearest
// level), so a raw intent→label map would drift from the control whenever the ladder lacks the
// stored slot. Callers must pass a supported profile; 'default' mirrors the control's own label.
const resolveProjectedEffortLabel = (
  intent: ReasoningEffort,
  profile: Extract<ReasoningEffortProfile, { supported: true }>,
  t: TFunction
): string => {
  if (intent === 'default') return t('Default')
  const control = resolveReasoningEffortControl(intent, profile)
  const selected = control.options.find((option) => option.value === control.selectedValue)
  // Defensive only: every slot value appears in control.options, so selected is always found.
  return selected?.label ?? t('Default')
}

const resolveFixedSummary = (
  configuration: Readonly<{ providerId: string; model: string; reasoningEffort: ReasoningEffort }>,
  eligibleCatalog: readonly ConfiguredModelCatalogEntry[],
  providers: readonly ProviderView[],
  t: TFunction
): ScenarioSummary => {
  const key = configuredModelKey(configuration.providerId, configuration.model)
  const entry = eligibleCatalog.find((candidate) => candidate.key === key && candidate.selectable)
  const provider = providers.find((candidate) => candidate.id === configuration.providerId)
  const profile = resolveProviderReasoningEffortProfile(provider, configuration.model)
  // The per-scenario select renders "Not supported" for a model without an effort ladder.
  const effortLabel = profile.supported
    ? resolveProjectedEffortLabel(configuration.reasoningEffort, profile, t)
    : t('Not supported')

  return entry
    ? {
        kind: 'fixed',
        model: entry.label,
        providerName: entry.providerName,
        providerKind: providerKindKey(entry.providerType, entry.vendorId),
        effortLabel
      }
    : {
        kind: 'unavailable',
        model: configuration.model,
        providerId: configuration.providerId,
        // The provider may be gone entirely; keep its name and kind icon when it still exists.
        ...(provider
          ? {
              providerName: provider.name,
              providerKind: providerKindKey(provider.type, provider.vendorId)
            }
          : {}),
        effortLabel
      }
}

// Teal status-info badge for an explicit selection, kept even when the target went unavailable.
const FixedEffortBadge = ({ label }: { label: string }): React.JSX.Element => (
  <Badge className="bg-status-info-surface text-status-info-foreground dark:bg-status-info-dark-surface dark:text-status-info-dark-foreground">
    {label}
  </Badge>
)

// Divider + provider tail at the end of the row: kind icon and name, visually separated from the
// model/effort pair so the three facts scan as two groups.
const ProviderTail = ({
  providerKind,
  name
}: {
  providerKind?: string
  name: string
}): React.JSX.Element => (
  <>
    <span className="h-3.5 w-px shrink-0 bg-border" aria-hidden="true" />
    <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
      {providerKind ? <ProviderKindIcon kindKey={providerKind} className="size-4" /> : null}
      <span className="max-w-32 truncate">{name}</span>
    </span>
  </>
)

// Right-side cluster of the summary row: model and reasoning effort on the left of a divider,
// provider at the end. An inherited row just says so — the effort follows the Reasoning effort
// section above, so repeating it as a badge would be noise. Unconfigured rows carry no provider.
const ScenarioRowCluster = ({ summary }: { summary: ScenarioSummary }): React.JSX.Element => {
  const { t } = useTranslation()

  switch (summary.kind) {
    case 'inherit':
      return <span className="truncate text-sm text-muted-foreground">{summary.label}</span>
    case 'unconfigured':
      return <span className="truncate text-sm text-muted-foreground">{t('Not configured')}</span>
    case 'unavailable':
      return (
        <>
          <span className="truncate text-sm text-muted-foreground">
            {summary.model} · {t('Unavailable')}
          </span>
          <FixedEffortBadge label={summary.effortLabel} />
          <ProviderTail
            providerKind={summary.providerKind}
            name={summary.providerName ?? summary.providerId}
          />
        </>
      )
    case 'fixed':
      return (
        <>
          <span className="truncate text-sm text-foreground">{summary.model}</span>
          <FixedEffortBadge label={summary.effortLabel} />
          <ProviderTail providerKind={summary.providerKind} name={summary.providerName} />
        </>
      )
  }
}

type Scenario = Readonly<{
  id: ScenarioId
  icon: LucideIcon
  name: string
  description: string
  summary: ScenarioSummary
  selector: React.JSX.Element
}>

const ScenarioModelRow = ({
  scenario,
  expanded,
  onToggle
}: {
  scenario: Scenario
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const panelId = `scenario-model-panel-${scenario.id}`
  const summaryId = `scenario-model-summary-${scenario.id}`
  const Icon = scenario.icon

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={
          expanded
            ? t('Collapse {{scenario}} settings', { scenario: scenario.name })
            : t('Expand {{scenario}} settings', { scenario: scenario.name })
        }
        // The aria-label replaces the visible content as the accessible name; aria-describedby
        // keeps the current model/effort/provider summary audible to screen readers.
        aria-describedby={summaryId}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/60"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 text-sm font-medium text-foreground">{scenario.name}</span>
        <span id={summaryId} className="ml-auto flex min-w-0 items-center justify-end gap-2">
          <ScenarioRowCluster summary={scenario.summary} />
        </span>
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
            expanded && 'rotate-90'
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div id={panelId} className="border-t border-border px-4 pb-3">
          {scenario.selector}
          <p className="pb-1 text-[13px] leading-5 text-muted-foreground">{scenario.description}</p>
        </div>
      ) : null}
    </div>
  )
}

// The Scenario models card: one summary row per routing scenario (Subagent, Reviewer, Vision).
// Rows expand inline as an accordion — a single useState, purely local UI state — and reuse the
// existing policy selectors unchanged, so a selection still saves optimistically through the store.
const ScenarioModelList = (): React.JSX.Element => {
  const { t } = useTranslation()
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (state) => state.claudeSubscriptionProviderId
  )
  const frameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const subagentModel = useSettingsStore((state) => state.subagentModel)
  const reviewerModel = useSettingsStore((state) => state.reviewerModel)
  const visionModel = useSettingsStore((state) => state.visionModel)

  // Accordion: at most one row open, and clicking the open row closes it. Never persisted.
  const [expanded, setExpanded] = useState<ScenarioId | null>(null)

  const catalog = buildConfiguredModelCatalog({
    providers,
    activeProviderId,
    claudeSubscriptionProviderId,
    frameworkId,
    frameworkEndpoints
  })
  // Vision offers only image-capable models, so its summary resolves against the same filter.
  const visionCatalog = catalog.filter((entry) => entry.supportsImageInput)

  const scenarios: readonly Scenario[] = [
    {
      id: 'subagent',
      icon: Workflow,
      name: t('Subagent'),
      description: t('Runs delegated tasks spawned by the main agent.'),
      summary:
        subagentModel.mode === 'inherit'
          ? { kind: 'inherit', label: t('Same as main model') }
          : resolveFixedSummary(subagentModel, catalog, providers, t),
      selector: <SubagentModelSelect />
    },
    {
      id: 'reviewer',
      icon: SearchCheck,
      name: t('Reviewer'),
      description: t('Reviews plans and code changes before they land.'),
      summary:
        reviewerModel.mode === 'inherit'
          ? { kind: 'inherit', label: t('Follow main model') }
          : resolveFixedSummary(reviewerModel, catalog, providers, t),
      selector: <ReviewerModelSelect />
    },
    {
      id: 'vision',
      icon: Eye,
      name: t('Vision'),
      description: t(
        "Describes images when the main model can't see them. Only models with image input are listed."
      ),
      summary: visionModel
        ? resolveFixedSummary(visionModel, visionCatalog, providers, t)
        : { kind: 'unconfigured' },
      selector: <VisionModelSelect />
    }
  ]

  return (
    <SettingsSection
      title={t('Scenario models')}
      aria-label={t('Scenario models')}
      description={t('Models for subagents, review, and image understanding.')}
    >
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {scenarios.map((scenario) => (
          <ScenarioModelRow
            key={scenario.id}
            scenario={scenario}
            expanded={expanded === scenario.id}
            onToggle={() =>
              setExpanded((current) => (current === scenario.id ? null : scenario.id))
            }
          />
        ))}
      </div>
    </SettingsSection>
  )
}

export { ScenarioModelList }
