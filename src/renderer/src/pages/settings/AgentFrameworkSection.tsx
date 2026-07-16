import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import type { AgentFrameworkId } from '../../../../shared/settings'
import { SettingsRow, SettingsSection } from './SettingsLayout'

// Lets the user pick which agent backend drives their sessions. Switching persists the choice and
// reconnects the agent (main drops the connection so the next prompt spawns the selected backend).
const AgentFrameworkSection = (): React.JSX.Element => {
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const setAgentFramework = useSettingsStore((state) => state.setAgentFramework)

  // Before the first snapshot loads the list is empty; show the current id so the control is stable.
  const currentId = agentFrameworkId ?? 'claude-code'
  const frameworks =
    agentFrameworks && agentFrameworks.length > 0
      ? agentFrameworks
      : [{ id: currentId, displayName: currentId, supportsSkills: true }]
  const selected = frameworks.find((framework) => framework.id === currentId)

  return (
    <SettingsSection
      title="Agent framework"
      description={
        <>
          Choose which coding-agent backend drives your sessions. Switching reconnects the agent;
          open conversations continue on the new backend.
        </>
      }
      aria-label="Agent framework"
      separated
    >
      <SettingsRow label="Framework" controlClassName="w-auto justify-self-end" className="pt-0">
        <Select
          value={currentId}
          onValueChange={(id) => void setAgentFramework(id as AgentFrameworkId)}
        >
          <SelectTrigger aria-label="Agent framework">
            <span>{selected?.displayName ?? currentId}</span>
          </SelectTrigger>
          <SelectContent>
            {frameworks.map((framework) => (
              <SelectItem key={framework.id} value={framework.id}>
                {framework.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      {selected && !selected.supportsSkills ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Skills aren&apos;t available with {selected.displayName}; use Claude Code for skill-based
          workflows.
        </p>
      ) : null}
    </SettingsSection>
  )
}

export { AgentFrameworkSection }
