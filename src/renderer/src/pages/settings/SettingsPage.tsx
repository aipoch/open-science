import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Bot,
  Brain,
  Cloud,
  Globe,
  LockKeyhole,
  Maximize2,
  Menu,
  Minimize2,
  MonitorSmartphone,
  ScrollText,
  Settings2,
  TerminalSquare,
  Users,
  X,
  Zap
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

import {
  resolveCodexSubscriptionType,
  type ProviderView,
  type UpsertProviderRequest
} from '../../../../shared/settings'
import type { SpecialistListItem } from '../../../../shared/specialist'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'
import { useProjectStore } from '@/stores/project-store'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import type { SettingsPanelId } from './settings-navigation'
import { useSpecialistStore } from '@/stores/specialist-store'
import { AgentPanel } from './AgentPanel'
import { ProvidersPanel } from './ProvidersPanel'
import { GeneralPanel } from './GeneralPanel'
import { NetworkPanel } from './NetworkPanel'
import { StoragePanel } from './StoragePanel'
import { RuntimesPanel } from './RuntimesPanel'
import { RemoteControlPanel } from './RemoteControlPanel'
import { SkillsPanel, type SkillsView } from './SkillsPanel'
import { ConnectorsPanel, type ConnectorsView } from './ConnectorsPanel'
import { SpecialistsPanel, type SpecialistsView } from './SpecialistsPanel'
import { ConnectorDetailView } from './ConnectorDetailView'
import { ConnectorAddForm } from './ConnectorAddForm'
import { ConnectorExportView } from './ConnectorExportView'
import { ConnectorImportView } from './ConnectorImportView'
import { ConnectorsNavIcon } from './connector-icons'
import { ComputePanel, type ComputeView } from './ComputePanel'
import { ComputeAddForm } from './ComputeAddForm'
import { ComputeHostDetail } from './ComputeHostDetail'
import { PermissionsPanel } from './PermissionsPanel'
import { ArchivedPanel, type ArchivedView } from './ArchivedPanel'
import { resolveVendorModelsUrl } from '../../../../shared/provider-registry'
import { ProviderForm } from './ProviderForm'
import {
  createEmptyProviderFormValue,
  defaultCustomApiEndpoint,
  defaultProviderKindKey,
  getProviderFormErrors,
  hasProviderFormErrors,
  providerFormApiEndpoints,
  providerKindPatch,
  type ProviderFormValue
} from './provider-form-value'

type SettingsPageProps = {
  open: boolean
  onClose: () => void
  onOpenSession?: (sessionId: string) => void
}

type SettingsPageHandle = {
  closeActivePane: () => boolean
}

// The model panel sub-view, driven by the settings navigation history so add/edit is a breadcrumb page.
type ModelView = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; providerId: string }

// Builds a form value from an existing provider (never carrying the plaintext key).
const toFormValue = (provider: ProviderView): ProviderFormValue =>
  createEmptyProviderFormValue({
    type:
      provider.type === 'codex-shared' || provider.type === 'codex-isolated'
        ? resolveCodexSubscriptionType(provider)
        : provider.type,
    name: provider.name,
    baseUrl: provider.baseUrl ?? '',
    model: provider.model ?? '',
    contextWindow: provider.contextWindow?.toString() ?? '',
    apiEndpoint: provider.apiEndpoints?.[0] ?? 'anthropic',
    supportsImageInput: provider.supportsImageInput,
    reasoningEffortPreset: provider.reasoningEffortPreset ?? 'standard-5',
    reasoningEffortTransport: provider.reasoningEffortTransport ?? 'reasoning-effort',
    vendorId: provider.vendorId,
    region: provider.region
  })

const toUpsertRequest = (
  value: ProviderFormValue,
  id: string | undefined
): UpsertProviderRequest => ({
  id,
  type: value.type,
  name: value.name,
  baseUrl: value.baseUrl,
  model: value.model,
  contextWindow:
    value.type === 'custom'
      ? value.contextWindow.trim()
        ? Number(value.contextWindow)
        : null
      : undefined,
  apiEndpoints: providerFormApiEndpoints(value),
  supportsImageInput: value.supportsImageInput,
  reasoningEffortPreset: value.type === 'custom' ? value.reasoningEffortPreset : undefined,
  reasoningEffortTransport: value.type === 'custom' ? value.reasoningEffortTransport : undefined,
  vendorId: value.vendorId,
  region: value.region,
  key: value.key || undefined
})

type SettingsPanel = {
  id: SettingsPanelId
  label: string
  Icon: React.ComponentType<{ className?: string }>
}

type SettingsGroup = {
  label?: string
  panels: ReadonlyArray<SettingsPanel>
  bottom?: boolean
}

const SETTINGS_GROUPS: ReadonlyArray<SettingsGroup> = [
  {
    label: 'Capabilities',
    panels: [
      { id: 'skills', label: 'Skills', Icon: ScrollText },
      { id: 'connectors', label: 'Connectors', Icon: ConnectorsNavIcon },
      { id: 'specialists', label: 'Specialists', Icon: Users },
      { id: 'compute', label: 'Compute', Icon: Zap },
      { id: 'network', label: 'Network', Icon: Globe }
    ]
  },
  {
    label: 'Workspace',
    panels: [
      { id: 'model', label: 'Model', Icon: Brain },
      { id: 'agent', label: 'Agent', Icon: Bot },
      { id: 'permissions', label: 'Permissions', Icon: LockKeyhole },
      { id: 'runtimes', label: 'Runtimes', Icon: TerminalSquare },
      { id: 'storage', label: 'Storage', Icon: Cloud },
      { id: 'general', label: 'General', Icon: Settings2 }
    ]
  },
  {
    label: 'Remote access',
    panels: [{ id: 'remote-control', label: 'Remote control', Icon: MonitorSmartphone }]
  },
  {
    panels: [{ id: 'archived', label: 'Archived', Icon: Archive }],
    bottom: true
  }
]

// Flattened panel list for lookups (header title, etc.).
const SETTINGS_PANELS: ReadonlyArray<SettingsPanel> = SETTINGS_GROUPS.flatMap(
  (group) => group.panels
)

// One entry in the settings back/forward history: the active panel plus each panel's current sub-view
// (skills: list / detail / create / edit / import; model: list / create / edit; connectors: list /
// detail / add / edit). `connectors` is optional so panel switches that don't touch it stay terse.
// Network panel sub-view: the package-mirror list vs. the configure form (a breadcrumb drill-in).
type NetworkView = { kind: 'list' | 'configure' }

type NavLocation = {
  panel: SettingsPanelId
  skills: SkillsView
  model: ModelView
  connectors?: ConnectorsView
  network?: NetworkView
  compute?: ComputeView
  specialists?: SpecialistsView
  archived?: ArchivedView
}

const INITIAL_LOCATION: NavLocation = {
  panel: 'model',
  skills: { kind: 'list' },
  model: { kind: 'list' },
  connectors: { kind: 'list' },
  network: { kind: 'list' },
  compute: { kind: 'list' },
  specialists: { kind: 'list' },
  archived: { kind: 'list' }
}

// App-level model settings surface. Reuses the onboarding cards/form; manages providers (CRUD +
// activate + test). Opened from the Home/Workspace gear entry.
const SettingsPage = forwardRef<SettingsPageHandle, SettingsPageProps>(function SettingsPage(
  { open, onClose, onOpenSession },
  ref
): React.JSX.Element {
  const providers = useSettingsStore((state) => state.providers)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const customApiEndpoint = defaultCustomApiEndpoint(frameworkEndpoints)
  const opencode = useSettingsStore((state) => state.opencode)
  const isDetectingOpencode = useSettingsStore((state) => state.isDetectingOpencode)
  const detectOpencode = useSettingsStore((state) => state.detectOpencode)
  const codex = useSettingsStore((state) => state.codex)
  const isDetectingCodex = useSettingsStore((state) => state.isDetectingCodex)
  const detectCodex = useSettingsStore((state) => state.detectCodex)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const load = useSettingsStore((state) => state.load)
  const persistProvider = useSettingsStore((state) => state.persistProvider)
  const validateProvider = useSettingsStore((state) => state.validateProvider)
  const refreshProviderModels = useSettingsStore((state) => state.refreshProviderModels)
  const pendingSkillId = useSettingsStore((state) => state.pendingSkillId)
  const consumePendingSkill = useSettingsStore((state) => state.consumePendingSkill)
  const pendingSpecialistId = useSettingsStore((state) => state.pendingSpecialistId)
  const consumePendingSpecialist = useSettingsStore((state) => state.consumePendingSpecialist)
  const pendingSettingsPanel = useSettingsStore((state) => state.pendingSettingsPanel)
  const consumePendingSettingsPanel = useSettingsStore((state) => state.consumePendingSettingsPanel)
  const settingsWriteError = useSettingsStore((state) => state.settingsWriteError)
  const clearSettingsWriteError = useSettingsStore((state) => state.clearSettingsWriteError)
  const canImportInstalledSkills =
    typeof window.api.settings.listAgentHomeSkills === 'function' &&
    typeof window.api.settings.importAgentHomeSkills === 'function'

  // Settings navigation history (browser-like back/forward). Panel switches and drill-downs push a
  // new location; the active panel and open sub-views are derived from the current entry.
  const [history, setHistory] = useState<NavLocation[]>([INITIAL_LOCATION])
  const [historyIndex, setHistoryIndex] = useState(0)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  // Whether the dialog is enlarged to near-fullscreen via the maximize control.
  const [isExpanded, setIsExpanded] = useState(false)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false)
  const skills = useSettingsStore((state) => state.skills)
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const computeHosts = useComputeStore((state) => state.hosts)
  const projects = useProjectStore((state) => state.projects)
  const specialistItems = useSpecialistStore((state) => state.items)
  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
  const [isSaving, setIsSaving] = useState(false)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined)
  const [statusOk, setStatusOk] = useState(false)
  // Shared with ProvidersPanel: the post-save validation and the list's manual test both mark the
  // provider busy so its card shows "Testing…".
  const [busyProviderId, setBusyProviderId] = useState<string | undefined>(undefined)

  // Refresh settings whenever the dialog opens so external changes are reflected.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // When opened from a skill mention, seed the history straight to that skill's detail page. This is
  // the derive-state-during-render pattern (guarded so it runs once per request); the guard resets on
  // close so reopening the same skill re-seeds. The Skills panel loads its list on mount, so the
  // breadcrumb name resolves once that arrives.
  const [seededSkillId, setSeededSkillId] = useState<string | undefined>(undefined)
  if (open && pendingSkillId !== undefined && pendingSkillId !== seededSkillId) {
    setSeededSkillId(pendingSkillId)
    setHistory([
      {
        panel: 'skills',
        skills: { kind: 'detail', id: pendingSkillId },
        model: { kind: 'list' },
        connectors: { kind: 'list' }
      }
    ])
    setHistoryIndex(0)
  }
  if (!open && seededSkillId !== undefined) {
    setSeededSkillId(undefined)
  }

  // External entry points seed one shared panel target. The consumed target cannot override a later
  // manual navigation when the dialog is reopened normally.
  const [seededSettingsPanel, setSeededSettingsPanel] = useState<SettingsPanelId | undefined>()
  if (open && pendingSettingsPanel !== undefined && pendingSettingsPanel !== seededSettingsPanel) {
    setSeededSettingsPanel(pendingSettingsPanel)
    setHistory([{ ...INITIAL_LOCATION, panel: pendingSettingsPanel }])
    setHistoryIndex(0)
  }
  if (!open && seededSettingsPanel !== undefined) {
    setSeededSettingsPanel(undefined)
  }

  // When opened from the specialist switch approval card, seed the history straight onto that
  // specialist's editor. Same derive-during-render pattern as the skill seed above; the
  // Specialists panel resolves the profile from the catalog once it mounts.
  const [seededSpecialistId, setSeededSpecialistId] = useState<string | undefined>(undefined)
  if (open && pendingSpecialistId !== undefined && pendingSpecialistId !== seededSpecialistId) {
    setSeededSpecialistId(pendingSpecialistId)
    setHistory([
      {
        panel: 'specialists',
        specialists: { kind: 'edit', id: pendingSpecialistId },
        skills: { kind: 'list' },
        model: { kind: 'list' }
      }
    ])
    setHistoryIndex(0)
  }
  if (!open && seededSpecialistId !== undefined) {
    setSeededSpecialistId(undefined)
  }

  useEffect(() => {
    if (pendingSettingsPanel !== undefined) consumePendingSettingsPanel()
  }, [pendingSettingsPanel, consumePendingSettingsPanel])
  // Clear the store's pending flag after it has been applied, so a later normal open starts fresh.
  useEffect(() => {
    if (pendingSkillId !== undefined) consumePendingSkill()
  }, [pendingSkillId, consumePendingSkill])
  useEffect(() => {
    if (pendingSpecialistId !== undefined) consumePendingSpecialist()
  }, [pendingSpecialistId, consumePendingSpecialist])

  // Auto-detect opencode the first time its detection card is shown without a known path, so the card
  // reflects reality without a manual re-detect. Guarded on path + in-flight to run at most once.
  useEffect(() => {
    if (
      open &&
      agentFrameworkId === 'opencode' &&
      !opencode?.resolvedPath &&
      !isDetectingOpencode
    ) {
      void detectOpencode()
    }
  }, [open, agentFrameworkId, opencode?.resolvedPath, isDetectingOpencode, detectOpencode])

  // Codex detection probes the ACP adapter and its paired native runtime. Keep it lazy so opening
  // settings for another framework does not spawn an unnecessary process.
  useEffect(() => {
    if (open && agentFrameworkId === 'codex' && !codex?.resolvedPath && !isDetectingCodex) {
      void detectCodex()
    }
  }, [open, agentFrameworkId, codex?.resolvedPath, isDetectingCodex, detectCodex])

  const currentLocation = history[historyIndex]
  const activePanel = currentLocation.panel
  const skillsView = currentLocation.skills
  const modelView = currentLocation.model
  const connectorsView: ConnectorsView = currentLocation.connectors ?? { kind: 'list' }
  const networkView: NetworkView = currentLocation.network ?? { kind: 'list' }
  const computeView: ComputeView = currentLocation.compute ?? { kind: 'list' }
  const specialistsView: SpecialistsView = currentLocation.specialists ?? { kind: 'list' }
  const archivedView: ArchivedView = currentLocation.archived ?? { kind: 'list' }
  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex < history.length - 1

  // Pushes a new location, dropping any forward entries.
  const navigate = (location: NavLocation): void => {
    const nextConnectors = location.connectors ?? { kind: 'list' }
    const nextNetwork = location.network ?? { kind: 'list' }
    const nextCompute = location.compute ?? { kind: 'list' }
    const nextSpecialists = location.specialists ?? { kind: 'list' }
    const nextArchived = location.archived ?? { kind: 'list' }
    if (
      location.panel === activePanel &&
      location.skills.kind === skillsView.kind &&
      ('id' in location.skills ? location.skills.id : undefined) ===
        ('id' in skillsView ? skillsView.id : undefined) &&
      location.model.kind === modelView.kind &&
      ('providerId' in location.model ? location.model.providerId : undefined) ===
        ('providerId' in modelView ? modelView.providerId : undefined) &&
      nextConnectors.kind === connectorsView.kind &&
      ('id' in nextConnectors ? nextConnectors.id : undefined) ===
        ('id' in connectorsView ? connectorsView.id : undefined) &&
      nextNetwork.kind === networkView.kind &&
      nextCompute.kind === computeView.kind &&
      ('providerId' in nextCompute ? nextCompute.providerId : undefined) ===
        ('providerId' in computeView ? computeView.providerId : undefined) &&
      nextSpecialists.kind === specialistsView.kind &&
      ('id' in nextSpecialists ? nextSpecialists.id : undefined) ===
        ('id' in specialistsView ? specialistsView.id : undefined) &&
      nextArchived.kind === archivedView.kind &&
      ('projectId' in nextArchived ? nextArchived.projectId : undefined) ===
        ('projectId' in archivedView ? archivedView.projectId : undefined)
    ) {
      return
    }
    setHistory((entries) => [...entries.slice(0, historyIndex + 1), location])
    setHistoryIndex((index) => index + 1)
  }

  // Internal panel transitions must use this dialog's history instead of reseeding an external
  // entry point, so Back returns to the recovery panel the user just completed.
  const navigatePanel = (panel: SettingsPanelId): void => navigate({ ...INITIAL_LOCATION, panel })

  // Navigates within the skills panel (list/detail/create/edit/import) as a history entry.
  const navigateSkills = (skills: SkillsView): void =>
    navigate({ panel: 'skills', skills, model: modelView, connectors: connectorsView })

  // Navigates within the connectors panel (list/detail/add/edit) as a history entry.
  const navigateConnectors = (connectors: ConnectorsView): void =>
    navigate({ panel: 'connectors', skills: skillsView, model: modelView, connectors })

  // Navigates within the specialists panel (list/create) as a history entry.
  const navigateSpecialists = (specialists: SpecialistsView): void =>
    navigate({ panel: 'specialists', skills: skillsView, model: modelView, specialists })

  // Navigates within the network panel (package-mirror list vs. configure) as a history entry, so the
  // configure form gets a proper "Network / Package mirror" breadcrumb + back/forward.
  const navigateNetwork = (network: NetworkView): void =>
    navigate({
      panel: 'network',
      skills: skillsView,
      model: modelView,
      connectors: connectorsView,
      network
    })

  // Navigates within the compute panel (list/add/detail) as a history entry.
  const navigateCompute = (compute: ComputeView): void =>
    navigate({
      panel: 'compute',
      skills: skillsView,
      model: modelView,
      connectors: connectorsView,
      compute
    })

  const navigateArchived = (archived: ArchivedView): void =>
    navigate({
      panel: 'archived',
      skills: skillsView,
      model: modelView,
      connectors: connectorsView,
      archived
    })

  // Shared header breadcrumb for a drilled-in sub-view (null when on a panel's list, so the plain
  // panel title shows). Covers both the skills and model panels.
  const breadcrumb = ((): {
    rootLabel: string
    rootTo: NavLocation
    leaf: string
  } | null => {
    if (activePanel === 'skills' && skillsView.kind !== 'list') {
      const leaf =
        skillsView.kind === 'create'
          ? 'New skill'
          : skillsView.kind === 'upload'
            ? 'Upload skills'
            : skillsView.kind === 'import'
              ? 'Import from GitHub'
              : skillsView.kind === 'import-agent-home'
                ? 'Import installed skills'
                : (() => {
                    const name = skills.find((skill) => skill.id === skillsView.id)?.name ?? ''
                    return skillsView.kind === 'edit' ? `Edit ${name}`.trim() : name
                  })()
      return {
        rootLabel: 'Skills',
        rootTo: { panel: 'skills', skills: { kind: 'list' }, model: currentLocation.model },
        leaf
      }
    }
    if (activePanel === 'model' && modelView.kind !== 'list') {
      const name =
        modelView.kind === 'edit'
          ? (providers.find((provider) => provider.id === modelView.providerId)?.name ?? '')
          : ''
      return {
        rootLabel: 'Model',
        rootTo: { panel: 'model', skills: currentLocation.skills, model: { kind: 'list' } },
        leaf: modelView.kind === 'create' ? 'Add provider' : `Edit ${name}`.trim()
      }
    }
    if (activePanel === 'network' && networkView.kind !== 'list') {
      return {
        rootLabel: 'Network',
        rootTo: {
          panel: 'network',
          skills: currentLocation.skills,
          model: currentLocation.model,
          network: { kind: 'list' }
        },
        leaf: 'Package mirror'
      }
    }
    if (activePanel === 'connectors' && connectorsView.kind !== 'list') {
      const leaf =
        connectorsView.kind === 'add'
          ? 'Add connector'
          : connectorsView.kind === 'import'
            ? 'Import configuration'
            : connectorsView.kind === 'export'
              ? `Export ${customServers.find((s) => s.id === connectorsView.id)?.name ?? 'connector'}`.trim()
              : connectorsView.kind === 'edit'
                ? `Edit ${customServers.find((s) => s.id === connectorsView.id)?.name ?? 'connector'}`.trim()
                : (connectors.find((c) => c.id === connectorsView.id)?.displayName ?? '')
      return {
        rootLabel: 'Connectors',
        rootTo: {
          panel: 'connectors',
          skills: currentLocation.skills,
          model: currentLocation.model,
          connectors: { kind: 'list' }
        },
        leaf
      }
    }
    if (activePanel === 'compute' && computeView.kind !== 'list') {
      const leaf =
        computeView.kind === 'add'
          ? 'Add SSH host'
          : (computeHosts.find((host) => host.providerId === computeView.providerId)?.displayName ??
            computeView.providerId)
      return {
        rootLabel: 'Compute',
        rootTo: {
          panel: 'compute',
          skills: currentLocation.skills,
          model: currentLocation.model,
          connectors: currentLocation.connectors,
          compute: { kind: 'list' }
        },
        leaf
      }
    }
    if (activePanel === 'specialists' && specialistsView.kind !== 'list') {
      const editingSpecialist =
        specialistsView.kind === 'edit'
          ? specialistItems.find(
              (item): item is Extract<SpecialistListItem, { kind: 'custom' }> =>
                item.kind === 'custom' && item.id === specialistsView.id
            )
          : undefined
      const leaf =
        specialistsView.kind === 'create'
          ? 'New specialist'
          : (editingSpecialist?.name ?? 'Edit specialist')
      return {
        rootLabel: 'Specialists',
        rootTo: {
          panel: 'specialists',
          skills: currentLocation.skills,
          model: currentLocation.model,
          specialists: { kind: 'list' }
        },
        leaf
      }
    }
    if (activePanel === 'archived' && archivedView.kind === 'project') {
      return {
        rootLabel: 'Archived',
        rootTo: {
          panel: 'archived',
          skills: currentLocation.skills,
          model: currentLocation.model,
          archived: { kind: 'list' }
        },
        leaf:
          projects.find((project) => project.id === archivedView.projectId)?.name ??
          'Archived project'
      }
    }
    return null
  })()

  const goBack = (): void => {
    if (!canGoBack) return
    setHistoryIndex((index) => index - 1)
  }

  const goForward = (): void => {
    if (!canGoForward) return
    setHistoryIndex((index) => index + 1)
  }

  useImperativeHandle(ref, () => ({
    closeActivePane: () => {
      if (!open) return false
      const activeDialog = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
        )
      )
        .filter((dialog) => dialog.dataset.slot !== 'settings-surface')
        .at(-1)
      if (activeDialog) {
        activeDialog.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        )
        return true
      }
      if (isMobileNavOpen) {
        setIsMobileNavOpen(false)
        return true
      }
      if (breadcrumb) {
        if (canGoBack) setHistoryIndex((index) => index - 1)
        else {
          setHistory((entries) =>
            entries.map((entry, index) => (index === historyIndex ? breadcrumb.rootTo : entry))
          )
        }
      } else {
        setIsMobileNavOpen(false)
        onClose()
      }
      return true
    }
  }))

  // A provider form (add/edit) is open when the model panel is on a non-list sub-view.
  const isProviderFormOpen = activePanel === 'model' && modelView.kind !== 'list'
  // Resolve the edited provider from the live store so a model refresh (which updates the cache) is
  // reflected in the form; undefined until the provider is found (or when creating).
  const editingProvider =
    modelView.kind === 'edit'
      ? providers.find((provider) => provider.id === modelView.providerId)
      : undefined
  // Required-field errors for the open draft; a custom provider must be complete before it can save.
  const formErrors = getProviderFormErrors(formValue, { hasStoredKey: editingProvider?.hasKey })
  const canSave = !isSaving && !hasProviderFormErrors(formErrors)

  // Seed the form value when entering a create/edit sub-view (adjust-state-during-render, keyed on the
  // sub-view so typing isn't clobbered by background store updates; edit guards until the provider
  // loads). A create pre-selects the official vendor matching the active agent framework. Also
  // clears any stale status message on entry.
  const modelViewKey = modelView.kind === 'edit' ? `edit:${modelView.providerId}` : modelView.kind
  const [seededModelView, setSeededModelView] = useState(modelViewKey)
  if (modelViewKey !== seededModelView) {
    setSeededModelView(modelViewKey)
    if (modelView.kind === 'create') {
      setFormValue(
        createEmptyProviderFormValue(providerKindPatch(defaultProviderKindKey(agentFrameworkId)))
      )
    } else if (modelView.kind === 'edit') {
      const provider = providers.find((entry) => entry.id === modelView.providerId)
      if (provider) setFormValue(toFormValue(provider))
    }
    setStatusMessage(undefined)
  }

  const openCreate = (): void =>
    navigate({ panel: 'model', skills: currentLocation.skills, model: { kind: 'create' } })

  const openEdit = (provider: ProviderView): void =>
    navigate({
      panel: 'model',
      skills: currentLocation.skills,
      model: { kind: 'edit', providerId: provider.id }
    })

  const closeForm = (): void =>
    navigate({ panel: 'model', skills: currentLocation.skills, model: { kind: 'list' } })

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    setStatusMessage(undefined)

    try {
      // Persist first and return to the provider list immediately — don't hold the form open waiting
      // for the connection test. The test then runs in the background and its result (green check or
      // warning) lands on the provider's card.
      const providerId = await persistProvider(toUpsertRequest(formValue, editingProvider?.id))

      navigate({ panel: 'model', skills: currentLocation.skills, model: { kind: 'list' } })

      if (providerId) {
        setBusyProviderId(providerId)
        void validateProvider({ providerId }).finally(() => setBusyProviderId(undefined))
      }
    } catch (error) {
      setStatusOk(false)
      setStatusMessage(error instanceof Error ? error.message : 'Could not save provider.')
    } finally {
      setIsSaving(false)
    }
  }

  // Pulls the vendor's live model list for the provider being edited; on success the form's tags and
  // the model selectors reflect it. On failure the bundled catalog stays in place.
  const handleRefreshModels = async (providerId: string): Promise<void> => {
    setIsRefreshingModels(true)
    setStatusMessage(undefined)

    try {
      const result = await refreshProviderModels(providerId)

      setStatusOk(result.ok)
      setStatusMessage(
        result.ok
          ? `Loaded ${result.models?.length ?? 0} models from the vendor.`
          : `Couldn't fetch models: ${result.message ?? 'request failed'}. Using the bundled list.`
      )
    } finally {
      setIsRefreshingModels(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) return
        setIsMobileNavOpen(false)
        onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none" />
        <Dialog.Content
          data-slot="settings-surface"
          onOpenAutoFocus={() => {
            returnFocusRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={(event) => {
            const returnFocus = returnFocusRef.current
            returnFocusRef.current = null
            if (!returnFocus?.isConnected) return
            event.preventDefault()
            returnFocus.focus()
          }}
          // Don't let a click/focus outside the dialog dismiss it. A Radix Select inside the panel
          // (provider type, active model, install source) portals its listbox outside the dialog's
          // DOM, so an outside-click meant only to close the open dropdown would otherwise also close
          // the whole panel. The dropdown's own dismiss still closes just the dropdown; the panel is
          // closed intentionally via the ✕ button or Escape.
          onInteractOutside={(event) => event.preventDefault()}
          className={cn(
            'fixed z-50 flex overflow-hidden overscroll-contain rounded-xl border border-border bg-card text-foreground shadow-dialog outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none',
            isExpanded
              ? 'inset-0 rounded-none md:inset-4 md:rounded-xl'
              : 'inset-0 h-[100dvh] w-screen rounded-none md:bottom-auto md:left-1/2 md:right-auto md:top-1/2 md:h-[min(688px,calc(100vh-2rem))] md:w-[min(960px,calc(100vw-2rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl'
          )}
        >
          {/* Radix requires a Title/Description for a11y; the visible panel title lives in the header. */}
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          <Dialog.Description className="sr-only">
            Manage your agent runtime and model providers.
          </Dialog.Description>

          {isMobileNavOpen ? (
            <button
              type="button"
              className="fixed inset-0 z-[65] bg-black/45 md:hidden"
              aria-label="Close settings navigation"
              onClick={() => setIsMobileNavOpen(false)}
            />
          ) : null}

          {/* Left navigation becomes an off-canvas drawer on narrow browser screens. */}
          <nav
            aria-label="Settings"
            aria-hidden={isMobile && !isMobileNavOpen ? true : undefined}
            inert={isMobile && !isMobileNavOpen ? true : undefined}
            className={cn(
              'fixed inset-y-0 left-0 z-[70] flex w-[min(86vw,320px)] shrink-0 flex-col gap-4 border-r border-border bg-background p-3 transition-transform duration-200 ease-out md:static md:z-auto md:w-48 md:translate-x-0',
              isMobileNavOpen ? 'translate-x-0' : '-translate-x-full'
            )}
          >
            {SETTINGS_GROUPS.map((group) => (
              <div
                key={group.label ?? group.panels[0]?.id}
                className={cn('flex flex-col gap-0.5', group.bottom && 'mt-auto')}
              >
                {group.label ? (
                  <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </div>
                ) : null}
                <ul className="flex flex-col gap-0.5">
                  {group.panels.map(({ id, label, Icon }) => {
                    const isActive = activePanel === id
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => {
                            setIsMobileNavOpen(false)
                            navigatePanel(id)
                          }}
                          className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-150 motion-reduce:transition-none ${
                            isActive
                              ? 'bg-muted font-medium text-foreground'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                          }`}
                        >
                          <Icon
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate">{label}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>

          {/* Right column: header bar + scrollable panel content. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
            <TooltipProvider delayDuration={300}>
              <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 md:px-3">
                <div className="flex min-w-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setIsMobileNavOpen(true)}
                        aria-label="Open settings navigation"
                        className="shrink-0 rounded-lg text-muted-foreground md:hidden"
                      >
                        <Menu className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Navigation</TooltipContent>
                  </Tooltip>
                  {/* Browser-like history controls for the settings navigation. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={goBack}
                        disabled={!canGoBack}
                        aria-label="Back"
                        className="shrink-0 rounded-lg text-muted-foreground disabled:opacity-40"
                      >
                        <ArrowLeft className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Back</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={goForward}
                        disabled={!canGoForward}
                        aria-label="Forward"
                        className="shrink-0 rounded-lg text-muted-foreground disabled:opacity-40"
                      >
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Forward</TooltipContent>
                  </Tooltip>
                  <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
                  {breadcrumb !== null ? (
                    <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                      <button
                        type="button"
                        onClick={() => navigate(breadcrumb.rootTo)}
                        aria-label={`Back to ${breadcrumb.rootLabel.toLowerCase()}`}
                        className="shrink-0 text-muted-foreground transition-colors motion-reduce:transition-none hover:text-foreground"
                      >
                        {breadcrumb.rootLabel}
                      </button>
                      <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                        ›
                      </span>
                      <span className="truncate text-foreground">{breadcrumb.leaf}</span>
                    </div>
                  ) : (
                    <h2 className="truncate text-sm font-semibold text-foreground">
                      {SETTINGS_PANELS.find((panel) => panel.id === activePanel)?.label}
                    </h2>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setIsExpanded((value) => !value)}
                        aria-label={isExpanded ? 'Restore' : 'Maximize'}
                        className="rounded-lg text-muted-foreground"
                      >
                        {isExpanded ? (
                          <Minimize2 className="size-4" aria-hidden="true" />
                        ) : (
                          <Maximize2 className="size-4" aria-hidden="true" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{isExpanded ? 'Restore' : 'Maximize'}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <Dialog.Close asChild>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Close settings"
                          className="rounded-lg text-muted-foreground"
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                    </Dialog.Close>
                    <TooltipContent>Close settings</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              {settingsWriteError ? (
                <div
                  data-slot="settings-write-error"
                  role="alert"
                  className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <p className="min-w-0 flex-1 break-words py-0.5">{settingsWriteError}</p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Dismiss settings error"
                        className="-my-1 -mr-1 shrink-0 rounded-md text-danger-000 hover:bg-danger-000/10 hover:text-danger-000"
                        onClick={clearSettingsWriteError}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Dismiss</TooltipContent>
                  </Tooltip>
                </div>
              ) : null}
            </TooltipProvider>

            <div data-slot="settings-content-scroll" className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto min-h-full w-full max-w-[880px]">
                {activePanel === 'skills' ? (
                  <SkillsPanel
                    view={skillsView}
                    onNavigate={navigateSkills}
                    canImportInstalledSkills={canImportInstalledSkills}
                  />
                ) : activePanel === 'specialists' ? (
                  <SpecialistsPanel view={specialistsView} onNavigate={navigateSpecialists} />
                ) : activePanel === 'connectors' ? (
                  connectorsView.kind === 'detail' ? (
                    <ConnectorDetailView
                      id={connectorsView.id}
                      onManagePermissions={() => navigatePanel('permissions')}
                    />
                  ) : connectorsView.kind === 'add' ? (
                    <ConnectorAddForm
                      initialTransport={connectorsView.transport}
                      initialTemplate={connectorsView.template}
                      onDone={() => navigateConnectors({ kind: 'list' })}
                      onCancel={() => navigateConnectors({ kind: 'list' })}
                    />
                  ) : connectorsView.kind === 'import' ? (
                    <ConnectorImportView
                      onUse={(template) =>
                        navigateConnectors({
                          kind: 'add',
                          transport: template.transport === 'stdio' ? 'local' : 'remote',
                          template
                        })
                      }
                      onCancel={() => navigateConnectors({ kind: 'list' })}
                    />
                  ) : connectorsView.kind === 'export' ? (
                    <ConnectorExportView
                      key={connectorsView.id}
                      id={connectorsView.id}
                      onDone={() => navigateConnectors({ kind: 'list' })}
                    />
                  ) : connectorsView.kind === 'edit' ? (
                    <ConnectorAddForm
                      editServer={customServers.find((s) => s.id === connectorsView.id)}
                      onDone={() => navigateConnectors({ kind: 'list' })}
                      onCancel={() => navigateConnectors({ kind: 'list' })}
                    />
                  ) : (
                    <ConnectorsPanel onNavigate={navigateConnectors} />
                  )
                ) : activePanel === 'compute' ? (
                  computeView.kind === 'add' ? (
                    <ComputeAddForm
                      onCreated={(providerId) => navigateCompute({ kind: 'detail', providerId })}
                      onCancel={() => navigateCompute({ kind: 'list' })}
                    />
                  ) : computeView.kind === 'detail' ? (
                    <ComputeHostDetail
                      providerId={computeView.providerId}
                      onRemoved={() => navigateCompute({ kind: 'list' })}
                    />
                  ) : (
                    <ComputePanel onNavigate={navigateCompute} />
                  )
                ) : activePanel === 'storage' ? (
                  <StoragePanel
                    onContinueToAgent={() => {
                      navigatePanel('agent')
                    }}
                  />
                ) : activePanel === 'permissions' ? (
                  <PermissionsPanel
                    onOpenSession={onOpenSession}
                    onOpenConnector={(id) =>
                      navigateConnectors(
                        customServers.some((server) => server.id === id)
                          ? { kind: 'edit', id }
                          : { kind: 'detail', id }
                      )
                    }
                  />
                ) : activePanel === 'archived' ? (
                  <ArchivedPanel view={archivedView} onNavigate={navigateArchived} />
                ) : activePanel === 'runtimes' ? (
                  <RuntimesPanel
                    title="Notebook runtimes"
                    description="Enable the environments each notebook language may run in. The app-managed environment is on by default; enable your own interpreters to make them available to the agent."
                  />
                ) : activePanel === 'network' ? (
                  <NetworkPanel view={networkView} onNavigate={navigateNetwork} />
                ) : activePanel === 'general' ? (
                  <GeneralPanel />
                ) : activePanel === 'remote-control' ? (
                  <RemoteControlPanel />
                ) : activePanel === 'agent' ? (
                  <AgentPanel
                    title="Agent framework"
                    description="Choose which coding-agent backend drives your sessions. Select a card to switch; switching starts a fresh agent session, and open conversations have their transcript replayed to the new backend. The active runtime can't be uninstalled — switch to the other one first."
                  />
                ) : isProviderFormOpen ? (
                  // Add/edit provider is a secondary page reached via the shared back/forward arrows.
                  <div className="p-5">
                    {/* Secret writes fail closed when the OS keychain is unavailable. */}
                    {!encryptionAvailable ? (
                      <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        Secure key storage is unavailable. API keys cannot be saved until the system
                        keychain is unlocked or authorized.
                      </p>
                    ) : null}
                    <ProviderForm
                      value={formValue}
                      onChange={(patch) => setFormValue((current) => ({ ...current, ...patch }))}
                      hasStoredKey={editingProvider?.hasKey}
                      maskedKey={editingProvider?.maskedKey}
                      needsKey={editingProvider?.needsKey}
                      errors={formErrors}
                      supportedModels={editingProvider?.models}
                      onRefreshModels={
                        editingProvider?.type === 'official' &&
                        editingProvider.hasKey &&
                        editingProvider.vendorId &&
                        resolveVendorModelsUrl(editingProvider.vendorId, editingProvider.region)
                          ? () => void handleRefreshModels(editingProvider.id)
                          : undefined
                      }
                      isRefreshingModels={isRefreshingModels}
                      disabled={isSaving}
                      encryptionAvailable={encryptionAvailable}
                      showCodexSubscriptions={
                        agentFrameworkId === 'codex' && editingProvider === undefined
                      }
                      showClaudeIsolated={
                        agentFrameworkId === 'claude-code' && editingProvider === undefined
                      }
                      defaultCustomApiEndpoint={customApiEndpoint}
                    />
                    {statusMessage ? (
                      <p
                        className={`mt-3 text-sm ${statusOk ? 'text-primary' : 'text-destructive'}`}
                        role="alert"
                      >
                        {statusMessage}
                      </p>
                    ) : null}
                    <div className="mt-6 flex justify-end gap-2">
                      <Button type="button" variant="ghost" onClick={closeForm} disabled={isSaving}>
                        Cancel
                      </Button>
                      <Button type="button" onClick={() => void handleSave()} disabled={!canSave}>
                        {isSaving ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <ProvidersPanel
                    onCreateProvider={openCreate}
                    onEditProvider={openEdit}
                    busyProviderId={busyProviderId}
                    onBusyProviderChange={setBusyProviderId}
                  />
                )}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
})

export { SettingsPage, type SettingsPageHandle }
