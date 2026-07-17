import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import type { AgentFrameworkId, AgentFrameworkView } from '../../../../shared/settings'
import { SettingsRow, SettingsSection } from './SettingsLayout'

// The selectable frameworks, used as a fallback so the dropdown always offers both even before the
// first snapshot arrives (or if a stale main omits the list). The snapshot's own entries take
// precedence when present, so live displayName/capability data wins.
const KNOWN_FRAMEWORKS: AgentFrameworkView[] = [
  { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true },
  { id: 'opencode', displayName: 'opencode', supportsSkills: false }
]

// Lets the user pick which agent backend drives their sessions. Switching persists the choice and
// reconnects the agent (main drops the connection so the next prompt spawns the selected backend).
const AgentFrameworkSection = (): React.JSX.Element => {
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const setAgentFramework = useSettingsStore((state) => state.setAgentFramework)

  const currentId = agentFrameworkId ?? 'claude-code'
  // Always list both frameworks (so switching is never blocked by an empty/partial list), preferring
  // the snapshot's entry for each id when it exists.
  const frameworks = KNOWN_FRAMEWORKS.map(
    (known) => agentFrameworks?.find((framework) => framework.id === known.id) ?? known
  )
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
