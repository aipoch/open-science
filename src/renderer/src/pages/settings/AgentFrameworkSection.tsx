import { AlertDialog } from 'radix-ui'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import type { AgentFrameworkId, AgentFrameworkView } from '../../../../shared/settings'
import { SettingsRow, SettingsSection } from './SettingsLayout'

// The selectable frameworks, used as a fallback so the dropdown always offers both even before the
// first snapshot arrives (or if a stale main omits the list). The snapshot's own entries take
// precedence when present, so live displayName/capability data wins.
const KNOWN_FRAMEWORKS: AgentFrameworkView[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    supportsSkills: true,
    supportedApiTypes: ['anthropic']
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    supportsSkills: false,
    supportedApiTypes: ['anthropic', 'openai']
  }
]

// Lets the user pick which agent backend drives their sessions. Because a session started on one
// backend cannot be resumed on another, switching adopts a fresh agent session — so the choice is
// confirmed first, warning that open conversations lose their prior agent context.
const AgentFrameworkSection = (): React.JSX.Element => {
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const setAgentFramework = useSettingsStore((state) => state.setAgentFramework)

  // The framework the user picked but hasn't confirmed yet; drives the warning dialog.
  const [pending, setPending] = useState<AgentFrameworkId | undefined>(undefined)

  const currentId = agentFrameworkId ?? 'claude-code'
  // Always list both frameworks (so switching is never blocked by an empty/partial list), preferring
  // the snapshot's entry for each id when it exists.
  const frameworks = KNOWN_FRAMEWORKS.map(
    (known) => agentFrameworks?.find((framework) => framework.id === known.id) ?? known
  )
  const selected = frameworks.find((framework) => framework.id === currentId)
  const pendingName =
    frameworks.find((framework) => framework.id === pending)?.displayName ?? pending

  const confirmSwitch = (): void => {
    if (pending) void setAgentFramework(pending)
    setPending(undefined)
  }

  return (
    <SettingsSection
      title="Agent framework"
      description={
        <>
          Choose which coding-agent backend drives your sessions. Switching starts a fresh agent
          session — open conversations keep their messages but the new backend won&apos;t have their
          earlier context.
        </>
      }
      aria-label="Agent framework"
      separated
    >
      <SettingsRow label="Framework" controlClassName="w-auto justify-self-end" className="pt-0">
        <Select
          value={currentId}
          onValueChange={(id) => {
            // Defer the switch to the confirmation; the controlled value stays until confirmed.
            if (id !== currentId) setPending(id as AgentFrameworkId)
          }}
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

      <AlertDialog.Root
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open) setPending(undefined)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-6 text-foreground shadow-menu">
            <AlertDialog.Title className="text-base font-semibold text-foreground">
              Switch to {pendingName}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
              A conversation started on one backend can&apos;t be replayed on another, so switching
              starts a fresh agent session. Open conversations keep their existing messages, but{' '}
              {pendingName} won&apos;t have their earlier context. New conversations are unaffected.
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button type="button" onClick={confirmSwitch}>
                  Switch
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </SettingsSection>
  )
}

export { AgentFrameworkSection }
