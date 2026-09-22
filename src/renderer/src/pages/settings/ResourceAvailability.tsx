import { useTranslation } from 'react-i18next'
import { useSpecialistStore } from '@/stores/specialist-store'
import { ResourceAssignmentControls } from './ResourceAssignmentControls'
import type { AssignableResource } from './resource-assignment'
import { SkillUsageAgents } from './SkillUsageAgents'
import {
  specialistsUsingSkill,
  specialistsUsingConnector,
  type SpecialistUsage
} from './specialist-resource-scope'

export const ResourceAvailability = ({
  resource,
  onSetMain,
  onOpenSpecialist
}: {
  resource: AssignableResource
  onSetMain: (enabled: boolean) => Promise<void>
  onOpenSpecialist?: (usage: SpecialistUsage) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const items = useSpecialistStore((state) => state.items)
  const usages =
    resource.kind === 'skill'
      ? specialistsUsingSkill(items, resource.id)
      : specialistsUsingConnector(items, resource)
  return (
    <section className="mt-6" aria-label={t('Availability')}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t('Availability')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('Control access separately for Main Agent and each Specialist.')}
          </p>
        </div>
        <ResourceAssignmentControls
          resource={resource}
          onSetMain={onSetMain}
          onOpenSpecialist={onOpenSpecialist}
        />
      </div>
      {onOpenSpecialist && usages.length > 0 ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('Used by')}</span>
          <SkillUsageAgents
            resourceKind={resource.kind === 'connector' ? 'Connector' : 'Skill'}
            mainEnabled={resource.mainEnabled}
            usages={usages}
            onOpenSpecialist={onOpenSpecialist}
          />
        </div>
      ) : null}
    </section>
  )
}
