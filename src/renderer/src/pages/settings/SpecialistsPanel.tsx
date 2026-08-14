import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
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
import { AlertDialog } from 'radix-ui'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { specialistDiagnosticCopy } from '@/lib/specialist-diagnostics'
import { resolveCustomizeProjectId } from '@/lib/last-opened-project'
import { SettingsToggle } from './SettingsLayout'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { CreateSpecialistInput } from '../../../../shared/specialist'
import type { SkillSource } from '../../../../shared/settings'
import { specialistPackageReportFromPreview } from '../../../../shared/specialist-package'
import type {
  SpecialistDeletePreview,
  SpecialistDeleteResult
} from '../../../../shared/specialist-package'
import { SpecialistEditor } from './SpecialistEditor'
import { SettingsSearchInput } from './SettingsSearchInput'
import { SpecialistAvatar } from './specialist-avatar'

// Sub-view for the Specialists panel (parallels SkillsView).
export type SpecialistsView =
  | { kind: 'list' }
  | { kind: 'create'; draft?: CreateSpecialistInput }
  | { kind: 'edit'; id: string }
  | { kind: 'export'; id: string }
  | { kind: 'import' }
  | { kind: 'builtin'; id: string }

type CategoryFilter = 'all' | 'custom' | 'builtin'

const FILTER_LABELS: Record<CategoryFilter, string> = {
  all: 'All',
  custom: 'Custom',
  builtin: 'Built-in'
}

const SKILL_SOURCE_LABELS: Record<SkillSource, string> = {
  featured: 'Featured',
  imported: 'Imported',
  personal: 'Personal'
}

const formatBytes = (value: number): string =>
  value >= 1024 * 1024
    ? `${Number((value / (1024 * 1024)).toFixed(1))} MB`
    : `${Number((value / 1024).toFixed(1))} KB`

// User-facing presentation of package diagnostics (see lib/specialist-diagnostics.ts).
// Severity is distinguished by icon shape, color and grouping, not by color alone.
const SEVERITY_GROUPS = [
  { severity: 'error', label: 'Blocking errors' },
  { severity: 'warning', label: 'Warnings' },
  { severity: 'info', label: 'Information' }
] as const

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
}

const SpecialistsPanel = ({ view, onNavigate }: SpecialistsPanelProps): React.JSX.Element => {
  const items = useSpecialistStore((s) => s.items)
  const isLoaded = useSpecialistStore((s) => s.isLoaded)
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
  // Live project catalog drives the `Chat with agent` entry's enabled state and routing. The stored
  // last-opened reference is re-validated against this list before navigating.
  const projects = useProjectStore((s) => s.projects)
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [deletingItem, setDeletingItem] = useState<{
    id: string
    revision: number
    name: string
    preview: SpecialistDeletePreview
  } | null>(null)
  const [deleteSkillIds, setDeleteSkillIds] = useState<Set<string>>(new Set())
  const [deleteError, setDeleteError] = useState<string | undefined>()
  const [templateSaving, setTemplateSaving] = useState(false)
  const [templateSaved, setTemplateSaved] = useState(false)
  const [templateSaveError, setTemplateSaveError] = useState<string | undefined>()
  const [packageBusy, setPackageBusy] = useState(false)
  const [packageErrorCode, setPackageErrorCode] = useState<string | undefined>()
  const [overwriteConfirmationOpen, setOverwriteConfirmationOpen] = useState(false)
  const [reportStatus, setReportStatus] = useState<string | undefined>()
  const [includedExportSkillIds, setIncludedExportSkillIds] = useState<string[]>([])
  const [exportBusy, setExportBusy] = useState(false)
  const [exportSaved, setExportSaved] = useState(false)
  const [exportError, setExportError] = useState<string | undefined>()
  // Specialist currently exporting from the list row (direct export bypasses the chooser).
  const [exportingId, setExportingId] = useState<string | null>(null)

  // Memoised so visibleCustomItems' memo can reference a stable value.
  const customItems = useMemo(() => items.filter((i) => i.kind === 'custom'), [items])
  const builtinItems = useMemo(() => items.filter((i) => i.kind === 'builtin'), [items])

  useEffect(() => {
    void load()

    // Subscribe to catalog-changed push events so the list stays in sync.
    if (typeof window.api?.specialist?.onCatalogChanged !== 'function') return
    const unsub = window.api.specialist.onCatalogChanged(() => void load())
    return unsub
  }, [load])

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

  // Keep runnable builtins distinct from the Reviewer placeholder even though Settings groups both
  // under Built-in. Only runnable builtins enter the Session picker.
  const reviewerItems = items.filter((i) => i.kind === 'reviewer')
  const visibleBuiltinItems = useMemo(() => {
    if (filter === 'custom') return []
    const term = query.trim().toLowerCase()
    if (!term) return builtinItems
    return builtinItems.filter(
      (item) =>
        (item.displayName ?? item.name).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
    )
  }, [builtinItems, filter, query])
  const visibleCustomItems = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (filter === 'builtin') return []
    if (!term) return customItems
    return customItems.filter(
      (item) =>
        (item.displayName ?? item.name).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
    )
  }, [customItems, filter, query])
  const visibleReviewerItems = useMemo(() => {
    if (filter === 'custom') return []
    const term = query.trim().toLowerCase()
    if (!term || 'reviewer used by auto-review'.includes(term)) return reviewerItems
    return []
  }, [filter, query, reviewerItems])

  // Built-in Skills are app-managed and never participate in Specialist deletion. Keep this
  // renderer-side filter as a defensive boundary even though the main-side preview omits them.
  const visibleDeleteSkills = deletingItem?.preview.skills.filter(
    (skill) => skill.source !== 'featured'
  )

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
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Import ZIP</p>
            <h2 className="mt-1 text-xl font-semibold">Import a Specialist package</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose one ZIP containing exactly one Specialist.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => onNavigate({ kind: 'list' })}>
            Back
          </Button>
        </div>
        <div className="rounded-xl border border-border px-6 py-10 text-center" role="status">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-success-000/10 text-success-000">
            ✓
          </div>
          <h3 className="mt-4 text-lg font-semibold">Template saved</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            openscience-specialist-template.zip is ready for contributor editing.
          </p>
          <Button type="button" className="mt-5" onClick={() => setTemplateSaved(false)}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  if (view.kind === 'create') {
    return (
      <SpecialistEditor
        existingNames={customItems.map((item) => item.name)}
        initialInput={view.draft}
        onCancel={() => onNavigate({ kind: 'list' })}
        onSave={async (input: CreateSpecialistInput) => {
          await createSpecialist(input)
          onNavigate({ kind: 'list' })
        }}
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
            <h2 className="mt-4 text-lg font-semibold">Export complete</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {exportPreview.fileName} was saved. No location is shown here.
            </p>
            <Button
              type="button"
              className="mt-5"
              onClick={() => {
                clearExport()
                onNavigate({ kind: 'list' })
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )
    }
    return (
      <div className="p-5">
        <div className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Export ZIP</p>
            <h2 className="mt-1 text-xl font-semibold">
              {exportPreview ? 'Choose Skills to include' : 'Preparing export…'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Owned Skills are selected by default. Skills copied into the ZIP are discovered
              automatically on import; Featured Skills and Connector names remain references.
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
            {exportPreview?.canExport ? '✓ Ready' : exportPreview ? '× Blocked' : 'Checking…'}
          </span>
        </div>
        {exportError ? (
          <div
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
          >
            {exportError}
          </div>
        ) : null}
        {exportPreview ? (
          <div className="flex flex-col gap-4">
            {exportPreview.diagnostics.map((diagnostic) => (
              <div
                key={diagnostic.code}
                role={diagnostic.severity === 'error' ? 'alert' : 'status'}
                className="rounded-lg border border-border p-3 text-sm"
              >
                <strong>{diagnostic.code}</strong>
                <p className="text-muted-foreground">{diagnostic.message}</p>
              </div>
            ))}
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
                          ? 'Featured Skill · referenced by name and not copied into the package.'
                          : skill.kind === 'owned'
                            ? `Owned Skill · v${skill.version} · bundled by default.`
                            : `Installed Skill · v${skill.version} · include it to bundle a copy.`}
                      </span>
                    </span>
                    <span className="text-xs capitalize text-muted-foreground">{skill.kind}</span>
                  </label>
                )
              })}
            </div>
            <div className="rounded-lg border border-border p-3 text-sm" role="status">
              <strong>What the package carries</strong>
              <p className="text-muted-foreground">
                Only checked Skills are bundled. Connector names are imported as selected
                references; full access can only be chosen later in the configuration page.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Connectors:{' '}
                {exportPreview.connectorIds.length
                  ? exportPreview.connectorIds.join(', ')
                  : 'None selected'}
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
                Cancel
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
                {exportBusy ? 'Saving…' : 'Export ZIP'}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  if (view.kind === 'edit') {
    // Reuse the existing editor for both ordinary edits and the setup that follows an import.
    const specialist = customItems.find((item) => item.kind === 'custom' && item.id === view.id)
    if (specialist && specialist.kind === 'custom') {
      return (
        <SpecialistEditor
          key={specialist.id}
          editSpecialist={specialist}
          existingNames={customItems.filter((item) => item.id !== view.id).map((item) => item.name)}
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
        />
      )
    }
    // Profile no longer exists (deleted/stale) — fall through to the list.
  }

  if (view.kind === 'import') {
    const summary = packagePreview?.summary
    const blocking = packagePreview?.diagnostics.some((item) => item.severity === 'error') ?? false
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
              {packagePreview ? 'Import ZIP · Preview' : 'Import ZIP'}
            </p>
            <h2 className="mt-1 text-xl font-semibold">
              {packagePreview
                ? packagePreview.installable
                  ? 'Ready to continue'
                  : 'Cannot continue'
                : 'Import a Specialist package'}
              {packagePreview ? (
                <span
                  role="status"
                  className={`ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    packagePreview.installable
                      ? 'bg-success-000/10 text-success-000'
                      : 'bg-danger-000/10 text-danger-000'
                  }`}
                >
                  {packagePreview.installable ? '✓ Installable' : '× Not installable'}
                </span>
              ) : null}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {packagePreview
                ? 'Review the package summary and diagnostics before continuing to setup.'
                : 'Choose one ZIP containing exactly one Specialist.'}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => onNavigate({ kind: 'list' })}>
            Back
          </Button>
        </div>

        {!packagePreview ? (
          <div className="rounded-xl border border-border p-6 text-center">
            <Upload className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
            <h3 className="mt-3 text-sm font-semibold">Select a Specialist ZIP</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              The package will be safely parsed and previewed before it is saved.
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              Limits: 50 MB compressed · 200 MB uncompressed · 2,000 files · 25 MB per file
            </p>
            <p className="mx-auto mt-2 max-w-xl text-xs text-muted-foreground">
              The ZIP contains app metadata, the specialist.json you fill in, and a README.txt
              guide. Skills placed in the skills folder are discovered automatically.
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={templateSaving}
                onClick={downloadTemplate}
              >
                <Download data-icon="inline-start" aria-hidden="true" />
                {templateSaving ? 'Saving template…' : 'Download template'}
              </Button>
              <Button
                type="button"
                disabled={packageBusy}
                onClick={() => {
                  setPackageBusy(true)
                  void selectPackage().finally(() => setPackageBusy(false))
                }}
              >
                Choose ZIP
              </Button>
            </div>
            {templateSaveError ? (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-danger-000/30 bg-danger-000/10 p-3 text-sm text-danger-000"
              >
                {templateSaveError}
              </p>
            ) : null}
          </div>
        ) : (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Specialist ZIP preview"
            className="space-y-4"
          >
            <div className="grid grid-cols-2 gap-3 rounded-xl border border-border p-4 text-sm">
              <div>
                <span className="block text-xs text-muted-foreground">Specialist</span>
                {summary?.name ?? 'Unknown'}
              </div>
              <div>
                <span className="block text-xs text-muted-foreground">Immutable ID</span>
                {summary?.id ?? 'Unknown'}
              </div>
              <div>
                <span className="block text-xs text-muted-foreground">Package version</span>
                {summary?.version ?? 'Unknown'}
              </div>
            </div>

            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold">Skills</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {summary?.bundledSkillIds.length
                  ? `Bundled: ${summary.bundledSkillIds.join(', ')}`
                  : 'No bundled Skills'}
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

            {packagePreview.archive ? (
              <section className="rounded-xl border border-border p-4">
                <h3 className="text-sm font-semibold">Archive limits</h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Compressed</dt>
                    <dd>
                      {formatBytes(packagePreview.archive.compressedBytes)} /{' '}
                      {formatBytes(packagePreview.archive.limits.compressedBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Uncompressed</dt>
                    <dd>
                      {formatBytes(packagePreview.archive.uncompressedBytes ?? 0)} /{' '}
                      {formatBytes(packagePreview.archive.limits.uncompressedBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Files</dt>
                    <dd>
                      {packagePreview.archive.fileCount ?? 0} /{' '}
                      {packagePreview.archive.limits.fileCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Per file</dt>
                    <dd>Up to {formatBytes(packagePreview.archive.limits.fileBytes)}</dd>
                  </div>
                </dl>
              </section>
            ) : null}

            <section className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Diagnostics</h3>
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
                        () => setReportStatus('Report copied'),
                        () => setReportStatus('Could not copy report')
                      )
                    }}
                  >
                    <Copy data-icon="inline-start" aria-hidden="true" />
                    Copy report
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void window.api.specialist
                        .savePackageReport({ candidateToken: packagePreview.candidateToken })
                        .then((result) =>
                          setReportStatus(result.saved ? 'Report saved' : undefined)
                        )
                        .catch(() => setReportStatus('Could not save report'))
                    }}
                  >
                    <Download data-icon="inline-start" aria-hidden="true" />
                    Download JSON
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
                          {group.label} ({items.length})
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
                                  <strong className="block">{copy.title}</strong>
                                  <span className="block opacity-80">{copy.body}</span>
                                  {diagnostic.path || diagnostic.relatedId ? (
                                    <span className="mt-0.5 block font-mono text-[10px] opacity-60">
                                      {diagnostic.path}
                                      {diagnostic.path && diagnostic.relatedId ? ' · ' : ''}
                                      {diagnostic.relatedId ? `ID: ${diagnostic.relatedId}` : ''}
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
                    <strong className="block">Validation passed</strong>
                    <span className="opacity-80">
                      The package can be installed after explicit confirmation.
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
                Local edits will be replaced by this import.
              </p>
            ) : null}
            {packageErrorCode ? (
              <p role="alert" className="text-xs text-destructive">
                Import failed: {packageErrorCode}
              </p>
            ) : null}
            <div className="flex justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancelPackage().then(() => onNavigate({ kind: 'list' }))}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={packageBusy || blocking || !packagePreview.installable}
                onClick={() => {
                  if (packagePreview.overwrite) {
                    setOverwriteConfirmationOpen(true)
                    return
                  }
                  setPackageBusy(true)
                  void installPackage(false)
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
                {packagePreview.overwrite ? 'Review overwrite' : 'Next'}
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
                          Local changes will be permanently replaced
                        </AlertDialog.Title>
                      </div>
                      <AlertDialog.Cancel asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Close"
                          className={dialogCloseButtonClassName}
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </AlertDialog.Cancel>
                    </div>

                    <div className={dialogBodyClassName}>
                      <AlertDialog.Description className={dialogDescriptionClassName}>
                        Current local edits are not recoverable after a successful overwrite. A
                        failed atomic install preserves the current version.
                      </AlertDialog.Description>
                      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-border p-3 text-xs">
                        <div>
                          <dt className="text-muted-foreground">Current version</dt>
                          <dd>{packagePreview.overwrite.currentVersion}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Incoming version</dt>
                          <dd>
                            {packagePreview.overwrite.incomingVersion}
                            {packagePreview.diagnostics.some(
                              (item) => item.code === 'specialist.overwrite-downgrade'
                            )
                              ? ' · downgrade'
                              : ''}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Local status</dt>
                          <dd>
                            {packagePreview.overwrite.hasImportBaseline
                              ? packagePreview.overwrite.modifiedSinceImport
                                ? 'Modified after import'
                                : 'Unchanged since import'
                              : 'No import baseline'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Target</dt>
                          <dd>Custom Specialist only</dd>
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
                        Export current version first
                      </Button>
                    </div>

                    <div className={dialogFooterClassName}>
                      <AlertDialog.Cancel asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className={dialogCancelButtonClassName}
                        >
                          Cancel
                        </Button>
                      </AlertDialog.Cancel>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={packageBusy}
                        onClick={() => {
                          setPackageBusy(true)
                          void installPackage(true)
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
                        Overwrite and continue
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
            Back to specialists
          </Button>
          <div className="mt-5 flex items-start gap-3">
            <SpecialistAvatar iconKey={specialist.iconKey} colorKey={specialist.colorKey} />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {specialist.displayName ?? specialist.name}
              </h2>
              <p className="text-xs text-muted-foreground">
                Built-in · Version {specialist.version}
              </p>
            </div>
          </div>
          <p className="mt-4 text-sm text-foreground">{specialist.description}</p>
          <div className="mt-5 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium text-foreground">Read-only</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This Specialist ships with the app and cannot be changed.
            </p>
          </div>
          <div className="mt-5">
            <h3 className="text-sm font-semibold text-foreground">Capabilities</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {specialist.capabilityMode === 'full' ? 'Full access' : 'Selected capabilities'}
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
      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-2">
        <div
          className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5"
          role="tablist"
          aria-label="Filter specialists by category"
        >
          {(['all', 'custom', 'builtin'] as const).map((key) => {
            const count =
              key === 'all'
                ? items.length
                : key === 'custom'
                  ? customItems.length
                  : builtinItems.length + reviewerItems.length
            const active = filter === key
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(key)}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors motion-reduce:transition-none ${
                  active
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {FILTER_LABELS[key]}
                <span className="tabular-nums text-muted-foreground">({count})</span>
              </button>
            )
          })}
        </div>
        <SettingsSearchInput
          aria-label="Search specialists"
          placeholder="Search specialists…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="shrink-0">
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add specialist
              <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'create' })}>
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Write from scratch</span>
                <span className="text-xs text-muted-foreground">
                  Configure instructions and capabilities yourself
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
                <span>Chat with agent</span>
                <span className="text-xs text-muted-foreground">
                  Start a normal conversation; the agent guides you step by step
                </span>
              </span>
            </DropdownMenuItem>
            {!chatProjectId ? (
              <>
                <DropdownMenuSeparator />
                <p className="px-2.5 pb-1 pt-0.5 text-xs text-muted-foreground">
                  Open a project to chat with the agent
                </p>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'import' })}>
              <Upload className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Import ZIP</span>
                <span className="text-xs text-muted-foreground">
                  Preview a package, then finish setup in the existing editor
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!isLoaded ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Custom specialists group */}
          {filter !== 'builtin' ? (
            <div>
              <div className="mb-1 flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">Custom</span>
                <span className="text-xs text-muted-foreground">Created by you.</span>
              </div>

              {visibleCustomItems.length > 0 ? (
                <ul className="mt-2 flex flex-col divide-y divide-border">
                  {visibleCustomItems.map((item) => {
                    if (item.kind !== 'custom') return null
                    return (
                      <li
                        key={item.id}
                        data-slot="settings-list-row"
                        className="flex min-h-14 items-center gap-2 py-2.5"
                      >
                        {/* Click the row body to open the editor (prefilled) */}
                        <button
                          type="button"
                          onClick={() => onNavigate({ kind: 'edit', id: item.id })}
                          aria-label={
                            item.setupPending
                              ? `Continue setup for ${item.displayName ?? item.name}`
                              : `Edit ${item.displayName ?? item.name}`
                          }
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {/* Avatar */}
                          <SpecialistAvatar iconKey={item.iconKey} colorKey={item.colorKey} />

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
                            <span className="block text-[11px] text-muted-foreground">
                              {item.setupPending
                                ? 'Setup incomplete · Continue setup'
                                : item.capabilityMode === 'full'
                                  ? 'Full access'
                                  : 'Selected capabilities'}
                              {!item.setupPending && item.origin === 'imported'
                                ? ` · Imported · Original version ${item.packageVersion ?? '0.1.0'} · ${
                                    item.modifiedSinceImport
                                      ? 'Modified after import'
                                      : 'Unchanged since import'
                                  }`
                                : ''}
                            </span>
                          </div>
                        </button>

                        {/* Enabled toggle */}
                        <SettingsToggle
                          enabled={item.enabled}
                          disabled={item.setupPending}
                          aria-label={
                            item.setupPending
                              ? `Complete setup before enabling ${item.displayName ?? item.name}`
                              : `Toggle ${item.displayName ?? item.name}`
                          }
                          onToggle={() => void setEnabled(item.id, !item.enabled)}
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
                                    aria-label={`Actions for ${item.displayName ?? item.name}`}
                                  >
                                    {exportingId === item.id ? (
                                      <span role="status" aria-label="Preparing export">
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
                                Actions for {item.displayName ?? item.name}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="gap-2 text-xs"
                              onSelect={() =>
                                void duplicateSpecialist(item.id).then((draft) =>
                                  onNavigate({ kind: 'create', draft })
                                )
                              }
                            >
                              <Copy className="size-3.5" aria-hidden="true" /> Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2 text-xs"
                              onSelect={() => void runDirectExport(item.id)}
                            >
                              <Download className="size-3.5" aria-hidden="true" /> Export ZIP
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2 text-xs text-destructive"
                              onSelect={() => {
                                setDeleteError(undefined)
                                setDeleteSkillIds(new Set())
                                void previewSpecialistDelete(item.id)
                                  .then((preview) =>
                                    setDeletingItem({
                                      id: item.id,
                                      revision: preview.expectedRevision,
                                      name: item.displayName ?? item.name,
                                      preview
                                    })
                                  )
                                  .catch(() =>
                                    setDeleteError('Could not load live Skill relationships.')
                                  )
                              }}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="mt-2 py-2 text-xs text-muted-foreground">
                  No specialists yet. Use &ldquo;Add specialist&rdquo; to create one.
                </p>
              )}
            </div>
          ) : null}

          {/* Built-in group: runnable repository profiles plus the separate Reviewer placeholder. */}
          {visibleBuiltinItems.length > 0 || visibleReviewerItems.length > 0 ? (
            <div>
              <div className="mb-1 flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">Built-in</span>
                <span className="text-xs text-muted-foreground">
                  Shipped with the app. Not configurable.
                </span>
              </div>
              <ul className="mt-2 flex flex-col divide-y divide-border">
                {visibleBuiltinItems.map((item) => (
                  <li
                    key={item.id}
                    data-slot="settings-list-row"
                    className="flex min-h-14 items-center gap-2 py-2.5"
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate({ kind: 'builtin', id: item.id })}
                      aria-label={`View ${item.displayName ?? item.name}`}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <SpecialistAvatar iconKey={item.iconKey} colorKey={item.colorKey} />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {item.displayName ?? item.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.description}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          Built-in · Version {item.version}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
                {visibleReviewerItems.map(() => (
                  <li
                    key="reviewer"
                    data-slot="settings-list-row"
                    className="flex min-h-14 items-center gap-2 py-2.5"
                  >
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-[13px] text-primary"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">Reviewer</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Used by Auto-review
                      </span>
                    </div>
                    {/* No toggle, no actions for Reviewer */}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog.Root
        open={deletingItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingItem(null)
            setDeleteError(undefined)
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] max-h-[85vh] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <AlertDialog.Title className={dialogTitleClassName}>
                  Delete “{deletingItem?.name}”?
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>

            <div className={`${dialogBodyClassName} overflow-y-auto`}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                This permanently deletes the Specialist. Conversations using it will no longer be
                able to use it.
              </AlertDialog.Description>
              <div className="mt-4">
                <p className="text-sm font-medium text-foreground">
                  Skills you can also delete{' '}
                  <span className="font-normal text-muted-foreground">(optional)</span>
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Only Skills used exclusively by this Specialist can be deleted. Other linked
                  Skills will be kept automatically.
                </p>
              </div>
              <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-border px-3">
                {visibleDeleteSkills?.length ? (
                  visibleDeleteSkills.map((skill) => {
                    const reasonText =
                      skill.reasons
                        .map((reason) =>
                          reason.code === 'standalone'
                            ? 'Already exists independently and will be kept.'
                            : reason.code === 'shared-owner'
                              ? 'Also owned by another Specialist and will be kept.'
                              : reason.code === 'referenced'
                                ? 'Used by another Specialist and will be kept.'
                                : 'Managed by the app and will be kept.'
                        )
                        .join(' ') ||
                      'Used only by this Specialist. Select to permanently delete it.'
                    return (
                      <label
                        key={skill.id}
                        className="flex items-start gap-3 border-b border-border py-3 last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4"
                          disabled={!skill.deletable}
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
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                            <span>{skill.displayName}</span>
                            <Badge variant="outline" className="text-[11px] font-normal">
                              {SKILL_SOURCE_LABELS[skill.source]}
                            </Badge>
                          </span>
                          <span className="block text-xs text-muted-foreground">{reasonText}</span>
                        </span>
                      </label>
                    )
                  })
                ) : (
                  <p className="py-3 text-xs text-muted-foreground">
                    No additional Skills will be deleted.
                  </p>
                )}
              </div>
              {deleteError ? (
                <p
                  role="alert"
                  className="mt-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
                >
                  {deleteError}
                </p>
              ) : null}
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (!deletingItem) return
                  const item = deletingItem
                  void (async () => {
                    try {
                      const result: SpecialistDeleteResult = await deleteSpecialist(
                        item.id,
                        item.revision,
                        [...deleteSkillIds].sort()
                      )
                      if (result.status === 'deleted') {
                        await useSettingsStore.getState().loadSkills()
                        setDeletingItem(null)
                        setDeleteSkillIds(new Set())
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
                    }
                  })()
                }}
              >
                Delete Specialist
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

export { SpecialistsPanel }
