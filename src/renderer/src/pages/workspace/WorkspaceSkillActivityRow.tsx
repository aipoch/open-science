import { useTranslation } from 'react-i18next'

import type { ToolActivity } from '@/stores/session-store'

import { WorkspaceToolActivityRow } from './WorkspaceToolActivityRow'
import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import { SkillDocumentSheet } from './WorkspaceSkillLoadRow'
import { getLoadedSkillName } from './workspace-skill-load'
import { useSkillDocument } from './use-skill-document'
import type { ToolExecutionPhase } from './tool-execution-phase'

type WorkspaceSkillActivityRowProps = {
  activity: ToolActivity
  phase?: ToolExecutionPhase
  isExpanded: boolean
  onToggle: (activityId: string, nextExpanded: boolean) => void
}

// A native Skill activity ("Loaded skill: <name>") carries no document — main deliberately strips
// the instruction payload from the activity pipelines — so the row resolves the SKILL.md body by
// its stable invocation name: from the app's skills catalog when listed, otherwise through the
// main-process connector-aware resolver (mcp-* connector skills are invocable but unlisted). While
// resolution is pending, and for skills no source provides (e.g. session-scoped projections), the
// row keeps the compact non-expandable look.
const WorkspaceSkillActivityRow = ({
  activity,
  phase,
  isExpanded,
  onToggle
}: WorkspaceSkillActivityRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const skillName = getLoadedSkillName(activity)
  const document = useSkillDocument(skillName)

  if (document.status === 'loading' || document.status === 'unavailable') {
    return <WorkspaceToolActivityRow activity={activity} phase={phase} />
  }

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
      {document.status === 'ready' ? (
        <SkillDocumentSheet markdown={document.markdown} />
      ) : (
        <button
          type="button"
          className="rounded-md px-1 py-1 text-[12px] text-text-300 transition-colors hover:text-text-100"
          onClick={document.retry}
        >
          {t('Retry')}
        </button>
      )}
    </WorkspaceToolActivityRowButton>
  )
}

export { WorkspaceSkillActivityRow }
