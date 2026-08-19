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
  onOpenSpecialist?: (usage: SpecialistUsage) => void
}

const ResourceAvailability = ({
  mainEnabled,
  mainToggleLabel,
  usages,
  onToggleMain,
  onOpenSpecialist
}: ResourceAvailabilityProps): React.JSX.Element => {
  const { t } = useTranslation()
  const scope = resourceScope(mainEnabled, usages)

  return (
    <section className="mt-6 border-t border-border pt-4" aria-label={t('Availability')}>
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

      {mainEnabled || usages.length > 0 ? (
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
      ) : null}
    </section>
  )
}

export { ResourceAvailability }
