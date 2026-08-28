import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ToolActivity } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'

import { WorkspaceToolActivityRow } from './WorkspaceToolActivityRow'
import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import { SkillDocumentSheet } from './WorkspaceSkillLoadRow'
import { getLoadedSkillName } from './workspace-skill-load'
import type { ToolExecutionPhase } from './tool-execution-phase'

type WorkspaceSkillActivityRowProps = {
  activity: ToolActivity
  phase?: ToolExecutionPhase
  isExpanded: boolean
  onToggle: (activityId: string, nextExpanded: boolean) => void
}

// A native Skill activity ("Loaded skill: <name>") carries no document — main deliberately strips
// the instruction payload from the activity pipelines — so the expanded row resolves the SKILL.md
// body from the app's own skills catalog by its stable invocation name, fetching on first expand.
// Skills outside the catalog (e.g. session-scoped projections) keep the compact non-expandable row.
const WorkspaceSkillActivityRow = ({
  activity,
  phase,
  isExpanded,
  onToggle
}: WorkspaceSkillActivityRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const skillName = getLoadedSkillName(activity)
  const skillId = useSettingsStore((state) =>
    skillName ? state.skills.find((skill) => skill.name === skillName)?.id : undefined
  )
  const [markdown, setMarkdown] = useState<string | undefined>()
  const requestRef = useRef(0)

  useEffect(() => {
    if (!isExpanded || !skillId || markdown !== undefined) return undefined

    const requestId = ++requestRef.current
    let cancelled = false

    void window.api.settings.getSkillDetail(skillId).then(
      (detail) => {
        if (!cancelled && requestRef.current === requestId) setMarkdown(detail.body)
      },
      () => {
        // A failed fetch leaves the sheet on its loading copy; the next expand retries.
      }
    )

    return () => {
      cancelled = true
    }
  }, [isExpanded, skillId, markdown])

  if (!skillId) return <WorkspaceToolActivityRow activity={activity} phase={phase} />

  return (
    <WorkspaceToolActivityRowButton
      activity={activity}
      phase={phase}
      label={t('Skill')}
      subtitle={skillName}
      isExpanded={isExpanded}
      panelClassName="mx-1 mb-1.5"
      panelTestId="skill-load-details"
      onToggle={onToggle}
    >
      {markdown ? (
        <SkillDocumentSheet markdown={markdown} />
      ) : (
        <div className="px-1 py-1 text-[12px] text-text-300">{t('Loading preview…')}</div>
      )}
    </WorkspaceToolActivityRowButton>
  )
}

export { WorkspaceSkillActivityRow }
