import {
  ChevronDown,
  Download,
  FileUp,
  FolderInput,
  ListChecks,
  MessagesSquare,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { SkillSource } from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { resolveCustomizeProjectId } from '@/lib/last-opened-project'
import { SkillDetailView } from './SkillDetailView'
import { SkillEditor, SkillEditLoader } from './SkillEditor'
import { SkillImportView } from './SkillImportView'
import { SkillUploadView } from './SkillUploadView'
import { AgentHomeImportView } from './AgentHomeImportView'
import { SkillBulkManageView } from './SkillBulkManageView'
import { SettingsIconAction, SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'
import { SettingsSearchInput } from './SettingsSearchInput'

// The skills panel sub-view, driven by the settings navigation history so each is a breadcrumb page.
export type SkillsView =
  | { kind: 'list' }
  | { kind: 'manage' }
  | { kind: 'detail'; id: string }
  | { kind: 'create' }
  | { kind: 'edit'; id: string }
  | { kind: 'import' }
  | { kind: 'import-agent-home' }
  | { kind: 'upload' }

type SourceFilter = 'all' | SkillSource

const skillExportErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

// Both tables hold catalog keys, not resolved strings: a module-level constant is evaluated once at
// import, so resolved text would pin the language of whichever locale happened to load first and
// never update on a language switch. `as const satisfies` keeps the literals for t()'s key check.
const FILTER_LABEL_KEYS = {
  all: 'All',
  featured: 'Featured',
  imported: 'Imported',
  personal: 'Personal'
} as const satisfies Record<SourceFilter, string>

const SOURCE_GROUPS = [
  {
    source: 'featured',
    labelKey: 'Featured',
    subtitleKey: 'Research skills bundled with the app.'
  },
  {
    source: 'imported',
    labelKey: 'Imported',
    subtitleKey: 'Skills you added from GitHub.'
  },
  {
    source: 'personal',
    labelKey: 'Personal',
    subtitleKey: 'Your custom skills.'
  }
] as const satisfies ReadonlyArray<{ source: SkillSource; labelKey: string; subtitleKey: string }>

type SkillsPanelProps = {
  view: SkillsView
  onNavigate: (view: SkillsView) => void
  canImportInstalledSkills?: boolean
}

const SkillsPanel = ({
  view,
  onNavigate,
  canImportInstalledSkills = true
}: SkillsPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const skills = useSettingsStore((state) => state.skills)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const setSkillEnabled = useSettingsStore((state) => state.setSkillEnabled)
  const createSkill = useSettingsStore((state) => state.createSkill)
  const deleteSkill = useSettingsStore((state) => state.deleteSkill)
  const conversationSkillImportEnabled = useSettingsStore(
    (state) => state.conversationSkillImportEnabled
  )
  const setConversationSkillImportEnabled = useSettingsStore(
    (state) => state.setConversationSkillImportEnabled
  )
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const projects = useProjectStore((state) => state.projects)
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Partial<Record<SkillSource, boolean>>>({})
  const [deleteError, setDeleteError] = useState<string | undefined>()
  const [exportError, setExportError] = useState<string | undefined>()
  const [exportStatus, setExportStatus] = useState<{ id: string; message: string } | undefined>()
  const [exportingId, setExportingId] = useState<string | undefined>()
  const canExportSkills = typeof window.api?.settings?.exportSkill === 'function'
  const chatProjectId = useMemo(
    () => resolveCustomizeProjectId(projects.filter((project) => project.archivedAt === undefined)),
    [projects]
  )

  const startChatWithAgent = (): void => {
    if (!chatProjectId) return
    useSettingsStore.getState().closeSettings()
    useNavigationStore.getState().startCustomizeConversation(chatProjectId, 'skill')
  }

  const exportSkill = async (id: string, name: string): Promise<void> => {
    if (!canExportSkills) return
    setExportError(undefined)
    setExportStatus(undefined)
    setExportingId(id)
    try {
      const result = await window.api.settings.exportSkill({ id })
      if (result.saved) setExportStatus({ id, message: t('Exported {{name}}.', { name }) })
    } catch (error) {
      // Main-process failures arrive already worded; only the fallback is ours to translate.
      setExportError(skillExportErrorMessage(error) || t('Could not export this Skill.'))
    } finally {
      setExportingId(undefined)
    }
  }

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return skills.filter((skill) => {
      if (filter !== 'all' && skill.source !== filter) return false
      if (!term) return true
      return (
        skill.displayName.toLowerCase().includes(term) ||
        skill.name.toLowerCase().includes(term) ||
        skill.description.toLowerCase().includes(term)
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
            ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
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
  if (view.kind === 'import-agent-home') {
    return canImportInstalledSkills ? (
      <AgentHomeImportView key={agentFrameworkId} onImported={() => undefined} />
    ) : (
      <div className="p-5 text-sm text-muted-foreground">
        {t('Installed-skill import is available in the desktop app.')}
      </div>
    )
  }
  if (view.kind === 'upload') {
    return (
      <SkillUploadView
        onUploaded={() => onNavigate({ kind: 'list' })}
        onWriteInstead={() => onNavigate({ kind: 'create' })}
      />
    )
  }
  if (view.kind === 'manage') {
    return <SkillBulkManageView />
  }

  const groups = SOURCE_GROUPS.filter((group) => filter === 'all' || filter === group.source)

  return (
    <div className="p-5">
      <SettingsSection
        title={t('Conversation imports')}
        description={t('Choose what conversations can import into Open Science.')}
        aria-label={t('Conversation imports')}
        className="mb-4 border-b border-border pb-4"
        contentClassName="mt-1"
      >
        <SettingsRow
          label={t('Skill packages')}
          description={
            <span className="line-clamp-2">
              {t(
                'Let the agent detect attached .zip and .skill packages and ask before importing them.'
              )}
            </span>
          }
          className="min-h-0 py-1.5"
        >
          <div className="flex justify-end">
            <SettingsToggle
              enabled={conversationSkillImportEnabled}
              aria-label={t('Toggle conversation Skill imports')}
              onToggle={() =>
                void setConversationSkillImportEnabled(!conversationSkillImportEnabled)
              }
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      <div className="mb-4 flex items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as SourceFilter)}>
          <SelectTrigger aria-label={t('Filter skills by source')} className="w-36">
            <span>{t(FILTER_LABEL_KEYS[filter])}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('All')}</SelectItem>
            <SelectItem value="featured">{t('Featured')}</SelectItem>
            <SelectItem value="imported">{t('Imported')}</SelectItem>
            <SelectItem value="personal">{t('Personal')}</SelectItem>
          </SelectContent>
        </Select>
        <SettingsSearchInput
          aria-label={t('Search skills')}
          placeholder={t('Search skills…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="button" variant="outline" onClick={() => onNavigate({ kind: 'manage' })}>
          <ListChecks data-icon="inline-start" aria-hidden="true" />
          {t('Manage')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="shrink-0">
              <Plus data-icon="inline-start" aria-hidden="true" />
              {t('Add skill')}
              <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="gap-2.5"
              disabled={!chatProjectId}
              onSelect={startChatWithAgent}
            >
              <MessagesSquare className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('Chat with agent')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('Describe it in a new session')}
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'create' })}>
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('Write from scratch')}</span>
                <span className="text-xs text-muted-foreground">{t('Open the skill creator')}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'upload' })}>
              <FileUp className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('Upload skills')}</span>
                <span className="text-xs text-muted-foreground">{t('Pick SKILL.md files')}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'import' })}>
              <Download className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('Import from GitHub')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('Add a skill from a repo')}
                </span>
              </span>
            </DropdownMenuItem>
            {canImportInstalledSkills ? (
              <DropdownMenuItem
                className="gap-2.5"
                onSelect={() => onNavigate({ kind: 'import-agent-home' })}
              >
                <FolderInput className="size-4 shrink-0" aria-hidden="true" />
                <span className="flex flex-col">
                  <span>{t('Import installed skills')}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('Scan global skill folders')}
                  </span>
                </span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {deleteError ? (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          {deleteError}
        </p>
      ) : null}

      {exportError ? (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          {exportError}
        </p>
      ) : null}

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
                  {t(group.labelKey)}
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                      expanded ? '' : '-rotate-90'
                    }`}
                    aria-hidden="true"
                  />
                </span>
                <span className="text-xs text-muted-foreground">{t(group.subtitleKey)}</span>
              </button>

              {expanded ? (
                rows.length > 0 ? (
                  <ul className="mt-2 flex flex-col divide-y divide-border">
                    {rows.map((skill) => (
                      <li
                        key={skill.id}
                        data-slot="settings-list-row"
                        className="flex min-h-14 items-center gap-2 py-2.5"
                      >
                        <button
                          type="button"
                          onClick={() => onNavigate({ kind: 'detail', id: skill.id })}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-sm text-foreground">
                            {skill.displayName}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {skill.description}
                          </span>
                        </button>
                        {exportStatus?.id === skill.id ? (
                          <span role="status" className="shrink-0 text-xs text-muted-foreground">
                            {exportStatus.message}
                          </span>
                        ) : null}
                        {skill.source !== 'featured' && canExportSkills ? (
                          <SettingsIconAction
                            label={t('Export {{name}}', { name: skill.displayName })}
                            icon={Download}
                            disabled={exportingId !== undefined}
                            onClick={() => void exportSkill(skill.id, skill.displayName)}
                          />
                        ) : null}
                        {skill.source === 'personal' ? (
                          <SettingsIconAction
                            label={t('Edit {{name}}', { name: skill.displayName })}
                            icon={Pencil}
                            onClick={() => onNavigate({ kind: 'edit', id: skill.id })}
                          />
                        ) : null}
                        {skill.source !== 'featured' ? (
                          <SettingsIconAction
                            label={t('Delete {{name}}', { name: skill.displayName })}
                            icon={Trash2}
                            onClick={() => {
                              setDeleteError(undefined)
                              void deleteSkill(skill.id).catch((error) =>
                                setDeleteError(
                                  error instanceof Error
                                    ? error.message
                                    : t('This Skill is protected and cannot be deleted.')
                                )
                              )
                            }}
                            danger
                          />
                        ) : null}
                        <SettingsToggle
                          enabled={skill.enabled}
                          aria-label={t('Toggle {{name}}', { name: skill.displayName })}
                          onToggle={() => void setSkillEnabled(skill.id, !skill.enabled)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 py-2 text-xs text-muted-foreground">
                    {group.source === 'personal'
                      ? t('Create a skill to teach Claude a workflow you use.')
                      : group.source === 'imported'
                        ? t('No imported skills yet.')
                        : t('No skills match your search.')}
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

export { SkillsPanel }
