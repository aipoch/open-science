import { useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleX,
  Copy,
  Download,
  Info,
  Loader2,
  MessagesSquare,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { AlertDialog, Collapsible } from 'radix-ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { specialistDiagnosticCopy } from '@/lib/specialist-diagnostics'
import { resolveCustomizeProjectId } from '@/lib/last-opened-project'
import { SettingsToggle } from './SettingsLayout'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useMarketplaceStore } from '@/stores/marketplace-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useTagStore } from '@/stores/tag-store'
import type { CreateSpecialistInput, SpecialistListItem } from '../../../../shared/specialist'
import type { SkillSource } from '../../../../shared/settings'
import { specialistPackageReportFromPreview } from '../../../../shared/specialist-package'
import type {
  SpecialistDeletePreview,
  SpecialistDeleteResult
} from '../../../../shared/specialist-package'
import { SpecialistEditor } from './SpecialistEditor'
import { MarketplaceManagedSpecialistDetail } from './MarketplaceManagedSpecialistDetail'
import {
  MarketplaceTabs,
  SpecialistMarketplace,
  type SpecialistMarketplaceView
} from './SpecialistMarketplace'
import { SettingsSearchInput } from './SettingsSearchInput'
import { SpecialistAppearancePicker } from './SpecialistAppearancePicker'
import { SpecialistAvatar } from './specialist-avatar'
import { SpecialistSkillConflictChoices } from './SpecialistSkillConflictChoices'
import {
  skillConflictResolutionList,
  specialistSkillConflicts,
  type SkillConflictResolutionMap
} from './specialist-skill-conflicts'
import {
  ResourceTagBadges,
  ResourceTagMenu,
  ResourceTagSummary,
  TagFilter
} from './ResourceTagControls'

// Sub-view for the Specialists panel (parallels SkillsView).
export type SpecialistsView =
  | { kind: 'list' }
  | { kind: 'create'; draft?: CreateSpecialistInput }
  | { kind: 'edit'; id: string }
  | { kind: 'export'; id: string }
  | { kind: 'import' }
  | { kind: 'builtin'; id: string }
  | SpecialistMarketplaceView

type CategoryFilter = 'all' | 'custom' | 'marketplace' | 'builtin'

const FILTER_LABELS: Record<CategoryFilter, string> = {
  all: 'All',
  custom: 'Custom',
  marketplace: 'Marketplace',
  builtin: 'Built-in'
}

const getFilterLabel = (filter: CategoryFilter, t: (key: string) => string): string => {
  return t(FILTER_LABELS[filter])
}

const SKILL_SOURCE_LABELS: Record<SkillSource, string> = {
  featured: 'Featured',
  imported: 'Imported',
  personal: 'Personal'
}

const getSkillSourceLabel = (source: SkillSource, t: (key: string) => string): string => {
  return t(SKILL_SOURCE_LABELS[source])
}

const formatBytes = (
  value: number,
  t: (key: string, options?: Record<string, unknown>) => string
): string =>
  value >= 1024 * 1024
    ? t('{{size}} MB', { size: Number((value / (1024 * 1024)).toFixed(1)) })
    : t('{{size}} KB', { size: Number((value / 1024).toFixed(1)) })

// User-facing presentation of package diagnostics (see lib/specialist-diagnostics.ts).
// Severity is distinguished by icon shape, color and grouping, not by color alone.
const SEVERITY_GROUPS = [
  { severity: 'error', label: 'Blocking errors' },
  { severity: 'warning', label: 'Warnings' },
  { severity: 'info', label: 'Information' }
] as const

const getSeverityLabel = (
  severity: 'error' | 'warning' | 'info',
  t: (key: string) => string
): string => {
  const group = SEVERITY_GROUPS.find((g) => g.severity === severity)
  return group ? t(group.label) : severity
}

const SEVERITY_ICON = {
  error: CircleX,
  warning: AlertTriangle,
  info: Info
} as const

const SEVERITY_CLASSES = {
  error: 'border-red-200 bg-red-50 text-red-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  info: 'border-blue-200 bg-blue-50 text-blue-800'
} as const

type SpecialistsPanelProps = {
  view: SpecialistsView
  onNavigate: (view: SpecialistsView) => void
  onOpenTag?: (tagId: string) => void
  // Opens one Skill / Connector from a specialist's capability list in its own settings panel.
  onOpenSkillDetail?: (skillId: string) => void
  onOpenConnectorDetail?: (connectorId: string) => void
}

type InstalledSpecialistsView = Exclude<SpecialistsView, SpecialistMarketplaceView>

const InstalledSpecialistsPanel = ({
  view,
  onNavigate,
  onOpenTag,
  onOpenSkillDetail,
  onOpenConnectorDetail
}: {
  view: InstalledSpecialistsView
  onNavigate: (view: SpecialistsView) => void
  onOpenTag?: (tagId: string) => void
  onOpenSkillDetail?: (skillId: string) => void
  onOpenConnectorDetail?: (connectorId: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()

  const items = useSpecialistStore((s) => s.items)
  const isLoaded = useSpecialistStore((s) => s.isLoaded)
  const loadError = useSpecialistStore((s) => s.loadError)
  const integrity = useSpecialistStore((s) => s.integrity)
  const load = useSpecialistStore((s) => s.load)
  const setEnabled = useSpecialistStore((s) => s.setEnabled)
  const createSpecialist = useSpecialistStore((s) => s.create)
  const updateSpecialist = useSpecialistStore((s) => s.update)
  const previewSpecialistDelete = useSpecialistStore((s) => s.previewDelete)
  const deleteSpecialist = useSpecialistStore((s) => s.delete)
  const duplicateSpecialist = useSpecialistStore((s) => s.duplicate)
  const packagePreview = useSpecialistStore((s) => s.packagePreview)
  const selectPackage = useSpecialistStore((s) => s.selectPackage)
  const installPackage = useSpecialistStore((s) => s.installPackage)
  const cancelPackage = useSpecialistStore((s) => s.cancelPackage)
  const exportPreview = useSpecialistStore((s) => s.exportPreview)
  const previewExport = useSpecialistStore((s) => s.previewExport)
  const exportSpecialist = useSpecialistStore((s) => s.exportSpecialist)
  const clearExport = useSpecialistStore((s) => s.clearExport)
  const marketplaceSnapshot = useMarketplaceStore((s) => s.snapshot)
  const refreshMarketplace = useMarketplaceStore((s) => s.refresh)
  // Live project catalog drives the `Chat with agent` entry's enabled state and routing. The stored
  // last-opened reference is re-validated against this list before navigating.
  const projects = useProjectStore((s) => s.projects)
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState('all')
  const [collapsed, setCollapsed] = useState<
    Partial<Record<Exclude<CategoryFilter, 'all'>, boolean>>
  >({})
  const tagAssignments = useTagStore((state) => state.assignments)
  const [deletingItem, setDeletingItem] = useState<{
    id: string
    revision: number
    name: string
    preview: SpecialistDeletePreview
    action: 'delete' | 'uninstall'
  } | null>(null)
  const [deleteSkillIds, setDeleteSkillIds] = useState<Set<string>>(new Set())
  const [deleteSkillsExpanded, setDeleteSkillsExpanded] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>()
  const [templateSaving, setTemplateSaving] = useState(false)
  const [templateSaved, setTemplateSaved] = useState(false)
  const [templateSaveError, setTemplateSaveError] = useState<string | undefined>()
  const [packageBusy, setPackageBusy] = useState(false)
  const [packageErrorCode, setPackageErrorCode] = useState<string | undefined>()
  const [skillConflictResolutions, setSkillConflictResolutions] =
    useState<SkillConflictResolutionMap>({})
  const [overwriteConfirmationOpen, setOverwriteConfirmationOpen] = useState(false)
  const [reportStatus, setReportStatus] = useState<string | undefined>()
  const [includedExportSkillIds, setIncludedExportSkillIds] = useState<string[]>([])
  const [exportBusy, setExportBusy] = useState(false)
  const [exportSaved, setExportSaved] = useState(false)
  const [exportError, setExportError] = useState<string | undefined>()
  // Specialist currently exporting from the list row (direct export bypasses the chooser).
  const [exportingId, setExportingId] = useState<string | null>(null)
  const catalogReadOnly = integrity.status === 'degraded'

  // Memoised so visibleCustomItems' memo can reference a stable value.
  const customItems = useMemo(
    () =>
      items.filter(
        (item): item is Extract<SpecialistListItem, { kind: 'custom' }> =>
          item.kind === 'custom' && item.origin !== 'marketplace'
      ),
    [items]
  )
  const marketplaceItems = useMemo(
    () =>
      items.filter(
        (
          item
        ): item is Extract<SpecialistListItem, { kind: 'custom' }> & {
          origin: 'marketplace'
        } => item.kind === 'custom' && item.origin === 'marketplace'
      ),
    [items]
  )
  const builtinItems = useMemo(() => items.filter((i) => i.kind === 'builtin'), [items])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (marketplaceItems.length > 0) void refreshMarketplace()
  }, [marketplaceItems.length, refreshMarketplace])

  useEffect(() => {
    if (
      catalogReadOnly &&
      (view.kind === 'create' || view.kind === 'edit' || view.kind === 'import')
    ) {
      onNavigate({ kind: 'list' })
    }
  }, [catalogReadOnly, onNavigate, view.kind])

  useEffect(() => {
    if (view.kind !== 'export') return
    let active = true
    void previewExport(view.id)
      .then((preview) => {
        if (!active) return
        setIncludedExportSkillIds(
          preview.skills.filter((skill) => skill.selected).map((skill) => skill.id)
        )
      })
      .catch(() => {
        if (active) setExportError('Could not preview this Specialist export. Try again.')
      })
    return () => {
      active = false
    }
  }, [previewExport, view])

  // Direct export from the list action menu: silently preview with the approved default selection
  // (builtin + owned Skills), then open the native save dialog. The chooser page is skipped unless
  // the export is blocked — then it opens automatically so the diagnostics and Skills stay visible.
  const runDirectExport = async (id: string): Promise<void> => {
    if (exportingId) return
    setExportingId(id)
    setExportSaved(false)
    setExportError(undefined)
    try {
      const preview = await previewExport(id)
      const includedSkillIds = preview.skills
        .filter((skill) => skill.selected)
        .map((skill) => skill.id)
      if (!preview.canExport) {
        onNavigate({ kind: 'export', id })
        return
      }
      const result = await exportSpecialist(preview, includedSkillIds)
      if (result.saved) {
        setExportSaved(true)
        onNavigate({ kind: 'export', id })
      } else {
        // Native save dialog cancelled — stay on the list with no feedback.
        clearExport()
      }
    } catch {
      setExportError('Could not save this Specialist export. Preview again and retry.')
      onNavigate({ kind: 'export', id })
    } finally {
      setExportingId(null)
    }
  }

  const openDeleteDialog = (
    item: Extract<SpecialistListItem, { kind: 'custom' }>,
    action: 'delete' | 'uninstall'
  ): void => {
    setDeleteError(undefined)
    setDeleteSkillIds(new Set())
    setDeleteSkillsExpanded(false)
    setDeleteBusy(false)
    void previewSpecialistDelete(item.id)
      .then((preview) =>
        setDeletingItem({
          id: item.id,
          revision: preview.expectedRevision,
          name: item.displayName ?? item.name,
          preview,
          action
        })
      )
      .catch(() => setDeleteError('Could not load live Skill relationships.'))
  }

  // Keep runnable builtins distinct from the Reviewer placeholder even though Settings groups both
  // under Built-in. Only runnable builtins enter the Session picker.
  const reviewerItems = items.filter((i) => i.kind === 'reviewer')
  const filterCounts: Record<CategoryFilter, number> = {
    all: items.length,
    custom: customItems.length,
    marketplace: marketplaceItems.length,
    builtin: builtinItems.length + reviewerItems.length
  }
  const marketplaceExpanded = !collapsed.marketplace
  const customExpanded = !collapsed.custom
  const builtinExpanded = !collapsed.builtin
  const visibleBuiltinItems = useMemo(() => {
    if (filter === 'custom' || filter === 'marketplace') return []
    const term = query.trim().toLowerCase()
    const filtered =
      tagFilter === 'all'
        ? builtinItems
        : builtinItems.filter((item) =>
            tagAssignments.some(
              (assignment) =>
                assignment.tagId === tagFilter &&
                assignment.resourceType === 'catalog.specialist' &&
                assignment.resourceId === item.id
            )
          )
    if (!term) return filtered
    return filtered.filter(
      (item) =>
        (item.displayName ?? item.name).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
    )
  }, [builtinItems, filter, query, tagAssignments, tagFilter])
  const visibleCustomItems = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (filter === 'builtin' || filter === 'marketplace') return []
    const filtered =
      tagFilter === 'all'
        ? customItems
        : customItems.filter((item) =>
            tagAssignments.some(
              (assignment) =>
                assignment.tagId === tagFilter &&
                assignment.resourceType === 'catalog.specialist' &&
                assignment.resourceId === item.id
            )
          )
    if (!term) return filtered
    return filtered.filter(
      (item) =>
        (item.displayName ?? item.name).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
    )
  }, [customItems, filter, query, tagAssignments, tagFilter])
  const visibleMarketplaceItems = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (filter === 'builtin' || filter === 'custom') return []
    const filtered =
      tagFilter === 'all'
        ? marketplaceItems
        : marketplaceItems.filter((item) =>
            tagAssignments.some(
              (assignment) =>
                assignment.tagId === tagFilter &&
                assignment.resourceType === 'catalog.specialist' &&
                assignment.resourceId === item.id
            )
          )
    if (!term) return filtered
    return filtered.filter(
      (item) =>
        (item.displayName ?? item.name).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
    )
  }, [filter, marketplaceItems, query, tagAssignments, tagFilter])
  const visibleReviewerItems = useMemo(() => {
    if (filter === 'custom' || filter === 'marketplace' || tagFilter !== 'all') return []
    const term = query.trim().toLowerCase()
    if (!term || 'reviewer used by auto-review'.includes(term)) return reviewerItems
    return []
  }, [filter, query, reviewerItems, tagFilter])

  // Built-in Skills are app-managed and never participate in Specialist deletion. Keep this
  // renderer-side filter as a defensive boundary even though the main-side preview omits them.
  const visibleDeleteSkills = deletingItem?.preview.skills.filter(
    (skill) => skill.source !== 'featured'
  )
  const deletableDeleteSkills = visibleDeleteSkills?.filter((skill) => skill.deletable) ?? []
  const allDeletableDeleteSkillsSelected =
    deletableDeleteSkills.length > 0 &&
    deletableDeleteSkills.every((skill) => deleteSkillIds.has(skill.id))

  // Resolves the valid last-opened project (or the newest-existing fallback) against the live catalog.
  // Undefined means zero projects and the entry is disabled with explanatory help text.
  const chatProjectId = useMemo(
    () => resolveCustomizeProjectId(projects.filter((project) => project.archivedAt === undefined)),
    [projects]
  )

  // Navigation/prefill intent only: closes Settings and opens the resolved project's New Conversation
  // draft carrying a `/customize` prefill. Does not send, create a session, bind a Specialist, or imply
  // mutation approval. Final activation against the real Featured Skill is owned by issue 08.
  const startChatWithAgent = (): void => {
    if (!chatProjectId) return
    useSettingsStore.getState().closeSettings()
    useNavigationStore.getState().startCustomizeConversation(chatProjectId, 'specialist')
  }

  const downloadTemplate = (): void => {
    void (async () => {
      setTemplateSaving(true)
      setTemplateSaveError(undefined)
      try {
        if (typeof window.api?.specialist?.exportContributionTemplate !== 'function') {
          setTemplateSaveError('Contribution templates are only available in the desktop app.')
          return
        }
        const result = await window.api.specialist.exportContributionTemplate()
        if (result?.saved) setTemplateSaved(true)
      } catch {
        setTemplateSaveError('Could not save contribution template. Try again.')
      } finally {
        setTemplateSaving(false)
      }
    })()
  }

  if (view.kind === 'import' && templateSaved) {
    return (
      <div className="p-5">
        <div className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">
              {t('Import ZIP')}
            </p>
            <h2 className="mt-1 text-xl font-semibold">{t('Import a Specialist package')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('Choose one ZIP containing exactly one Specialist.')}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => onNavigate({ kind: 'list' })}>
            {t('Back')}
          </Button>
        </div>
        <div className="rounded-xl border border-border px-6 py-10 text-center" role="status">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-success-000/10 text-success-000">
            ✓
          </div>
          <h3 className="mt-4 text-lg font-semibold">{t('Template saved')}</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('openscience-specialist-template.zip is ready for contributor editing.')}
          </p>
          <Button type="button" className="mt-5" onClick={() => setTemplateSaved(false)}>
            {t('Done')}
          </Button>
        </div>
      </div>
    )
  }

  if (view.kind === 'create') {
    return (
      <SpecialistEditor
        existingNames={items.flatMap((item) => (item.kind === 'custom' ? [item.name] : []))}
        existingIds={items.map((item) => item.id)}
        initialInput={view.draft}
        onCancel={() => onNavigate({ kind: 'list' })}
        onSave={async (input: CreateSpecialistInput) => {
          await createSpecialist(input)
          onNavigate({ kind: 'list' })
        }}
        onOpenSkillDetail={onOpenSkillDetail}
        onOpenConnectorDetail={onOpenConnectorDetail}
      />
    )
  }

  if (view.kind === 'export') {
    if (exportSaved && exportPreview) {
      return (
        <div className="p-5">
          <div className="rounded-xl border border-border px-6 py-10 text-center" role="status">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-success-000/10 text-success-000">
              ✓
            </div>
            <h2 className="mt-4 text-lg font-semibold">{t('Export complete')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('{{fileName}} was saved. No location is shown here.', {
                fileName: exportPreview.fileName
              })}
            </p>
            <Button
              type="button"
              className="mt-5"
              onClick={() => {
                clearExport()
                onNavigate({ kind: 'list' })
              }}
            >
              {t('Done')}
            </Button>
          </div>
        </div>
      )
    }
    return (
      <div className="p-5">
        <div className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">
              {t('Export ZIP')}
            </p>
            <h2 className="mt-1 text-xl font-semibold">
              {exportPreview ? t('Choose Skills to include') : t('Preparing export…')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                'Builtin and owned Skills are selected by default. Skills copied into the ZIP are discovered automatically on import; Connector IDs are carried as selected references.'
              )}
            </p>
          </div>
          <span
            role="status"
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
              exportPreview?.canExport
                ? 'bg-success-000/10 text-success-000'
                : exportPreview
                  ? 'bg-danger-000/10 text-danger-000'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            {exportPreview?.canExport
              ? t('✓ Ready')
              : exportPreview
                ? t('× Blocked')
                : t('Checking…')}
          </span>
        </div>
        {exportError ? (
          <div
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
          >
            {t(exportError)}
          </div>
        ) : null}
        {exportPreview ? (
          <div className="flex flex-col gap-4">
            {exportPreview.diagnostics.map((diagnostic) => {
              const copy = specialistDiagnosticCopy(diagnostic)
              return (
                <div
                  key={diagnostic.code}
                  role={diagnostic.severity === 'error' ? 'alert' : 'status'}
                  className="rounded-lg border border-border p-3 text-sm"
                >
                  <strong>{t(copy.title)}</strong>
                  <p className="text-muted-foreground">{t(copy.body)}</p>
                </div>
              )
            })}
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {exportPreview.skills.map((skill) => {
                const checked = includedExportSkillIds.includes(skill.id)
                return (
                  <label key={skill.id} className="flex items-center gap-3 p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!skill.selectable}
                      onChange={(event) =>
                        setIncludedExportSkillIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, skill.id])]
                            : current.filter((id) => id !== skill.id)
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <strong className="block">{skill.id}</strong>
                      <span className="text-xs text-muted-foreground">
                        {skill.kind === 'builtin'
                          ? t(
                              'Featured Skill · referenced by name and not copied into the package.'
                            )
                          : skill.kind === 'owned'
                            ? t('Owned Skill · v{{version}} · bundled by default.', {
                                version: skill.version
                              })
                            : t('Installed Skill · v{{version}} · include it to bundle a copy.', {
                                version: skill.version
                              })}
                      </span>
                    </span>
                    <span className="text-xs capitalize text-muted-foreground">
                      {skill.kind === 'builtin'
                        ? t('Featured')
                        : skill.kind === 'owned'
                          ? t('Owned')
                          : t('Installed')}
                    </span>
                  </label>
                )
              })}
            </div>
            <div className="rounded-lg border border-border p-3 text-sm" role="status">
              <strong>{t('What the package carries')}</strong>
              <p className="text-muted-foreground">
                {t(
                  'Only checked Skills are bundled. Connector names are imported as selected references; full access can only be chosen later in the configuration page.'
                )}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t('Connectors:')}{' '}
                {exportPreview.connectorIds.length
                  ? exportPreview.connectorIds.join(', ')
                  : t('None selected')}
              </p>
            </div>
            <div className="flex justify-between gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  clearExport()
                  onNavigate({ kind: 'list' })
                }}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="button"
                disabled={!exportPreview.canExport || exportBusy}
                onClick={() => {
                  setExportBusy(true)
                  setExportError(undefined)
                  void exportSpecialist(exportPreview, includedExportSkillIds)
                    .then((result) => {
                      if (result.saved) setExportSaved(true)
                    })
                    .catch(() =>
                      setExportError(
                        'Could not save this Specialist export. Preview again and retry.'
                      )
                    )
                    .finally(() => setExportBusy(false))
                }}
              >
                {exportBusy ? t('Saving…') : t('Export ZIP')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  if (view.kind === 'edit') {
    // Reuse the existing editor for both ordinary edits and the setup that follows an import.
    const specialist = items.find((item) => item.kind === 'custom' && item.id === view.id)
    if (specialist && specialist.kind === 'custom') {
      if (specialist.origin === 'marketplace') {
        const listing = marketplaceSnapshot?.specialists.find(
          (item) =>
            item.id === specialist.id &&
            item.sourceId === specialist.marketplaceProvenance?.sourceId
        )
        return (
          <MarketplaceManagedSpecialistDetail
            specialist={specialist as typeof specialist & { origin: 'marketplace' }}
            update={listing}
            disabled={catalogReadOnly}
            onBack={() => onNavigate({ kind: 'list' })}
            onAppearanceChange={(patch) =>
              updateSpecialist({
                id: specialist.id,
                revision: specialist.revision,
                ...patch
              }).then(() => undefined)
            }
            onToggle={() => void setEnabled(specialist.id, !specialist.enabled)}
            onDuplicate={() =>
              void duplicateSpecialist(specialist.id).then((draft) =>
                onNavigate({ kind: 'create', draft })
              )
            }
            onUpdate={() => {
              if (!listing) return
              onNavigate({
                kind: 'marketplace-release',
                sourceId: listing.sourceId,
                sourceName: listing.sourceName,
                sourceTrust: listing.sourceTrust,
                id: listing.id,
                version: listing.version,
                installedVersion: listing.installedVersion,
                updateAvailable: listing.updateAvailable
              })
            }}
            onUninstall={() => {
              openDeleteDialog(specialist, 'uninstall')
              onNavigate({ kind: 'list' })
            }}
          />
        )
      }
      return (
        <div>
          <ResourceTagSummary
            reference={{ resourceType: 'catalog.specialist', resourceId: specialist.id }}
            className="px-5 pt-5"
            onOpenTag={onOpenTag}
          />
          <SpecialistEditor
            key={specialist.id}
            editSpecialist={specialist}
            existingNames={items.flatMap((item) =>
              item.kind === 'custom' && item.id !== view.id ? [item.name] : []
            )}
            onCancel={() => onNavigate({ kind: 'list' })}
            onSave={async () => onNavigate({ kind: 'list' })}
            onSaveEdit={async (input) => {
              await updateSpecialist(input)
              onNavigate({ kind: 'list' })
            }}
            onReload={async () => {
              // Load the fresh list and read the result from the store directly —
              // not from the render closure, which captured the pre-load items.
              await load()
              const refreshed = useSpecialistStore
                .getState()
                .items.find((item) => item.kind === 'custom' && item.id === view.id)
              if (refreshed && refreshed.kind === 'custom') return refreshed
              return undefined
            }}
            onOpenSkillDetail={onOpenSkillDetail}
            onOpenConnectorDetail={onOpenConnectorDetail}
          />
        </div>
      )
    }
    // Profile no longer exists (deleted/stale) — fall through to the list.
  }

  if (view.kind === 'import') {
    const summary = packagePreview?.summary
    const blocking = packagePreview?.diagnostics.some((item) => item.severity === 'error') ?? false
    const skillConflicts = specialistSkillConflicts(summary?.skills)
    const conflictsResolved = skillConflicts.every(
      (skill) => skillConflictResolutions[skill.id] !== undefined
    )
    const canInstallPackage = Boolean(packagePreview && !blocking && conflictsResolved)
    const conflictResolutionList = skillConflictResolutionList(
      skillConflicts,
      skillConflictResolutions
    )
    const diagnosticsBySeverity = packagePreview
      ? {
          error: packagePreview.diagnostics.filter((item) => item.severity === 'error'),
          warning: packagePreview.diagnostics.filter((item) => item.severity === 'warning'),
          info: packagePreview.diagnostics.filter((item) => item.severity === 'info')
        }
      : { error: [], warning: [], info: [] }
    return (
      <div className="p-5">
        <div className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">
              {packagePreview ? t('Import ZIP · Preview') : t('Import ZIP')}
            </p>
            <h2 className="mt-1 text-xl font-semibold">
              {packagePreview
                ? canInstallPackage
                  ? t('Ready to continue')
                  : skillConflicts.length > 0 && !blocking
                    ? t('Resolve Skill conflicts')
                    : t('Cannot continue')
                : t('Import a Specialist package')}
              {packagePreview ? (
                <span
                  role="status"
                  className={`ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    canInstallPackage
                      ? 'bg-success-000/10 text-success-000'
                      : blocking
                        ? 'bg-danger-000/10 text-danger-000'
                        : 'bg-warning-100/10 text-warning-100'
                  }`}
                >
                  {canInstallPackage
                    ? t('✓ Installable')
                    : blocking
                      ? t('× Not installable')
                      : t('Action required')}
                </span>
              ) : null}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {packagePreview
                ? t('Review the package summary and diagnostics before continuing to setup.')
                : t('Choose one ZIP containing exactly one Specialist.')}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => onNavigate({ kind: 'list' })}>
            {t('Back')}
          </Button>
        </div>

        {!packagePreview ? (
          <div className="rounded-xl border border-border p-6 text-center">
            <Upload className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
            <h3 className="mt-3 text-sm font-semibold">{t('Select a Specialist ZIP')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('The package will be safely parsed and previewed before it is saved.')}
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              {t('Limits: 50 MB compressed · 200 MB uncompressed · 2,000 files · 25 MB per file')}
            </p>
            <p className="mx-auto mt-2 max-w-xl text-xs text-muted-foreground">
              {t(
                'The ZIP contains app metadata, the specialist.json you fill in, and a README.txt guide. Skills placed in the skills folder are discovered automatically.'
              )}
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={templateSaving}
                onClick={downloadTemplate}
              >
                <Download data-icon="inline-start" aria-hidden="true" />
                {templateSaving ? t('Saving template…') : t('Download template')}
              </Button>
              <Button
                type="button"
                disabled={packageBusy}
                onClick={() => {
                  setSkillConflictResolutions({})
                  setPackageBusy(true)
                  void selectPackage().finally(() => setPackageBusy(false))
                }}
              >
                {t('Choose ZIP')}
              </Button>
            </div>
            {templateSaveError ? (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-danger-000/30 bg-danger-000/10 p-3 text-sm text-danger-000"
              >
                {t(templateSaveError)}
              </p>
            ) : null}
          </div>
        ) : (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('Specialist ZIP preview')}
            className="space-y-4"
          >
            <div className="grid grid-cols-2 gap-3 rounded-xl border border-border p-4 text-sm">
              <div>
                <span className="block text-xs text-muted-foreground">{t('Specialist')}</span>
                {summary?.name ?? t('Unknown')}
              </div>
              <div>
                <span className="block text-xs text-muted-foreground">{t('Immutable ID')}</span>
                {summary?.id ?? t('Unknown')}
              </div>
              <div>
                <span className="block text-xs text-muted-foreground">{t('Package version')}</span>
                {summary?.version ?? t('Unknown')}
              </div>
            </div>

            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold">{t('Skills')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {summary?.bundledSkillIds.length
                  ? t('Bundled: {{skills}}', { skills: summary.bundledSkillIds.join(', ') })
                  : t('No bundled Skills')}
              </p>
              {summary?.skills?.length ? (
                <div className="mt-3 space-y-2">
                  {summary.skills.map((skill) => (
                    <details key={skill.id} className="rounded-lg border border-border px-3 py-2">
                      <summary className="cursor-pointer text-xs font-medium">
                        {skill.id} · {skill.version} ·{' '}
                        {skill.disposition
                          .split('-')
                          .map((part, index) =>
                            index === 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part
                          )
                          .join(' ')}
                      </summary>
                      {skill.reason ? (
                        <p className="mt-2 text-xs text-muted-foreground">{skill.reason}</p>
                      ) : null}
                      <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
                        {skill.files.map((file) => (
                          <li key={file}>{file}</li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </div>
              ) : null}
            </section>

            <SpecialistSkillConflictChoices
              conflicts={skillConflicts}
              resolutions={skillConflictResolutions}
              onChange={(skillId, resolution) =>
                setSkillConflictResolutions((current) => ({
                  ...current,
                  [skillId]: resolution
                }))
              }
            />

            {packagePreview.archive ? (
              <section className="rounded-xl border border-border p-4">
                <h3 className="text-sm font-semibold">{t('Archive limits')}</h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">{t('Compressed')}</dt>
                    <dd>
                      {formatBytes(packagePreview.archive.compressedBytes, t)} /{' '}
                      {formatBytes(packagePreview.archive.limits.compressedBytes, t)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('Uncompressed')}</dt>
                    <dd>
                      {formatBytes(packagePreview.archive.uncompressedBytes ?? 0, t)} /{' '}
                      {formatBytes(packagePreview.archive.limits.uncompressedBytes, t)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('Files')}</dt>
                    <dd>
                      {packagePreview.archive.fileCount ?? 0} /{' '}
                      {packagePreview.archive.limits.fileCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('Per file')}</dt>
                    <dd>
                      {t('Up to {{size}}', {
                        size: formatBytes(packagePreview.archive.limits.fileBytes, t)
                      })}
                    </dd>
                  </div>
                </dl>
              </section>
            ) : null}

            <section className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t('Diagnostics')}</h3>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const json = JSON.stringify(
                        specialistPackageReportFromPreview(packagePreview),
                        null,
                        2
                      )
                      void navigator.clipboard.writeText(json).then(
                        () => setReportStatus(t('Report copied')),
                        () => setReportStatus(t('Could not copy report'))
                      )
                    }}
                  >
                    <Copy data-icon="inline-start" aria-hidden="true" />
                    {t('Copy report')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void window.api.specialist
                        .savePackageReport({ candidateToken: packagePreview.candidateToken })
                        .then((result) =>
                          setReportStatus(result.saved ? t('Report saved') : undefined)
                        )
                        .catch(() => setReportStatus(t('Could not save report')))
                    }}
                  >
                    <Download data-icon="inline-start" aria-hidden="true" />
                    {t('Download JSON')}
                  </Button>
                </div>
              </div>
              {packagePreview.diagnostics.length ? (
                <div className="mt-3 max-h-64 space-y-4 overflow-y-auto pr-2" tabIndex={0}>
                  {SEVERITY_GROUPS.map((group) => {
                    const items = diagnosticsBySeverity[group.severity]
                    if (!items.length) return null
                    return (
                      <div key={group.severity}>
                        <h4 className="text-xs font-semibold">
                          {getSeverityLabel(group.severity, t)} ({items.length})
                        </h4>
                        <ul className="mt-1 space-y-2">
                          {items.map((diagnostic, index) => {
                            const copy = specialistDiagnosticCopy(diagnostic)
                            const SeverityIcon = SEVERITY_ICON[group.severity]
                            return (
                              <li
                                key={`${diagnostic.code}-${index}`}
                                role={group.severity === 'error' ? 'alert' : 'status'}
                                className={`flex gap-2 rounded-md border p-2 text-xs ${SEVERITY_CLASSES[group.severity]}`}
                              >
                                <SeverityIcon
                                  className="mt-0.5 size-3.5 shrink-0"
                                  aria-hidden="true"
                                />
                                <div className="min-w-0">
                                  <strong className="block">{t(copy.title)}</strong>
                                  <span className="block opacity-80">{t(copy.body)}</span>
                                  {diagnostic.path || diagnostic.relatedId ? (
                                    <span className="mt-0.5 block font-mono text-[10px] opacity-60">
                                      {diagnostic.path}
                                      {diagnostic.path && diagnostic.relatedId ? ' · ' : ''}
                                      {diagnostic.relatedId
                                        ? t('ID: {{id}}', { id: diagnostic.relatedId })
                                        : ''}
                                    </span>
                                  ) : null}
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div
                  role="status"
                  className="mt-3 flex gap-2 rounded-md border border-green-200 bg-green-50 p-2 text-xs text-green-800"
                >
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <div>
                    <strong className="block">{t('Validation passed')}</strong>
                    <span className="opacity-80">
                      {t('The package can be installed after explicit confirmation.')}
                    </span>
                  </div>
                </div>
              )}
              {reportStatus ? (
                <p role="status" className="mt-2 text-xs text-muted-foreground">
                  {reportStatus}
                </p>
              ) : null}
            </section>

            {packagePreview.overwrite?.modifiedSinceImport ? (
              <p
                role="alert"
                className="rounded-lg border border-warning-100/50 bg-warning-100/10 p-3 text-xs"
              >
                {t('Local edits will be replaced by this import.')}
              </p>
            ) : null}
            {packageErrorCode ? (
              <p role="alert" className="text-xs text-destructive">
                {t('Import failed:')} {packageErrorCode}
              </p>
            ) : null}
            <div className="flex justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancelPackage().then(() => onNavigate({ kind: 'list' }))}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="button"
                disabled={packageBusy || !canInstallPackage}
                onClick={() => {
                  if (packagePreview.overwrite) {
                    setOverwriteConfirmationOpen(true)
                    return
                  }
                  setPackageBusy(true)
                  void installPackage({ skillConflictResolutions: conflictResolutionList })
                    .then(async (result) => {
                      if (result.status === 'installed') {
                        // Bundled Skills were just installed on disk; refresh the Skill catalog so the
                        // editor recognizes them as available instead of showing "Missing · unavailable".
                        try {
                          await useSettingsStore.getState().loadSkills()
                        } catch {
                          // Best-effort refresh; navigation proceeds so the install result is shown.
                        }
                        onNavigate({ kind: 'edit', id: result.specialist.id })
                      } else {
                        setPackageErrorCode(result.code)
                      }
                    })
                    .finally(() => setPackageBusy(false))
                }}
              >
                {packagePreview.overwrite ? t('Review overwrite') : t('Next')}
              </Button>
            </div>
            {packagePreview.overwrite ? (
              <AlertDialog.Root
                open={overwriteConfirmationOpen}
                onOpenChange={setOverwriteConfirmationOpen}
              >
                <AlertDialog.Portal>
                  <AlertDialog.Overlay className={dialogOverlayClassName} />
                  <AlertDialog.Content
                    className={dialogPanelClassName('w-[min(520px,calc(100vw-2rem))] p-0')}
                  >
                    <div className={dialogHeaderClassName}>
                      <div className="min-w-0">
                        <AlertDialog.Title className={dialogTitleClassName}>
                          {t('Local changes will be permanently replaced')}
                        </AlertDialog.Title>
                      </div>
                      <AlertDialog.Cancel asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('Close')}
                          className={dialogCloseButtonClassName}
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </AlertDialog.Cancel>
                    </div>

                    <div className={dialogBodyClassName}>
                      <AlertDialog.Description className={dialogDescriptionClassName}>
                        {t(
                          'Current local edits are not recoverable after a successful overwrite. A failed atomic install preserves the current version.'
                        )}
                      </AlertDialog.Description>
                      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-border p-3 text-xs">
                        <div>
                          <dt className="text-muted-foreground">{t('Current version')}</dt>
                          <dd>{packagePreview.overwrite.currentVersion}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t('Incoming version')}</dt>
                          <dd>
                            {packagePreview.overwrite.incomingVersion}
                            {packagePreview.diagnostics.some(
                              (item) => item.code === 'specialist.overwrite-downgrade'
                            )
                              ? ` · ${t('downgrade')}`
                              : ''}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t('Local status')}</dt>
                          <dd>
                            {packagePreview.overwrite.hasImportBaseline
                              ? packagePreview.overwrite.modifiedSinceImport
                                ? t('Modified after import')
                                : t('Unchanged since import')
                              : t('No import baseline')}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t('Target')}</dt>
                          <dd>{t('Custom Specialist only')}</dd>
                        </div>
                      </dl>
                      <Button
                        type="button"
                        variant="outline"
                        className="mt-4"
                        onClick={() => {
                          setExportSaved(false)
                          setExportError(undefined)
                          clearExport()
                          onNavigate({ kind: 'export', id: packagePreview.overwrite!.id })
                        }}
                      >
                        {t('Export current version first')}
                      </Button>
                    </div>

                    <div className={dialogFooterClassName}>
                      <AlertDialog.Cancel asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className={dialogCancelButtonClassName}
                        >
                          {t('Cancel')}
                        </Button>
                      </AlertDialog.Cancel>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={packageBusy}
                        onClick={() => {
                          setPackageBusy(true)
                          void installPackage({
                            confirmOverwrite: true,
                            skillConflictResolutions: conflictResolutionList
                          })
                            .then(async (result) => {
                              if (result.status === 'installed') {
                                // Bundled Skills were just installed on disk; refresh the Skill catalog
                                // so the editor recognizes them as available after the overwrite.
                                try {
                                  await useSettingsStore.getState().loadSkills()
                                } catch {
                                  // Best-effort refresh; navigation proceeds so the install result is shown.
                                }
                                setOverwriteConfirmationOpen(false)
                                onNavigate({ kind: 'edit', id: result.specialist.id })
                              } else setPackageErrorCode(result.code)
                            })
                            .finally(() => setPackageBusy(false))
                        }}
                      >
                        {t('Overwrite and continue')}
                      </Button>
                    </div>
                  </AlertDialog.Content>
                </AlertDialog.Portal>
              </AlertDialog.Root>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  if (view.kind === 'builtin') {
    const specialist = builtinItems.find((item) => item.id === view.id)
    if (specialist) {
      const skillIds =
        specialist.capabilityMode === 'selected'
          ? specialist.selectedCapabilities.skillIds
          : specialist.fullAccess.excludedSkillIds
      return (
        <div className="p-5">
          <Button type="button" variant="ghost" onClick={() => onNavigate({ kind: 'list' })}>
            {t('Back to specialists')}
          </Button>
          <div className="mt-5 flex items-start gap-3">
            <SpecialistAvatar iconKey={specialist.iconKey} colorKey={specialist.colorKey} />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {specialist.displayName ?? specialist.name}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t('Built-in · Version {{version}}', { version: specialist.version })}
              </p>
            </div>
          </div>
          <ResourceTagSummary
            reference={{ resourceType: 'catalog.specialist', resourceId: specialist.id }}
            className="mt-4"
            onOpenTag={onOpenTag}
          />
          <p className="mt-4 text-sm text-foreground">{specialist.description}</p>
          <div className="mt-5 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium text-foreground">{t('Read-only')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('This Specialist ships with the app and cannot be changed.')}
            </p>
          </div>
          <div className="mt-5">
            <h3 className="text-sm font-semibold text-foreground">{t('Capabilities')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {specialist.capabilityMode === 'full' ? t('Full access') : t('Selected capabilities')}
            </p>
            {skillIds.length > 0 ? (
              <ul className="mt-2 list-inside list-disc text-xs text-foreground">
                {skillIds.map((skillId) => (
                  <li key={skillId}>{skillId}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      )
    }
  }

  return (
    <div className="p-5">
      <div className="mb-5">
        <MarketplaceTabs
          active="installed"
          installedCount={items.length}
          onNavigate={onNavigate}
          t={t}
        />
      </div>
      {/* Toolbar */}
      <div data-slot="specialists-toolbar" className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as CategoryFilter)}>
          <SelectTrigger aria-label={t('Filter specialists by category')} className="w-36">
            <span>
              {getFilterLabel(filter, t)} ({filterCounts[filter]})
            </span>
          </SelectTrigger>
          <SelectContent>
            {(['all', 'custom', 'marketplace', 'builtin'] as const).map((key) => (
              <SelectItem key={key} value={key}>
                {getFilterLabel(key, t)} ({filterCounts[key]})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TagFilter resourceType="catalog.specialist" value={tagFilter} onChange={setTagFilter} />
        <SettingsSearchInput
          aria-label={t('Search specialists')}
          placeholder={t('Search specialists…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="ml-auto shrink-0">
              <Plus data-icon="inline-start" aria-hidden="true" />
              {t('Add specialist')}
              <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="gap-2.5"
              disabled={catalogReadOnly}
              onSelect={() => onNavigate({ kind: 'create' })}
            >
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('Write from scratch')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('Configure instructions and capabilities yourself')}
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2.5"
              disabled={!chatProjectId}
              aria-disabled={!chatProjectId}
              onSelect={(event) => {
                // A disabled item cannot fire onSelect in Radix, but keep the guard explicit so the
                // intent stays a no-op if the catalog empties between render and click.
                if (!chatProjectId) {
                  event.preventDefault()
                  return
                }
                startChatWithAgent()
              }}
            >
              <MessagesSquare className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('Chat with agent')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('Start a normal conversation; the agent guides you step by step')}
                </span>
              </span>
            </DropdownMenuItem>
            {!chatProjectId ? (
              <>
                <DropdownMenuSeparator />
                <p className="px-2.5 pb-1 pt-0.5 text-xs text-muted-foreground">
                  {t('Open a project to chat with the agent')}
                </p>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2.5"
              disabled={catalogReadOnly}
              onSelect={() => onNavigate({ kind: 'import' })}
            >
              <Upload className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('Import ZIP')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('Preview a package, then finish setup in the existing editor')}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-sm text-danger-000"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>{t('Open Science could not load Specialists. Retry to continue.')}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void load()}
          >
            {t('Retry')}
          </Button>
        </div>
      ) : null}

      {catalogReadOnly ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-warning-100/50 bg-warning-100/10 px-3 py-2 text-sm"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">{t('Some Specialist data could not be read.')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('No Specialist changes will be saved until the data is repaired.')}
              </p>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              {t('Retry')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void window.api.storage.revealAppStorage()}
            >
              {t('Open data folder')}
            </Button>
          </div>
        </div>
      ) : null}

      {!isLoaded && !loadError ? (
        <p className="text-sm text-muted-foreground">{t('Loading…')}</p>
      ) : isLoaded ? (
        <div className="flex flex-col gap-6">
          {/* Marketplace-managed Specialists are installed packages, not editable custom drafts. */}
          {filter !== 'custom' &&
          filter !== 'builtin' &&
          (marketplaceItems.length > 0 || filter === 'marketplace') ? (
            <div data-slot="specialists-source-group" data-source="marketplace">
              <button
                type="button"
                aria-expanded={marketplaceExpanded}
                onClick={() =>
                  setCollapsed((previous) => ({
                    ...previous,
                    marketplace: !previous.marketplace
                  }))
                }
                className="flex w-full flex-col items-start gap-0.5 text-left"
              >
                <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                  {t('Marketplace')}
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                      marketplaceExpanded ? '' : '-rotate-90'
                    }`}
                    aria-hidden="true"
                  />
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('Installed from Marketplace and managed by its publisher.')}
                </span>
              </button>
              {visibleMarketplaceItems.length > 0 ? (
                <ul
                  hidden={!marketplaceExpanded}
                  className="mt-2 flex flex-col divide-y divide-border"
                >
                  {visibleMarketplaceItems.map((item) => {
                    if (item.kind !== 'custom' || item.origin !== 'marketplace') return null
                    const listing = marketplaceSnapshot?.specialists.find(
                      (candidate) =>
                        candidate.id === item.id &&
                        candidate.sourceId === item.marketplaceProvenance?.sourceId
                    )
                    return (
                      <li
                        key={item.id}
                        data-slot="settings-list-row"
                        className="flex min-h-14 items-center gap-2 py-2.5"
                      >
                        <SpecialistAppearancePicker
                          name={item.displayName ?? item.name}
                          iconKey={item.iconKey}
                          colorKey={item.colorKey}
                          disabled={catalogReadOnly}
                          onChange={(patch) =>
                            updateSpecialist({
                              id: item.id,
                              revision: item.revision,
                              ...patch
                            }).then(() => undefined)
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={() => onNavigate({ kind: 'edit', id: item.id })}
                            aria-label={t('View {{name}}', {
                              name: item.displayName ?? item.name
                            })}
                            className="block w-full min-w-0 cursor-pointer rounded-md text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted/50"
                          >
                            <span className="block truncate text-sm text-foreground">
                              {item.displayName ?? item.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {item.description}
                            </span>
                          </button>
                          <span
                            className="mt-1 flex min-w-0 flex-wrap items-center gap-1"
                            data-specialist-metadata-group={item.id}
                          >
                            <button
                              type="button"
                              onClick={() => onNavigate({ kind: 'edit', id: item.id })}
                              aria-label={t('View {{name}}', {
                                name: item.displayName ?? item.name
                              })}
                              className="flex min-w-0 cursor-pointer flex-wrap items-center gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <Badge
                                variant="secondary"
                                className="h-5 px-1.5 text-[11px] font-normal"
                                data-specialist-metadata="source"
                              >
                                {t('Marketplace')}
                              </Badge>
                              <Badge
                                variant="outline"
                                className="h-5 px-1.5 text-[11px] font-normal tabular-nums text-muted-foreground"
                                data-specialist-metadata="version"
                              >
                                {t('Version {{version}}', {
                                  version: item.packageVersion ?? '0.1.0'
                                })}
                              </Badge>
                              {item.marketplaceProvenance?.publisher ? (
                                <Badge
                                  variant="outline"
                                  className="h-5 max-w-full px-1.5 text-[11px] font-normal text-muted-foreground"
                                  data-specialist-metadata="publisher"
                                >
                                  <span className="truncate">
                                    {t('By {{publisher}}', {
                                      publisher: item.marketplaceProvenance.publisher
                                    })}
                                  </span>
                                </Badge>
                              ) : null}
                              {listing?.updateAvailable ? (
                                <Badge className="h-5 border-primary/20 bg-primary/10 px-1.5 text-[11px] font-normal text-primary">
                                  {t('Update available')}
                                </Badge>
                              ) : null}
                            </button>
                            <ResourceTagBadges
                              reference={{
                                resourceType: 'catalog.specialist',
                                resourceId: item.id
                              }}
                              onOpenTag={onOpenTag}
                            />
                          </span>
                        </div>
                        <ResourceTagMenu
                          reference={{ resourceType: 'catalog.specialist', resourceId: item.id }}
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t('Actions for {{name}}', {
                                name: item.displayName ?? item.name
                              })}
                            >
                              <ChevronDown aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="gap-2 text-xs"
                              disabled={catalogReadOnly}
                              onSelect={() =>
                                void duplicateSpecialist(item.id).then((draft) =>
                                  onNavigate({ kind: 'create', draft })
                                )
                              }
                            >
                              <Copy className="size-3.5" aria-hidden="true" />
                              {t('Create editable copy')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="gap-2 text-xs text-destructive"
                              disabled={catalogReadOnly}
                              onSelect={() => openDeleteDialog(item, 'uninstall')}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" /> {t('Uninstall')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {listing?.updateAvailable ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="hidden shrink-0 sm:inline-flex"
                            onClick={() =>
                              onNavigate({
                                kind: 'marketplace-release',
                                sourceId: listing.sourceId,
                                sourceName: listing.sourceName,
                                sourceTrust: listing.sourceTrust,
                                id: listing.id,
                                version: listing.version,
                                installedVersion: listing.installedVersion,
                                updateAvailable: listing.updateAvailable
                              })
                            }
                          >
                            {t('Update')}
                          </Button>
                        ) : null}
                        <SettingsToggle
                          enabled={item.enabled}
                          disabled={catalogReadOnly}
                          aria-label={t('Toggle {{name}}', {
                            name: item.displayName ?? item.name
                          })}
                          onToggle={() => void setEnabled(item.id, !item.enabled)}
                        />
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p
                  hidden={!marketplaceExpanded}
                  className="mt-2 py-2 text-xs text-muted-foreground"
                >
                  {t('No Marketplace Specialists installed.')}
                </p>
              )}
            </div>
          ) : null}

          {/* Custom specialists group */}
          {filter !== 'builtin' &&
          filter !== 'marketplace' &&
          (customItems.length > 0 || filter === 'custom' || items.length === 0) ? (
            <div data-slot="specialists-source-group" data-source="custom">
              <button
                type="button"
                aria-expanded={customExpanded}
                onClick={() =>
                  setCollapsed((previous) => ({
                    ...previous,
                    custom: !previous.custom
                  }))
                }
                className="flex w-full flex-col items-start gap-0.5 text-left"
              >
                <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                  {t('Custom')}
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                      customExpanded ? '' : '-rotate-90'
                    }`}
                    aria-hidden="true"
                  />
                </span>
                <span className="text-xs text-muted-foreground">{t('Created by you.')}</span>
              </button>

              {visibleCustomItems.length > 0 ? (
                <ul hidden={!customExpanded} className="mt-2 flex flex-col divide-y divide-border">
                  {visibleCustomItems.map((item) => {
                    if (item.kind !== 'custom') return null
                    return (
                      <li
                        key={item.id}
                        data-slot="settings-list-row"
                        className="flex min-h-14 items-center gap-2 py-2.5"
                      >
                        <SpecialistAppearancePicker
                          name={item.displayName ?? item.name}
                          iconKey={item.iconKey}
                          colorKey={item.colorKey}
                          disabled={catalogReadOnly}
                          onChange={(patch) =>
                            updateSpecialist({
                              id: item.id,
                              revision: item.revision,
                              ...patch
                            }).then(() => undefined)
                          }
                        />

                        {/* Click the row body to open the editor (prefilled) */}
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            disabled={catalogReadOnly}
                            onClick={() => onNavigate({ kind: 'edit', id: item.id })}
                            aria-label={
                              item.setupPending
                                ? t('Continue setup for {{name}}', {
                                    name: item.displayName ?? item.name
                                  })
                                : t('Edit {{name}}', { name: item.displayName ?? item.name })
                            }
                            className="flex w-full min-w-0 cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                          >
                            {/* Body: name + description */}
                            <div className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-foreground">
                                {item.displayName ?? item.name}
                              </span>
                              {item.description ? (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {item.description}
                                </span>
                              ) : null}
                            </div>
                          </button>
                          <span
                            className="mt-1 flex min-w-0 flex-wrap items-center gap-1"
                            data-specialist-metadata-group={item.id}
                          >
                            <button
                              type="button"
                              disabled={catalogReadOnly}
                              onClick={() => onNavigate({ kind: 'edit', id: item.id })}
                              aria-label={
                                item.setupPending
                                  ? t('Continue setup for {{name}}', {
                                      name: item.displayName ?? item.name
                                    })
                                  : t('Edit {{name}}', { name: item.displayName ?? item.name })
                              }
                              className="flex min-w-0 cursor-pointer flex-wrap items-center gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                            >
                              <Badge
                                variant="outline"
                                className="h-5 px-1.5 text-[11px] font-normal text-muted-foreground"
                                data-specialist-metadata="capabilities"
                              >
                                {item.setupPending
                                  ? t('Setup incomplete')
                                  : item.capabilityMode === 'full'
                                    ? t('Full access')
                                    : t('Selected capabilities')}
                              </Badge>
                              {!item.setupPending && item.origin === 'imported' ? (
                                <>
                                  <Badge
                                    variant="secondary"
                                    className="h-5 px-1.5 text-[11px] font-normal"
                                    data-specialist-metadata="source"
                                  >
                                    {item.marketplaceProvenance
                                      ? t('Marketplace')
                                      : t('Imported ZIP')}
                                  </Badge>
                                  {item.marketplaceProvenance?.publisher ? (
                                    <Badge
                                      variant="outline"
                                      className="h-5 max-w-full px-1.5 text-[11px] font-normal text-muted-foreground"
                                      data-specialist-metadata="publisher"
                                      title={t('By {{publisher}}', {
                                        publisher: item.marketplaceProvenance.publisher
                                      })}
                                    >
                                      <span className="truncate">
                                        {t('By {{publisher}}', {
                                          publisher: item.marketplaceProvenance.publisher
                                        })}
                                      </span>
                                    </Badge>
                                  ) : null}
                                  <Badge
                                    variant="outline"
                                    className="h-5 px-1.5 text-[11px] font-normal tabular-nums text-muted-foreground"
                                    data-specialist-metadata="version"
                                  >
                                    {t('Version {{version}}', {
                                      version: item.packageVersion ?? '0.1.0'
                                    })}
                                  </Badge>
                                  <Badge
                                    variant="outline"
                                    className={
                                      item.modifiedSinceImport
                                        ? 'h-5 border-warning-100 bg-warning-100/60 px-1.5 text-[11px] font-normal text-warning-900'
                                        : 'h-5 px-1.5 text-[11px] font-normal text-muted-foreground'
                                    }
                                    data-specialist-metadata="local-status"
                                  >
                                    {item.modifiedSinceImport
                                      ? t('Modified locally')
                                      : t('Unchanged locally')}
                                  </Badge>
                                </>
                              ) : null}
                            </button>
                            <ResourceTagBadges
                              reference={{
                                resourceType: 'catalog.specialist',
                                resourceId: item.id
                              }}
                              onOpenTag={onOpenTag}
                            />
                          </span>
                        </div>

                        <ResourceTagMenu
                          reference={{ resourceType: 'catalog.specialist', resourceId: item.id }}
                        />
                        <DropdownMenu>
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={exportingId === item.id}
                                    aria-label={t('Actions for {{name}}', {
                                      name: item.displayName ?? item.name
                                    })}
                                  >
                                    {exportingId === item.id ? (
                                      <span role="status" aria-label={t('Preparing export')}>
                                        <Loader2
                                          className="size-4 animate-spin"
                                          aria-hidden="true"
                                        />
                                      </span>
                                    ) : (
                                      <ChevronDown aria-hidden="true" />
                                    )}
                                  </Button>
                                </DropdownMenuTrigger>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t('Actions for {{name}}', { name: item.displayName ?? item.name })}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="gap-2 text-xs"
                              disabled={catalogReadOnly}
                              onSelect={() =>
                                void duplicateSpecialist(item.id).then((draft) =>
                                  onNavigate({ kind: 'create', draft })
                                )
                              }
                            >
                              <Copy className="size-3.5" aria-hidden="true" /> {t('Duplicate')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2 text-xs"
                              onSelect={() => void runDirectExport(item.id)}
                            >
                              <Download className="size-3.5" aria-hidden="true" /> {t('Export ZIP')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2 text-xs text-destructive"
                              disabled={catalogReadOnly}
                              onSelect={() => openDeleteDialog(item, 'delete')}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" /> {t('Delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {item.setupPending ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled={catalogReadOnly}
                            aria-label={t('Continue setup for {{name}}', {
                              name: item.displayName ?? item.name
                            })}
                            onClick={() => onNavigate({ kind: 'edit', id: item.id })}
                          >
                            {t('Continue setup')}
                          </Button>
                        ) : (
                          <SettingsToggle
                            enabled={item.enabled}
                            disabled={catalogReadOnly}
                            aria-label={t('Toggle {{name}}', {
                              name: item.displayName ?? item.name
                            })}
                            onToggle={() => void setEnabled(item.id, !item.enabled)}
                          />
                        )}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p hidden={!customExpanded} className="mt-2 py-2 text-xs text-muted-foreground">
                  {t('No specialists yet. Use "Add specialist" to create one.')}
                </p>
              )}
            </div>
          ) : null}

          {/* Built-in group: runnable repository profiles plus the separate Reviewer placeholder. */}
          {visibleBuiltinItems.length > 0 || visibleReviewerItems.length > 0 ? (
            <div data-slot="specialists-source-group" data-source="builtin">
              <button
                type="button"
                aria-expanded={builtinExpanded}
                onClick={() =>
                  setCollapsed((previous) => ({
                    ...previous,
                    builtin: !previous.builtin
                  }))
                }
                className="flex w-full flex-col items-start gap-0.5 text-left"
              >
                <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                  {t('Built-in')}
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                      builtinExpanded ? '' : '-rotate-90'
                    }`}
                    aria-hidden="true"
                  />
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('Shipped with the app. Not configurable.')}
                </span>
              </button>
              <ul hidden={!builtinExpanded} className="mt-2 flex flex-col divide-y divide-border">
                {visibleBuiltinItems.map((item) => (
                  <li
                    key={item.id}
                    data-slot="settings-list-row"
                    className="flex min-h-14 items-center gap-2 py-2.5"
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate({ kind: 'builtin', id: item.id })}
                      aria-label={t('View {{name}}', { name: item.displayName ?? item.name })}
                      className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <SpecialistAvatar iconKey={item.iconKey} colorKey={item.colorKey} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => onNavigate({ kind: 'builtin', id: item.id })}
                        aria-label={t('View {{name}}', { name: item.displayName ?? item.name })}
                        className="block w-full min-w-0 cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="block truncate text-sm text-foreground">
                          {item.displayName ?? item.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      </button>
                      <div
                        className="mt-0.5 flex min-w-0 items-center gap-2"
                        data-specialist-metadata-group={item.id}
                      >
                        <button
                          type="button"
                          onClick={() => onNavigate({ kind: 'builtin', id: item.id })}
                          aria-label={t('View {{name}}', {
                            name: item.displayName ?? item.name
                          })}
                          className="min-w-0 cursor-pointer truncate rounded-md text-left text-[11px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {t('Built-in · Version {{version}}', { version: item.version })}
                        </button>
                        <ResourceTagBadges
                          reference={{
                            resourceType: 'catalog.specialist',
                            resourceId: item.id
                          }}
                          onOpenTag={onOpenTag}
                        />
                      </div>
                    </div>
                    <ResourceTagMenu
                      reference={{ resourceType: 'catalog.specialist', resourceId: item.id }}
                    />
                  </li>
                ))}
                {visibleReviewerItems.map(() => (
                  <li
                    key="reviewer"
                    data-slot="settings-list-row"
                    className="flex min-h-14 items-center gap-2 py-2.5"
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center">
                      <SpecialistAvatar iconKey="owl-scholar" colorKey="teal" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {t('Reviewer')}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t('Used by Auto-review')}
                      </span>
                    </div>
                    {/* No toggle, no actions for Reviewer */}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Delete confirmation dialog */}
      {/*
       * Hallmark · component: destructive disclosure · genre: modern-minimal · theme: project tokens
       * states: default · hover · focus · active · disabled · loading · error · success (quiet close)
       * contrast: semantic foreground / muted / destructive tokens
       * pre-emit critique: P5 H5 E5 S5 R5 V4 · hierarchy: title→impact→optional cleanup→action
       * structure: destructive-disclosure · motion: transform/opacity only · slop: pass
       */}
      <AlertDialog.Root
        open={deletingItem !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) {
            setDeletingItem(null)
            setDeleteSkillIds(new Set())
            setDeleteSkillsExpanded(false)
            setDeleteError(undefined)
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(520px,calc(100vw-2rem))] max-h-[85vh] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <AlertDialog.Title className={dialogTitleClassName}>
                  {deletingItem?.action === 'uninstall'
                    ? t('Uninstall “{{name}}”?', { name: deletingItem.name })
                    : t('Delete “{{name}}”?', { name: deletingItem?.name ?? '' })}
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  className={dialogCloseButtonClassName}
                  disabled={deleteBusy}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>

            <div className={`${dialogBodyClassName} overflow-y-auto`}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {deletingItem?.action === 'uninstall'
                  ? t(
                      'This removes the Marketplace Specialist from this device. Conversations using it will no longer be able to use it.'
                    )
                  : t(
                      'This permanently deletes the Specialist. Conversations using it will no longer be able to use it.'
                    )}
              </AlertDialog.Description>
              {visibleDeleteSkills?.length ? (
                <Collapsible.Root
                  open={deleteSkillsExpanded}
                  onOpenChange={setDeleteSkillsExpanded}
                  className="mt-4 overflow-hidden rounded-lg border border-border"
                >
                  <div className="flex items-center gap-2 p-2">
                    <Collapsible.Trigger asChild>
                      <button
                        type="button"
                        aria-controls="specialist-delete-skills"
                        className="group flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted/80 disabled:pointer-events-none disabled:opacity-50"
                        disabled={deleteBusy}
                      >
                        <ChevronDown
                          className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${deleteSkillsExpanded ? '' : '-rotate-90'}`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">
                            <Trans
                              i18nKey="Skills you can also delete <muted>(optional)</muted>"
                              components={{
                                muted: <span className="font-normal text-muted-foreground" />
                              }}
                            />
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {t(
                              'Select all selects only deletable Skills. Skills used by the Main Agent or another Specialist will be kept.'
                            )}
                          </span>
                        </span>
                      </button>
                    </Collapsible.Trigger>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0 px-3 transition-[color,background-color,border-color,transform] aria-pressed:border-primary/30 aria-pressed:bg-primary/10 aria-pressed:text-primary"
                      aria-pressed={allDeletableDeleteSkillsSelected}
                      disabled={deleteBusy || deletableDeleteSkills.length === 0}
                      onClick={() =>
                        setDeleteSkillIds(
                          allDeletableDeleteSkillsSelected
                            ? new Set()
                            : new Set(deletableDeleteSkills.map((skill) => skill.id))
                        )
                      }
                    >
                      {allDeletableDeleteSkillsSelected ? (
                        <Check data-icon="inline-start" aria-hidden="true" />
                      ) : null}
                      {t(allDeletableDeleteSkillsSelected ? 'Clear selection' : 'Select all')}
                    </Button>
                  </div>
                  <Collapsible.Content id="specialist-delete-skills">
                    <div className="max-h-64 divide-y divide-border overflow-y-auto border-t border-border px-3">
                      {visibleDeleteSkills.map((skill) => {
                        const reasonText =
                          skill.reasons
                            .map((reason) =>
                              reason.code === 'main-enabled'
                                ? t('Used by the Main Agent and will be kept.')
                                : reason.code === 'shared-owner'
                                  ? t('Also owned by another Specialist and will be kept.')
                                  : reason.code === 'referenced'
                                    ? t('Used by another Specialist and will be kept.')
                                    : t('Managed by the app and will be kept.')
                            )
                            .join(' ') ||
                          t('Used only by this Specialist. Select to permanently delete it.')
                        const checkbox = (
                          <input
                            type="checkbox"
                            className="size-4 shrink-0 cursor-pointer accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px motion-reduce:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={deleteBusy || !skill.deletable}
                            checked={deleteSkillIds.has(skill.id)}
                            onChange={(event) =>
                              setDeleteSkillIds((current) => {
                                const next = new Set(current)
                                if (event.target.checked) next.add(skill.id)
                                else next.delete(skill.id)
                                return next
                              })
                            }
                          />
                        )
                        return (
                          <label
                            key={skill.id}
                            className={`flex min-w-0 items-start gap-3 py-3 ${skill.deletable && !deleteBusy ? 'cursor-pointer' : ''}`}
                          >
                            {skill.deletable ? (
                              <span className="mt-0.5 inline-flex">{checkbox}</span>
                            ) : (
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      data-slot="specialist-delete-disabled-skill"
                                      tabIndex={0}
                                      aria-disabled="true"
                                      aria-label={reasonText}
                                      className="mt-0.5 inline-flex size-4 shrink-0 cursor-not-allowed rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                    >
                                      {checkbox}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-xs leading-relaxed">
                                    {reasonText}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
                                <span className="min-w-0 flex-1 truncate" title={skill.displayName}>
                                  {skill.displayName}
                                </span>
                                <Badge
                                  variant="outline"
                                  className="shrink-0 text-[11px] font-normal"
                                >
                                  {getSkillSourceLabel(skill.source, t)}
                                </Badge>
                              </span>
                              <span
                                className="block truncate text-xs text-muted-foreground"
                                title={reasonText}
                              >
                                {reasonText}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </Collapsible.Content>
                </Collapsible.Root>
              ) : (
                <p className="mt-4 rounded-lg border border-border px-3 py-2.5 text-xs text-muted-foreground">
                  {t('No additional Skills will be deleted.')}
                </p>
              )}
              {deleteError ? (
                <p
                  role="alert"
                  className="mt-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
                >
                  {t(deleteError)}
                </p>
              ) : null}
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className={dialogCancelButtonClassName}
                  disabled={deleteBusy}
                >
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="destructive"
                disabled={deleteBusy}
                onClick={() => {
                  if (!deletingItem || deleteBusy) return
                  const item = deletingItem
                  void (async () => {
                    setDeleteBusy(true)
                    setDeleteError(undefined)
                    try {
                      const result: SpecialistDeleteResult = await deleteSpecialist(
                        item.id,
                        item.revision,
                        [...deleteSkillIds].sort()
                      )
                      if (result.status === 'deleted') {
                        await useSettingsStore.getState().loadSkills()
                        setDeleteBusy(false)
                        setDeletingItem(null)
                        setDeleteSkillIds(new Set())
                        setDeleteSkillsExpanded(false)
                        setDeleteError(undefined)
                      } else {
                        const messages: Record<typeof result.code, string> = {
                          'stale-preview':
                            'Skill relationships changed. Refresh the preview and review again.',
                          'revision-conflict':
                            'This Specialist changed. Refresh the preview and review again.',
                          'protected-skill': 'A selected Skill is protected and cannot be deleted.',
                          'protected-target': 'This Specialist is read-only and cannot be deleted.',
                          'recovery-failed':
                            'Storage recovery failed. No new deletion can continue safely.',
                          'rollback-failed':
                            'Deletion rollback failed. Restart before trying again.',
                          'commit-failed': 'Deletion failed and was rolled back.'
                        }
                        setDeleteError(messages[result.code])
                      }
                    } catch (err) {
                      // Reload the list so a retry picks up the current revision.
                      void load()
                      setDeleteError(
                        err instanceof Error
                          ? err.message
                          : 'This specialist changed — review and try again.'
                      )
                    } finally {
                      setDeleteBusy(false)
                    }
                  })()
                }}
              >
                {deleteBusy ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
                ) : null}
                {deletingItem?.action === 'uninstall'
                  ? t(deleteBusy ? 'Uninstalling…' : 'Uninstall')
                  : t(deleteBusy ? 'Deleting…' : 'Delete Specialist')}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

const SpecialistsPanel = (props: SpecialistsPanelProps): React.JSX.Element =>
  props.view.kind === 'marketplace' ||
  props.view.kind === 'marketplace-sources' ||
  props.view.kind === 'marketplace-release' ? (
    <SpecialistMarketplace view={props.view} onNavigate={props.onNavigate} />
  ) : (
    <InstalledSpecialistsPanel
      view={props.view}
      onNavigate={props.onNavigate}
      onOpenTag={props.onOpenTag}
      onOpenSkillDetail={props.onOpenSkillDetail}
      onOpenConnectorDetail={props.onOpenConnectorDetail}
    />
  )

export { SpecialistsPanel }
