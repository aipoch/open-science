import { useTranslation } from 'react-i18next'

import type { SpecialistPackageSkillPreview } from '../../../../shared/specialist-package'
import type { SkillConflictResolutionMap } from './specialist-skill-conflicts'

export const SpecialistSkillConflictChoices = ({
  conflicts,
  resolutions,
  onChange
}: {
  conflicts: readonly SpecialistPackageSkillPreview[]
  resolutions: SkillConflictResolutionMap
  onChange: (skillId: string, resolution: SkillConflictResolutionMap[string]) => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (conflicts.length === 0) return null

  return (
    <section className="rounded-xl border border-warning-100/50 bg-warning-100/5 p-4">
      <h3 className="text-sm font-semibold">{t('Resolve Skill conflicts')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('Choose one version for every conflicting Skill before installing the Specialist.')}
      </p>
      <div className="mt-3 space-y-3">
        {conflicts.map((skill) => {
          const affected = [
            ...(skill.conflict?.mainEnabled ? [t('Main Agent')] : []),
            ...(skill.conflict?.specialists.map((specialist) => specialist.name) ?? [])
          ]
          return (
            <fieldset key={skill.id} className="rounded-lg border border-border bg-background p-3">
              <legend className="px-1 text-xs font-semibold">{skill.id}</legend>
              <p className="text-xs text-muted-foreground">
                {t('Installed {{installedVersion}} · Package {{packageVersion}}', {
                  installedVersion: skill.conflict?.installedVersion ?? t('Unknown'),
                  packageVersion: skill.version
                })}
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="flex cursor-pointer gap-2 rounded-md border border-border p-3 text-xs">
                  <input
                    type="radio"
                    name={`skill-conflict-${skill.id}`}
                    value="use-installed"
                    checked={resolutions[skill.id] === 'use-installed'}
                    onChange={() => onChange(skill.id, 'use-installed')}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>
                    <strong className="block text-foreground">{t('Keep installed Skill')}</strong>
                    <span className="mt-1 block text-muted-foreground">
                      {t('Keep the current files. The new Specialist will use this version.')}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer gap-2 rounded-md border border-border p-3 text-xs">
                  <input
                    type="radio"
                    name={`skill-conflict-${skill.id}`}
                    value="use-incoming"
                    checked={resolutions[skill.id] === 'use-incoming'}
                    onChange={() => onChange(skill.id, 'use-incoming')}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>
                    <strong className="block text-foreground">{t('Use package Skill')}</strong>
                    <span className="mt-1 block text-muted-foreground">
                      {t('Replace the installed files for every current user of this Skill.')}
                    </span>
                  </span>
                </label>
              </div>
              {affected.length > 0 ? (
                <p className="mt-2 text-xs text-warning-100">
                  {t('Affected now: {{targets}}', { targets: affected.join(', ') })}
                </p>
              ) : null}
            </fieldset>
          )
        })}
      </div>
    </section>
  )
}
