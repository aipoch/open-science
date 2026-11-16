import { Boxes, Check, ChevronDown, Folder, Paperclip } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import type { ProjectFilesFilterOption } from './project-files-query-model'

export const ProjectFilesSectionHeader = ({
  id,
  title,
  countLabel,
  isCollapsed,
  hideTopBorder = false,
  onToggle
}: {
  id: string
  title: string
  countLabel: string
  isCollapsed: boolean
  hideTopBorder?: boolean
  onToggle: (id: string) => void
}): React.JSX.Element => (
  <button
    type="button"
    data-testid="project-file-section-header"
    className={cn(
      'flex w-full min-w-0 items-center gap-1.5 px-4 py-2 text-left text-sm text-text-000 hover:bg-bg-100',
      id.startsWith('session:') && 'cursor-default',
      !hideTopBorder && 'border-t border-border-300/40'
    )}
    aria-expanded={!isCollapsed}
    onClick={() => onToggle(id)}
  >
    <ChevronDown
      className={cn(
        'size-3 shrink-0 text-text-300 transition-transform motion-reduce:transition-none',
        isCollapsed && '-rotate-90'
      )}
      strokeWidth={2}
      aria-hidden="true"
    />
    <span className="min-w-0 flex-1 truncate">{title}</span>
    <span className="shrink-0 text-[11px] text-text-300">{countLabel}</span>
  </button>
)

// Keeps collection semantics visible in both the menu rows and the currently selected trigger.
export const ProjectFilesFilterIcon = ({
  kind,
  className
}: {
  kind: ProjectFilesFilterOption['kind']
  className: string
}): React.JSX.Element => {
  if (kind === 'uploads') {
    return <Paperclip className={className} strokeWidth={1.8} aria-hidden="true" />
  }
  if (kind === 'session') {
    return <Folder className={className} strokeWidth={1.8} aria-hidden="true" />
  }
  return <Boxes className={className} strokeWidth={1.8} aria-hidden="true" />
}

export const ProjectFolderSourceOption = ({
  name,
  selected,
  onSelect
}: {
  name: string | undefined
  selected: boolean
  onSelect: (() => void) | undefined
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (!name) return null

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('This project')}</DropdownMenuLabel>
      <DropdownMenuGroup>
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={selected}
          className="gap-2"
          onSelect={onSelect}
        >
          <Folder className="size-4 shrink-0 text-text-300" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {t('Project folder')} <span className="text-[11px] text-text-300">{name}</span>
          </span>
          {selected ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  )
}
