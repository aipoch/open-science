import { useTranslation } from 'react-i18next'

import { SettingsToggle } from './SettingsLayout'
import { SkillUsageAgents } from './SkillUsageAgents'
import {
  resourceScope,
  type ResourceScope,
  type SpecialistUsage
} from './specialist-resource-scope'

const SCOPE_LABEL_KEYS = {
  'main-only': 'Main only',
  'specialist-only': 'Specialist only',
  shared: 'Shared with Main',
  'not-in-use': 'Not in use'
} as const satisfies Record<ResourceScope, string>

type ResourceAvailabilityProps = {
  mainEnabled: boolean
  mainToggleLabel: string
  usages: readonly SpecialistUsage[]
  onToggleMain: () => void
  showAgentPopover?: boolean
  onOpenSpecialist?: (usage: SpecialistUsage) => void
}

const ResourceAvailability = ({
  mainEnabled,
  mainToggleLabel,
  usages,
  onToggleMain,
  showAgentPopover = false,
  onOpenSpecialist
}: ResourceAvailabilityProps): React.JSX.Element => {
  const { t } = useTranslation()
  const scope = resourceScope(mainEnabled, usages)

  return (
    <section className="mt-6" aria-label={t('Availability')}>
      <h2 className="text-sm font-semibold text-foreground">{t('Availability')}</h2>
      <p className="text-xs text-muted-foreground">
        {t('Specialist access is configured on each Specialist.')}
      </p>

      <div className="mt-3 flex items-center justify-between gap-3 py-1.5">
        <div className="min-w-0">
          <p className="text-sm text-foreground">{t('Main Agent')}</p>
          <p className="text-xs text-muted-foreground">{t(SCOPE_LABEL_KEYS[scope])}</p>
        </div>
        <SettingsToggle
          enabled={mainEnabled}
          aria-label={mainToggleLabel}
          onToggle={onToggleMain}
        />
      </div>

      {showAgentPopover && (mainEnabled || usages.length > 0) ? (
        <div className="flex items-center justify-between gap-3 py-1.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{t('Agents with access')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('Hover to preview. Click to view every agent.')}
            </p>
          </div>
          <SkillUsageAgents
            mainEnabled={mainEnabled}
            usages={usages}
            onOpenSpecialist={onOpenSpecialist}
          />
        </div>
      ) : showAgentPopover ? null : (
        <div className="py-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t('Specialists')}</p>
          {usages.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {usages.map((usage) => (
                <span
                  key={usage.id}
                  className="rounded-md bg-muted px-2 py-1 text-xs text-foreground"
                >
                  {usage.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-0.5 text-sm text-foreground">{t('None')}</p>
          )}
        </div>
      )}
    </section>
  )
}

export { ResourceAvailability }
