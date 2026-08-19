import {
  ChevronDown,
  Download,
  FileUp,
  FolderInput,
  Info,
  ListChecks,
  MessagesSquare,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { SkillSource } from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import { resolveCustomizeProjectId } from '@/lib/last-opened-project'
import { SkillDetailView } from './SkillDetailView'
import { SkillEditor, SkillEditLoader } from './SkillEditor'
import { SkillImportView } from './SkillImportView'
import { SkillUploadView } from './SkillUploadView'
import { AgentHomeImportView } from './AgentHomeImportView'
import { SkillBulkManageView } from './SkillBulkManageView'
import { SettingsLoadNotice, SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'
import { SettingsSearchInput } from './SettingsSearchInput'
import {
  specialistsOwningSkill,
  specialistsUsingSkill,
  type SpecialistUsage
} from './specialist-resource-scope'
import { SkillUsageAgents } from './SkillUsageAgents'
import {
  ResourceTagBadges,
  ResourceTagMenu,
  ResourceTagSummary,
  TagFilter
} from './ResourceTagControls'

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
const MAIN_AGENT_FILTER = '__main-agent__'

const skillOperationErrorMessage = (error: unknown): string => {
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
  onOpenTag?: (tagId: string) => void
  onOpenSpecialist?: (usage: SpecialistUsage) => void
  canImportInstalledSkills?: boolean
}

const SkillsPanel = ({
  view,
  onNavigate,
  onOpenTag,
  onOpenSpecialist,
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
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const projects = useProjectStore((state) => state.projects)
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [specialistFilter, setSpecialistFilter] = useState('all')
  const [tagFilter, setTagFilter] = useState('all')
  const tagAssignments = useTagStore((state) => state.assignments)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Partial<Record<SkillSource, boolean>>>({})
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | undefined>()
  const [exportError, setExportError] = useState<string | undefined>()
  const [exportStatus, setExportStatus] = useState<{ id: string; message: string } | undefined>()
  const [exportingId, setExportingId] = useState<string | undefined>()
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [toggleError, setToggleError] = useState<string | undefined>()
  const loadRequestRef = useRef(0)
  const exportInFlightRef = useRef(false)
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
    if (!canExportSkills || exportInFlightRef.current) return
    exportInFlightRef.current = true
    setExportError(undefined)
    setExportStatus(undefined)
    setExportingId(id)
    try {
      const result = await window.api.settings.exportSkill({ id })
      if (result.saved) setExportStatus({ id, message: t('Exported {{name}}.', { name }) })
    } catch (error) {
      // Main-process failures arrive already worded; only the fallback is ours to translate.
      setExportError(skillOperationErrorMessage(error) || t('Could not export this Skill.'))
    } finally {
      exportInFlightRef.current = false
      setExportingId(undefined)
    }
  }

  const loadCatalog = async (): Promise<void> => {
    const requestId = ++loadRequestRef.current
    setCatalogState('loading')
    try {
      await loadSkills()
      if (loadRequestRef.current === requestId) setCatalogState('ready')
    } catch {
      if (loadRequestRef.current === requestId) setCatalogState('error')
    }
  }

  const retryCatalog = (): void => {
    void loadCatalog()
  }

  useEffect(() => {
    const requestId = ++loadRequestRef.current
    void loadSkills().then(
      () => {
        if (loadRequestRef.current === requestId) setCatalogState('ready')
      },
      () => {
        if (loadRequestRef.current === requestId) setCatalogState('error')
      }
    )
    return () => {
      loadRequestRef.current += 1
    }
  }, [loadSkills])

  useEffect(() => {
    void loadSpecialists()
  }, [loadSpecialists])

  const specialistOptions = useMemo(
    () =>
      specialistItems
        .flatMap((item) =>
          item.kind === 'reviewer'
            ? []
            : [{ id: item.id, name: item.displayName?.trim() || item.name }]
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    [specialistItems]
  )

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return skills.flatMap((skill) => {
      if (filter !== 'all' && skill.source !== filter) return []
      const usages = specialistsUsingSkill(specialistItems, skill.id)
      const owners = specialistsOwningSkill(specialistItems, skill.id)
      if (specialistFilter === MAIN_AGENT_FILTER && !skill.enabled) return []
      if (
        specialistFilter !== 'all' &&
        specialistFilter !== MAIN_AGENT_FILTER &&
        !usages.some((usage) => usage.id === specialistFilter)
      ) {
        return []
      }
      if (
        tagFilter !== 'all' &&
        !tagAssignments.some(
          (assignment) =>
            assignment.tagId === tagFilter &&
            assignment.resourceType === 'catalog.skill' &&
            assignment.resourceId === skill.id
        )
      ) {
        return []
      }
      if (
        term &&
        !(
          skill.displayName.toLowerCase().includes(term) ||
          skill.name.toLowerCase().includes(term) ||
          skill.description.toLowerCase().includes(term)
        )
      )
        return []
      return [{ skill, usages, owners }]
    })
  }, [filter, query, skills, specialistFilter, specialistItems, tagAssignments, tagFilter])
  if (view.kind === 'detail') {
    return (
      <div>
        <ResourceTagSummary
          reference={{ resourceType: 'catalog.skill', resourceId: view.id }}
          className="px-5 pt-5"
          onOpenTag={onOpenTag}
        />
        <SkillDetailView key={view.id} skillId={view.id} onOpenSpecialist={onOpenSpecialist} />
      </div>
    )
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
    return (
      <div>
        <ResourceTagSummary
          reference={{ resourceType: 'catalog.skill', resourceId: view.id }}
          className="px-5 pt-5"
          onOpenTag={onOpenTag}
        />
        <SkillEditLoader skillId={view.id} onDone={() => onNavigate({ kind: 'list' })} />
      </div>
    )
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

  const toggleSkill = async (id: string, enabled: boolean): Promise<void> => {
    setToggleError(undefined)
    try {
      await setSkillEnabled(id, enabled)
    } catch {
      setToggleError(t('Could not save this setting. The previous value was restored.'))
    }
  }

  if (skills.length === 0 && catalogState !== 'ready') {
    return (
      <div className="p-5">
        <SettingsLoadNotice
          state={catalogState === 'error' ? 'error' : 'loading'}
          loadingLabel={t('Loading Skills…')}
          errorMessage={t('Open Science could not load Skills.')}
          onRetry={retryCatalog}
        />
      </div>
    )
  }

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

      <div className="mb-4 space-y-2">
        <div data-slot="skills-filter-bar" className="flex flex-wrap items-center gap-2">
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
          <Select value={specialistFilter} onValueChange={setSpecialistFilter}>
            <SelectTrigger aria-label={t('Filter Skills by agent')} className="w-48">
              <span>
                {specialistFilter === 'all'
                  ? t('All Agents/Specialists')
                  : specialistFilter === MAIN_AGENT_FILTER
                    ? t('Main Agent')
                    : specialistOptions.find((item) => item.id === specialistFilter)?.name}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('All Agents/Specialists')}</SelectItem>
              <SelectItem value={MAIN_AGENT_FILTER}>{t('Main Agent')}</SelectItem>
              {specialistOptions.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <TagFilter resourceType="catalog.skill" value={tagFilter} onChange={setTagFilter} />
          <SettingsSearchInput
            aria-label={t('Search skills')}
            placeholder={t('Search skills…')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div data-slot="skills-action-bar" className="flex items-center justify-end gap-2">
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
                  <span className="text-xs text-muted-foreground">
                    {t('Open the skill creator')}
                  </span>
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
      </div>

      {exportError ? (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          {exportError}
        </p>
      ) : null}

      {toggleError ? (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          {toggleError}
        </p>
      ) : null}

      {catalogState === 'error' && skills.length > 0 ? (
        <SettingsLoadNotice
          state="error"
          loadingLabel={t('Loading Skills…')}
          errorMessage={t('Open Science could not load Skills.')}
          onRetry={retryCatalog}
          className="mb-3"
        />
      ) : null}

      <div className="flex flex-col gap-4">
        {groups.map((group) => {
          const rows = visible.filter(({ skill }) => skill.source === group.source)
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
                    {rows.map(({ skill, usages, owners }) => {
                      const deleteBlockedReason =
                        owners.length === 1
                          ? t(
                              'Owned by {{name}}. Delete this Skill when deleting that Specialist.',
                              { name: owners[0].name }
                            )
                          : owners.length > 1
                            ? t(
                                'Owned by {{count}} Specialists. Delete this Skill when deleting its final owner.',
                                { count: owners.length }
                              )
                            : usages.length === 1
                              ? t(
                                  'Used by {{name}}. Remove this Skill from that Specialist before deleting it.',
                                  { name: usages[0].name }
                                )
                              : usages.length > 1
                                ? t(
                                    'Used by {{count}} Specialists. Remove this Skill from them before deleting it.',
                                    { count: usages.length }
                                  )
                                : undefined
                      return (
                        <li
                          key={skill.id}
                          data-slot="settings-list-row"
                          className="flex min-h-14 flex-wrap items-center gap-2 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => onNavigate({ kind: 'detail', id: skill.id })}
                              className="block w-full min-w-0 text-left"
                            >
                              <span className="block truncate text-sm text-foreground">
                                {skill.displayName}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {skill.description}
                              </span>
                            </button>
                            <div className="mt-0.5 flex min-w-0 items-center gap-2">
                              {skill.enabled || usages.length > 0 ? (
                                <span className="inline-flex shrink-0 items-center gap-1">
                                  <span
                                    data-slot="skill-usage-agents-label"
                                    className="text-xs text-muted-foreground"
                                  >
                                    {t('Used by')}
                                  </span>
                                  <SkillUsageAgents
                                    mainEnabled={skill.enabled}
                                    usages={usages}
                                    onOpenSpecialist={onOpenSpecialist}
                                  />
                                </span>
                              ) : null}
                              <ResourceTagBadges
                                reference={{
                                  resourceType: 'catalog.skill',
                                  resourceId: skill.id
                                }}
                                onOpenTag={onOpenTag}
                              />
                            </div>
                          </div>
                          {exportStatus?.id === skill.id ? (
                            <span role="status" className="shrink-0 text-xs text-muted-foreground">
                              {exportStatus.message}
                            </span>
                          ) : null}
                          <div className="flex shrink-0 items-center gap-2">
                            <ResourceTagMenu
                              reference={{ resourceType: 'catalog.skill', resourceId: skill.id }}
                            />
                            {skill.source !== 'featured' ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    disabled={exportingId !== undefined}
                                    aria-label={t('Actions for {{name}}', {
                                      name: skill.displayName
                                    })}
                                  >
                                    <ChevronDown aria-hidden="true" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {canExportSkills ? (
                                    <DropdownMenuItem
                                      className="gap-2 text-xs"
                                      onSelect={() => void exportSkill(skill.id, skill.displayName)}
                                    >
                                      <Download className="size-3.5" aria-hidden="true" />
                                      {t('Export')}
                                    </DropdownMenuItem>
                                  ) : null}
                                  {skill.source === 'personal' ? (
                                    <DropdownMenuItem
                                      className="gap-2 text-xs"
                                      onSelect={() => onNavigate({ kind: 'edit', id: skill.id })}
                                    >
                                      <Pencil className="size-3.5" aria-hidden="true" /> {t('Edit')}
                                    </DropdownMenuItem>
                                  ) : null}
                                  <DropdownMenuSeparator />
                                  {deleteBlockedReason ? (
                                    <TooltipProvider delayDuration={800}>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <DropdownMenuItem
                                            aria-disabled="true"
                                            data-slot="skill-delete-blocked"
                                            className="gap-2 text-xs text-muted-foreground hover:text-muted-foreground data-[highlighted]:text-muted-foreground"
                                            onSelect={(event) => event.preventDefault()}
                                          >
                                            <Trash2
                                              className="size-3.5 shrink-0"
                                              aria-hidden="true"
                                            />
                                            <span className="min-w-0 flex-1">{t('Delete')}</span>
                                            <Info
                                              data-slot="skill-delete-blocked-tip"
                                              className="size-3.5 shrink-0"
                                              aria-hidden="true"
                                            />
                                          </DropdownMenuItem>
                                        </TooltipTrigger>
                                        <TooltipContent side="left" className="max-w-64">
                                          {deleteBlockedReason}
                                        </TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  ) : (
                                    <DropdownMenuItem
                                      className="gap-2 text-xs text-destructive"
                                      onSelect={() => {
                                        setDeleteError(undefined)
                                        void deleteSkill(skill.id).catch((error) =>
                                          setDeleteError({
                                            id: skill.id,
                                            message:
                                              skillOperationErrorMessage(error) ||
                                              t('This Skill is protected and cannot be deleted.')
                                          })
                                        )
                                      }}
                                    >
                                      <Trash2 className="size-3.5 shrink-0" aria-hidden="true" />
                                      <span>{t('Delete')}</span>
                                    </DropdownMenuItem>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                            <SettingsToggle
                              enabled={skill.enabled}
                              aria-label={t('Toggle {{name}}', { name: skill.displayName })}
                              title={
                                skill.enabled
                                  ? t('Available to Main Agent')
                                  : t('Unavailable to Main Agent')
                              }
                              onToggle={() => void toggleSkill(skill.id, !skill.enabled)}
                            />
                          </div>
                          {deleteError?.id === skill.id ? (
                            <p
                              role="alert"
                              className="basis-full rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
                            >
                              {deleteError.message}
                            </p>
                          ) : null}
                        </li>
                      )
                    })}
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
