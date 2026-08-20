/* Hallmark · SkillImportMenu 8-state development preview; not mounted in production. */
import { useTranslation } from 'react-i18next'

import { SkillImportMenu, type SkillImportMenuPreviewState } from './SkillImportMenu'

const STATES: SkillImportMenuPreviewState[] = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
]

const SkillImportMenuPreview = (): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div className="grid max-w-sm gap-3 bg-background p-5 text-foreground">
      <h1 className="text-base font-semibold">{t('Skill import menu — 8 states')}</h1>
      {STATES.map((state) => (
        <div key={state} className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
          <span className="text-xs text-muted-foreground">{state}</span>
          <div className="justify-self-start">
            <SkillImportMenu
              previewState={state}
              onUploadSkills={() => undefined}
              onImportFromGitHub={() => undefined}
              onImportInstalledSkills={() => undefined}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export { SkillImportMenuPreview }
