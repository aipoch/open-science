// Shared ro/rw access badge styling for granted local roots, used by both the Files tab filter
// menu and the composer "Your files" tree: mono 10px, green for read & write.
import type { GrantedLocalRoot } from '../../../../shared/local-fs'
import { cn } from '@/lib/utils'

export const grantedRootAccessBadgeClassName = (access: GrantedLocalRoot['access']): string =>
  cn(
    'shrink-0 rounded px-1 font-mono text-[10px] font-semibold leading-4',
    access === 'rw' ? 'bg-mention-chip text-mention-chip-foreground' : 'bg-bg-200 text-text-100'
  )
