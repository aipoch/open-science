import { ChevronDown, Download, FileUp, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { SkillSource } from '../../../../shared/settings'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import { SkillDetailView } from './SkillDetailView'
import { SkillEditor, SkillEditLoader } from './SkillEditor'
import { SkillImportView } from './SkillImportView'
import { SkillUploadView } from './SkillUploadView'

// The skills panel sub-view, driven by the settings navigation history so each is a breadcrumb page.
export type SkillsView =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'create' }
  | { kind: 'edit'; id: string }
  | { kind: 'import' }
  | { kind: 'upload' }

type SourceFilter = 'all' | SkillSource

const FILTER_LABELS: Record<SourceFilter, string> = {
  all: 'All',
  featured: 'Featured',
  imported: 'Imported',
  personal: 'Personal'
}

const SOURCE_GROUPS: ReadonlyArray<{ source: SkillSource; label: string; subtitle: string }> = [
  { source: 'featured', label: 'Featured', subtitle: 'Research skills bundled with the app.' },
  { source: 'imported', label: 'Imported', subtitle: 'Skills you added from GitHub.' },
  { source: 'personal', label: 'Personal', subtitle: 'Your custom skills.' }
]

// A compact on/off toggle. The repo has no shared Switch component, so the control is inlined here and
// reused by the detail view via the same markup.
const SkillToggle = ({
  enabled,
  label,
  onToggle
}: {
  enabled: boolean
  label: string
  onToggle: () => void
}): React.JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    aria-label={label}
    onClick={onToggle}
    className={
      'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ' +
      (enabled ? 'bg-primary' : 'bg-muted')
    }
  >
    <span
      className={
        'inline-block size-4 rounded-full bg-white shadow transition-transform ' +
        (enabled ? 'translate-x-4' : 'translate-x-0.5')
      }
    />
  </button>
)

type SkillsPanelProps = {
  view: SkillsView
  onNavigate: (view: SkillsView) => void
}

const SkillsPanel = ({ view, onNavigate }: SkillsPanelProps): React.JSX.Element => {
  const skills = useSettingsStore((state) => state.skills)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const setSkillEnabled = useSettingsStore((state) => state.setSkillEnabled)
  const createSkill = useSettingsStore((state) => state.createSkill)
  const deleteSkill = useSettingsStore((state) => state.deleteSkill)

  const [filter, setFilter] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Partial<Record<SkillSource, boolean>>>({})

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return skills.filter((skill) => {
      if (filter !== 'all' && skill.source !== filter) return false
      if (!term) return true
      return (
        skill.name.toLowerCase().includes(term) || skill.description.toLowerCase().includes(term)
      )
    })
  }, [skills, filter, query])

  if (view.kind === 'detail') {
    return <SkillDetailView skillId={view.id} />
  }
  if (view.kind === 'create') {
    return (
      <SkillEditor
        initial={{ name: '', description: '', body: '' }}
        onCancel={() => onNavigate({ kind: 'list' })}
        onSave={async (draft) => {
          await createSkill({
            name: draft.name,
            description: draft.description,
            body: draft.body,
            slug: draft.slug,
            references: draft.references
          })
          onNavigate({ kind: 'list' })
        }}
      />
    )
  }
  if (view.kind === 'edit') {
    return <SkillEditLoader skillId={view.id} onDone={() => onNavigate({ kind: 'list' })} />
  }
  if (view.kind === 'import') {
    return <SkillImportView onImported={() => undefined} />
  }
  if (view.kind === 'upload') {
    return (
      <SkillUploadView
        onUploaded={() => onNavigate({ kind: 'list' })}
        onWriteInstead={() => onNavigate({ kind: 'create' })}
      />
    )
  }

  const groups = SOURCE_GROUPS.filter((group) => filter === 'all' || filter === group.source)

  return (
    <div className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as SourceFilter)}>
          <SelectTrigger aria-label="Filter skills by source" className="w-36">
            <span>{FILTER_LABELS[filter]}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="featured">Featured</SelectItem>
            <SelectItem value="imported">Imported</SelectItem>
            <SelectItem value="personal">Personal</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search skills"
            placeholder="Search skills…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted">
            <Plus className="size-4" aria-hidden="true" />
            Add skill
            <ChevronDown className="size-4 opacity-70" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'create' })}>
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Write from scratch</span>
                <span className="text-xs text-muted-foreground">Open the skill creator</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'upload' })}>
              <FileUp className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Upload a skill</span>
                <span className="text-xs text-muted-foreground">Pick a SKILL.md file</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'import' })}>
              <Download className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Import from GitHub</span>
                <span className="text-xs text-muted-foreground">Add a skill from a repo</span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-4">
        {groups.map((group) => {
          const rows = visible.filter((skill) => skill.source === group.source)
          const expanded = !collapsed[group.source]

          return (
            <div key={group.source}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() =>
                  setCollapsed((prev) => ({ ...prev, [group.source]: !prev[group.source] }))
                }
                className="flex w-full flex-col items-start gap-0.5 text-left"
              >
                <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                  {group.label}
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                      expanded ? '' : '-rotate-90'
                    }`}
                    aria-hidden="true"
                  />
                </span>
                <span className="text-xs text-muted-foreground">{group.subtitle}</span>
              </button>

              {expanded ? (
                rows.length > 0 ? (
                  <ul className="mt-2 flex flex-col divide-y divide-border">
                    {rows.map((skill) => (
                      <li key={skill.id} className="flex items-center gap-2 py-2.5">
                        <button
                          type="button"
                          onClick={() => onNavigate({ kind: 'detail', id: skill.id })}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-sm text-foreground">
                            {skill.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {skill.description}
                          </span>
                        </button>
                        {skill.source === 'personal' ? (
                          <button
                            type="button"
                            aria-label={`Edit ${skill.name}`}
                            onClick={() => onNavigate({ kind: 'edit', id: skill.id })}
                            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <Pencil className="size-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                        {skill.source !== 'featured' ? (
                          <button
                            type="button"
                            aria-label={`Delete ${skill.name}`}
                            onClick={() => void deleteSkill(skill.id)}
                            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                        <SkillToggle
                          enabled={skill.enabled}
                          label={`Toggle ${skill.name}`}
                          onToggle={() => void setSkillEnabled(skill.id, !skill.enabled)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 py-2 text-xs text-muted-foreground">
                    {group.source === 'personal'
                      ? 'Create a skill to teach Claude a workflow you use.'
                      : group.source === 'imported'
                        ? 'No imported skills yet.'
                        : 'No skills match your search.'}
                  </p>
                )
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export { SkillsPanel, SkillToggle }
