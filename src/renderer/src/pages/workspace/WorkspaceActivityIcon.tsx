import { cn } from '@/lib/utils'
import type { ToolActivity } from '@/stores/session-store'
import {
  Check,
  CircleAlert,
  CircleMinus,
  FilePen,
  FileText,
  Globe2,
  LoaderCircle,
  Search,
  Sparkles,
  Terminal,
  Wrench
} from 'lucide-react'

import { isActivityActive, isContextCompactionActivity } from './workspace-conversation-items'
import type { ToolExecutionPhase } from './tool-execution-phase'

type WorkspaceActivityIconProps = {
  activity: ToolActivity
  phase?: ToolExecutionPhase
}

// Picks the smallest status/tool-kind icon that describes the current activity state.
const WorkspaceActivityIcon = ({
  activity,
  phase
}: WorkspaceActivityIconProps): React.JSX.Element => {
  const isActive = phase ? phase === 'executing' : isActivityActive(activity)
  const className = cn('size-3.5 shrink-0', isActive ? 'animate-spin' : undefined)
  const iconProps = {
    className,
    strokeWidth: 2.2,
    'aria-hidden': true
  } as const

  // Status takes precedence over tool kind so terminal or active states are unmistakable.
  if (isActive) return <LoaderCircle {...iconProps} />
  if (phase ? phase === 'failed' : activity.status === 'failed') {
    return <CircleAlert {...iconProps} />
  }
  if (
    phase === 'closed' ||
    phase === 'declined' ||
    phase === 'limit-reached' ||
    phase === 'cancelled' ||
    phase === 'interrupted'
  ) {
    return <CircleMinus {...iconProps} />
  }
  if (isContextCompactionActivity(activity) && activity.title === 'Context compaction cancelled') {
    return <CircleMinus {...iconProps} />
  }
  if (phase ? phase === 'completed' : activity.status === 'completed') {
    return <Check {...iconProps} />
  }

  // Otherwise the tool kind hints at what the call did.
  switch (activity.toolKind) {
    case 'fetch':
      return <Globe2 {...iconProps} />
    case 'execute':
      return <Terminal {...iconProps} />
    case 'read':
      return <FileText {...iconProps} />
    case 'edit':
      return <FilePen {...iconProps} />
    case 'search':
      return <Search {...iconProps} />
    case 'think':
      return <Sparkles {...iconProps} />
    default:
      return <Wrench {...iconProps} />
  }
}

export { WorkspaceActivityIcon }
