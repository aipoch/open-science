import { ChevronDown, Download, Loader2, Wrench } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ClaudeInstallSource, ClaudeInstallSourceInfo } from '../../../../shared/settings'

type AgentInstallSourceMenuProps = {
  name: string
  label: 'Install' | 'Repair'
  sources: ClaudeInstallSourceInfo[]
  installing: boolean
  disabled: boolean
  npmAvailable: boolean
  blockedInstallSources: Partial<Record<ClaudeInstallSource, string>>
  buttonSize?: React.ComponentProps<typeof Button>['size']
  onInstall: (source: ClaudeInstallSource) => void
}

// The card action and repair dialog share one source picker so availability rules and installer
// routing cannot drift between the two entry points.
const AgentInstallSourceMenu = ({
  name,
  label,
  sources,
  installing,
  disabled,
  npmAvailable,
  blockedInstallSources,
  buttonSize = 'sm',
  onInstall
}: AgentInstallSourceMenuProps): React.JSX.Element => {
  const Icon = label === 'Repair' ? Wrench : Download

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size={buttonSize}
          disabled={installing || disabled}
          aria-label={`${label} ${name}`}
        >
          {installing ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Icon aria-hidden />
          )}
          {installing ? 'Installing…' : label}
          {!installing ? <ChevronDown aria-hidden="true" /> : null}
        </Button>
      </DropdownMenuTrigger>
      {/* The same menu is portaled from the z-60 repair dialog, so its layer must clear that modal. */}
      <DropdownMenuContent align="end" className="z-[70] w-80">
        <DropdownMenuLabel>Install source</DropdownMenuLabel>
        {sources.map((item) => {
          // Keep unavailable sources visible with a reason so users can understand what prerequisite
          // is missing without losing the complete set of supported repair paths.
          const npmMissing = item.requiresNpm && !npmAvailable
          const unavailableReason =
            blockedInstallSources[item.id] ?? (npmMissing ? 'npm not found' : undefined)
          return (
            <DropdownMenuItem
              key={item.id}
              disabled={Boolean(unavailableReason)}
              onSelect={() => onInstall(item.id)}
              className="flex flex-col items-start gap-0.5"
            >
              <span>
                {item.label}
                {unavailableReason ? ` (${unavailableReason})` : ''}
              </span>
              {item.description ? (
                <span className="text-xs text-muted-foreground">{item.description}</span>
              ) : item.displayCommand ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {item.displayCommand}
                </span>
              ) : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { AgentInstallSourceMenu }
export type { AgentInstallSourceMenuProps }
