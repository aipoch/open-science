import { cn } from '@/lib/utils'
import type { ToolActivity } from '@/stores/session-store'
import {
  Check,
  CircleAlert,
  FilePen,
  FileText,
  Globe2,
  LoaderCircle,
  Search,
  Sparkles,
  Terminal,
  Wrench
} from 'lucide-react'

import { isActivityActive } from './workspace-conversation-items'

type WorkspaceActivityIconProps = {
  activity: ToolActivity
}

// Picks the smallest status/tool-kind icon that describes the current activity state.
const WorkspaceActivityIcon = ({ activity }: WorkspaceActivityIconProps): React.JSX.Element => {
  const isActive = isActivityActive(activity)
  const className = cn('size-3.5 shrink-0', isActive ? 'animate-spin' : undefined)
  const iconProps = {
    className,
    strokeWidth: 2.2,
    'aria-hidden': true
  } as const

  // Status takes precedence over tool kind so terminal or active states are unmistakable.
  if (isActive) return <LoaderCircle {...iconProps} />
  if (activity.status === 'failed') return <CircleAlert {...iconProps} />
  if (activity.status === 'completed') return <Check {...iconProps} />

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
