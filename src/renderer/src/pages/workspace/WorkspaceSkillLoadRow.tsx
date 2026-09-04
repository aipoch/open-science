import { useTranslation } from 'react-i18next'

import type { ToolActivity } from '@/stores/session-store'
import { PresentedAgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { cn } from '@/lib/utils'

import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import type { ToolExecutionPhase } from './tool-execution-phase'

type WorkspaceSkillLoadRowProps = {
  activity: ToolActivity
  phase?: ToolExecutionPhase
  skillName?: string
  markdown: string
  isExpanded: boolean
  onToggle: (activityId: string, nextExpanded: boolean) => void
}

// The shared SKILL.md sheet: a full-width white surface with a fixed max height (scrolls beyond
// it), no border, and the subtle ringless sheet shadow. Shared by the load_skill and native rows.
// `maxHeightClassName` lets roomier surfaces (the permission card) raise the 320px transcript cap.
const SkillDocumentSheet = ({
  markdown,
  maxHeightClassName = 'max-h-[320px]'
}: {
  markdown: string
  maxHeightClassName?: string
}): React.JSX.Element => (
  <div
    className={cn(
      maxHeightClassName,
      'overflow-y-auto rounded-md bg-bg-000 px-4 py-3 shadow-sheet'
    )}
  >
    <PresentedAgentMarkdown content={markdown} allowMedia={false} />
  </div>
)

// A completed load_skill call expands into the loaded SKILL.md itself, rendered with the shared
// markdown renderer — instead of the generic input/output JSON sections.
const WorkspaceSkillLoadRow = ({
  activity,
  phase,
  skillName,
  markdown,
  isExpanded,
  onToggle
}: WorkspaceSkillLoadRowProps): React.JSX.Element => {
  const { t } = useTranslation()

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
      <SkillDocumentSheet markdown={markdown} />
    </WorkspaceToolActivityRowButton>
  )
}

export { SkillDocumentSheet, WorkspaceSkillLoadRow }
