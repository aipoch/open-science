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
// body from the app's skills catalog by its stable invocation name, fetching on first expand.
// Skills outside the catalog (e.g. session-scoped projections) keep the compact non-expandable row.
const WorkspaceSkillActivityRow = ({
  activity,
  phase,
  isExpanded,
  onToggle
}: WorkspaceSkillActivityRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const skillName = getLoadedSkillName(activity)
  // The runtime materializes enabled skills, so an enabled catalog entry wins a name collision.
  const skillId = useSettingsStore((state) =>
    skillName
      ? (state.skills.find((skill) => skill.name === skillName && skill.enabled)?.id ??
        state.skills.find((skill) => skill.name === skillName)?.id)
      : undefined
  )
  // Keyed by catalog id so a re-imported or renamed skill cannot show a stale body.
  const [loaded, setLoaded] = useState<{ id: string; body: string } | undefined>()
  const [failedId, setFailedId] = useState<string | undefined>()
  const requestRef = useRef(0)
  const markdown = loaded && loaded.id === skillId ? loaded.body : undefined
  const failed = skillId !== undefined && failedId === skillId

  useEffect(() => {
    if (!isExpanded || !skillId || markdown !== undefined || failed) return undefined

    const requestId = ++requestRef.current
    let cancelled = false

    void window.api.settings.getSkillDetail(skillId).then(
      (detail) => {
        if (!cancelled && requestRef.current === requestId) {
          setLoaded({ id: skillId, body: detail.body })
        }
      },
      () => {
        if (!cancelled && requestRef.current === requestId) setFailedId(skillId)
      }
    )

    return () => {
      cancelled = true
    }
  }, [isExpanded, skillId, markdown, failed])

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
      ) : failed ? (
        <button
          type="button"
          className="rounded-md px-1 py-1 text-[12px] text-text-300 transition-colors hover:text-text-100"
          onClick={() => setFailedId(undefined)}
        >
          {t('Retry')}
        </button>
      ) : (
        <div className="px-1 py-1 text-[12px] text-text-300">{t('Loading preview…')}</div>
      )}
    </WorkspaceToolActivityRowButton>
  )
}

export { WorkspaceSkillActivityRow }
