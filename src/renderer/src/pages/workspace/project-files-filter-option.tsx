import { Boxes, Check, EyeOff, Folder, Paperclip } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { ProjectFilesFilterOption } from './project-files-query-model'

// Keeps collection semantics visible in both the menu rows and the currently selected trigger.
const ProjectFilesFilterIcon = ({
  kind,
  className
}: {
  kind: ProjectFilesFilterOption['kind']
  className: string
}): React.JSX.Element => {
  if (kind === 'hidden') return <EyeOff className={className} aria-hidden="true" />
  if (kind === 'uploads') {
    return <Paperclip className={className} strokeWidth={1.8} aria-hidden="true" />
  }
  if (kind === 'session') {
    return <Folder className={className} strokeWidth={1.8} aria-hidden="true" />
  }
  return <Boxes className={className} strokeWidth={1.8} aria-hidden="true" />
}
const FilterMenuItem = ({
  option,
  isSelected,
  onSelect
}: {
  option: ProjectFilesFilterOption
  isSelected: boolean
  onSelect: (optionId: string) => void
}): React.JSX.Element => (
  <DropdownMenuItem
    role="menuitemradio"
    aria-checked={isSelected}
    data-filter-id={option.id}
    className="gap-2"
    onSelect={() => onSelect(option.id)}
  >
    <ProjectFilesFilterIcon kind={option.kind} className="size-4 shrink-0 text-text-300" />
    <span className="min-w-0 flex-1 truncate">{option.label}</span>
    {isSelected ? (
      <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
    ) : null}
    <span className="shrink-0 text-[11px] text-text-300">{option.count}</span>
  </DropdownMenuItem>
)

export { ProjectFilesFilterIcon, FilterMenuItem }
